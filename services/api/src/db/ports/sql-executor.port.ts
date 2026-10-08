import type { ResolvedDatabaseConfig } from '../config/database-config';

/**
 * SQL 连接端口（**与驱动无关**）。
 *
 * 为什么先有端口而不是直接接驱动：ORM / 迁移工具选型（Prisma 与 TypeORM 比较，
 * 见 docs/P2-开源复用评估.md §1）尚未完成，驱动与连接池实现属于未验证依赖。
 * 因此本层只固定「能力声明 + 执行接口」两件事：
 * - 业务 repository adapter（如 `services/api/src/modules/groups/groups.postgres-repository.ts`）
 *   只依赖 `SqlExecutor`，不 import 任何驱动；
 * - 驱动实现（pg / Prisma / TypeORM DataSource）由消费方在**显式注册**后提供，
 *   未注册时拿到的是 `createUnavailableSqlConnectionFactory()` 的 fail-closed 工厂。
 *
 * 边界事实：本端口不解析连接串、不建连接池、不做重试与熔断；它只声明「拿到一个
 * 可执行 SQL 的执行器」这件事，避免把未验证的连接语义提前固化进业务代码。
 */

/** 存储后端能力声明：让上层与运维能机器判定当前后端是否持久化、能否用于生产 */
export interface PersistenceCapabilities {
  /** 后端标识，例如 `in-memory-baseline` / `postgres` / `unverified-driver` */
  readonly backend: string;
  /** 是否跨进程/重启保留（内存实现必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存实现与未验证驱动必须为 false） */
  readonly productionReady: boolean;
}

/** 单次查询结果：行数据 + 影响行数（与 pg 的 `QueryResult` 语义对齐，但不依赖它） */
export interface SqlQueryResult<Row = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

/**
 * SQL 执行器：仓储 adapter 唯一依赖的数据库能力。
 * 参数一律走占位符绑定（`$1`/`$2`...），禁止把值拼进 SQL 字符串。
 */
export interface SqlExecutor {
  readonly capabilities: PersistenceCapabilities;
  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
}

/** 连接：执行器 + 事务边界 + 释放。事务回调内的执行器不得逃逸出回调 */
export interface SqlConnection extends SqlExecutor {
  transaction<Result>(run: (executor: SqlExecutor) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}

/** 连接工厂端口：由消费方显式提供；`connect` 失败必须抛错，不得返回半可用连接 */
export interface SqlConnectionFactory {
  readonly capabilities: PersistenceCapabilities;
  connect(config: ResolvedDatabaseConfig): Promise<SqlConnection>;
}

/**
 * DI 令牌：SQL 连接工厂。
 *
 * 默认绑定 `createUnavailableSqlConnectionFactory(...)`（fail-closed，能力声明为未验证驱动）。
 * 换绑到真实驱动实现属于「启用数据库」这一步，必须同时满足：驱动依赖经评估引入、
 * 连接实现经集成测试验证、能力声明改为 `productionReady = true`；三者缺一不可，
 * 否则 `PersistenceBoundaryService` 会在生产启动阶段拒绝启动。
 */
export const SQL_CONNECTION_FACTORY = Symbol('SQL_CONNECTION_FACTORY');

/** 未注册可用驱动时抛出的错误：让「数据库不可用」显式暴露，而不是静默降级 */
export class DatabaseUnavailableError extends Error {
  readonly code = 'DATABASE_UNAVAILABLE';
  readonly backend: string;

  constructor(backend: string, reason: string) {
    super(`数据库后端不可用（${backend}）：${reason}`);
    this.name = 'DatabaseUnavailableError';
    this.backend = backend;
  }
}

/** 未验证驱动的后端标识：出现在能力声明与错误消息里 */
export const UNVERIFIED_DRIVER_BACKEND = 'unverified-driver';

/**
 * fail-closed 连接工厂：当前项目没有经过验证的数据库驱动，默认注册的就是它。
 *
 * 它如实声明 `persistent = false`、`productionReady = false`，任何 `connect` 调用都抛
 * `DatabaseUnavailableError`。这样：
 * - 运行时不会在无人察觉的情况下把 provider 切到未验证数据库；
 * - 生产环境即使误绑，也会被 `assertPersistenceBoundary` 拦下（能力声明不满足）。
 */
export function createUnavailableSqlConnectionFactory(reason: string): SqlConnectionFactory {
  return {
    capabilities: {
      backend: UNVERIFIED_DRIVER_BACKEND,
      persistent: false,
      productionReady: false,
    },
    connect(): Promise<SqlConnection> {
      return Promise.reject(new DatabaseUnavailableError(UNVERIFIED_DRIVER_BACKEND, reason));
    },
  };
}

/**
 * 生产可用性断言：在把执行器交给业务代码前显式检查能力声明。
 * 非生产环境也执行（能力声明缺失属于代码缺陷，不能等到生产才暴露）。
 */
export function assertProductionReadyExecutor(
  capabilities: PersistenceCapabilities,
  label: string,
  nodeEnv: string,
): void {
  if (nodeEnv !== 'production') {
    return;
  }
  if (!capabilities.persistent || !capabilities.productionReady) {
    throw new DatabaseUnavailableError(
      capabilities.backend,
      `${label} 在 NODE_ENV=production 下未声明为持久且生产可用（persistent=${String(capabilities.persistent)}, productionReady=${String(capabilities.productionReady)}）`,
    );
  }
}
