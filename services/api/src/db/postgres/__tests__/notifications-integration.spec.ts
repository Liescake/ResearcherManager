import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseConfig } from '../../config/database-config';
import { loadEnv } from '../../../config/env';
import { runMigrations } from '../../migrations/migration-runner';
import { resolveMigrationsDirectory } from '../../migrations/run-migrations';
import { createPostgresMigrationDatabase } from '../postgres-migration-database';
import {
  createPostgresConnection,
  toPostgresPoolProfile,
  UNATTESTED_POSTGRES_CAPABILITIES,
} from '../postgres-executor';
import { PostgresExecutorError } from '../postgres-error';
import type { SqlConnection } from '../../ports/sql-executor.port';
import {
  NotificationStatus,
  NotificationType,
} from '../../../modules/notifications/notifications.port';
import type { Notification } from '../../../modules/notifications/notifications.port';
import {
  POSTGRES_NOTIFICATION_COLUMNS,
  POSTGRES_NOTIFICATION_TABLE,
  PostgresNotificationRepository,
} from '../../../modules/notifications/notifications.postgres-repository';

/**
 * 站内通知的**真实 PostgreSQL 集成**（WSL2 / Docker Compose 提供的开发库）。
 *
 * ## 为什么必须显式启用
 * 未提供 `TEST_DATABASE_URL`（或库名含 `test` 的 `DATABASE_URL`）时整个套件**明确 skip**，
 * 绝不伪造通过；提供了但连不上、或目标库名不含 `test` 时**失败**（本套件执行迁移与 DDL）。
 * 与 `postgres-integration.spec.ts` / `audit-integration.spec.ts` /
 * `application-reviews-integration.spec.ts` 同一套启用口径。
 *
 * ## 断言的硬性质（离线 spec 无法证明、必须在真库上闭环的）
 * 1. **schema 由仓库真实迁移建立**：`notifications` 的列清单与 `POSTGRES_NOTIFICATION_COLUMNS`
 *    双向一致（迁移不许多列、也不许少列），主键是 `id`，本人列表取数路径有
 *    `(user_id, created_at, id)` 索引，且枚举闭集与「`read` 必带 `read_at` / `unread` 不得携带」
 *    这两类契约在存储层有 CHECK 镜像；
 * 2. **写读闭环与归属隔离**：字段（含可选 `read_at` 的空 / 非空）原样往返，顺序是
 *    `created_at ASC, id ASC`；他人通知**既不出库也不可探测**（归属下推进 SQL）；
 * 3. **主键冲突不得静默覆盖**：同 ID 再写被判 `CONFLICT`，且库里那一行逐字段不变；
 * 4. **read 状态机在存储层 fail-closed 且幂等**：`unread -> read` 成功；对已读记录再写一次判
 *    `TRANSITION_REJECTED` 且**不产生任何写入**（`read_at` 不被重复请求改写）；
 *    **并发重复标记已读只有一个能命中**；不存在「已读 -> 未读」回退路径；
 * 5. **绕过应用层也写不坏**：直接对 `notifications` 执行非法状态 / `read` 缺 `read_at` /
 *    `unread` 带 `read_at` / 空 UUID 主键的 INSERT 都被 CHECK 拒绝（23514）；
 * 6. **敏感内容与存储 ID 域在写路径就被拒绝**：标题 / 正文含身份证号或疑似密钥、非 UUID 主体
 *    一律 fail-closed，且库里查不到对应主键的行。
 *
 * ## 为什么需要清理行
 * 与只追加的审计表不同，通知表是可变的业务表，因此本套件在 `afterAll` 里按**本次运行写入的
 * 主体集合**清理，保证重复运行不会把上一次的行当成夹具（列表断言依赖「该主体名下恰好这些行」）。
 *
 * ## 运行方式（重要）
 * `runMigrations` 没有跨连接的互斥锁，因此**各集成 spec 不能并行跑**。请按文件串行执行：
 * `node node_modules/vitest/vitest.mjs run src/db/postgres/__tests__ --pool=threads --no-file-parallelism`
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']?.trim();
const FALLBACK_DATABASE_URL = process.env['DATABASE_URL']?.trim();

function databaseNameOf(url: string): string | undefined {
  try {
    const name = new URL(url).pathname.replace(/^\//u, '');
    return name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}

const FALLBACK_DATABASE_NAME =
  FALLBACK_DATABASE_URL === undefined || FALLBACK_DATABASE_URL === ''
    ? undefined
    : databaseNameOf(FALLBACK_DATABASE_URL);

const RAW_URL =
  TEST_DATABASE_URL !== undefined && TEST_DATABASE_URL !== ''
    ? TEST_DATABASE_URL
    : FALLBACK_DATABASE_NAME?.includes('test') === true
      ? FALLBACK_DATABASE_URL
      : undefined;
const ENABLED = RAW_URL !== undefined;

function describeState(): string {
  if (ENABLED) {
    return RAW_URL === TEST_DATABASE_URL
      ? '已配置 TEST_DATABASE_URL'
      : '已配置 DATABASE_URL（库名含 test）';
  }
  if (FALLBACK_DATABASE_URL !== undefined && FALLBACK_DATABASE_URL !== '') {
    return '未启用：DATABASE_URL 指向的库名不含 test（避免对开发/生产库执行破坏性 DDL）';
  }
  return '未配置 TEST_DATABASE_URL / DATABASE_URL';
}

if (!ENABLED) {
  describe('真实 PostgreSQL 通知集成（未启用）', () => {
    it.skip(`未启用：${describeState()}（需要 WSL2 Docker Compose 中的开发库，见 README）`, () => {
      expect.unreachable(
        'reachable only when TEST_DATABASE_URL (or a test DATABASE_URL) is configured',
      );
    });
  });
}

const integrationDescribe = ENABLED ? describe : describe.skip;

let connection: SqlConnection | undefined;

/** 本次运行写入的主体集合：用于 `afterAll` 精确清理（通知表可变，不清会污染后续断言） */
const owners = new Set<string>();

