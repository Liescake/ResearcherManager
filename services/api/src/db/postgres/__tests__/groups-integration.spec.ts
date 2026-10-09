import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GroupStatus, isGroupApplicable } from '@rm/shared';
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
  POSTGRES_GROUP_COLUMNS,
  POSTGRES_GROUP_INTERNAL_COLUMNS,
  POSTGRES_GROUP_TABLE,
  PostgresGroupRepository,
} from '../../../modules/groups/groups.postgres-repository';
import type { GroupVisibilityQuery, ResearchGroup } from '../../../modules/groups/groups.port';

/**
 * 科研小组的**真实 PostgreSQL 集成**（WSL2 / Docker Compose 提供的开发库）。
 *
 * ## 为什么必须显式启用
 * 未提供 `TEST_DATABASE_URL`（或库名含 `test` 的 `DATABASE_URL`）时整个套件**明确 skip**，
 * 绝不伪造通过；提供了但连不上、或目标库名不含 `test` 时**失败**（本套件执行迁移与 DDL）。
 * 与 `postgres-integration.spec.ts` / `audit-integration.spec.ts` /
 * `notifications-integration.spec.ts` / `application-reviews-integration.spec.ts` 同一套启用口径。
 *
 * ## 断言的硬性质（离线 spec 无法证明、必须在真库上闭环的）
 * 1. **schema 由仓库真实迁移建立**：`research_groups` 的列清单与 `POSTGRES_GROUP_COLUMNS`（输出列）
 *    + `POSTGRES_GROUP_INTERNAL_COLUMNS`（内部列）**双向一致**（迁移不许多列、也不许少列），
 *    主键是 `id`，有效期内小组名唯一（部分唯一索引），列表取数路径有
 *    `(created_at, id) WHERE status='open' AND deleted_at IS NULL` 索引，状态闭集与
 *    「主键/负责人非空 UUID」在存储层有 CHECK 镜像；
 * 2. **写读闭环**：字段（含可选 `description` 的空 / 非空）原样往返，顺序是
 *    `created_at ASC, id ASC`，分页窗口由 `LIMIT/OFFSET` 下推，`total` 不受窗口影响；
 * 3. **范围与归属隔离**：资源级可见只出判定范围内的小组；软删除行与暂停/关闭小组都不出库；
 *    `includeAllOpenGroups=false` 且范围为空时**不会放大**成「全部小组」；
 * 4. **主键冲突不得静默覆盖**：同 ID 再写被判 `CONFLICT`，且库里那一行逐字段不变；
 * 5. **绕过应用层也写不坏**：直接对 `research_groups` 执行非法状态 / 空研究方向 / 空负责人 UUID /
 *    空 UUID 主键 / 空白名称的 INSERT 都被 CHECK 拒绝（23514），重名被唯一索引拒绝（23505）；
 * 6. **存储 ID 域在进 SQL 之前判定**：非 UUID 的可见 ID / 非 UUID 的负责人 fail-closed，且
 *    **一次数据库连接都不建立**（`createGroupRepository` 的延迟建连路径已由 binding spec 覆盖，
 *    这里在真库上复核同一性质）。
 *
 * ## 为什么需要清理行
 * 与只追加的审计表不同，小组表是可变的业务表（且有效期内小组名唯一），因此本套件在 `afterAll`
 * 里按**本次运行写入的主键集合**清理，保证重复运行不会把上一次的行当成夹具。
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
  describe('真实 PostgreSQL 小组集成（未启用）', () => {
    it.skip(`未启用：${describeState()}（需要 WSL2 Docker Compose 中的开发库，见 README）`, () => {
      expect.unreachable(
        'reachable only when TEST_DATABASE_URL (or a test DATABASE_URL) is configured',
      );
    });
  });
}

const integrationDescribe = ENABLED ? describe : describe.skip;

const OPEN_QUERY: GroupVisibilityQuery = { includeAllOpenGroups: true, visibleGroupIds: [] };

let connection: SqlConnection | undefined;

/** 本次运行写入的主键集合：用于 `afterAll` 精确清理（小组表可变，不清会污染后续断言） */
const createdIds = new Set<string>();
/** 本次运行使用过的小组名：保证有效期内名称唯一，避免与历史运行冲突 */
function newName(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

function newGroup(overrides: Partial<ResearchGroup> = {}): ResearchGroup {
  const id = overrides.id ?? randomUUID();
  createdIds.add(id);
  const now = new Date().toISOString();
  return {
    id,
    name: newName('集成小组'),
    description: '面向校内竞赛的机器人方向小组',
    researchDirections: ['机器人', '嵌入式'],
    recruitmentRequirements: { skills: ['C++'], grades: ['sophomore'], headcount: 4 },
    leaderUserId: randomUUID(),
    status: GroupStatus.Open,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function repository(): PostgresGroupRepository {
  return new PostgresGroupRepository(connection as SqlConnection);
}

async function query<T = Record<string, unknown>>(
  sql: string,
  parameters?: readonly unknown[],
): Promise<readonly T[]> {
  const result = await (connection as SqlConnection).query<T>(sql, parameters);
  return result.rows;
}

integrationDescribe('真实 PostgreSQL 小组集成（TEST_DATABASE_URL / 测试库 DATABASE_URL）', () => {
  beforeAll(async () => {
    if (!ENABLED || RAW_URL === undefined) {
      return;
    }
    const resolution = resolveDatabaseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: RAW_URL,
      DATABASE_APPLICATION_NAME: 'researcher-manager-groups-integration',
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
      appliedBy: 'groups-integration-test',
    });
    if (applied.guard.violations.length > 0) {
      throw new Error('测试前置失败：真实迁移未通过部署守卫');
    }
  }, 90_000);

  afterAll(async () => {
    if (connection !== undefined && createdIds.size > 0) {
      // 只清理本次运行写入的主键：不触碰其它数据，也不做整表截断
      await connection.query('DELETE FROM research_groups WHERE id = ANY($1::uuid[])', [
        [...createdIds],
      ]);
      await connection.close();
    }
  });

  it('research_groups 由迁移 0011 建立：列清单 = 输出列 + 内部列、主键是 id、唯一名与取数索引、存储层 CHECK 齐备', async () => {
    const exists = await query<{ exists: boolean }>(
      'SELECT to_regclass($1::text) IS NOT NULL AS exists',
      [`public.${POSTGRES_GROUP_TABLE}`],
    );
    expect(exists[0]?.exists).toBe(true);

    const columns = await query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', POSTGRES_GROUP_TABLE],
    );
    // 双向一致：迁移不许多列，也不许少列
    // （adapter 用显式输出列清单，多出的列会被严格行契约拒绝；内部列不得流进领域对象）
    expect(columns.map((row) => row.column_name).sort()).toEqual(
      [...POSTGRES_GROUP_COLUMNS, ...POSTGRES_GROUP_INTERNAL_COLUMNS].sort(),
    );
    // 内部列与输出列必须真的不相交（否则「内部」这个概念就是自欺）
    for (const internal of POSTGRES_GROUP_INTERNAL_COLUMNS) {
      expect(POSTGRES_GROUP_COLUMNS as readonly string[]).not.toContain(internal);
    }

    const primaryKey = await query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'public.research_groups'::regclass AND i.indisprimary`,
    );
    expect(primaryKey.map((row) => row.column_name)).toEqual(['id']);

    const indexes = await query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
      [POSTGRES_GROUP_TABLE],
    );
    // 有效期内小组名唯一：部分唯一索引把软删除行排除在唯一性之外
    const uniqueName = indexes.find((row) => row.indexname === 'uq_research_groups_name_active');
    expect(uniqueName?.indexdef).toMatch(/UNIQUE/iu);
    expect(uniqueName?.indexdef).toMatch(/deleted_at IS NULL/iu);
    // 列表取数路径（过滤 + 排序 + 窗口）必须有索引支撑
    // 注意：PostgreSQL 会重写谓词文本（`status = 'open'` 变成 `((status)::text = 'open'::text)`），
    // 因此这里按「列出现」而不是按原始 SQL 文本匹配。
    const openCreated = indexes.find(
      (row) => row.indexname === 'idx_research_groups_open_created_at',
    );
    expect(openCreated?.indexdef).toMatch(/\(created_at,\s*id\)/u);
    expect(openCreated?.indexdef).toMatch(/status/iu);
    expect(openCreated?.indexdef).toMatch(/'open'/u);
    expect(openCreated?.indexdef).toMatch(/deleted_at IS NULL/iu);

    // 存储层 CHECK 镜像 adapter 契约：状态闭集、方向非空、名称与描述长度、非空 UUID
    const constraints = await query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.research_groups'::regclass AND contype = 'c'`,
    );
    const names = constraints.map((row) => row.conname);
    for (const expected of [
      'research_groups_status_check',
      'research_groups_name_not_blank',
      'research_groups_description_length',
      'research_groups_directions_not_empty',
      'research_groups_id_not_nil',
      'research_groups_leader_user_id_not_nil',
    ]) {
      expect(names).toContain(expected);
    }
  }, 60_000);

  it('创建 / 分页浏览在真实库闭环：字段原样往返、稳定排序、窗口下推、total 不受窗口影响', async () => {
    const underTest = repository();
    const base = Date.parse('2026-07-01T00:00:00.000Z');

    const first = newGroup({ createdAt: new Date(base).toISOString() });
    const second = newGroup({
      createdAt: new Date(base + 1000).toISOString(),
      description: undefined,
      recruitmentRequirements: { headcount: 2 },
      researchDirections: ['嵌入式'],
    });
    const paused = newGroup({
      status: GroupStatus.Paused,
      createdAt: new Date(base + 2000).toISOString(),
    });
    const closed = newGroup({
      status: GroupStatus.Closed,
      createdAt: new Date(base + 3000).toISOString(),
    });
    const softDeleted = newGroup({ createdAt: new Date(base + 4000).toISOString() });

    for (const record of [first, second, paused, closed, softDeleted]) {
      await expect(underTest.create(record)).resolves.toEqual(record);
    }
    // 软删除只能由存储层置位（本切片没有删除端点）：直接改标记以证明可见性谓词真的生效
    await query('UPDATE research_groups SET deleted_at = now() WHERE id = $1::uuid', [
      softDeleted.id,
    ]);

    // created_at ASC, id ASC：本次运行写入的开放小组按创建顺序出现在结果里
    const listed = await underTest.listVisibleGroups(OPEN_QUERY, { offset: 0, limit: 100 });
    const mine = listed.filter((record) => createdIds.has(record.id));
    expect(mine.map((record) => record.id)).toEqual([first.id, second.id]);
    expect(mine[0]).toEqual(first);
    expect(mine[1]).toEqual(second);
    // 可选 description 的「有 / 无」两条路径都原样往返
    expect(mine[0]?.description).toBe(first.description);
    expect(mine[1]?.description).toBeUndefined();
    // 暂停 / 关闭 / 软删除的小组一个都不出库
    const text = JSON.stringify(listed);
    for (const hidden of [paused, closed, softDeleted]) {
      expect(text).not.toContain(hidden.id);
      expect(text).not.toContain(hidden.name);
    }
    // 共享谓词与 adapter 的可见性口径一致
    expect(isGroupApplicable(GroupStatus.Open)).toBe(true);
    expect(isGroupApplicable(GroupStatus.Paused)).toBe(false);

    // 窗口下推：只取第二页，但 total（计数）不受窗口影响
    const pageTwo = await underTest.listVisibleGroups(OPEN_QUERY, { offset: 1, limit: 1 });
    const pageTwoMine = pageTwo.filter((record) => createdIds.has(record.id));
    expect(pageTwoMine.map((record) => record.id)).toEqual([second.id]);
    const total = await underTest.countVisibleGroups(OPEN_QUERY);
    expect(total).toBeGreaterThanOrEqual(2);
    const all = await underTest.listVisibleGroups(OPEN_QUERY, { offset: 0, limit: 100 });
    expect(total).toBe(all.length);

    // 超出末尾的窗口返回空页（不报错、不回退成第一页）
    await expect(
      underTest.listVisibleGroups(OPEN_QUERY, { offset: 100_000, limit: 20 }),
    ).resolves.toEqual([]);
  }, 60_000);

  it('范围隔离：资源级可见只出判定范围内的小组，空范围不会放大成「全部小组」', async () => {
    const underTest = repository();
    const mine = newGroup();
    const foreign = newGroup();
    await underTest.create(mine);
    await underTest.create(foreign);

    const scoped = await underTest.listVisibleGroups(
      { includeAllOpenGroups: false, visibleGroupIds: [mine.id] },
      { offset: 0, limit: 100 },
    );
    expect(scoped.map((record) => record.id)).toEqual([mine.id]);
    expect(JSON.stringify(scoped)).not.toContain(foreign.id);
    expect(JSON.stringify(scoped)).not.toContain(foreign.name);
    // 计数与列表共用同一套谓词，因此 total 也不会泄露范围外的小组
    await expect(
      underTest.countVisibleGroups({ includeAllOpenGroups: false, visibleGroupIds: [mine.id] }),
    ).resolves.toBe(1);

    // 空范围（服务端判定一个候选都没通过时 service 已 403；端口层必须同样不放大）
    const empty = await underTest.listVisibleGroups(
      { includeAllOpenGroups: false, visibleGroupIds: [] },
      { offset: 0, limit: 100 },
    );
    expect(empty).toEqual([]);
    await expect(
      underTest.countVisibleGroups({ includeAllOpenGroups: false, visibleGroupIds: [] }),
    ).resolves.toBe(0);
  }, 60_000);

  it('主键冲突不得静默覆盖：同 ID 再写判 CONFLICT，库里那一行逐字段不变', async () => {
    const underTest = repository();
    const original = newGroup();
    await expect(underTest.create(original)).resolves.toEqual(original);

    const conflicting = newGroup({ id: original.id, description: '试图覆盖的描述' });
    await expect(underTest.create(conflicting)).rejects.toMatchObject({ code: 'CONFLICT' });

    const rows = await query<{ name: string; leader_user_id: string; description: string | null }>(
      'SELECT name, leader_user_id, description FROM research_groups WHERE id = $1::uuid',
      [original.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe(original.name);
    expect(rows[0]?.leader_user_id).toBe(original.leaderUserId);
    expect(rows[0]?.description).toBe(original.description ?? null);
  }, 60_000);

  it('存储 ID 域在进 SQL 之前判定：非 UUID 的可见 ID / 负责人 fail-closed，且不产生任何行', async () => {
    const underTest = repository();
    const owner = randomUUID();

    // 可见 ID 不是存储 ID 域内的标识 ⇒ 连 SQL 都不生成（否则 uuid[] 转换会失败或退化为放弃类型约束）
    await expect(
      underTest.listVisibleGroups(
        { includeAllOpenGroups: false, visibleGroupIds: ['g-1'] },
        { offset: 0, limit: 20 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(
      underTest.countVisibleGroups({ includeAllOpenGroups: false, visibleGroupIds: ['g-1'] }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });

    // 负责人不是可用 UUID ⇒ 写路径直接拒绝
    await expect(underTest.create(newGroup({ leaderUserId: 'u-student-1' }))).rejects.toMatchObject(
      { code: 'INVALID_RECORD' },
    );
    await expect(
      underTest.create(newGroup({ leaderUserId: '00000000-0000-0000-0000-000000000000' })),
    ).rejects.toMatchObject({ code: 'INVALID_RECORD' });

    // 未被契约登记的记录形状（带未登记字段）同样拒绝
    await expect(
      underTest.create({ ...newGroup(), deletedAt: '2026-01-01T00:00:00.000Z' } as never),
    ).rejects.toMatchObject({ code: 'INVALID_RECORD' });

    const rows = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM research_groups WHERE leader_user_id = $1::uuid',
      [owner],
    );
    expect(rows[0]?.count).toBe(0);

    // 合法记录仍然写得进去（证明上面的拒绝来自校验，而不是「谁都写不进去」）
    const legal = newGroup({ leaderUserId: owner });
    await expect(underTest.create(legal)).resolves.toEqual(legal);
  }, 60_000);

  it('绕过应用层也写不坏：非法状态 / 空方向 / 空负责人 / 空 UUID 主键 / 空白名称都被 CHECK 拒绝，重名被唯一索引拒绝', async () => {
    const existing = newGroup();
    await repository().create(existing);

    const run = (sql: string, parameters: readonly unknown[]): Promise<unknown> =>
      (connection as SqlConnection).query(sql, parameters).then(
        () => {
          throw new Error('存储层没有拒绝违规写入：CHECK 约束失效');
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(PostgresExecutorError);
          return (error as PostgresExecutorError).issues[0]?.code;
        },
      );

    const insertSql = `INSERT INTO research_groups
      (id, name, description, research_directions, recruitment_requirements, leader_user_id, status, created_at, updated_at)
      VALUES ($1::uuid, $2, $3, $4::text[], $5::jsonb, $6::uuid, $7, now(), now())`;
    const owner = randomUUID();
    const requirements = JSON.stringify({ headcount: 3 });
    const id = (): string => randomUUID();

    // 未登记状态取值
    expect(
      await run(insertSql, [
        id(),
        newName('非法状态'),
        null,
        ['机器人'],
        requirements,
        owner,
        'archived',
      ]),
    ).toBe('23514');
    // 研究方向为空数组
    expect(
      await run(insertSql, [id(), newName('空方向'), null, [], requirements, owner, 'open']),
    ).toBe('23514');
    // 空白名称
    expect(await run(insertSql, [id(), '   ', null, ['机器人'], requirements, owner, 'open'])).toBe(
      '23514',
    );
    // 空 UUID 主键
    expect(
      await run(insertSql, [
        '00000000-0000-0000-0000-000000000000',
        newName('空主键'),
        null,
        ['机器人'],
        requirements,
        owner,
        'open',
      ]),
    ).toBe('23514');
    // 空 UUID 负责人
    expect(
      await run(insertSql, [
        id(),
        newName('空负责人'),
        null,
        ['机器人'],
        requirements,
        '00000000-0000-0000-0000-000000000000',
        'open',
      ]),
    ).toBe('23514');
    // 有效期内重名（部分唯一索引）
    expect(
      await run(insertSql, [id(), existing.name, null, ['机器人'], requirements, owner, 'open']),
    ).toBe('23505');

    // 六类违规一行都没落库（除了那条合法夹具）
    const rows = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM research_groups WHERE name LIKE $1',
      ['非法状态-%'],
    );
    expect(rows[0]?.count).toBe(0);
    const stored = await query<{ name: string }>(
      'SELECT name FROM research_groups WHERE id = $1::uuid',
      [existing.id],
    );
    expect(stored.map((row) => row.name)).toEqual([existing.name]);
  }, 60_000);

  it('模块换绑工厂 + 真实执行器：小组端口直连真实库闭环，存储 ID 域先判（非法范围不建连）', async () => {
    const { createGroupRepository } = await import('../../../modules/groups/groups.module');
    const owner = randomUUID();

    let connects = 0;
    const port = createGroupRepository(loadEnv({ NODE_ENV: 'test', DATABASE_URL: RAW_URL }), {
      capabilities: { backend: 'postgres', persistent: true, productionReady: false },
      connect: () => {
        connects += 1;
        return Promise.resolve(connection as SqlConnection);
      },
    });

    // 装配阶段不建连；非 UUID 的可见资源标识在解析执行器之前就被拒绝，因此仍然没有建连
    expect(connects).toBe(0);
    await expect(
      port.listVisibleGroups(
        { includeAllOpenGroups: false, visibleGroupIds: ['g-1'] },
        { offset: 0, limit: 20 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(connects).toBe(0);

    // 合法请求：建连一次并被复用，真实库上创建 / 取数 / 计数闭环
    const record = newGroup({ leaderUserId: owner });
    await expect(port.create(record)).resolves.toEqual(record);
    const listed = await port.listVisibleGroups(
      { includeAllOpenGroups: false, visibleGroupIds: [record.id] },
      { offset: 0, limit: 20 },
    );
    expect(listed.map((item) => item.id)).toEqual([record.id]);
    await expect(
      port.countVisibleGroups({ includeAllOpenGroups: false, visibleGroupIds: [record.id] }),
    ).resolves.toBe(1);
    expect(connects).toBe(1);
  }, 60_000);
});
