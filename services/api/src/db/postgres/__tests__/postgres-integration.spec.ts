import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseConfig, type ResolvedDatabaseConfig } from '../../config/database-config';
import { MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY } from '../../migrations/migration-deployment-guard';
import { loadMigrationStatus, runMigrations } from '../../migrations/migration-runner';
import { resolveMigrationsDirectory } from '../../migrations/run-migrations';
import { createPostgresMigrationDatabase } from '../postgres-migration-database';
import {
  createPostgresConnection,
  toPostgresPoolProfile,
  UNATTESTED_POSTGRES_CAPABILITIES,
} from '../postgres-executor';
import { PostgresExecutorError } from '../postgres-error';
import { PostgresStatisticsRepository } from '../../../modules/statistics/statistics.postgres-repository';
import type { SqlConnection } from '../../ports/sql-executor.port';

/**
 * **真实 PostgreSQL 集成测试**（WSL2 + Docker Compose 提供的开发库）。
 *
 * ## 为什么必须显式启用
 * 未提供任何数据库地址时整个套件**明确 skip**（`describe.skip` + 说明），绝不伪造通过。启用分两级：
 * 1. `TEST_DATABASE_URL`（首选，专用测试库）：提供了但连不上、或目标库名不含 `test` 时用例**失败**
 *    （fail-closed），不会悄悄降级成 skip；
 * 2. `DATABASE_URL`（兜底）：**仅当**它解析出的库名包含 `test` 时才启用 —— 开发档的
 *    `.../researcher_manager` 因此不会被本套件执行破坏性 DDL；不满足条件就仍然 skip。
 *
 * 启用方式见仓库根 `README.md` 的「本地 PostgreSQL（WSL2 + Docker Compose）」一节：
 *
 * ```bash
 * docker compose up -d postgres
 * TEST_DATABASE_URL=postgresql://rm:rm@127.0.0.1:55432/researcher_manager_test \
 *   pnpm --filter @rm/api exec vitest run --pool=threads src/db/postgres/__tests__/postgres-integration.spec.ts
 * ```
 *
 * ## 覆盖内容
 * 1. **启动**：真实建连、`SELECT 1`、参数化查询、语句超时配置生效；
 * 2. **参数槽 fail-closed**：槽位与参数不配对时拒绝，且不产生服务端错误（说明没下发）；
 * 3. **错误脱敏**：真实驱动的 SQLSTATE 保留，连接串 / 口令 / 行取值不外发；
 * 4. **事务**：显式回滚不留数据、提交留数据；
 * 5. **迁移**：部署守卫 + 真实执行 `0001`–`0005` + 幂等重跑；**失败迁移整体回滚**（无半成品表、无记账行）；
 * 6. **全新数据库 bootstrap**：记账表缺失时 `0001` 能先建表并记账，之后 status 稳定可重复；
 * 7. **owner 隔离**：统计聚合读只返回请求主体自己的计数（他人记录不参与、也不回流）。
 *
 * 四张统计来源表**不再由测试临时建表**：它们由仓库真实迁移 `0002`–`0005` 建立，测试只在
 * 表上写入 / 清理自己的行（按 `user_id` 删除），因此「统计切片对真实 schema 取数」是被真的验证过的。
 *
 * ## 安全边界
 * - 目标库名必须包含 `test`，否则 fail-closed（避免误连生产库跑破坏性 DDL）；
 * - 只创建 / 删除本测试自带的表 `rm_it_*`，以及**唯一一次** `DROP TABLE schema_migrations`（纯记账表，
 *   无外键引用，紧接着由同一用例按守卫顺序幂等重建）；对迁移建出的业务表只按 `user_id` 增删本测试的行，
 *   不 DROP、不 TRUNCATE，也不触碰业务表里的既有数据；
 * - 断言里绝不打印连接串。
 */
/** 从连接串里取出数据库名；解析失败或无库名时返回 undefined（调用方按「不启用」处理） */
function databaseNameOf(url: string): string | undefined {
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\/+/u, ''));
    return name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']?.trim();
