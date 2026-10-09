import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SqlConnection, SqlExecutor, SqlQueryResult } from '../../ports/sql-executor.port';
import {
  loadMigrationStatus,
  MigrationRunnerError,
  runMigrations,
  type MigrationDatabasePort,
} from '../../migrations/migration-runner';
import { resolveMigrationsDirectory } from '../../migrations/run-migrations';
import {
  createPostgresMigrationDatabase,
  SCHEMA_MIGRATIONS_INSERT_SQL,
  SCHEMA_MIGRATIONS_SELECT_SQL,
  SCHEMA_MIGRATIONS_UNDEFINED_TABLE_SQLSTATE,
} from '../postgres-migration-database';
import { PostgresExecutorError } from '../postgres-error';

/**
 * 迁移数据库端口的回归测试（**不连数据库**：用确定性替身模拟真实 PostgreSQL 的记账表语义）。
 *
 * ## 这份测试固定的是哪个缺陷
 * 记账表 `schema_migrations` 由迁移 `0001` 建立，所以**全新数据库里它本来就不存在**。
 * 修复前 `loadApplied()` 直接 `SELECT ... FROM schema_migrations`，空库上抛
 * `EXECUTOR_QUERY_FAILED`（`relation "schema_migrations" does not exist`），于是
 * `db:migrate` / `db:migrate:status` 与真实库集成测试**在第一步就失败**，
 * `0001` 永远没机会执行 —— 鸡生蛋死锁。这里把修复后的契约钉死：
 * 1. 空库（42P01）= **空集合**，不是错误；
 * 2. `0001` 的建表语句与它的记账写入**在同一个事务内、且建表在前**；
 * 3. 除「记账表缺失」以外的读取失败仍然 fail-closed，且错误文本已脱敏；
 * 4. 守卫拒绝时一个 SQL 都不执行（连建表都不许发生）。
 *
 * 替身刻意模拟「真实 PG 的可见性」：事务提交前不改变对外可见状态，回滚后恢复快照。
 * 真实 PostgreSQL 上的同一路径另有集成测试与 CLI 实测覆盖（见 `postgres-integration.spec.ts`）。
 */

/** 迁移文件的 0001 建表语句特征（与 `db/migrations/0001_bootstrap.sql` 一致） */
const LEDGER_CREATE_PATTERN = /CREATE TABLE IF NOT EXISTS schema_migrations/u;

/** 集成测试里的「必然失败」语句：替身据此模拟事务内失败 */
const DIVISION_BY_ZERO_PATTERN = /1\s*\/\s*0/u;

/** 42P01（undefined_table）：与真实驱动在空库上给出的一致（结构名可外发，不含取值） */
function ledgerMissingError(): PostgresExecutorError {
  return new PostgresExecutorError(
    'EXECUTOR_QUERY_FAILED',
    'PostgreSQL 查询失败（已脱敏）：relation "schema_migrations" does not exist',
    [
      {
        code: SCHEMA_MIGRATIONS_UNDEFINED_TABLE_SQLSTATE,
        detail: 'sqlstate=42P01 routine=parserOpenTable',
      },
    ],
  );
}

interface LedgerRow {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
}

/**
 * 模拟真实 PostgreSQL 的记账表连接。
 *
 * - 事务外只允许出现「读记账表」这一条 SQL（出现别的语句说明端口在绕过事务做 DDL）；
 * - 事务内维护快照：回调失败即回滚（建表与记账都退回），成功才对外可见；
 * - 只认识 `schema_migrations`，业务 DDL 一律记入日志并「成功」（不需要真的建表）。
 */
class StubLedgerConnection implements SqlConnection {
  readonly capabilities = Object.freeze({
    backend: 'stub-ledger',
    persistent: false,
    productionReady: false,
  });

