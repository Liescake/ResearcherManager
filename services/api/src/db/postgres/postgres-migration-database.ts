import type { SqlConnection } from '../ports/sql-executor.port';
import type { MigrationApplication, MigrationDescriptor } from '../migrations/migration-boundary';
import type { MigrationDatabasePort } from '../migrations/migration-runner';
import { PostgresExecutorError } from './postgres-error';

/**
 * `MigrationDatabasePort` 的 PostgreSQL 实现（**不 import `pg`**：只依赖 `SqlExecutor` 端口）。
 *
 * ## 记账与原子性
 * PostgreSQL 的 DDL 是事务性的（`CREATE TABLE` 可以回滚），因此每条迁移都在**一个事务**里完成：
 * 执行迁移语句 → 写入 `schema_migrations` 记录 → 提交。任何一步失败都会整体回滚，
 * 不会出现「表建好了但没有迁移记录」或反之的半成品状态。
 *
 * ## 行契约（fail-closed）
 * `schema_migrations` 是**外部可变状态**：版本 / 名称 / 校验和必须是字符串，缺失即拒绝。
 * 解析失败不会被静默跳过 —— 那会把「库里有代码里没有的版本」这类必须人工处理的情况变成
 * 「看起来已同步」。
 */

export const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations';

/** 已应用记录读取：只取运行迁移需要的四列，按版本升序 */
export const SCHEMA_MIGRATIONS_SELECT_SQL =
  'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC';

/** 记账写入：参数化（版本 / 名称 / 校验和 / 执行者 / 耗时），值绝不拼进 SQL 文本 */
export const SCHEMA_MIGRATIONS_INSERT_SQL =
  'INSERT INTO schema_migrations (version, name, checksum, applied_by, execution_ms) VALUES ($1, $2, $3, $4, $5)';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value === '') {
    throw new PostgresExecutorError(
      'EXECUTOR_RESULT_INVALID',
      `${SCHEMA_MIGRATIONS_TABLE} 行缺少合法的 ${key} 列：迁移状态不可信，拒绝继续`,
    );
  }
  return value;
}

function readAppliedAt(row: Record<string, unknown>): string | undefined {
  const value = row['applied_at'];
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function toMigrationApplication(row: unknown): MigrationApplication {
  if (!isRecord(row)) {
    throw new PostgresExecutorError(
      'EXECUTOR_RESULT_INVALID',
      `${SCHEMA_MIGRATIONS_TABLE} 返回了非对象行：迁移状态不可信，拒绝继续`,
    );
  }
  const appliedAt = readAppliedAt(row);
  return {
    version: readRequiredString(row, 'version'),
    name: readRequiredString(row, 'name'),
    checksum: readRequiredString(row, 'checksum'),
    ...(appliedAt !== undefined ? { appliedAt } : {}),
  };
}

/** 用执行器构造真实的迁移数据库端口（迁移 CLI 与集成测试共用） */
export function createPostgresMigrationDatabase(connection: SqlConnection): MigrationDatabasePort {
  return {
    async loadApplied(): Promise<readonly MigrationApplication[]> {
      const result = await connection.query(SCHEMA_MIGRATIONS_SELECT_SQL);
      return result.rows.map((row) => toMigrationApplication(row));
    },

    async applyAtomically(input: {
      readonly descriptor: MigrationDescriptor;
      readonly statement: string;
      readonly appliedBy: string;
    }): Promise<{ readonly executionMs: number }> {
      const startedAt = Date.now();
      return connection.transaction(async (executor) => {
        await executor.query(input.statement);
        const executionMs = Date.now() - startedAt;
        await executor.query(SCHEMA_MIGRATIONS_INSERT_SQL, [
          input.descriptor.version,
          input.descriptor.name,
          input.descriptor.checksum,
          input.appliedBy,
          executionMs,
        ]);
        return { executionMs };
      });
    },
  };
}
