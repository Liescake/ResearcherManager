import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { MigrationApplication, MigrationDescriptor } from '../migration-boundary';
import {
  loadMigrationStatus,
  MigrationRunnerError,
  runMigrations,
  stripTransactionBoundary,
  versionOfMigrationFile,
  type MigrationDatabasePort,
} from '../migration-runner';
import { resolveMigrationsDirectory } from '../run-migrations';

/**
 * 迁移运行入口：**部署守卫先行** + 事务原子性。
 *
 * 这里用确定性的 `MigrationDatabasePort` 替身，把「守卫拒绝时不写库」「按版本升序执行」
 * 「幂等重跑」「中途失败上抛」四件事固定下来；真实 PostgreSQL 上的原子性由集成测试覆盖。
 */
const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rm-migrations-'));
  temporaryDirectories.push(directory);
  return directory;
}

function migrationContent(version: string, name: string, body: string): string {
  return [
    `-- migration: ${version}_${name}`,
    `-- description: ${name}（测试夹具）`,
    '-- reversible: 否（测试夹具）',
    '-- owner: test',
    '',
    'BEGIN;',
    '',
    body,
    '',
    'COMMIT;',
    '',
  ].join('\n');
}

function writeMigration(directory: string, version: string, name: string, body: string): string {
  const fileName = `${version}_${name}.sql`;
  const content = migrationContent(version, name, body);
  writeFileSync(join(directory, fileName), content, 'utf8');
  return content;
}

class FakeDatabase implements MigrationDatabasePort {
  applied: MigrationApplication[] = [];
  readonly calls: {
    readonly version: string;
    readonly statement: string;
    readonly appliedBy: string;
  }[] = [];
  failOnVersion: string | undefined;
  loadCount = 0;

  loadApplied(): Promise<readonly MigrationApplication[]> {
    this.loadCount += 1;
    return Promise.resolve(this.applied.map((item) => ({ ...item })));
  }

  applyAtomically(input: {
    readonly descriptor: MigrationDescriptor;
    readonly statement: string;
    readonly appliedBy: string;
  }): Promise<{ readonly executionMs: number }> {
    this.calls.push({
      version: input.descriptor.version,
      statement: input.statement,
      appliedBy: input.appliedBy,
    });
    if (this.failOnVersion === input.descriptor.version) {
      return Promise.reject(new Error('synthetic failure'));
    }
    this.applied.push({
      version: input.descriptor.version,
      name: input.descriptor.name,
      checksum: input.descriptor.checksum,
    });
    return Promise.resolve({ executionMs: 7 });
  }
}

describe('stripTransactionBoundary：把事务边界交还给执行器', () => {
  it('摘掉独立成行的 BEGIN/COMMIT，保留语句本体', () => {
    const content = migrationContent('0001', 'create_t', 'CREATE TABLE t (id int);');
    const stripped = stripTransactionBoundary(content);
    expect(stripped).not.toMatch(/^\s*BEGIN\s*;/mu);
    expect(stripped).not.toMatch(/^\s*COMMIT\s*;/mu);
    expect(stripped).toContain('CREATE TABLE t (id int);');
  });

  it('BEGIN/COMMIT 不是独立成行（内联）时拒绝执行，不猜事务位置', () => {
    expect(() => stripTransactionBoundary('BEGIN; SELECT 1; COMMIT;\n')).toThrow(
      MigrationRunnerError,
    );
  });

  it('多段事务拒绝执行', () => {
    const content = 'BEGIN;\nSELECT 1;\nCOMMIT;\nBEGIN;\nSELECT 2;\nCOMMIT;\n';
    expect(() => stripTransactionBoundary(content)).toThrow(MigrationRunnerError);
    expect(() => stripTransactionBoundary(content)).toThrow(/多段事务|独立成行/u);
  });

  it('部分摘除后仍残留 BEGIN/COMMIT 也要拒绝', () => {
    const content = 'BEGIN;\nSELECT 1;\nCOMMIT;\nCOMMIT;\n';
    expect(() => stripTransactionBoundary(content)).toThrow(MigrationRunnerError);
  });
});

