/**
 * 连接池的**结构性端口**（驱动无关）。
 *
 * 为什么单独成文件：执行器的所有行为（参数槽、事务、错误收敛）都应该能在**没有真实数据库**
 * 的情况下被穷举测试。把「池」抽象成这里的三四个方法后，测试可以注入确定性替身，
 * 而唯一 import `pg` 的地方被收窄到 `postgres-driver.ts` 一个文件（见
 * `db/persistence/postgres-adapter-registry.ts` 的「驱动导入层」门禁）。
 */

/** 单次查询结果：与 `pg` 的 `QueryResult` 语义对齐，但不依赖它 */
export interface PoolQueryResultLike {
  readonly rows: readonly unknown[];
  readonly rowCount: number | null;
}

/** 池上借出的单个连接 */
export interface PoolClientLike {
  query(text: string, values?: unknown[]): Promise<PoolQueryResultLike>;
  /** 归还连接到池；`destroy` 为真时销毁而不是复用 */
  release(destroy?: boolean): void;
}

/** 连接池的最小能力面 */
export interface PoolLike {
  connect(): Promise<PoolClientLike>;
  query(text: string, values?: unknown[]): Promise<PoolQueryResultLike>;
  end(): Promise<void>;
}

/**
 * 连接档案：执行器交给池工厂的**唯一输入**（已从 `ResolvedDatabaseConfig` 归一化）。
 * 它包含连接串（机密），因此只允许在驱动层与执行器内部流转，不得写日志。
 */
export interface PostgresPoolProfile {
  readonly connectionString: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly applicationName: string;
  readonly poolMax: number;
  readonly connectTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly ssl: 'disable' | 'require' | 'verify-full';
  readonly tlsCaPath?: string;
  readonly tlsCertPath?: string;
  readonly tlsKeyPath?: string;
}

/** 池工厂：真实实现由 `postgres-driver.ts` 提供；测试注入替身 */
export type PostgresPoolFactory = (profile: PostgresPoolProfile) => PoolLike;