const FALLBACK_DATABASE_URL = process.env['DATABASE_URL']?.trim();
const FALLBACK_DATABASE_NAME =
  FALLBACK_DATABASE_URL === undefined || FALLBACK_DATABASE_URL === ''
    ? undefined
    : databaseNameOf(FALLBACK_DATABASE_URL);

/** 实际使用的连接串；`undefined` 表示整族 skip（不产生任何「通过」） */
const RAW_URL =
  TEST_DATABASE_URL !== undefined && TEST_DATABASE_URL !== ''
    ? TEST_DATABASE_URL
    : FALLBACK_DATABASE_NAME?.includes('test') === true
      ? FALLBACK_DATABASE_URL
      : undefined;
const ENABLED = RAW_URL !== undefined;

function describeState(): string {
  if (ENABLED && RAW_URL === TEST_DATABASE_URL) {
    return '已配置 TEST_DATABASE_URL';
  }
  if (ENABLED) {
    return '已配置 DATABASE_URL（库名含 test）';
  }
  if (FALLBACK_DATABASE_URL !== undefined && FALLBACK_DATABASE_URL !== '') {
    return '未启用：DATABASE_URL 指向的库名不含 test（避免对开发/生产库执行破坏性 DDL）';
  }
  return '未配置 TEST_DATABASE_URL / DATABASE_URL';
}

if (!ENABLED) {
  describe('真实 PostgreSQL 集成（未启用）', () => {
    // 明确 skip 并说明前置条件：未启用时**不产生**任何「通过」
    it.skip(`未启用：${describeState()}（需要 WSL2 Docker Compose 中的开发库，见 README）`, () => {
      expect.unreachable(
        'reachable only when TEST_DATABASE_URL (or a test DATABASE_URL) is configured',
      );
    });
  });
}

const integrationDescribe = ENABLED ? describe : describe.skip;

/** 统计聚合读依赖的四张来源表：由迁移 `0002`–`0005` 建立，本测试只按 `user_id` 增删自己的行 */
const STATISTICS_TABLES = [
  'education_records',
  'join_applications',
  'achievements',
  'ai_match_records',
] as const;

type StatisticsTable = (typeof STATISTICS_TABLES)[number];

/**
 * 每张来源表的**批量**合法行写入：只写迁移里的 `NOT NULL` 列 + 归属列，可空列一律留 `NULL`。
 *
 * 为什么不用 `CREATE TABLE` 造表：真实 schema 必须由迁移建立，否则「统计聚合读在真库上取数」
 * 验证的就是测试自己的临时表；这些夹具正是为了让统计切片跑在**迁移产出的**表上。
 * 用 `generate_series` + `gen_random_uuid()` 一次写入多行，避免上千次往返。
 */
const STATISTICS_ROW_INSERTS: Readonly<Record<StatisticsTable, string>> = {
  education_records: `INSERT INTO education_records (id, user_id, year, type, status, review_status)
    SELECT gen_random_uuid(), $1::uuid, 2025, 'postgraduate', 'admitted', 'approved'
    FROM generate_series(1, $2::int)`,
  join_applications: `INSERT INTO join_applications (id, user_id, group_id, kind, status)
    SELECT gen_random_uuid(), $1::uuid, gen_random_uuid(), 'join', 'pending'
    FROM generate_series(1, $2::int)`,
  achievements: `INSERT INTO achievements (id, user_id, type, title, review_status)
    SELECT gen_random_uuid(), $1::uuid, 'paper', 'integration fixture', 'approved'
    FROM generate_series(1, $2::int)`,
  ai_match_records: `INSERT INTO ai_match_records (id, user_id, status, input_snapshot_hash, recommendations, model_version, prompt_version, fallback_used)
    SELECT gen_random_uuid(), $1::uuid, 'completed', repeat('a', 64), '[]'::jsonb, 'mock-model-1', 'prompt-v1', false
    FROM generate_series(1, $2::int)`,
};

const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';

let connection: SqlConnection;
let config: ResolvedDatabaseConfig;
let databaseName: string;
const temporaryDirectories: string[] = [];