function newOwner(): string {
  const owner = randomUUID();
  owners.add(owner);
  return owner;
}

function notificationFor(userId: string, overrides: Partial<Notification> = {}): Notification {
  return {
    id: randomUUID(),
    userId,
    type: NotificationType.MembershipReview,
    title: '入组申请审核结果',
    body: '你提交的入组申请已通过审核。',
    status: NotificationStatus.Unread,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function repository(): PostgresNotificationRepository {
  return new PostgresNotificationRepository(connection as SqlConnection);
}

async function query<T = Record<string, unknown>>(
  sql: string,
  parameters?: readonly unknown[],
): Promise<readonly T[]> {
  const result = await (connection as SqlConnection).query<T>(sql, parameters);
  return result.rows;
}

integrationDescribe('真实 PostgreSQL 通知集成（TEST_DATABASE_URL / 测试库 DATABASE_URL）', () => {
  beforeAll(async () => {
    if (!ENABLED || RAW_URL === undefined) {
      return;
    }
    const resolution = resolveDatabaseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: RAW_URL,
      DATABASE_APPLICATION_NAME: 'researcher-manager-notifications-integration',
    });
    if (resolution.status !== 'configured') {
      throw new Error(`测试前置失败：${describeState()} 未解析成可用配置`);
    }
    if (!resolution.config.database.includes('test')) {
      throw new Error(
        `${describeState()} 指向的库名不含 test（${resolution.config.database}）：本套件会执行 DDL，拒绝在非测试库上运行`,
      );
    }

    connection = createPostgresConnection({
      profile: toPostgresPoolProfile(resolution.config),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
    });
    await connection.query('SELECT 1');

    // schema 必须由**仓库真实迁移**建立（而不是测试自己建表），否则验证的是临时表
    const applied = await runMigrations({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database: createPostgresMigrationDatabase(connection),
      appliedBy: 'notifications-integration-test',
    });
    if (applied.guard.violations.length > 0) {
      throw new Error('测试前置失败：真实迁移未通过部署守卫');
    }
  }, 90_000);

  afterAll(async () => {
    if (connection !== undefined && owners.size > 0) {
      // 只清理本次运行写入的主体：不触碰其它数据，也不做整表截断
      await connection.query('DELETE FROM notifications WHERE user_id = ANY($1::uuid[])', [
        [...owners],
      ]);
      await connection.close();
    }
  });

  it('notifications 由迁移 0010 建立：列清单与 adapter 常量双向一致、主键是 id、归属索引与存储层 CHECK 齐备', async () => {
    const exists = await query<{ exists: boolean }>(
      'SELECT to_regclass($1::text) IS NOT NULL AS exists',
      [`public.${POSTGRES_NOTIFICATION_TABLE}`],
    );
    expect(exists[0]?.exists).toBe(true);

    const columns = await query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', POSTGRES_NOTIFICATION_TABLE],
    );
    // 双向一致：迁移不许多列，也不许少列（adapter 用显式列清单，多出的列会被严格行契约拒绝）
    expect(columns.map((row) => row.column_name).sort()).toEqual(
      [...POSTGRES_NOTIFICATION_COLUMNS].sort(),
    );

    const primaryKey = await query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'public.notifications'::regclass AND i.indisprimary`,
    );
    expect(primaryKey.map((row) => row.column_name)).toEqual(['id']);

    // 本人列表的取数路径（WHERE user_id = $1 ORDER BY created_at, id）必须有索引支撑
    const indexes = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
      [POSTGRES_NOTIFICATION_TABLE],
    );
    expect(indexes.some((row) => /\(user_id,\s*created_at,\s*id\)/u.test(row.indexdef))).toBe(true);

    // 存储层 CHECK 镜像 adapter 契约：枚举闭集、长度上界、read/read_at 跨字段不变式、存储 ID 域
    const constraints = await query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.notifications'::regclass AND contype = 'c'`,
    );
    const names = constraints.map((row) => row.conname);
    for (const expected of [
      'notifications_type_check',
      'notifications_status_check',
      'notifications_title_length',
      'notifications_body_length',
      'notifications_read_state_consistent',
      'notifications_id_not_nil',
      'notifications_user_id_not_nil',
    ]) {
      expect(names).toContain(expected);
    }
  }, 60_000);

  it('写入 / 按主体取数在真实库闭环：字段原样往返、稳定排序、他人记录不出库', async () => {
    const owner = newOwner();
    const other = newOwner();
    const repositoryUnderTest = repository();

    const firstUnread = notificationFor(owner, { createdAt: '2026-06-01T00:00:00.000Z' });
    const secondRead = notificationFor(owner, {
      type: NotificationType.EducationReview,
      title: '升学记录审核结果',
      status: NotificationStatus.Read,
      readAt: '2026-06-01T00:00:05.000Z',
      updatedAt: '2026-06-01T00:00:05.000Z',
      createdAt: '2026-06-01T00:00:01.000Z',
    });
    const foreign = notificationFor(other, { createdAt: '2026-06-01T00:00:02.000Z' });

    // 写入：返回值必须与写入记录逐字段等价（含 `read_at` 的空 / 非空两条路径）
    await expect(repositoryUnderTest.create(firstUnread)).resolves.toEqual(firstUnread);
    await expect(repositoryUnderTest.create(secondRead)).resolves.toEqual(secondRead);
    await expect(repositoryUnderTest.create(foreign)).resolves.toEqual(foreign);

    // 取数：只出本人两条，顺序为 created_at ASC, id ASC；逐字段等价（时间戳原样往返）
    const mine = await repositoryUnderTest.listByUserId(owner);
    expect(mine.map((item) => item.id)).toEqual([firstUnread.id, secondRead.id]);
    expect(mine[0]).toEqual(firstUnread);
    expect(mine[1]).toEqual(secondRead);
    expect(mine[0]?.readAt).toBeUndefined();
    expect(mine[1]?.readAt).toBe(secondRead.readAt);
    expect(JSON.stringify(mine)).not.toContain(foreign.id);

    // 单条读取：归属下推进 SQL，因此「他人 ID + 本人主体」既命中不了也不报错（统一按不存在处理）
    await expect(repositoryUnderTest.findById(firstUnread.id, owner)).resolves.toEqual(firstUnread);
    await expect(repositoryUnderTest.findById(firstUnread.id, other)).resolves.toBeUndefined();
    await expect(repositoryUnderTest.findById(foreign.id, owner)).resolves.toBeUndefined();

    // 他人那行**在库里确实存在**（不是写入失败被吞掉）
    const stored = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM notifications WHERE user_id = $1::uuid',
      [other],
    );
    expect(stored[0]?.count).toBe(1);
  }, 60_000);

  it('主键冲突不得静默覆盖：同 ID 再写判 CONFLICT，库里那一行逐字段不变', async () => {
    const owner = newOwner();
    const repositoryUnderTest = repository();
    const original = notificationFor(owner, { title: '原始通知标题' });

    await expect(repositoryUnderTest.create(original)).resolves.toEqual(original);

    const conflicting = notificationFor(owner, { id: original.id, title: '被覆盖的通知标题' });
    await expect(repositoryUnderTest.create(conflicting)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const rows = await query<{ title: string; user_id: string }>(
      'SELECT title, user_id FROM notifications WHERE id = $1::uuid',
      [original.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('原始通知标题');
    expect(rows[0]?.user_id).toBe(owner);
  }, 60_000);

  it('read 状态机在存储层闭环：unread→read 成功、重复写回 TRANSITION_REJECTED 且 read_at 不被改写', async () => {
    const owner = newOwner();
    const repositoryUnderTest = repository();
    const unread = notificationFor(owner, { createdAt: '2026-06-02T00:00:00.000Z' });
    await repositoryUnderTest.create(unread);

    const readAt = '2026-06-02T01:00:00.000Z';
    const read: Notification = {
      ...unread,
      status: NotificationStatus.Read,
      readAt,
      updatedAt: readAt,
    };

    // 合法前向边：条件写入命中，返回库里的真实行
    await expect(repositoryUnderTest.save(read)).resolves.toEqual(read);

    // 幂等复核：对**已读**记录再写一次 → 条件谓词不命中（read 没有前驱）→ TRANSITION_REJECTED
    const secondAttempt = { ...read, readAt: '2026-06-02T02:00:00.000Z' };
    await expect(repositoryUnderTest.save(secondAttempt)).rejects.toMatchObject({
      code: 'TRANSITION_REJECTED',
    });

    // read_at 仍是第一次写入的值（重复请求不得改写「已读时间」）
    const rows = await query<{ status: string; read_at: Date }>(
      'SELECT status, read_at FROM notifications WHERE id = $1::uuid',
      [unread.id],
    );
    expect(rows[0]?.status).toBe('read');
    expect(rows[0]?.read_at.toISOString()).toBe(readAt);

    // 不存在「已读 → 未读」回退路径：目标状态 unread 的前驱集合为空，条件写入永不命中
    await expect(
      repositoryUnderTest.save({
        ...unread,
        status: NotificationStatus.Unread,
        updatedAt: '2026-06-02T03:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'TRANSITION_REJECTED' });
    const after = await query<{ status: string }>(
      'SELECT status FROM notifications WHERE id = $1::uuid',
      [unread.id],
    );
    expect(after[0]?.status).toBe('read');
  }, 60_000);

  it('并发重复标记已读：两个请求只有一个命中条件写入，另一个被判非法转移且无任何写入', async () => {
    const owner = newOwner();
    const repositoryUnderTest = repository();
    const unread = notificationFor(owner, { createdAt: '2026-06-03T00:00:00.000Z' });
    await repositoryUnderTest.create(unread);

    const readAt = '2026-06-03T01:00:00.000Z';
    const read: Notification = {
      ...unread,
      status: NotificationStatus.Read,
      readAt,
      updatedAt: readAt,
    };

    const results = await Promise.allSettled([
      repositoryUnderTest.save(read),
      repositoryUnderTest.save(read),
    ]);
    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'TRANSITION_REJECTED',
    });

    // 库里恰好一次状态变化：read_at 就是那一次写入的值
    const rows = await query<{ status: string; read_at: Date }>(
      'SELECT status, read_at FROM notifications WHERE id = $1::uuid',
      [unread.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.read_at.toISOString()).toBe(readAt);
  }, 60_000);

  it('归属隔离在写路径同样成立：用他人主体写本人记录的主键 → NOT_FOUND，他人行不被改写', async () => {
    const owner = newOwner();
    const other = newOwner();
    const repositoryUnderTest = repository();
    const mine = notificationFor(owner, { createdAt: '2026-06-04T00:00:00.000Z' });
    await repositoryUnderTest.create(mine);

    const readAt = '2026-06-04T01:00:00.000Z';
    // 拿本人的通知 ID + 他人的归属写回：id + user_id 双重限定 ⇒ 0 行 ⇒ NOT_FOUND，绝不跨归属改写
    await expect(
      repositoryUnderTest.save({
        ...mine,
        userId: other,
        status: NotificationStatus.Read,
        readAt,
        updatedAt: readAt,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const rows = await query<{ status: string; read_at: Date | null }>(
      'SELECT status, read_at FROM notifications WHERE id = $1::uuid',
      [mine.id],
    );
    expect(rows[0]?.status).toBe('unread');
    expect(rows[0]?.read_at).toBeNull();
  }, 60_000);

  it('绕过应用层也写不坏：非法状态 / read 缺 read_at / unread 带 read_at / 空 UUID 都被 CHECK 拒绝', async () => {
    const owner = newOwner();
    const run = (sql: string, parameters: readonly unknown[]): Promise<unknown> =>
      (connection as SqlConnection).query(sql, parameters).then(
        () => {
          throw new Error('存储层没有拒绝违规写入：CHECK 约束失效');
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(PostgresExecutorError);
          // 23514 = check_violation
          expect((error as PostgresExecutorError).issues[0]?.code).toBe('23514');
          return undefined;
        },
      );

    const insertSql = `INSERT INTO notifications
      (id, user_id, type, title, body, status, read_at, created_at, updated_at)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::timestamptz, now(), now())`;

    // 未知状态取值
    await run(insertSql, [
      randomUUID(),
      owner,
      'membership_review',
      '标题',
      '正文',
      'archived',
      null,
    ]);
    // read 缺 read_at
    await run(insertSql, [randomUUID(), owner, 'membership_review', '标题', '正文', 'read', null]);
    // unread 带 read_at
    await run(insertSql, [
      randomUUID(),
      owner,
      'membership_review',
      '标题',
      '正文',
      'unread',
      new Date().toISOString(),
    ]);
    // 未登记通知类型
    await run(insertSql, [randomUUID(), owner, 'unknown_type', '标题', '正文', 'unread', null]);
    // 空 UUID 主键（不是可用标识）
    await run(insertSql, [
      '00000000-0000-0000-0000-000000000000',
      owner,
      'membership_review',
      '标题',
      '正文',
      'unread',
      null,
    ]);

    // 五类违规一行都没落库
    const rows = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM notifications WHERE user_id = $1::uuid',
      [owner],
    );
    expect(rows[0]?.count).toBe(0);
  }, 60_000);

  it('存储 ID 域与内容安全：非 UUID 主体 / 身份证号与疑似密钥在写路径就被拒绝，库里不产生任何行', async () => {
    const owner = newOwner();
    const repositoryUnderTest = repository();

    // 非 UUID 主体（会话基线形状）：进入 SQL 之前即拒绝。
    // 写路径上「主体不可用」与「待写记录不合规」是同一道存储 ID 域校验（INVALID_RECORD）；
    // 取数路径上主体本身就是查询谓词，因此是更具体的 INVALID_SUBJECT（见下一条）。
    await expect(repositoryUnderTest.create(notificationFor('u-student-1'))).rejects.toMatchObject({
      code: 'INVALID_RECORD',
    });
    // 空 UUID 主体同样不是可用主体（它是 UUID，但不是可用标识）
    await expect(
      repositoryUnderTest.listByUserId('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });

    // 敏感内容（身份证号 / 疑似密钥）：写路径拒绝，且**一个 SQL 都不执行**
    // （注意：这里用 adapter 的写路径，记录形状合法但内容命中内容安全门禁 ⇒ INVALID_RECORD）
    for (const record of [
      notificationFor(owner, { title: '证件 11010119900307123X 待核对' }),
      notificationFor(owner, { body: 'token: abcdefgh1234' }),
    ]) {
      await expect(repositoryUnderTest.create(record)).rejects.toMatchObject({
        code: 'INVALID_RECORD',
      });
    }

    // 库里一条都没有
    const rows = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM notifications WHERE user_id = $1::uuid',
      [owner],
    );
    expect(rows[0]?.count).toBe(0);

    // 合法记录仍然写得进去（证明上面的拒绝来自校验，而不是「谁都写不进去」）
    const legal = notificationFor(owner, { createdAt: '2026-06-05T00:00:00.000Z' });
    await expect(repositoryUnderTest.create(legal)).resolves.toEqual(legal);
  }, 60_000);

  it('模块换绑工厂 + 真实执行器：通知端口直连真实库闭环，主体域先判（非法主体不建连）', async () => {
    const { createNotificationRepository } =
      await import('../../../modules/notifications/notifications.module');
    const owner = newOwner();

    let connects = 0;
    const port = createNotificationRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: RAW_URL }),
      {
        capabilities: { backend: 'postgres', persistent: true, productionReady: false },
        connect: () => {
          connects += 1;
          return Promise.resolve(connection as SqlConnection);
        },
      },
    );

    // 装配阶段不建连；非 UUID 主体在解析执行器之前就被拒绝，因此仍然没有建连
    expect(connects).toBe(0);
    await expect(port.listByUserId('u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    expect(connects).toBe(0);

    // 合法主体：建连一次并被复用，真实库上创建 / 读取 / 标记已读闭环
    const record = notificationFor(owner, { createdAt: '2026-06-06T00:00:00.000Z' });
    await expect(port.create(record)).resolves.toEqual(record);
    await expect(port.listByUserId(owner)).resolves.toEqual([record]);

    const readAt = '2026-06-06T01:00:00.000Z';
    const read: Notification = {
      ...record,
      status: NotificationStatus.Read,
      readAt,
      updatedAt: readAt,
    };
    await expect(port.save(read)).resolves.toEqual(read);
    await expect(port.findById(record.id, owner)).resolves.toEqual(read);
    expect(connects).toBe(1);
  }, 60_000);
});