  ledgerPresent = false;
  rows: LedgerRow[] = [];
  /** 事务内执行过的迁移语句（按顺序） */
  readonly executedStatements: string[] = [];
  /** 事务外执行过的 SQL（应当只有读记账表） */
  readonly outsideStatements: string[] = [];
  /** 事务边界日志：BEGIN / COMMIT / ROLLBACK 与语句交错，用于证明「建表与记账同事务」 */
  readonly log: string[] = [];
  transactions = 0;
  closed = false;
  /** 注入读取失败（模拟权限不足、连接中断等） */
  readFailure: PostgresExecutorError | undefined;

  async query<Row = Record<string, unknown>>(
    sql: string,
    _parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    this.outsideStatements.push(sql);
    if (this.readFailure !== undefined) {
      throw this.readFailure;
    }
    if (sql !== SCHEMA_MIGRATIONS_SELECT_SQL) {
      throw new PostgresExecutorError(
        'EXECUTOR_QUERY_FAILED',
        `事务外出现非预期的 SQL（端口不得在事务外 DDL）：${sql}`,
      );
    }
    if (!this.ledgerPresent) {
      throw ledgerMissingError();
    }
    return {
      rows: this.rows.map((row) => ({ ...row })) as unknown as Row[],
      rowCount: this.rows.length,
    };
  }