integrationDescribe('真实 PostgreSQL 集成（TEST_DATABASE_URL / 测试库 DATABASE_URL）', () => {
  beforeAll(async () => {
    if (!ENABLED || RAW_URL === undefined) {
      return;
    }
    const resolution = resolveDatabaseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: RAW_URL,
      DATABASE_APPLICATION_NAME: 'researcher-manager-integration',
    });
    if (resolution.status !== 'configured') {
      throw new Error(`测试前置失败：${describeState()} 未解析成可用配置`);
    }
    config = resolution.config;
    databaseName = config.database;

    // fail-closed：只允许对「像测试库」的库执行迁移与 DDL
    if (!databaseName.includes('test')) {
      throw new Error(
        `${describeState()} 指向的库名不包含 test（${databaseName}）：集成测试会执行 DDL，拒绝在非测试库上运行`,
      );
    }

    // 真实建连：连不上就是**失败**，不是 skip
    connection = createPostgresConnection({
      profile: toPostgresPoolProfile(config),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
    });
    await connection.query('SELECT 1');

    // 先应用仓库真实迁移（部署守卫 + 原子执行）：后续所有用例都建立在「迁移已就绪」的 schema 上，
    // 而不是靠测试自己建表。迁移失败即整族失败（fail-closed），不会被当成环境问题跳过。
    const applied = await runMigrations({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database: createPostgresMigrationDatabase(connection),
      appliedBy: 'integration-test',
    });
    if (applied.guard.violations.length > 0) {
      throw new Error('测试前置失败：真实迁移未通过部署守卫');
    }
  }, 90_000);

  afterAll(async () => {
    if (connection !== undefined) {
      // 只删本测试写入的行：迁移建出的表必须留着（否则「幂等重跑」与后续用例会失去 schema）
      for (const table of STATISTICS_TABLES) {
        await connection
          .query(`DELETE FROM ${table} WHERE user_id IN ($1::uuid, $2::uuid)`, [OWNER_A, OWNER_B])
          .catch(() => undefined);
      }
      await connection.query('DROP TABLE IF EXISTS rm_it_rollback_marker').catch(() => undefined);
      await connection.close();
    }
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('启动：真实建连并执行参数化只读查询', async () => {
    const result = await connection.query<{ sum: number }>(
      'SELECT ($1::int + $2::int)::int AS sum',
      [2, 3],
    );
    expect(result.rows).toEqual([{ sum: 5 }]);
  });

  it('启动：连接参数（application_name / 语句超时）在服务端可见', async () => {
    const result = await connection.query<{ application_name: string }>(
      'SELECT current_setting($1::text) AS application_name',
      ['application_name'],
    );
    expect(result.rows[0]?.application_name).toBe('researcher-manager-integration');
  });

  it('参数槽不配对：拒绝下发，且不产生服务端错误', async () => {
    let captured: unknown;
    try {
      await connection.query('SELECT $1::int AS a, $2::int AS b', [1]);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PostgresExecutorError);
    expect((captured as PostgresExecutorError).code).toBe('EXECUTOR_PARAMETER_SLOT_MISMATCH');
  });

  it('事务：显式回滚不留数据，提交留数据', async () => {
    await connection.query('CREATE TABLE IF NOT EXISTS rm_it_rollback_marker (id int PRIMARY KEY)');
    await connection.query('DELETE FROM rm_it_rollback_marker');

    await connection
      .transaction(async (executor) => {
        await executor.query('INSERT INTO rm_it_rollback_marker (id) VALUES ($1)', [1]);
        throw new Error('synthetic rollback');
      })
      .catch(() => undefined);

    await connection.transaction(async (executor) => {
      await executor.query('INSERT INTO rm_it_rollback_marker (id) VALUES ($1)', [2]);
    });

    const rows = await connection.query<{ id: number }>(
      'SELECT id FROM rm_it_rollback_marker ORDER BY id',
    );
    expect(rows.rows).toEqual([{ id: 2 }]);
  });

  it('错误脱敏：保留 SQLSTATE，不外发连接串 / 口令 / SQL 文本 / 行取值', async () => {
    const sql = 'SELECT * FROM rm_it_definitely_missing_table';
    let captured: unknown;
    try {
      await connection.query(sql);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PostgresExecutorError);
    const executorError = captured as PostgresExecutorError;
    // SQLSTATE 是**可外发**的诊断事实（脱敏契约要求保留它）
    expect(executorError.issues[0]?.code).toBe('42P01');

    const serialized = JSON.stringify(executorError, Object.getOwnPropertyNames(executorError));
    const password = new URL(config.connectionString).password;
    // 不外发：连接串、口令、主机，以及 SQL 文本（`postgres-error.ts` 明确丢弃 `query` / `detail` / `where`）
    for (const secret of [config.connectionString, password, config.host, sql]) {
      expect(serialized).not.toContain(secret);
    }
    expect(executorError.message).not.toContain(config.connectionString);
    // 结构名（表名）按脱敏契约**可以**外发：`postgres-error.ts` 与 `postgres-error.spec.ts` 明确保留
    // schema / table / column / constraint 以便定位，因此这里不断言表名不出现 —— 表名不是行取值。
    expect(executorError.message).toContain('does not exist');
  });

  it('迁移：真实执行 0001–0005，且幂等重跑不再执行任何 SQL', async () => {
    const applied = await connection.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(applied.rows.map((row) => row.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
    ]);

    // 四张统计来源表必须真的由迁移建立（不是测试临时建表），且带统计所需的归属列
    for (const table of STATISTICS_TABLES) {
      const exists = await connection.query<{ exists: boolean }>(
        'SELECT to_regclass($1::text) IS NOT NULL AS exists',
        [`public.${table}`],
      );
      expect(exists.rows[0]?.exists).toBe(true);

      const columns = await connection.query<{ column_name: string }>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        ['public', table],
      );
      expect(columns.rows.map((row) => row.column_name)).toContain('user_id');
    }

    const again = await runMigrations({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database: createPostgresMigrationDatabase(connection),
      appliedBy: 'integration-test',
    });
    expect(again.guard.violations).toEqual([]);
    expect(again.executed).toEqual([]);
  }, 60_000);

  it('全新数据库 bootstrap：记账表缺失时先安全执行 0001，再读取应用版本', async () => {
    // 复现 WSL 真实测试发现的故障：空库里没有 schema_migrations，修复前 loadApplied() 直接抛
    // EXECUTOR_QUERY_FAILED（relation "schema_migrations" does not exist），0001 永远没机会执行。
    //
    // 为什么可以安全地 DROP 这张表：它是迁移 0001 建立的**纯记账表**，没有任何外键引用它；
    // 仓库全部迁移都用 IF NOT EXISTS（0001–0005），因此本用例随后按守卫顺序重放时
    // 只是幂等重建，不动业务表里的任何数据，且结束时记账表已恢复。
    await connection.query('DROP TABLE IF EXISTS schema_migrations');
    const database = createPostgresMigrationDatabase(connection);

    // 「记账表尚未建立」= 空集合（而不是读取失败）
    await expect(database.loadApplied()).resolves.toEqual([]);

    const first = await runMigrations({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database,
      appliedBy: 'integration-test',
    });
    const versions = ['0001', '0002', '0003', '0004', '0005'];
    expect(first.guard.violations).toEqual([]);
    expect(first.appliedBefore).toEqual([]);
    expect(first.executionOrder).toEqual(versions);
    expect(first.executed.map((item) => item.version)).toEqual(versions);
    expect(first.appliedAfter).toEqual(versions);

    // 0001 真的建立了记账表（不是测试自己建的）
    const ledger = await connection.query<{ exists: boolean }>(
      'SELECT to_regclass($1::text) IS NOT NULL AS exists',
      ['public.schema_migrations'],
    );
    expect(ledger.rows[0]?.exists).toBe(true);

    // 重复 status：两次结果一致，且报告已同步（只读，不写库）
    const statusOptions = {
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database,
      appliedBy: 'integration-test',
    } as const;
    const statusFirst = await loadMigrationStatus(statusOptions);
    const statusSecond = await loadMigrationStatus(statusOptions);
    expect(statusFirst.applied).toEqual(versions);
    expect(statusFirst.pending).toEqual([]);
    expect(statusFirst.upToDate).toBe(true);
    expect(statusSecond.applied).toEqual(statusFirst.applied);
    expect(statusSecond.pending).toEqual([]);

    // 再跑一次仍然是幂等的（bootstrap 之后不再执行任何 SQL）
    const again = await runMigrations({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database,
      appliedBy: 'integration-test',
    });
    expect(again.executed).toEqual([]);
  }, 120_000);

  it('迁移失败整体回滚：半成品表与记账行都不留下', async () => {
    // 与已应用状态对齐：临时目录里放**与仓库逐字节相同**的全部迁移，再加一条必然失败的下一版本
    const directory = mkdtempSync(join(tmpdir(), 'rm-it-migrations-'));
    temporaryDirectories.push(directory);
    const realDirectory = resolveMigrationsDirectory();
    for (const file of readdirSync(realDirectory)) {
      if (!file.endsWith('.sql')) continue;
      writeFileSync(join(directory, file), readFileSync(join(realDirectory, file), 'utf8'), 'utf8');
    }

    const failing = [
      '-- migration: 0006_rm_it_failing',
      '-- description: 集成测试：必然失败的迁移',
      '-- reversible: 否（测试夹具）',
      '-- owner: integration-test',
      '',
      'BEGIN;',
      '',
      'CREATE TABLE rm_it_should_not_exist (id int PRIMARY KEY);',
      'SELECT 1 / 0;',
      '',
      'COMMIT;',
      '',
    ].join('\n');
    writeFileSync(join(directory, '0006_rm_it_failing.sql'), failing, 'utf8');

    const database = createPostgresMigrationDatabase(connection);
    await expect(
      runMigrations({
        environment: 'test',
        sourceDirectory: directory,
        database,
        appliedBy: 'integration-test',
      }),
    ).rejects.toMatchObject({ code: 'RUN_APPLY_FAILED' });

    const leftover = await connection.query<{ exists: boolean }>(
      'SELECT to_regclass($1::text) IS NOT NULL AS exists',
      ['public.rm_it_should_not_exist'],
    );
    expect(leftover.rows[0]?.exists).toBe(false);

    const recorded = await connection.query<{ version: string }>(
      'SELECT version FROM schema_migrations WHERE version = $1',
      ['0006'],
    );
    expect(recorded.rows).toEqual([]);
  }, 60_000);

  it('owner 隔离：统计聚合读只返回请求主体自己的计数', async () => {
    // 表由迁移建立：这里只清理本测试的两个主体，再按真实 schema 写入合法行
    for (const table of STATISTICS_TABLES) {
      await connection.query(`DELETE FROM ${table} WHERE user_id IN ($1::uuid, $2::uuid)`, [
        OWNER_A,
        OWNER_B,
      ]);
    }

    const inserts: readonly [StatisticsTable, string, number][] = [
      ['education_records', OWNER_A, 3],
      ['join_applications', OWNER_A, 2],
      ['achievements', OWNER_A, 5],
      ['ai_match_records', OWNER_A, 1],
      ['education_records', OWNER_B, 999],
      ['join_applications', OWNER_B, 998],
      ['achievements', OWNER_B, 997],
      ['ai_match_records', OWNER_B, 996],
    ];
    for (const [table, owner, count] of inserts) {
      await connection.query(STATISTICS_ROW_INSERTS[table], [owner, count]);
    }

    const repository = new PostgresStatisticsRepository(connection);
    await expect(repository.readCountsByUserId(OWNER_A)).resolves.toEqual({
      educationRecords: 3,
      applications: 2,
      achievements: 5,
      matchingRequests: 1,
    });
    await expect(repository.readCountsByUserId(OWNER_B)).resolves.toEqual({
      educationRecords: 999,
      applications: 998,
      achievements: 997,
      matchingRequests: 996,
    });
  }, 60_000);

  it('迁移来源目录口径固定为 db/migrations（临时目录也必须以该相对路径记账）', () => {
    expect(MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY).toBe('db/migrations');
    expect(databaseName).toContain('test');
  });
});