describe('versionOfMigrationFile', () => {
  it('只从合法命名里取版本号', () => {
    expect(versionOfMigrationFile('0007_add_index.sql')).toBe('0007');
    expect(versionOfMigrationFile('bad-name.sql')).toBeUndefined();
  });
});

describe('runMigrations：守卫先行', () => {
  it('草案（*.draft.sql）被守卫拒绝：一个迁移都不执行', async () => {
    const directory = makeDirectory();
    writeFileSync(join(directory, '0001_thing.draft.sql'), 'select 1;\n', 'utf8');
    const database = new FakeDatabase();

    await expect(
      runMigrations({
        environment: 'development',
        sourceDirectory: directory,
        database,
        appliedBy: 'test',
      }),
    ).rejects.toMatchObject({ code: 'RUN_GUARD_REJECTED' });
    expect(database.calls).toEqual([]);
  });

  it('危险非事务 DDL（CREATE INDEX CONCURRENTLY）被守卫拒绝：一个迁移都不执行', async () => {
    const directory = makeDirectory();
    writeMigration(directory, '0001', 'bad_index', 'CREATE INDEX CONCURRENTLY idx ON t (a);');
    const database = new FakeDatabase();

    await expect(
      runMigrations({
        environment: 'development',
        sourceDirectory: directory,
        database,
        appliedBy: 'test',
      }),
    ).rejects.toMatchObject({ code: 'RUN_GUARD_REJECTED' });
    expect(database.calls).toEqual([]);
  });

  it('已应用迁移的内容被改写（校验和不一致）：拒绝执行，不自动覆盖', async () => {
    const directory = makeDirectory();
    const content = writeMigration(directory, '0001', 'create_t', 'CREATE TABLE t (id int);');
    const database = new FakeDatabase();
    database.applied = [{ version: '0001', name: 'create_t', checksum: 'f'.repeat(64) }];
    expect(content).toBeTruthy();

    await expect(
      runMigrations({
        environment: 'development',
        sourceDirectory: directory,
        database,
        appliedBy: 'test',
      }),
    ).rejects.toMatchObject({ code: 'RUN_GUARD_REJECTED' });
    expect(database.calls).toEqual([]);
  });

  it('库里有代码里没有的版本：拒绝执行（可能回退到旧版本）', async () => {
    const directory = makeDirectory();
    writeMigration(directory, '0001', 'create_t', 'CREATE TABLE t (id int);');
    const database = new FakeDatabase();
    database.applied = [{ version: '0009', name: 'gone', checksum: 'a'.repeat(64) }];

    await expect(
      runMigrations({
        environment: 'development',
        sourceDirectory: directory,
        database,
        appliedBy: 'test',
      }),
    ).rejects.toMatchObject({ code: 'RUN_GUARD_REJECTED' });
    expect(database.calls).toEqual([]);
  });
});

