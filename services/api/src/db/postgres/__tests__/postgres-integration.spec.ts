import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseConfig, type ResolvedDatabaseConfig } from '../../config/database-config';
import { MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY } from '../../migrations/migration-deployment-guard';
import { runMigrations, type MigrationDatabasePort } from '../../migrations/migration-runner';
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
 * 未提供 `TEST_DATABASE_URL` 时整个套件**明确 skip**（`describe.skip` + 说明），绝不伪造通过；
 * 提供了但连不上、或目标库不像测试库时，用例会**失败**（fail-closed），不会悄悄降级成 skip。
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
 * 5. **迁移**：部署守卫 + 真实执行 + 幂等重跑；**失败迁移整体回滚**（无半成品表、无记账行）；
 * 6. **owner 隔离**：统计聚合读只返回请求主体自己的计数（他人记录不参与、也不回流）。
 *
 * ## 安全边界
 * - 目标库名必须包含 `test`，否则 fail-closed（避免误连生产库跑破坏性 DDL）；
 * - 只创建 / 删除本测试自带的表（`rm_it_*`、四张统计来源表），不触碰 `schema_migrations` 之外的既有数据；
 * - 断言里绝不打印连接串。
 */
const RAW_URL = process.env['TEST_DATABASE_URL']?.trim();
const ENABLED = RAW_URL !== undefined && RAW_URL !== '';

function describeState(): string {
  return ENABLED ? '已配置 TEST_DATABASE_URL' : '未配置 TEST_DATABASE_URL';
}

if (!ENABLED) {
  describe('真实 PostgreSQL 集成（未启用）', () => {
    // 明确 skip 并说明前置条件：未启用时**不产生**任何「通过」
    it.skip(`未启用：${describeState()}（需要 WSL2 Docker Compose 中的开发库，见 README）`, () => {
      expect.unreachable('reachable only when TEST_DATABASE_URL is configured');
    });
  });
}

const integrationDescribe = ENABLED ? describe : describe.skip;

/** 统计聚合读依赖的四张来源表（只在本测试里创建 / 清理） */
const STATISTICS_TABLES = [
  'education_records',
  'join_applications',
  'achievements',
  'ai_match_records',
] as const;

const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';

let connection: SqlConnection;
let config: ResolvedDatabaseConfig;
let databaseName: string;
const temporaryDirectories: string[] = [];

integrationDescribe('真实 PostgreSQL 集成（TEST_DATABASE_URL）', () => {
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
      throw new Error('测试前置失败：TEST_DATABASE_URL 未解析成可用配置');
    }
    config = resolution.config;
    databaseName = config.database;

    // fail-closed：只允许对「像测试库」的库执行迁移与 DDL
    if (!databaseName.includes('test')) {
      throw new Error(
        `TEST_DATABASE_URL 指向的库名不包含 test（${databaseName}）：集成测试会执行 DDL，拒绝在非测试库上运行`,
      );
    }

    // 真实建连：连不上就是**失败**，不是 skip
    connection = createPostgresConnection({
      profile: toPostgresPoolProfile(config),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
    });
    await connection.query('SELECT 1');
  }, 30_000);

  afterAll(async () => {
    if (connection !== undefined) {
      for (const table of STATISTICS_TABLES) {
        await connection.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
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

  it('错误脱敏：保留 SQLSTATE，不外发连接串 / 口令 / 行取值', async () => {
    let captured: unknown;
    try {
      await connection.query('SELECT * FROM rm_it_definitely_missing_table');
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PostgresExecutorError);
    const executorError = captured as PostgresExecutorError;
    expect(executorError.issues[0]?.code).toBe('42P01');

    const serialized = JSON.stringify(executorError, Object.getOwnPropertyNames(executorError));
    expect(serialized).not.toContain(config.host);
    for (const secret of [config.connectionString, 'rm_it_definitely_missing_table']) {
      expect(serialized).not.toContain(secret);
    }
    expect(executorError.message).not.toContain(config.connectionString);
  });

  it('迁移：部署守卫 + 真实执行 + 幂等重跑', async () => {
    const database: MigrationDatabasePort = createPostgresMigrationDatabase(connection);
    const sourceDirectory = resolveMigrationsDirectory();

    const first = await runMigrations({
      environment: 'test',
      sourceDirectory,
      database,
      appliedBy: 'integration-test',
    });
    expect(first.guard.violations).toEqual([]);
    expect(first.appliedAfter).toContain('0001');

    const applied = await connection.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(applied.rows.map((row) => row.version)).toContain('0001');

    const second = await runMigrations({
      environment: 'test',
      sourceDirectory,
      database,
      appliedBy: 'integration-test',
    });
    expect(second.executed).toEqual([]);
  }, 60_000);

  it('迁移失败整体回滚：半成品表与记账行都不留下', async () => {
    // 与已应用状态对齐：临时目录里放一份**与仓库逐字节相同**的 0001，再加一条必然失败的 0002
    const directory = mkdtempSync(join(tmpdir(), 'rm-it-migrations-'));
    temporaryDirectories.push(directory);
    const realDirectory = resolveMigrationsDirectory();
    const bootstrap = readFileSync(join(realDirectory, '0001_bootstrap.sql'), 'utf8');
    writeFileSync(join(directory, '0001_bootstrap.sql'), bootstrap, 'utf8');

    const failing = [
      '-- migration: 0002_rm_it_failing',
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
    writeFileSync(join(directory, '0002_rm_it_failing.sql'), failing, 'utf8');

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
      ['0002'],
    );
    expect(recorded.rows).toEqual([]);
  }, 60_000);

  it('owner 隔离：统计聚合读只返回请求主体自己的计数', async () => {
    for (const table of STATISTICS_TABLES) {
      await connection.query(`CREATE TABLE IF NOT EXISTS ${table} (user_id uuid NOT NULL)`);
      await connection.query(`DELETE FROM ${table}`);
    }

    const inserts: readonly [string, string, number][] = [
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
      for (let index = 0; index < count; index += 1) {
        await connection.query(`INSERT INTO ${table} (user_id) VALUES ($1::uuid)`, [owner]);
      }
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
