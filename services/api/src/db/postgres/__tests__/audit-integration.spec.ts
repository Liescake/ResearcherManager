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
import { AuditEventType, AuditResourceType, AuditResult } from '../../../modules/audit/audit.port';
import type { AuditEvent } from '../../../modules/audit/audit.port';
import {
  POSTGRES_AUDIT_COLUMNS,
  POSTGRES_AUDIT_TABLE,
  PostgresAuditRepository,
} from '../../../modules/audit/audit.postgres-repository';

/**
 * 不可变业务审计记录的**真实 PostgreSQL 集成**（WSL2 / Docker Compose 提供的开发库）。
 *
 * ## 为什么必须显式启用
 * 未提供 `TEST_DATABASE_URL`（或库名含 `test` 的 `DATABASE_URL`）时整个套件**明确 skip**，
 * 绝不伪造通过；提供了但连不上、或目标库名不含 `test` 时**失败**（本套件执行迁移与 DDL）。
 * 与 `postgres-integration.spec.ts` / `application-reviews-integration.spec.ts` 同一套启用口径。
 *
 * ## 断言的五条硬性质（离线 spec 无法证明、必须在真库上闭环的）
 * 1. **schema 由仓库真实迁移建立**：`audit_logs` 的列清单与 `POSTGRES_AUDIT_COLUMNS` 逐一致
 *    （迁移不许多列、也不许少列），主键是 `id`，归属取数路径有 `(actor_user_id, …)` 索引；
 * 2. **追加 / 按主体取数闭环**：字段（含可选 `resource_id` 的空 / 非空）原样往返，顺序是
 *    `occurred_at ASC, id ASC`；他人事件与仅管理端可见的事件**既不出库也不可探测**；
 * 3. **主键冲突不得静默覆盖**：同 ID 再写被判 `CONFLICT`，且库里那一行逐字段不变；
 * 4. **存储层仅追加**：绕过 adapter 直接对 `audit_logs` 执行改写 / 删除 / 整表截断都被
 *    **触发器**拒绝（`55000`），被拒后行仍在且内容不变 —— 「审计不可删除」不只是 adapter 缺方法；
 * 5. **敏感内容不落库**：摘要含连接串 / SQL 语句片段 / 身份证号的事件在写路径就被拒绝，
 *    库里查不到对应主键的行；非 UUID 主体在进入 SQL 之前被拒绝。
 *
 * ## 为什么不需要清理行
 * 审计表是**只追加**的（第 4 条正是证明这一点），因此本套件按「每次运行使用随机 UUID 主体」
 * 隔离：断言都限定在自己写入的主体上，既不需要、也不允许 `DELETE` 自己的行。
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
  describe('真实 PostgreSQL 审计集成（未启用）', () => {
    it.skip(`未启用：${describeState()}（需要 WSL2 Docker Compose 中的开发库，见 README）`, () => {
      expect.unreachable(
        'reachable only when TEST_DATABASE_URL (or a test DATABASE_URL) is configured',
      );
    });
  });
}

const integrationDescribe = ENABLED ? describe : describe.skip;

let connection: SqlConnection | undefined;

/** 每次运行使用随机主体：审计表只追加，不清理行，因此测试之间用归属隔离 */
function newOwner(): string {
  return randomUUID();
}

