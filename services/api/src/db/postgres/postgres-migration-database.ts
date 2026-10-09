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
 * ## 全新数据库（记账表缺失）不是错误
 * `schema_migrations` 由迁移 `0001` 建立，因此**刚从零建出来的库里这张表本来就不存在**。
 * 若把「表不存在」当成读取失败，就会出现死锁：要读应用版本就得先有表，要有表就得先执行 `0001`，
 * 要执行 `0001` 又得先读版本。因此 `loadApplied()` 把这种情形如实表达为**空集合**：
 * 「没有记账表」= 「没有任何已应用迁移」，这正是事实，不是猜测。
 *
 * 建表这一步**只由守卫放行的 `0001` 在它自己的事务内完成**（见 `migration-runner.ts`）。
 * 本模块刻意**不**在读取路径上顺手 `CREATE TABLE IF NOT EXISTS`：那等于把 DDL 从唯一的执行侧
 * （迁移部署守卫）手里拿走，会让「哪些 DDL 允许部署」出现第二个不受守卫判定的入口。
 *
 * 只有**记账表缺失**这一种失败被这样处理：连接失败、权限不足、超时、行契约不合法等一律
 * 照原样抛出（驱动错误已在 `postgres-error.ts` 脱敏），由运行入口 fail-closed 上抛。
 *
 * ## 行契约（fail-closed）
 * `schema_migrations` 是**外部可变状态**：版本 / 名称 / 校验和必须是字符串，缺失即拒绝。
 * 解析失败不会被静默跳过 —— 那会把「库里有代码里没有的版本」这类必须人工处理的情况变成
 * 「看起来已同步」。
 */

export const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations';

/**
 * SQLSTATE `undefined_table`（42P01）：记账表尚未建立。
 *
 * 为什么可以只看 SQLSTATE 就判定「全新数据库」：`SCHEMA_MIGRATIONS_SELECT_SQL` 是常量，
 * 它只引用 `schema_migrations` 这一张表（没有函数、没有 CTE、没有其它 relation），
 * 因此这一次读取上的 42P01 只可能表示这张表不存在。
 */
export const SCHEMA_MIGRATIONS_UNDEFINED_TABLE_SQLSTATE = '42P01';

/** 已应用记录读取：只取运行迁移需要的四列，按版本升序 */
export const SCHEMA_MIGRATIONS_SELECT_SQL =
  'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC';

/** 记账写入：参数化（版本 / 名称 / 校验和 / 执行者 / 耗时），值绝不拼进 SQL 文本 */
export const SCHEMA_MIGRATIONS_INSERT_SQL =
  'INSERT INTO schema_migrations (version, name, checksum, applied_by, execution_ms) VALUES ($1, $2, $3, $4, $5)';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 这一次读取失败是否只是「记账表还不存在」（全新数据库）。
 *
 * 判定复用执行器已经脱敏后的结构（SQLSTATE 在 `issues` 里，不含连接串与行取值）：
 * 驱动原文不参与判定，因此这里读到的不是未脱敏的机密。
 */
export function isSchemaMigrationsTableMissing(error: unknown): boolean {
  return (
    error instanceof PostgresExecutorError &&
    error.code === 'EXECUTOR_QUERY_FAILED' &&
    error.issues.some((issue) => issue.code === SCHEMA_MIGRATIONS_UNDEFINED_TABLE_SQLSTATE)
  );
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
      let rows: readonly unknown[];
      try {
        const result = await connection.query(SCHEMA_MIGRATIONS_SELECT_SQL);
        rows = result.rows;
      } catch (error) {
        if (isSchemaMigrationsTableMissing(error)) {
          // 全新数据库：记账表由 0001 bootstrap 在它自己的事务里建立后，才可能有已应用记录。
          return [];
        }
        throw error;
      }
      return rows.map((row) => toMigrationApplication(row));
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