describe('runMigrations：执行与幂等', () => {
  it('按版本升序执行待应用集合，并透传 appliedBy 与摘除事务后的语句', async () => {
    const directory = makeDirectory();
    writeMigration(directory, '0001', 'create_a', 'CREATE TABLE IF NOT EXISTS a (id int);');
    writeMigration(directory, '0002', 'create_b', 'CREATE TABLE IF NOT EXISTS b (id int);');
    const database = new FakeDatabase();

    const report = await runMigrations({
      environment: 'development',
      sourceDirectory: directory,
      database,
      appliedBy: 'ci-run-1',
    });

    expect(report.ok).toBe(true);
    expect(report.dryRun).toBe(false);
    expect(report.executed.map((item) => item.version)).toEqual(['0001', '0002']);
    expect(report.appliedBefore).toEqual([]);
    expect(report.appliedAfter).toEqual(['0001', '0002']);
    expect(database.calls.map((item) => item.version)).toEqual(['0001', '0002']);
    expect(database.calls[0]?.appliedBy).toBe('ci-run-1');
    expect(database.calls[0]?.statement).not.toMatch(/^\s*BEGIN\s*;/mu);
    // 守卫的执行顺序 = 待执行集合按版本升序
    expect(report.executionOrder).toEqual(['0001', '0002']);
  });

  it('重复执行是幂等的：已应用集合被跳过，不再写库', async () => {
    const directory = makeDirectory();
    writeMigration(directory, '0001', 'create_a', 'CREATE TABLE IF NOT EXISTS a (id int);');
    const database = new FakeDatabase();
    await runMigrations({
      environment: 'development',
      sourceDirectory: directory,
      database,
      appliedBy: 'test',
    });
    const appliedAfterFirst = database.applied.length;

    const second = await runMigrations({
      environment: 'development',
      sourceDirectory: directory,
      database,
      appliedBy: 'test',
    });
    expect(second.executed).toEqual([]);
    expect(database.applied).toHaveLength(appliedAfterFirst);
    expect(database.calls).toHaveLength(1);
  });

  it('dry-run 只判定不执行：给出待执行集合，但一次写库都没有', async () => {
    const directory = makeDirectory();
    writeMigration(directory, '0001', 'create_a', 'CREATE TABLE IF NOT EXISTS a (id int);');
    const database = new FakeDatabase();

    const report = await runMigrations({
      environment: 'development',
      sourceDirectory: directory,
      database,
      appliedBy: 'test',
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.pendingVersions).toEqual(['0001']);
    expect(report.executed).toEqual([]);
    expect(database.calls).toEqual([]);
  });

  it('某条迁移失败即整体上抛，失败版本不会被记为已应用（由事务实现保证）', async () => {
    const directory = makeDirectory();
    writeMigration(directory, '0001', 'create_a', 'CREATE TABLE IF NOT EXISTS a (id int);');
    writeMigration(directory, '0002', 'create_b', 'CREATE TABLE IF NOT EXISTS b (id int);');
    const database = new FakeDatabase();
    database.failOnVersion = '0002';

    await expect(
      runMigrations({
        environment: 'development',
        sourceDirectory: directory,
        database,
        appliedBy: 'test',
      }),
    ).rejects.toMatchObject({ code: 'RUN_APPLY_FAILED' });
    expect(database.applied.map((item) => item.version)).toEqual(['0001']);
  });

  it('未知部署环境被守卫拒绝（不猜测守卫强度）', async () => {
    const directory = makeDirectory();
    writeMigration(directory, '0001', 'create_a', 'CREATE TABLE IF NOT EXISTS a (id int);');
    const database = new FakeDatabase();
    await expect(
      runMigrations({
        environment: 'nowhere',
        sourceDirectory: directory,
        database,
        appliedBy: 'test',
      }),
    ).rejects.toMatchObject({ code: 'RUN_GUARD_REJECTED' });
    expect(database.calls).toEqual([]);
  });
});

describe('仓库真实迁移目录', () => {
  it('db/migrations 通过部署守卫，并可在空库上按序执行', async () => {
    const database = new FakeDatabase();
    const report = await runMigrations({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database,
      appliedBy: 'unit-test',
    });
    expect(report.guard.violations).toEqual([]);
    expect(report.executed.map((item) => item.version)).toContain('0001');
    expect(database.calls[0]?.statement).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
  });

  it('loadMigrationStatus 只读：报告已应用与待执行版本，不写库', async () => {
    const database = new FakeDatabase();
    const status = await loadMigrationStatus({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database,
      appliedBy: 'unit-test',
    });
    expect(status.applied).toEqual([]);
    expect(status.pending).toContain('0001');
    expect(status.upToDate).toBe(false);
    expect(database.calls).toEqual([]);
  });
});