  async transaction<Result>(run: (executor: SqlExecutor) => Promise<Result>): Promise<Result> {
    this.transactions += 1;
    this.log.push('BEGIN');
    const snapshot = {
      ledgerPresent: this.ledgerPresent,
      rows: this.rows.map((row) => ({ ...row })),
    };

    const executor: SqlExecutor = {
      capabilities: this.capabilities,
      query: async <Row = Record<string, unknown>>(
        sql: string,
        parameters?: readonly unknown[],
      ): Promise<SqlQueryResult<Row>> => {
        this.executedStatements.push(sql);
        this.log.push(
          sql.includes('INSERT INTO schema_migrations') ? 'INSERT schema_migrations' : 'DDL',
        );

        if (DIVISION_BY_ZERO_PATTERN.test(sql)) {
          throw new Error('division by zero');
        }
        if (LEDGER_CREATE_PATTERN.test(sql)) {
          this.ledgerPresent = true;
          return { rows: [] as Row[], rowCount: 0 };
        }
        if (sql === SCHEMA_MIGRATIONS_INSERT_SQL) {
          this.rows.push({
            version: String(parameters?.[0] ?? ''),
            name: String(parameters?.[1] ?? ''),
            checksum: String(parameters?.[2] ?? ''),
            applied_at: new Date(),
          });
          return { rows: [] as Row[], rowCount: 1 };
        }
        return { rows: [] as Row[], rowCount: 0 };
      },
    };

    try {
      const result = await run(executor);
      this.log.push('COMMIT');
      return result;
    } catch (error) {
      // 事务失败：建表与记账一并回滚（真实 PG 的 DDL 是事务性的）
      this.ledgerPresent = snapshot.ledgerPresent;
      this.rows = snapshot.rows;
      this.log.push('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rm-ledger-'));
  temporaryDirectories.push(directory);
  return directory;
}

function makeDatabase(connection: StubLedgerConnection): MigrationDatabasePort {
  return createPostgresMigrationDatabase(connection);
}

describe('createPostgresMigrationDatabase：全新数据库（记账表缺失）', () => {
  it('loadApplied 把 42P01 表达为空集合，而不是抛错', async () => {
    const connection = new StubLedgerConnection();
    const database = makeDatabase(connection);

    await expect(database.loadApplied()).resolves.toEqual([]);
    // 读取仍然真的下发过（不是凭空返回空）：只是把「表不存在」翻译成「没有已应用记录」
    expect(connection.outsideStatements).toEqual([SCHEMA_MIGRATIONS_SELECT_SQL]);
    expect(connection.ledgerPresent).toBe(false);
    expect(connection.transactions).toBe(0);
  });

  it('空库 bootstrap：先执行 0001 建表并记账（同一事务、建表在前），再读应用版本', async () => {
    const connection = new StubLedgerConnection();
    const database = makeDatabase(connection);

    const report = await runMigrations({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database,
      appliedBy: 'unit-test',
    });

    // 第一次读取发生在记账表缺失时 → 如实为空集合；0001 因此成为第一个待执行版本
    expect(report.appliedBefore).toEqual([]);
    expect(report.executionOrder[0]).toBe('0001');
    expect(report.executed.map((item) => item.version)).toEqual([
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
    expect(report.appliedAfter).toEqual([
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

    // 记账表由 0001 建立，且建表之后就写入了 0001 的记账行（同事务）
    expect(connection.ledgerPresent).toBe(true);
    const firstStatement = connection.executedStatements[0] ?? '';
    expect(firstStatement).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
    expect(connection.log.slice(0, 4)).toEqual([
      'BEGIN',
      'DDL',
      'INSERT schema_migrations',
      'COMMIT',
    ]);

    // 每条迁移一个事务；事务外只有「读记账表」两次（执行前 / 执行后）
    expect(connection.transactions).toBe(14);
    expect(connection.outsideStatements).toEqual([
      SCHEMA_MIGRATIONS_SELECT_SQL,
      SCHEMA_MIGRATIONS_SELECT_SQL,
    ]);
  });

  it('空库上 dry-run 与 status 都只判定不写库', async () => {
    const connection = new StubLedgerConnection();
    const database = makeDatabase(connection);

    const status = await loadMigrationStatus({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database,
      appliedBy: 'unit-test',
    });
    expect(status.applied).toEqual([]);
    expect(status.pending).toEqual([
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
    expect(status.upToDate).toBe(false);

    const dryRun = await runMigrations({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database,
      appliedBy: 'unit-test',
      dryRun: true,
    });
    expect(dryRun.executed).toEqual([]);

    expect(connection.transactions).toBe(0);
    expect(connection.ledgerPresent).toBe(false);
  });
});

describe('createPostgresMigrationDatabase：重复 status 与幂等重跑', () => {
  it('bootstrap 之后的重复 status 结果稳定，且不产生任何写事务', async () => {
    const connection = new StubLedgerConnection();
    const database = makeDatabase(connection);
    await runMigrations({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database,
      appliedBy: 'unit-test',
    });
    const transactionsAfterApply = connection.transactions;

    const first = await loadMigrationStatus({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database,
      appliedBy: 'unit-test',
    });
    const second = await loadMigrationStatus({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database,
      appliedBy: 'unit-test',
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
    expect(first.applied).toEqual(versions);
    expect(first.upToDate).toBe(true);
    expect(second).toEqual(first);
    expect(connection.transactions).toBe(transactionsAfterApply);

    const again = await runMigrations({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database,
      appliedBy: 'unit-test',
    });
    expect(again.executed).toEqual([]);
    expect(again.appliedAfter).toEqual(versions);
    expect(connection.transactions).toBe(transactionsAfterApply);
  });
});

describe('createPostgresMigrationDatabase：守卫拒绝与读取失败', () => {
  it('空库上守卫拒绝时一个 SQL 都不执行（连建表都不发生）', async () => {
    const directory = makeDirectory();
    writeFileSync(join(directory, '0001_thing.draft.sql'), 'select 1;\n', 'utf8');
    const connection = new StubLedgerConnection();

    await expect(
      runMigrations({
        environment: 'test',
        sourceDirectory: directory,
        database: makeDatabase(connection),
        appliedBy: 'unit-test',
      }),
    ).rejects.toMatchObject({ code: 'RUN_GUARD_REJECTED' });

    expect(connection.transactions).toBe(0);
    expect(connection.executedStatements).toEqual([]);
    expect(connection.ledgerPresent).toBe(false);
    expect(connection.rows).toEqual([]);
  });

  it('已应用的记账行被改写（校验和不一致）时守卫拒绝执行', async () => {
    const directory = makeDirectory();
    writeFileSync(
      join(directory, '0001_create_t.sql'),
      [
        '-- migration: 0001_create_t',
        '-- description: 测试夹具',
        '-- reversible: 否（测试夹具）',
        '-- owner: unit-test',
        '',
        'BEGIN;',
        'CREATE TABLE IF NOT EXISTS t (id int);',
        'COMMIT;',
        '',
      ].join('\n'),
      'utf8',
    );
    const connection = new StubLedgerConnection();
    connection.ledgerPresent = true;
    connection.rows = [
      { version: '0001', name: 'create_t', checksum: 'f'.repeat(64), applied_at: new Date() },
    ];

    await expect(
      runMigrations({
        environment: 'test',
        sourceDirectory: directory,
        database: makeDatabase(connection),
        appliedBy: 'unit-test',
      }),
    ).rejects.toMatchObject({ code: 'RUN_GUARD_REJECTED' });
    expect(connection.transactions).toBe(0);
  });

  it('非 42P01 的读取失败不被当成空库：fail-closed 且错误已脱敏', async () => {
    const connection = new StubLedgerConnection();
    connection.readFailure = new PostgresExecutorError(
      'EXECUTOR_QUERY_FAILED',
      'PostgreSQL 查询失败（已脱敏）：permission denied for table schema_migrations',
      [{ code: '42501', detail: 'sqlstate=42501 routine=aclcheck_error' }],
    );
    const database = makeDatabase(connection);

    await expect(database.loadApplied()).rejects.toBeInstanceOf(PostgresExecutorError);

    let captured: unknown;
    try {
      await runMigrations({
        environment: 'test',
        sourceDirectory: resolveMigrationsDirectory(),
        database,
        appliedBy: 'unit-test',
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(MigrationRunnerError);
    const runnerError = captured as MigrationRunnerError;
    expect(runnerError.code).toBe('RUN_APPLIED_READ_FAILED');
    expect(runnerError.message).toContain('状态未知');
    // 脱敏：细节里只有 SQLSTATE 与结构名，不含连接串 / 口令 / SQL 取值
    expect(runnerError.issues[0]?.detail).toContain('42501');
    expect(JSON.stringify(runnerError.issues)).not.toContain('postgresql://');
    expect(connection.transactions).toBe(0);

    await expect(
      loadMigrationStatus({
        environment: 'test',
        sourceDirectory: resolveMigrationsDirectory(),
        database,
        appliedBy: 'unit-test',
      }),
    ).rejects.toMatchObject({ code: 'RUN_APPLIED_READ_FAILED' });
  });

  it('迁移失败整体回滚：半成品记账表与记账行都不留下', async () => {
    const directory = makeDirectory();
    writeFileSync(
      join(directory, '0001_bootstrap.sql'),
      [
        '-- migration: 0001_bootstrap',
        '-- description: 建立迁移记录表（测试夹具）',
        '-- reversible: 是（DROP TABLE schema_migrations）',
        '-- owner: unit-test',
        '',
        'BEGIN;',
        'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY);',
        'COMMIT;',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(directory, '0002_boom.sql'),
      [
        '-- migration: 0002_boom',
        '-- description: 必然失败的迁移（测试夹具）',
        '-- reversible: 否（测试夹具）',
        '-- owner: unit-test',
        '',
        'BEGIN;',
        'CREATE TABLE rm_should_not_exist (id int PRIMARY KEY);',
        'SELECT 1 / 0;',
        'COMMIT;',
        '',
      ].join('\n'),
      'utf8',
    );
    const connection = new StubLedgerConnection();

    await expect(
      runMigrations({
        environment: 'test',
        sourceDirectory: directory,
        database: makeDatabase(connection),
        appliedBy: 'unit-test',
      }),
    ).rejects.toMatchObject({ code: 'RUN_APPLY_FAILED' });

    // 0001 已提交并留下记账行；0002 失败后既无记账行，也没有把失败事务里的状态泄露出来
    expect(connection.rows.map((row) => row.version)).toEqual(['0001']);
    expect(connection.log.at(-1)).toBe('ROLLBACK');
    expect(connection.transactions).toBe(2);
  });
});