function eventFor(actorUserId: string, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: randomUUID(),
    actorUserId,
    type: AuditEventType.SelfAuditEventsRead,
    result: AuditResult.Success,
    resourceType: AuditResourceType.AuditEvent,
    summary: '读取本人审计事件摘要',
    selfVisible: true,
    requestId: randomUUID(),
    ipHash: 'a'.repeat(64),
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

function repository(): PostgresAuditRepository {
  return new PostgresAuditRepository(connection as SqlConnection);
}

async function query<T = Record<string, unknown>>(
  sql: string,
  parameters?: readonly unknown[],
): Promise<readonly T[]> {
  const result = await (connection as SqlConnection).query<T>(sql, parameters);
  return result.rows;
}

integrationDescribe('真实 PostgreSQL 审计集成（TEST_DATABASE_URL / 测试库 DATABASE_URL）', () => {
  beforeAll(async () => {
    if (!ENABLED || RAW_URL === undefined) {
      return;
    }
    const resolution = resolveDatabaseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: RAW_URL,
      DATABASE_APPLICATION_NAME: 'researcher-manager-audit-integration',
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
      appliedBy: 'audit-integration-test',
    });
    if (applied.guard.violations.length > 0) {
      throw new Error('测试前置失败：真实迁移未通过部署守卫');
    }
  }, 90_000);

  afterAll(async () => {
    if (connection !== undefined) {
      await connection.close();
    }
  });

  it('audit_logs 由迁移 0009 建立：列清单与 adapter 常量逐一致、主键是 id、归属索引与仅追加触发器齐备', async () => {
    const exists = await query<{ exists: boolean }>(
      'SELECT to_regclass($1::text) IS NOT NULL AS exists',
      [`public.${POSTGRES_AUDIT_TABLE}`],
    );
    expect(exists[0]?.exists).toBe(true);

    const columns = await query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', POSTGRES_AUDIT_TABLE],
    );
    // 双向一致：迁移不许多列，也不许少列（adapter 用显式列清单，多出的列会被严格行契约拒绝）
    expect(columns.map((row) => row.column_name).sort()).toEqual(
      [...POSTGRES_AUDIT_COLUMNS].sort(),
    );

    const primaryKey = await query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'public.audit_logs'::regclass AND i.indisprimary`,
    );
    expect(primaryKey.map((row) => row.column_name)).toEqual(['id']);

    // 本人审计摘要的取数路径（WHERE actor_user_id = $1 AND self_visible ORDER BY occurred_at, id）
    // 必须有索引支撑
    const indexes = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
      [POSTGRES_AUDIT_TABLE],
    );
    expect(
      indexes.some((row) =>
        /\(actor_user_id,\s*self_visible,\s*occurred_at,\s*id\)/u.test(row.indexdef),
      ),
    ).toBe(true);

    // 存储层仅追加：改写 / 删除（行级）与整表截断（语句级）各有一个触发器
    const triggers = await query<{ tgname: string; tgtype: number }>(
      `SELECT tgname, tgtype FROM pg_trigger WHERE tgrelid = 'public.audit_logs'::regclass AND NOT tgisinternal`,
    );
    const names = triggers.map((row) => row.tgname);
    expect(names).toContain('audit_logs_append_only_row');
    expect(names).toContain('audit_logs_append_only_statement');
  }, 60_000);

  it('追加 / 按主体取数在真实库闭环：字段原样往返、稳定排序、他人与仅管理端可见的事件不出库', async () => {
    const owner = newOwner();
    const other = newOwner();
    const repositoryUnderTest = repository();

    const resourceBound = eventFor(owner, {
      type: AuditEventType.MembershipApply,
      resourceType: AuditResourceType.Membership,
      resourceId: randomUUID(),
      occurredAt: '2026-06-01T00:00:00.000Z',
    });
    const withoutResource = eventFor(owner, {
      type: AuditEventType.ProfileSelfUpdate,
      resourceType: AuditResourceType.StudentProfile,
      occurredAt: '2026-06-01T00:00:01.000Z',
    });
    const adminOnly = eventFor(owner, {
      type: AuditEventType.MembershipReview,
      resourceType: AuditResourceType.Membership,
      selfVisible: false,
      occurredAt: '2026-06-01T00:00:02.000Z',
    });
    const foreign = eventFor(other, { occurredAt: '2026-06-01T00:00:03.000Z' });

    // 写入：返回值必须与写入记录逐字段等价（含可选 resource_id 的非空 / 缺省两条路径）
    await expect(repositoryUnderTest.append(resourceBound)).resolves.toEqual(resourceBound);
    await expect(repositoryUnderTest.append(withoutResource)).resolves.toEqual(withoutResource);
    await expect(repositoryUnderTest.append(adminOnly)).resolves.toEqual(adminOnly);
    await expect(repositoryUnderTest.append(foreign)).resolves.toEqual(foreign);

    // 取数：只出「本人 且 本人可见」的两条，顺序为 occurred_at ASC, id ASC
    const mine = await repositoryUnderTest.listVisibleByActor(owner);
    expect(mine.map((item) => item.id)).toEqual([resourceBound.id, withoutResource.id]);
    expect(mine[0]).toEqual(resourceBound);
    expect(mine[1]).toEqual(withoutResource);
    expect(JSON.stringify(mine)).not.toContain(adminOnly.id);

    // 归属下推进 SQL：他人那行与仅管理端可见那行**在库里存在**（不是写入失败被吞掉）
    const stored = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM audit_logs WHERE actor_user_id = $1::uuid',
      [owner],
    );
    expect(stored[0]?.count).toBe(3);

    // 他人主体读不到本人的行，本人也读不到他人的行
    const otherRows = await repositoryUnderTest.listVisibleByActor(other);
    expect(otherRows.map((item) => item.id)).toEqual([foreign.id]);
  }, 60_000);

  it('主键冲突不得静默覆盖：同 ID 再写判 CONFLICT，库里那一行逐字段不变', async () => {
    const owner = newOwner();
    const repositoryUnderTest = repository();
    const original = eventFor(owner, { summary: '原始审计摘要' });

    await expect(repositoryUnderTest.append(original)).resolves.toEqual(original);

    const conflicting = eventFor(owner, { id: original.id, summary: '被覆盖的审计摘要' });
    await expect(repositoryUnderTest.append(conflicting)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const rows = await query<{ summary: string; actor_user_id: string }>(
      'SELECT summary, actor_user_id FROM audit_logs WHERE id = $1::uuid',
      [original.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe('原始审计摘要');
    expect(rows[0]?.actor_user_id).toBe(owner);
  }, 60_000);

  it('存储层仅追加：业务侧改写 / 删除 / 整表截断都被触发器拒绝，被拒后行仍在且内容不变', async () => {
    const owner = newOwner();
    const repositoryUnderTest = repository();
    const record = eventFor(owner, { summary: '仅追加验证' });
    await repositoryUnderTest.append(record);

    // 改写：触发器以 55000 拒绝（object_not_in_prerequisite_state）
    await (connection as SqlConnection)
      .query('UPDATE audit_logs SET summary = $1 WHERE id = $2::uuid', ['被改写', record.id])
      .then(
        () => {
          throw new Error('存储层没有拒绝业务侧改写：仅追加触发器失效');
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(PostgresExecutorError);
          expect((error as PostgresExecutorError).issues[0]?.code).toBe('55000');
        },
      );

    // 删除：同样被拒绝
    await (connection as SqlConnection)
      .query('DELETE FROM audit_logs WHERE id = $1::uuid', [record.id])
      .then(
        () => {
          throw new Error('存储层没有拒绝业务侧删除：仅追加触发器失效');
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(PostgresExecutorError);
          expect((error as PostgresExecutorError).issues[0]?.code).toBe('55000');
        },
      );

    // 整表截断：语句级触发器拒绝（不只是行级）
    await (connection as SqlConnection).query('TRUNCATE audit_logs').then(
      () => {
        throw new Error('存储层没有拒绝整表截断：语句级仅追加触发器失效');
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(PostgresExecutorError);
        expect((error as PostgresExecutorError).issues[0]?.code).toBe('55000');
      },
    );

    // 三次拒绝之后：行仍在、摘要仍是原值（不是「抛错但已经改写」）
    const rows = await query<{ summary: string }>(
      'SELECT summary FROM audit_logs WHERE id = $1::uuid',
      [record.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe('仅追加验证');
  }, 60_000);

  it('存储 ID 域与敏感内容：非 UUID 主体 / 连接串与 SQL 摘要在写路径就被拒绝，库里不产生任何行', async () => {
    const owner = newOwner();
    const repositoryUnderTest = repository();

    // 非 UUID 主体（会话基线形状）：进入 SQL 之前即拒绝
    const nonUuid = eventFor('u-student-1');
    await expect(repositoryUnderTest.append(nonUuid)).rejects.toMatchObject({
      code: 'INVALID_RECORD',
    });
    // 空 UUID 主体同样不是可用主体
    await expect(
      repositoryUnderTest.listVisibleByActor('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });

    // 敏感内容（连接串 / SQL 语句片段 / 身份证号）：写路径拒绝，且**一个 SQL 都不执行**
    const hostileSummaries = [
      'postgresql://rm:secret@127.0.0.1:55432/researcher_manager_test',
      'SELECT summary FROM audit_logs WHERE actor_user_id = $1',
      '证件 11010119900307123X 待核对',
    ];
    for (const summary of hostileSummaries) {
      await expect(repositoryUnderTest.append(eventFor(owner, { summary }))).rejects.toMatchObject({
        code: 'INVALID_RECORD',
      });
    }

    // 库里既没有非 UUID 归属的行，也没有本次尝试的任何行
    const stray = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM audit_logs WHERE id = ANY($1::uuid[])',
      [[nonUuid.id]],
    );
    expect(stray[0]?.count).toBe(0);
    const ownerRows = await repositoryUnderTest.listVisibleByActor(owner);
    expect(ownerRows).toEqual([]);

    // 合法写入仍然成功（证明上面的拒绝来自校验，而不是「谁都写不进去」）
    const legal = eventFor(owner);
    await expect(repositoryUnderTest.append(legal)).resolves.toEqual(legal);
  }, 60_000);

  it('模块换绑工厂 + 真实执行器：审计端口直连真实库闭环，主体域先判（非法主体不建连）', async () => {
    const { createAuditRepository } = await import('../../../modules/audit/audit.module');
    const owner = newOwner();

    let connects = 0;
    const port = createAuditRepository(loadEnv({ NODE_ENV: 'test', DATABASE_URL: RAW_URL }), {
      capabilities: { backend: 'postgres', persistent: true, productionReady: false },
      connect: () => {
        connects += 1;
        return Promise.resolve(connection as SqlConnection);
      },
    });

    // 装配阶段不建连；非 UUID 主体在解析执行器之前就被拒绝，因此仍然没有建连
    expect(connects).toBe(0);
    await expect(port.listVisibleByActor('u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    expect(connects).toBe(0);

    // 合法主体：建连一次并被复用，真实库上追加 / 读取闭环
    const record = eventFor(owner, { summary: '换绑工厂真库验证' });
    await expect(port.append(record)).resolves.toEqual(record);
    await expect(port.listVisibleByActor(owner)).resolves.toEqual([record]);
    expect(connects).toBe(1);
  }, 60_000);
});
