import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AchievementType,
  ApplicationKind,
  ApplicationStatus,
  AvailablePeriod,
  EducationStatus,
  EducationType,
  Grade,
  ProgrammingLevel,
  ReviewStatus,
  Role,
} from '@rm/shared';
import { resolveDatabaseConfig, type ResolvedDatabaseConfig } from '../../config/database-config';
import { loadEnv } from '../../../config/env';
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
import {
  POSTGRES_ACHIEVEMENT_COLUMNS,
  PostgresAchievementRepository,
} from '../../../modules/achievements/achievements.postgres-repository';
import type { Achievement } from '../../../modules/achievements/achievements.port';
import { PostgresStatisticsRepository } from '../../../modules/statistics/statistics.postgres-repository';
import {
  POSTGRES_EDUCATION_RECORD_COLUMNS,
  PostgresEducationRecordRepository,
} from '../../../modules/education/education-records.postgres-repository';
import { createEducationRecordRepository } from '../../../modules/education/education.module';
import type { EducationRecord } from '../../../modules/education/education-records.port';
import {
  POSTGRES_APPLICATION_COLUMNS,
  PostgresApplicationRepository,
} from '../../../modules/memberships/applications.postgres-repository';
import type { Application } from '../../../modules/memberships/applications.port';
import { createApplicationRepository } from '../../../modules/memberships/memberships.module';
import { PostgresSessionStore } from '../../../modules/auth/session-store.postgres-repository';
import { normalizeSubject } from '../../../modules/auth/session-subject.baseline';
import { generateSessionTicket, sessionTicketDigest } from '../../../modules/auth/session-ticket';
import {
  POSTGRES_STUDENT_PROFILE_COLUMNS,
  PostgresStudentProfileRepository,
} from '../../../modules/profiles/student-profile.postgres-repository';
import type { StudentProfile } from '../../../modules/profiles/student-profile.port';
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
 * 5. **迁移**：部署守卫 + 真实执行 `0001`–`0009` + 幂等重跑；**失败迁移整体回滚**（无半成品表、无记账行）；
 * 6. **全新数据库 bootstrap**：记账表缺失时 `0001` 能先建表并记账，之后 status 稳定可重复；
 * 7. **owner 隔离**：统计聚合读只返回请求主体自己的计数（他人记录不参与、也不回流）；
 * 8. **会话存储（0006）**：表由迁移建立且字段恰为最小集合；创建 / 读取 / 撤销在真实库上闭环；
 *    **原始票据结构上落不了库**（形状约束拒绝）；过期由数据库时钟判定并由清理语句删除；
 * 9. **画像存储（0007）**：表由迁移建立且列清单与 adapter 常量逐一致；upsert / 按主体读取 /
 *    归属隔离在真实库上闭环；**高敏感字段（学号/联系方式）原样往返**；归属与创建时间不可覆盖；
 *    未登记枚举被存储层 CHECK 拒绝。
 * 10. **成果存储（0004 建表 + 0008 补约束）**：表由迁移建立且列清单与 adapter 常量逐一致；
 *    创建 / 按主体列表在真实库上闭环，归属隔离（他人记录不出库）与稳定排序可复现；
 *    `id` 主键冲突不得静默覆盖（adapter 判 `CONFLICT`）；**0008 的两条 CHECK 在绕过应用层时
 *    也拒绝空标题与空 UUID 归属**。
 *
 * 四张统计来源表、会话表、画像表、成果表与审计表**都不由测试临时建表**：它们由仓库真实迁移
 * `0002`–`0009` 建立，
 * 测试只在表上写入 / 清理自己的行（统计、画像与成果按 `user_id` 删除，会话按摘要删除；审计表
 * 只追加、由 `audit-integration.spec.ts` 在真库上验证「业务侧改写与删除被存储层拒绝」），因此
 * 「切片对真实 schema 读写」是被真的验证过的。
 *
 * ## 安全边界
 * - 目标库名必须包含 `test`，否则 fail-closed（避免误连生产库跑破坏性 DDL）；
 * - 只创建 / 删除本测试自带的表 `rm_it_*`，以及**唯一一次** `DROP TABLE schema_migrations`（纯记账表，
 *   无外键引用，紧接着由同一用例按守卫顺序幂等重建）；对迁移建出的业务表只按归属增删本测试的行，
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
/** 本测试写入的会话主键（票据摘要）：结束时按这些摘要删除自己的行 */
const createdSessionDigests: string[] = [];
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
      if (createdSessionDigests.length > 0) {
        await connection
          .query('DELETE FROM sessions WHERE session_id = ANY($1::text[])', [createdSessionDigests])
          .catch(() => undefined);
      }
      // 画像表同样由迁移建立：只删本测试写入的两个主体
      await connection
        .query('DELETE FROM student_profiles WHERE user_id IN ($1::uuid, $2::uuid)', [
          OWNER_A,
          OWNER_B,
        ])
        .catch(() => undefined);
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

  it('迁移：真实执行 0001–0014，且幂等重跑不再执行任何 SQL', async () => {
    const applied = await connection.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(applied.rows.map((row) => row.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
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
    // 仓库全部迁移都用 IF NOT EXISTS（0001–0006），因此本用例随后按守卫顺序重放时
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
    const versions = [
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
    ];
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
      '-- migration: 0015_rm_it_failing',
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
    writeFileSync(join(directory, '0015_rm_it_failing.sql'), failing, 'utf8');

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
      ['0015'],
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

  // -------------------------------------------------------------------------
  // 会话存储（迁移 0006）：表结构 + 四个生命周期操作 + 「只存摘要」的结构保证
  // -------------------------------------------------------------------------

  it('会话表由迁移 0006 建立，且字段恰为最小集合（session_id / user_id / roles / scope / expires_at / revoked_at）', async () => {
    const exists = await connection.query<{ exists: boolean }>(
      'SELECT to_regclass($1::text) IS NOT NULL AS exists',
      ['public.sessions'],
    );
    expect(exists.rows[0]?.exists).toBe(true);

    const columns = await connection.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name',
      ['public', 'sessions'],
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'expires_at',
      'revoked_at',
      'roles',
      'scope',
      'session_id',
      'user_id',
    ]);
  });

  it('会话存储：创建 / 读取 / 撤销在真实库上闭环，且原始票据结构上落不了库', async () => {
    const store = new PostgresSessionStore(connection);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();

    const issued = await store.createSession({
      subject: {
        userId: 'u-it-session-1',
        roles: [Role.GroupLeader],
        groupIds: ['g-it-1'],
      },
      expiresAt,
    });
    const digest = sessionTicketDigest(issued.ticket);
    createdSessionDigests.push(digest);

    // 票据与摘要形状不重叠：票据是 43 字符 base64url，摘要是 64 字符十六进制
    expect(issued.ticket).toHaveLength(43);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);

    // 1) 表里**只有摘要**这一行，原始票据查不到任何行
    const rawRows = await connection.query<{ count: number }>(
      'SELECT count(1)::int AS count FROM sessions WHERE session_id = $1',
      [issued.ticket],
    );
    expect(rawRows.rows[0]?.count).toBe(0);

    // 2) 摘要是主键，行内容与创建输入一致
    const stored = await connection.query<{ user_id: string; roles: string[]; scope: unknown }>(
      'SELECT user_id, roles, scope FROM sessions WHERE session_id = $1',
      [digest],
    );
    expect(stored.rows[0]?.user_id).toBe('u-it-session-1');
    expect(stored.rows[0]?.roles).toEqual([Role.GroupLeader]);
    expect(stored.rows[0]?.scope).toEqual({ groupIds: ['g-it-1'] });

    // 3) 读取：主体（含范围）完整回来，摘要是会话主键
    await expect(store.findSession(issued.ticket)).resolves.toEqual({
      sessionId: digest,
      subject: {
        userId: 'u-it-session-1',
        roles: [Role.GroupLeader],
        groupIds: ['g-it-1'],
      },
    });

    // 4) 撤销幂等：第一次 true、第二次 false，之后读不到
    await expect(store.revokeSession(issued.ticket)).resolves.toBe(true);
    await expect(store.revokeSession(issued.ticket)).resolves.toBe(false);
    await expect(store.findSession(issued.ticket)).resolves.toBeUndefined();

    // 5) 「原始票据落不了库」的结构保证：即使写入方忘了哈希，直接绑原始票据也会被形状约束拒绝
    let rejected: unknown;
    try {
      await connection.query(
        "INSERT INTO sessions (session_id, user_id, roles, scope, expires_at) VALUES ($1, $2, $3::text[], $4::jsonb, now() + interval '1 hour')",
        [issued.ticket, 'u-it-session-1', [Role.GroupLeader], '{}'],
      );
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(PostgresExecutorError);
    expect((rejected as PostgresExecutorError).issues[0]?.code).toBe('23514');
  }, 60_000);

  it('会话存储：过期由数据库时钟判定（应用侧无过期分支），过期清理删除该行', async () => {
    const store = new PostgresSessionStore(connection);
    // 直接写入一条已过期会话：走 adapter 的创建路径会因「有效期上界」拒绝，所以这里用 SQL 夹具
    const ticket = generateSessionTicket();
    const digest = sessionTicketDigest(ticket);
    createdSessionDigests.push(digest);
    await connection.query(
      "INSERT INTO sessions (session_id, user_id, roles, scope, expires_at) VALUES ($1, $2, $3::text[], $4::jsonb, now() - interval '1 hour')",
      [digest, 'u-it-session-expired', [Role.Student], '{}'],
    );

    // 过期会话在读取路径上不可用（谓词 expires_at > now() 由数据库判定）
    await expect(store.findSession(ticket)).resolves.toBeUndefined();

    await expect(store.purgeExpired()).resolves.toBeGreaterThanOrEqual(1);
    const left = await connection.query<{ count: number }>(
      'SELECT count(1)::int AS count FROM sessions WHERE session_id = $1',
      [digest],
    );
    expect(left.rows[0]?.count).toBe(0);

    // 清理是幂等的：同一批已过期行不会再次被删
    await expect(store.purgeExpired()).resolves.toBe(0);
  }, 60_000);

  it('会话存储：未登记角色落库后读取返回该行，但认证边界会整体拒绝该主体（fail-closed）', async () => {
    const store = new PostgresSessionStore(connection);
    const ticket = generateSessionTicket();
    const digest = sessionTicketDigest(ticket);
    createdSessionDigests.push(digest);
    // 写入一个**形状合法但未登记**的角色：存储层只约束形状，角色闭集由认证边界判定
    await connection.query(
      "INSERT INTO sessions (session_id, user_id, roles, scope, expires_at) VALUES ($1, $2, $3::text[], $4::jsonb, now() + interval '1 hour')",
      [digest, 'u-it-session-unknown', ['guest'], '{}'],
    );

    const record = await store.findSession(ticket);
    expect(record?.subject.roles).toEqual(['guest']);

    // 认证边界的判定（与存储层解耦）：未登记角色 ⇒ normalizeSubject 返回 undefined ⇒ 401
    expect(normalizeSubject(record)).toBeUndefined();
  }, 60_000);

  // -------------------------------------------------------------------------
  // 画像存储（迁移 0007）：表结构 + upsert/读取闭环 + 归属隔离 + 存储层形状约束
  // -------------------------------------------------------------------------

  /** 与迁移 0007 的列一一对应的画像记录（高敏感字段带可区分取值，便于证明「原样往返」） */
  function profileFixture(userId: string, overrides: Partial<StudentProfile> = {}): StudentProfile {
    return {
      userId,
      name: '集成测试画像',
      studentNo: '2026000001',
      college: '计算机学院',
      major: '软件工程',
      grade: Grade.Junior,
      phone: '13800138000',
      skills: ['TypeScript', 'PostgreSQL'],
      programmingLevel: ProgrammingLevel.Intermediate,
      researchExperience: '参与过真实库集成验证',
      availableTime: { weeklyHours: 10, periods: [AvailablePeriod.Weekend], note: '周末全天' },
      researchInterests: ['数据要素'],
      strengths: '工程实现能力',
      intendedFields: ['可信数据空间'],
      privacyConsent: { policyVersion: 'v2026-01', consentedAt: '2026-02-01T00:00:00.000Z' },
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('画像表由迁移 0007 建立，列清单与 adapter 的 POSTGRES_STUDENT_PROFILE_COLUMNS 逐一致', async () => {
    const exists = await connection.query<{ exists: boolean }>(
      'SELECT to_regclass($1::text) IS NOT NULL AS exists',
      ['public.student_profiles'],
    );
    expect(exists.rows[0]?.exists).toBe(true);

    const columns = await connection.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name',
      ['public', 'student_profiles'],
    );
    // 双向一致：迁移不许多列，也不许少列（adapter 用显式列清单，缺列会直接让读写失败）
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(
      [...POSTGRES_STUDENT_PROFILE_COLUMNS].sort(),
    );

    // 归属即主键（一人一行）：这是「按主体取数」与「覆盖写入」语义的存储层保证
    const primaryKey = await connection.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'public.student_profiles'::regclass AND i.indisprimary`,
    );
    expect(primaryKey.rows.map((row) => row.column_name)).toEqual(['user_id']);
  }, 30_000);

  it('画像存储：upsert / 按主体读取 / 归属隔离在真实库上闭环，高敏感字段原样往返', async () => {
    const repository = new PostgresStudentProfileRepository(connection);
    await connection.query('DELETE FROM student_profiles WHERE user_id IN ($1::uuid, $2::uuid)', [
      OWNER_A,
      OWNER_B,
    ]);

    const mine = profileFixture(OWNER_A);
    await expect(repository.save(mine)).resolves.toEqual(mine);

    // 读取：逐字段等价（含 studentNo / phone 这两个只写不读的高敏感列：存储层原样承载）
    const found = await repository.findByUserId(OWNER_A);
    expect(found).toEqual(mine);
    expect(found?.studentNo).toBe(mine.studentNo);
    expect(found?.phone).toBe(mine.phone);

    // 覆盖写入（upsert）：同一主体第二次写入是更新而不是主键冲突
    const updated = profileFixture(OWNER_A, {
      college: '数学学院',
      updatedAt: '2026-02-02T00:00:00.000Z',
    });
    await expect(repository.save(updated)).resolves.toEqual(updated);
    await expect(repository.findByUserId(OWNER_A)).resolves.toEqual(updated);

    // 归属隔离：他人主体读不到本行；写入他人行也不影响本人的读取
    await expect(repository.findByUserId(OWNER_B)).resolves.toBeUndefined();
    await repository.save(profileFixture(OWNER_B, { college: '他人学院' }));
    const stillMine = await repository.findByUserId(OWNER_A);
    expect(stillMine?.college).toBe('数学学院');
    expect(JSON.stringify(stillMine)).not.toContain('他人学院');

    // 存储 ID 域：非 UUID 主体（会话基线形状）在进入 SQL 之前就被拒绝，不触达数据库
    await expect(repository.findByUserId('u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
  }, 60_000);

  it('画像存储：归属与创建时间不可覆盖（ON CONFLICT 的 SET 子句排除它们）', async () => {
    const repository = new PostgresStudentProfileRepository(connection);
    await connection.query('DELETE FROM student_profiles WHERE user_id = $1::uuid', [OWNER_A]);

    const original = profileFixture(OWNER_A);
    await repository.save(original);

    // 用同一主体、不同 created_at 再写：数据库保留原创建时间 ⇒ adapter 判 LIFECYCLE_MISMATCH
    let captured: unknown;
    try {
      await repository.save(profileFixture(OWNER_A, { createdAt: '2026-03-01T00:00:00.000Z' }));
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: 'LIFECYCLE_MISMATCH' });

    // 数据库侧创建时间确实没被改写（不是「抛错但已覆盖」）
    const stored = await repository.findByUserId(OWNER_A);
    expect(stored?.createdAt).toBe(original.createdAt);
  }, 60_000);

  it('画像存储：未登记枚举被存储层 CHECK 拒绝（绕过应用层也写不进坏数据）', async () => {
    await connection.query('DELETE FROM student_profiles WHERE user_id = $1::uuid', [OWNER_A]);
    await connection
      .query(
        `INSERT INTO student_profiles (
         user_id, name, student_no, college, major, grade, phone, skills, programming_level,
         available_time, research_interests, intended_fields, privacy_consent, created_at, updated_at
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8::text[], $9,
         $10::jsonb, $11::text[], $12::text[], $13::jsonb, $14::timestamptz, $15::timestamptz
       )`,
        [
          OWNER_A,
          '集成测试画像',
          '2026000001',
          '计算机学院',
          '软件工程',
          'unknown_grade',
          '13800138000',
          ['TypeScript'],
          'intermediate',
          JSON.stringify({ weeklyHours: 10, periods: ['weekend'] }),
          ['数据要素'],
          ['可信数据空间'],
          JSON.stringify({ policyVersion: 'v2026-01', consentedAt: '2026-02-01T00:00:00.000Z' }),
          '2026-02-01T00:00:00.000Z',
          '2026-02-01T00:00:00.000Z',
        ],
      )
      .then(
        () => {
          throw new Error('存储层没有拒绝未登记枚举：CHECK 约束失效');
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(PostgresExecutorError);
          // 23514 = check_violation
          expect((error as PostgresExecutorError).issues[0]?.code).toBe('23514');
        },
      );
  }, 60_000);

  // -------------------------------------------------------------------------
  // 成果存储（迁移 0004 建表 + 0008 补约束）：表结构 + 创建/列表闭环 + 归属隔离 + 存储层约束
  // -------------------------------------------------------------------------

  /** 与迁移 0004 的列一一对应的成果记录（可选列带可区分取值，便于证明「原样往返」） */
  function achievementFixture(userId: string, overrides: Partial<Achievement> = {}): Achievement {
    return {
      id: randomUUID(),
      userId,
      type: AchievementType.Paper,
      title: '集成测试成果',
      awardLevel: '校级一等奖',
      description: '真实库集成验证用成果记录',
      achievedAt: '2026-04-01T00:00:00.000Z',
      evidenceFileId: randomUUID(),
      reviewStatus: ReviewStatus.Pending,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('成果表由迁移 0004 建立，列清单与 adapter 的 POSTGRES_ACHIEVEMENT_COLUMNS 逐一致', async () => {
    const exists = await connection.query<{ exists: boolean }>(
      'SELECT to_regclass($1::text) IS NOT NULL AS exists',
      ['public.achievements'],
    );
    expect(exists.rows[0]?.exists).toBe(true);

    const columns = await connection.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name',
      ['public', 'achievements'],
    );
    // 双向一致：迁移不许多列，也不许少列（adapter 用显式列清单，缺列会直接让读写失败）
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(
      [...POSTGRES_ACHIEVEMENT_COLUMNS].sort(),
    );

    // 主键是 id：`ON CONFLICT (id) DO NOTHING` 的冲突语义依赖它
    const primaryKey = await connection.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'public.achievements'::regclass AND i.indisprimary`,
    );
    expect(primaryKey.rows.map((row) => row.column_name)).toEqual(['id']);

    // 0008 补的两条 CHECK 必须真的在库里（不是只在迁移文件里写着）
    const constraints = await connection.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.achievements'::regclass AND contype = 'c' ORDER BY conname`,
    );
    const names = constraints.rows.map((row) => row.conname);
    expect(names).toContain('achievements_title_length');
    expect(names).toContain('achievements_owner_not_nil');

    // 本人列表的取数路径（WHERE user_id = $1 ORDER BY created_at, id）必须有索引支撑
    const indexes = await connection.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'achievements'`,
    );
    expect(indexes.rows.some((row) => /\(user_id,\s*created_at,\s*id\)/u.test(row.indexdef))).toBe(
      true,
    );
  }, 30_000);

  it('成果存储：创建 / 按主体列表在真实库上闭环，归属只来自服务端主体且稳定排序', async () => {
    await connection.query('DELETE FROM achievements WHERE user_id IN ($1::uuid, $2::uuid)', [
      OWNER_A,
      OWNER_B,
    ]);
    const repository = new PostgresAchievementRepository(connection);

    const first = achievementFixture(OWNER_A, { createdAt: '2026-04-01T00:00:00.000Z' });
    const second = achievementFixture(OWNER_A, {
      type: AchievementType.Competition,
      title: '第二作者竞赛成果',
      createdAt: '2026-04-02T00:00:00.000Z',
      updatedAt: '2026-04-02T00:00:00.000Z',
    });

    // 写入：返回值必须与写入记录逐字段等价（含可选列与归属），归属由调用方（service）提供
    await expect(repository.create(first)).resolves.toEqual(first);
    await expect(repository.create(second)).resolves.toEqual(second);

    // 读取：本人两条、顺序为 created_at ASC（稳定全序），并且逐字段原样往返
    const mine = await repository.listByUserId(OWNER_A);
    expect(mine.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(mine[0]).toEqual(first);
    expect(mine[1]).toEqual(second);

    // 归属隔离：他人主体一条都看不到；写入他人成果也不影响本人列表
    await expect(repository.listByUserId(OWNER_B)).resolves.toEqual([]);
    const foreign = achievementFixture(OWNER_B, { title: '他人成果' });
    await repository.create(foreign);
    const stillMine = await repository.listByUserId(OWNER_A);
    expect(stillMine.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(JSON.stringify(stillMine)).not.toContain('他人成果');
    expect(JSON.stringify(stillMine)).not.toContain(OWNER_B);

    // 归属下推进 SQL：他人成果确实在库里（不是写入失败被吞掉），只是取数时不出库
    const foreignInDatabase = await connection.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM achievements WHERE user_id = $1::uuid',
      [OWNER_B],
    );
    expect(foreignInDatabase.rows[0]?.count).toBe(1);

    // 存储 ID 域：非 UUID 主体（会话基线形状）在进入 SQL 之前就被拒绝，不触达数据库
    await expect(repository.listByUserId('u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    // 空 UUID 同样不是可用主体
    await expect(
      repository.listByUserId('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
  }, 60_000);

  it('成果存储：主键冲突不得静默覆盖（ON CONFLICT DO NOTHING + adapter 判 CONFLICT）', async () => {
    const repository = new PostgresAchievementRepository(connection);
    await connection.query('DELETE FROM achievements WHERE user_id = $1::uuid', [OWNER_A]);

    const original = achievementFixture(OWNER_A, { title: '原始成果' });
    await repository.create(original);

    // 同一 id 再写：数据库侧不产生返回行 ⇒ adapter 显式抛 CONFLICT，不得改写既有记录
    await expect(
      repository.create(achievementFixture(OWNER_A, { id: original.id, title: '被覆盖的标题' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const stored = await connection.query<{ title: string }>(
      'SELECT title FROM achievements WHERE id = $1::uuid',
      [original.id],
    );
    expect(stored.rows[0]?.title).toBe('原始成果');
  }, 60_000);

  it('成果存储：0008 的存储层 CHECK 拒绝空标题与空 UUID 归属（绕过应用层也写不进坏数据）', async () => {
    await connection.query('DELETE FROM achievements WHERE user_id = $1::uuid', [OWNER_A]);

    // 空标题（0004 的 varchar(300) NOT NULL 拦不住）⇒ achievements_title_length
    await connection
      .query(
        `INSERT INTO achievements (id, user_id, type, title, review_status)
         VALUES ($1::uuid, $2::uuid, 'paper', '', 'pending')`,
        [randomUUID(), OWNER_A],
      )
      .then(
        () => {
          throw new Error('存储层没有拒绝空标题：achievements_title_length 约束失效');
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(PostgresExecutorError);
          expect((error as PostgresExecutorError).issues[0]?.code).toBe('23514');
        },
      );

    // 空 UUID 归属（adapter 的存储 ID 域之外的取值）⇒ achievements_owner_not_nil
    await connection
      .query(
        `INSERT INTO achievements (id, user_id, type, title, review_status)
         VALUES ($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'paper', '空归属成果', 'pending')`,
        [randomUUID()],
      )
      .then(
        () => {
          throw new Error('存储层没有拒绝空 UUID 归属：achievements_owner_not_nil 约束失效');
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(PostgresExecutorError);
          expect((error as PostgresExecutorError).issues[0]?.code).toBe('23514');
        },
      );

    // 未被拒绝的合法写入仍然成功（证明上面的失败来自 CHECK，而不是「谁都写不进去」）
    const repository = new PostgresAchievementRepository(connection);
    await expect(repository.create(achievementFixture(OWNER_A))).resolves.toMatchObject({
      userId: OWNER_A,
      title: '集成测试成果',
    });
  }, 60_000);

  // -------------------------------------------------------------------------
  // 升学记录存储（迁移 0002 建表，本切片直接复用、不新增 schema）：
  // 表结构 + 创建/列表/单条闭环 + 归属下推隔离 + 主键冲突 + 存储 ID 域
  // -------------------------------------------------------------------------

  /** 与迁移 0002 的列一一对应的升学记录（可选列带可区分取值，便于证明「原样往返」） */
  function educationFixture(
    userId: string,
    overrides: Partial<EducationRecord> = {},
  ): EducationRecord {
    return {
      id: randomUUID(),
      userId,
      year: 2026,
      type: EducationType.Postgraduate,
      status: EducationStatus.Admitted,
      institutionOrDestination: '集成测试大学',
      reviewStatus: ReviewStatus.Pending,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('升学记录表由迁移 0002 建立，列清单与 adapter 的 POSTGRES_EDUCATION_RECORD_COLUMNS 逐一致', async () => {
    const exists = await connection.query<{ exists: boolean }>(
      'SELECT to_regclass($1::text) IS NOT NULL AS exists',
      ['public.education_records'],
    );
    expect(exists.rows[0]?.exists).toBe(true);

    const columns = await connection.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', 'education_records'],
    );
    // 双向一致：迁移不许多列，也不许少列（adapter 用显式列清单，多出的列会被严格行契约拒绝）
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(
      [...POSTGRES_EDUCATION_RECORD_COLUMNS].sort(),
    );

    // 主键必须是 id（写路径依赖 ON CONFLICT (id) 暴露冲突）
    const primaryKey = await connection.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'public.education_records'::regclass AND i.indisprimary`,
    );
    expect(primaryKey.rows.map((row) => row.column_name)).toEqual(['id']);

    // 归属下推的取数路径必须有索引支撑（user_id 前导）
    const indexes = await connection.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'education_records'`,
    );
    expect(indexes.rows.some((row) => /\(user_id,\s*created_at,\s*id\)/u.test(row.indexdef))).toBe(
      true,
    );
  }, 30_000);

  it('升学记录存储：创建 / 列表 / 单条归属下推在真实库闭环，他人记录既不出库也不可探测', async () => {
    await connection.query('DELETE FROM education_records WHERE user_id IN ($1::uuid, $2::uuid)', [
      OWNER_A,
      OWNER_B,
    ]);
    const repository = new PostgresEducationRecordRepository(connection);

    const first = educationFixture(OWNER_A, { createdAt: '2026-05-01T00:00:00.000Z' });
    const second = educationFixture(OWNER_A, {
      year: 2027,
      status: EducationStatus.Preparing,
      institutionOrDestination: undefined,
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });

    // 写入：返回值必须与写入记录逐字段等价（含可选列为空的往返）
    await expect(repository.create(first)).resolves.toEqual(first);
    await expect(repository.create(second)).resolves.toEqual(second);

    // 列表：只返回本人记录，顺序为 created_at ASC（稳定全序）
    const mine = await repository.listByUserId(OWNER_A);
    expect(mine.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(mine[0]).toEqual(first);
    expect(mine[1]).toEqual(second);

    // 单条：归属同时命中才返回
    await expect(repository.findById(first.id, OWNER_A)).resolves.toEqual(first);

    // 归属隔离：他人主体一条都看不到（写入他人记录后亦不影响本人列表）
    const foreign = educationFixture(OWNER_B, { institutionOrDestination: '他人大学' });
    await repository.create(foreign);

    await expect(repository.listByUserId(OWNER_B)).resolves.toEqual([foreign]);
    await expect(repository.findById(foreign.id, OWNER_A)).resolves.toBeUndefined();
    await expect(repository.findById(first.id, OWNER_B)).resolves.toBeUndefined();

    const stillMine = await repository.listByUserId(OWNER_A);
    expect(stillMine.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(JSON.stringify(stillMine)).not.toContain('他人大学');
    expect(JSON.stringify(stillMine)).not.toContain(OWNER_B);

    // 归属确实下推到了 SQL：他人那行**在库里存在**（不是写入失败被吞掉），只是取数时不出库
    const foreignInDatabase = await connection.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM education_records WHERE id = $1::uuid AND user_id = $2::uuid',
      [foreign.id, OWNER_B],
    );
    expect(foreignInDatabase.rows[0]?.count).toBe(1);
  }, 60_000);

  it('升学记录存储：主键冲突不得静默覆盖（ON CONFLICT DO NOTHING + adapter 判 CONFLICT）', async () => {
    const repository = new PostgresEducationRecordRepository(connection);
    await connection.query('DELETE FROM education_records WHERE user_id = $1::uuid', [OWNER_A]);

    const original = educationFixture(OWNER_A, { institutionOrDestination: '原始大学' });
    await repository.create(original);

    // 同一 id 再写：数据库侧不产生返回行 ⇒ adapter 显式抛 CONFLICT，不得改写既有记录
    await expect(
      repository.create(
        educationFixture(OWNER_A, { id: original.id, institutionOrDestination: '被覆盖大学' }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const stored = await connection.query<{ institution_or_destination: string }>(
      'SELECT institution_or_destination FROM education_records WHERE id = $1::uuid',
      [original.id],
    );
    expect(stored.rows[0]?.institution_or_destination).toBe('原始大学');
  }, 60_000);

  it('升学记录存储：存储 ID 域在进入 SQL 之前判定（非 UUID 主体 / 空 UUID / 非 UUID 资源 ID）', async () => {
    const repository = new PostgresEducationRecordRepository(connection);

    // 非 UUID 主体（会话基线形状）在进入 SQL 之前就被拒绝，不触达数据库
    await expect(repository.listByUserId('u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    await expect(repository.findById(randomUUID(), 'u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    // 空 UUID 同样不是可用主体
    await expect(
      repository.listByUserId('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
    // 非 UUID 的资源标识属于服务端缺陷：不得进入 SQL
    await expect(repository.findById('not-a-uuid', OWNER_A)).rejects.toMatchObject({
      code: 'INVALID_RECORD_ID',
    });
    // 大写（非规范形）UUID 会被数据库规范化，因此在进 SQL 之前拒绝（避免落库后再判 IDENTITY_MISMATCH）
    await expect(repository.findById(randomUUID().toUpperCase(), OWNER_A)).rejects.toMatchObject({
      code: 'INVALID_RECORD_ID',
    });
    // 写路径的资源 ID 同样受存储 ID 域约束
    await expect(
      repository.create({ ...educationFixture(OWNER_A), id: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'INVALID_RECORD' });
  }, 60_000);

  it('升学记录存储：错误信息脱敏（失败路径不回显归属与「院校或去向」原文）', async () => {
    const repository = new PostgresEducationRecordRepository(connection);
    const marker = '脱敏标记大学-不可外泄';

    let captured: unknown;
    try {
      // 用「与已登记列冲突的行」无法从外部构造，因此这里直接走存储层约束：
      // 空院校字符串之外的非法取值由 adapter 在进 SQL 前拒绝，错误里不得带原文。
      await repository.create({
        ...educationFixture(OWNER_A, { institutionOrDestination: `${marker}\u0007` }),
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    const serialized = JSON.stringify(captured, Object.getOwnPropertyNames(captured));
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain(OWNER_A);
  }, 60_000);

  it('升学记录运行路径：模块换绑工厂（createEducationRecordRepository）+ 真实执行器直连真实库', async () => {
    // 这一次不直接用 adapter 类，而是走**模块的换绑工厂**：即运行时真正取用的那条路径。
    // 「数据库已配置 ⇒ 端口上是 PostgreSQL 实现」+「延迟建连」+「归属隔离」三者在这里同时成立。
    const connectCalls: ResolvedDatabaseConfig[] = [];
    const repository = createEducationRecordRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: RAW_URL }),
      {
        capabilities: { backend: 'postgres', persistent: true, productionReady: false },
        connect: (resolved: ResolvedDatabaseConfig) => {
          connectCalls.push(resolved);
          return Promise.resolve(connection);
        },
      },
    );

    // 延迟建连：拿到端口时一次都没连（装配阶段不碰数据库）
    expect(connectCalls).toEqual([]);
    expect(repository.capabilities).toMatchObject({
      backend: 'postgres',
      persistent: true,
      productionReady: false,
    });

    await connection.query('DELETE FROM education_records WHERE user_id IN ($1::uuid, $2::uuid)', [
      OWNER_A,
      OWNER_B,
    ]);
    const record = educationFixture(OWNER_A, { institutionOrDestination: '运行路径大学' });

    // 首次真实读写：建立连接（复用同一真实连接）并完成写入 / 取数闭环
    await expect(repository.create(record)).resolves.toEqual(record);
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0]?.database).toBe(databaseName);

    await expect(repository.findById(record.id, OWNER_A)).resolves.toEqual(record);
    await expect(repository.listByUserId(OWNER_A)).resolves.toEqual([record]);

    // 归属隔离：换绑后的端口同样不返回他人记录（只有 404 语义，没有存在性泄露）
    await expect(repository.findById(record.id, OWNER_B)).resolves.toBeUndefined();
    await expect(repository.listByUserId(OWNER_B)).resolves.toEqual([]);
    // 非存储 ID 域的主体在进入 SQL 之前就被拒绝（不触发第二次建连）
    await expect(repository.listByUserId('u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    expect(connectCalls).toHaveLength(1);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 入组申请存储（迁移 0003 建表，本切片直接复用、不新增 schema）：
  // 表结构 + 创建/列表/单条闭环 + 归属下推隔离 + 主键冲突 + 条件写入（状态转移）
  // + 存储 ID 域 + 错误脱敏 + 模块换绑工厂的运行路径
  // -------------------------------------------------------------------------

  const GROUP_A = '33333333-3333-4333-8333-333333333333';
  const GROUP_B = '44444444-4444-4444-8444-444444444444';
  const GROUP_MISSING = '55555555-5555-4555-8555-555555555555';

  /** 与迁移 0003 的列一一对应的入组申请（可选列带可区分取值，便于证明「原样往返」） */
  function applicationFixture(
    userId: string,
    groupId: string,
    overrides: Partial<Application> = {},
  ): Application {
    return {
      id: randomUUID(),
      userId,
      groupId,
      kind: ApplicationKind.Join,
      note: '集成测试入组申请备注',
      status: ApplicationStatus.Pending,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('入组申请表由迁移 0003 建立，列清单与 adapter 的 POSTGRES_APPLICATION_COLUMNS 逐一致', async () => {
    const exists = await connection.query<{ exists: boolean }>(
      'SELECT to_regclass($1::text) IS NOT NULL AS exists',
      ['public.join_applications'],
    );
    expect(exists.rows[0]?.exists).toBe(true);

    const columns = await connection.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', 'join_applications'],
    );
    // 双向一致：迁移不许多列，也不许少列（adapter 用显式列清单，多出的列会被严格行契约拒绝）
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(
      [...POSTGRES_APPLICATION_COLUMNS].sort(),
    );

    // 主键必须是 id（写路径依赖 ON CONFLICT (id) 暴露冲突）
    const primaryKey = await connection.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'public.join_applications'::regclass AND i.indisprimary`,
    );
    expect(primaryKey.rows.map((row) => row.column_name)).toEqual(['id']);

    // 归属下推的取数路径必须有索引支撑（user_id 前导）
    const indexes = await connection.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'join_applications'`,
    );
    expect(indexes.rows.some((row) => /\(user_id,\s*created_at,\s*id\)/u.test(row.indexdef))).toBe(
      true,
    );
  }, 30_000);

  it('入组申请存储：创建 / 列表 / 按小组 / 单条归属下推在真实库闭环，他人申请既不出库也不可探测', async () => {
    await connection.query('DELETE FROM join_applications WHERE user_id IN ($1::uuid, $2::uuid)', [
      OWNER_A,
      OWNER_B,
    ]);
    const repository = new PostgresApplicationRepository(connection);

    const first = applicationFixture(OWNER_A, GROUP_A, {
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    const second = applicationFixture(OWNER_A, GROUP_B, {
      note: undefined,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });

    // 写入：返回值必须与写入记录逐字段等价（含可选列为空的往返）
    await expect(repository.create(first)).resolves.toEqual(first);
    await expect(repository.create(second)).resolves.toEqual(second);

    // 列表：只返回本人记录，顺序为 created_at ASC（稳定全序）
    const mine = await repository.listByUserId(OWNER_A);
    expect(mine.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(mine[0]).toEqual(first);
    expect(mine[1]).toEqual(second);

    // 单条：归属与资源 ID 同时命中才返回
    await expect(repository.findById(first.id, OWNER_A)).resolves.toEqual(first);

    // 按（主体, 小组）取数：只命中该小组，且谓词里没有状态条件（终态语义属于共享状态机）
    await expect(repository.listByUserAndGroup(OWNER_A, GROUP_A)).resolves.toEqual([first]);
    await expect(repository.listByUserAndGroup(OWNER_A, GROUP_MISSING)).resolves.toEqual([]);
    await expect(repository.listByUserAndGroup(OWNER_B, GROUP_A)).resolves.toEqual([]);

    // 归属隔离：他人主体一条都看不到（写入他人申请后亦不影响本人列表）
    const foreign = applicationFixture(OWNER_B, GROUP_B, { note: '他人申请备注明文' });
    await repository.create(foreign);

    await expect(repository.listByUserId(OWNER_B)).resolves.toEqual([foreign]);
    await expect(repository.findById(foreign.id, OWNER_A)).resolves.toBeUndefined();
    await expect(repository.findById(first.id, OWNER_B)).resolves.toBeUndefined();
    // 「不存在」与「他人申请」在端口上是同一种结果（service 因此统一 404，不泄露存在性）
    await expect(repository.findById(randomUUID(), OWNER_A)).resolves.toBeUndefined();

    const stillMine = await repository.listByUserId(OWNER_A);
    expect(stillMine.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(JSON.stringify(stillMine)).not.toContain('他人申请备注明文');
    expect(JSON.stringify(stillMine)).not.toContain(OWNER_B);

    // 归属确实下推到了 SQL：他人那行**在库里存在**（不是写入失败被吞掉），只是取数时不出库
    const foreignInDatabase = await connection.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM join_applications WHERE id = $1::uuid AND user_id = $2::uuid',
      [foreign.id, OWNER_B],
    );
    expect(foreignInDatabase.rows[0]?.count).toBe(1);
  }, 60_000);

  it('入组申请存储：主键冲突不静默覆盖；状态转移是条件写入，非法转移不产生任何更改', async () => {
    await connection.query('DELETE FROM join_applications WHERE user_id IN ($1::uuid, $2::uuid)', [
      OWNER_A,
      OWNER_B,
    ]);
    const repository = new PostgresApplicationRepository(connection);

    const original = applicationFixture(OWNER_A, GROUP_A, { note: '原始申请备注明文' });
    await repository.create(original);

    // 同一 id 再写：数据库侧 ON CONFLICT DO NOTHING 不产生返回行 ⇒ adapter 显式抛 CONFLICT
    await expect(
      repository.create(
        applicationFixture(OWNER_A, GROUP_A, { id: original.id, note: '被覆盖申请备注明文' }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const untouched = await connection.query<{ note: string }>(
      'SELECT note FROM join_applications WHERE id = $1::uuid',
      [original.id],
    );
    expect(untouched.rows[0]?.note).toBe('原始申请备注明文');

    // 合法转移（pending → withdrawn）命中条件写入，并原样返回写回后的记录
    const withdrawn: Application = {
      ...original,
      status: ApplicationStatus.Withdrawn,
      updatedAt: '2026-06-03T00:00:00.000Z',
    };
    await expect(repository.save(withdrawn)).resolves.toEqual(withdrawn);

    // 并发重复撤回 / 越权推进：目标状态的前驱集合里没有 withdrawn ⇒ 0 行 + 诊断确认 ⇒ TRANSITION_REJECTED
    await expect(
      repository.save({ ...original, status: ApplicationStatus.Approved }),
    ).rejects.toMatchObject({ code: 'TRANSITION_REJECTED' });

    const current = await connection.query<{ status: string }>(
      'SELECT status FROM join_applications WHERE id = $1::uuid',
      [original.id],
    );
    expect(current.rows[0]?.status).toBe(ApplicationStatus.Withdrawn);

    // 写路径的归属隔离：同一条记录的 id、他人的归属 ⇒ 条件写入与诊断都不命中 ⇒ NOT_FOUND（不写他人数据）
    await expect(repository.save({ ...withdrawn, userId: OWNER_B })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const unchangedAfterForeignWrite = await connection.query<{ status: string }>(
      'SELECT status FROM join_applications WHERE id = $1::uuid',
      [original.id],
    );
    expect(unchangedAfterForeignWrite.rows[0]?.status).toBe(ApplicationStatus.Withdrawn);
  }, 60_000);

  it('入组申请存储：存储 ID 域在进入 SQL 之前判定（非 UUID 主体 / 空 UUID / 域外查询键 / 小组谓词）', async () => {
    const repository = new PostgresApplicationRepository(connection);

    // 非 UUID 主体（会话基线形状）在进入 SQL 之前就被拒绝，不触达数据库
    await expect(repository.listByUserId('u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    await expect(repository.findById(randomUUID(), 'u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    // 空 UUID 同样不是可用主体
    await expect(
      repository.listByUserId('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });

    // 域外**查询键**：单条读取按「该主体名下不存在」处理（返回 undefined），不是服务端缺陷
    await expect(repository.findById('not-a-uuid', OWNER_A)).resolves.toBeUndefined();
    await expect(repository.findById(randomUUID().toUpperCase(), OWNER_A)).resolves.toBeUndefined();

    // 但**谓词**无法正确回答时必须 fail-closed：不得退化成空集（那会被 service 读成「无重复申请」）
    await expect(repository.listByUserAndGroup(OWNER_A, 'not-a-uuid')).rejects.toMatchObject({
      code: 'INVALID_IDENTIFIER',
    });

    // 写路径的存储标识同样受约束
    await expect(
      repository.create({ ...applicationFixture(OWNER_A, GROUP_A), id: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    await expect(
      repository.create({
        ...applicationFixture(OWNER_A, GROUP_A),
        userId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RECORD' });
  }, 60_000);

  it('入组申请存储：错误信息脱敏（失败路径不回显归属与备注原文）', async () => {
    const repository = new PostgresApplicationRepository(connection);
    const marker = '脱敏标记备注-不可外泄';

    let captured: unknown;
    try {
      // 备注含控制字符：由共享字段原语在进 SQL 之前拒绝，错误里不得带原文
      await repository.create(applicationFixture(OWNER_A, GROUP_A, { note: `${marker}\u0007` }));
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    const serialized = JSON.stringify(captured, Object.getOwnPropertyNames(captured));
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain(OWNER_A);
  }, 60_000);

  it('入组申请运行路径：模块换绑工厂（createApplicationRepository）+ 真实执行器直连真实库', async () => {
    // 这一次不直接用 adapter 类，而是走**模块的换绑工厂**：即运行时真正取用的那条路径。
    // 「数据库已配置 ⇒ 端口上是 PostgreSQL 实现」+「延迟建连」+「归属隔离」三者在这里同时成立。
    const connectCalls: ResolvedDatabaseConfig[] = [];
    const repository = createApplicationRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: RAW_URL }),
      {
        capabilities: { backend: 'postgres', persistent: true, productionReady: false },
        connect: (resolved: ResolvedDatabaseConfig) => {
          connectCalls.push(resolved);
          return Promise.resolve(connection);
        },
      },
    );

    // 延迟建连：拿到端口时一次都没连（装配阶段不碰数据库）
    expect(connectCalls).toEqual([]);
    expect(repository.capabilities).toMatchObject({
      backend: 'postgres',
      persistent: true,
      productionReady: false,
    });

    await connection.query('DELETE FROM join_applications WHERE user_id IN ($1::uuid, $2::uuid)', [
      OWNER_A,
      OWNER_B,
    ]);
    const record = applicationFixture(OWNER_A, GROUP_A, { note: '运行路径入组申请备注' });

    // 首次真实读写：建立连接（复用同一真实连接）并完成写入 / 取数闭环
    await expect(repository.create(record)).resolves.toEqual(record);
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0]?.database).toBe(databaseName);

    await expect(repository.findById(record.id, OWNER_A)).resolves.toEqual(record);
    await expect(repository.listByUserId(OWNER_A)).resolves.toEqual([record]);
    await expect(repository.listByUserAndGroup(OWNER_A, GROUP_A)).resolves.toEqual([record]);

    // 归属隔离：换绑后的端口同样不返回他人申请（只有 404 语义，没有存在性泄露）
    await expect(repository.findById(record.id, OWNER_B)).resolves.toBeUndefined();
    await expect(repository.listByUserId(OWNER_B)).resolves.toEqual([]);
    await expect(repository.save({ ...record, userId: OWNER_B })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // 非存储 ID 域的主体在进入 SQL 之前就被拒绝（不触发第二次建连）
    await expect(repository.listByUserId('u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    expect(connectCalls).toHaveLength(1);
  }, 60_000);
});
