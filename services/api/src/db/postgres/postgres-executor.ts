import {
  type PersistenceCapabilities,
  type SqlConnection,
  type SqlConnectionFactory,
  type SqlExecutor,
  type SqlQueryResult,
} from '../ports/sql-executor.port';
import {
  assertVerifiedSqlExecutor,
  collectSqlExecutorVerificationInput,
  inspectSqlExecutorSurface,
  type SqlExecutorVerificationRegistry,
} from '../ports/sql-executor-verification';
import type { ResolvedDatabaseConfig } from '../config/database-config';
import { extractConnectionSecrets, NODE_POSTGRES_POOL_FACTORY } from './postgres-driver';
import {
  describeRedactedError,
  PostgresExecutorError,
  redactPostgresError,
} from './postgres-error';
import type {
  PoolClientLike,
  PoolLike,
  PostgresPoolFactory,
  PostgresPoolProfile,
} from './postgres-pool';
import { assertQueryParameterSlots, SqlParameterSlotError } from './sql-parameter-slots';

/**
 * 受 **attest 约束**的参数化 SQL 执行器（PostgreSQL）。
 *
 * ## 它提供什么
 * `db/ports/sql-executor.port.ts` 只声明「拿到一个可执行 SQL 的执行器」，本模块把它落到真实驱动上，
 * 并同时满足四件事：
 * 1. **参数化**：值一律走 `$n` 占位符；执行前用 `sql-parameter-slots.ts` 断言「占位符数量与序号」
 *    与传入参数严格配对（`$0`、重复序号、缺号、数量不符一律拒绝），绝不把值拼进 SQL 文本；
 * 2. **事务**：`transaction(run)` 在**专用连接**上 `BEGIN` / `COMMIT` / `ROLLBACK`；
 *    事务内执行器一旦在回调结束后被使用即抛 `EXECUTOR_TRANSACTION_ESCAPED`，
 *    嵌套事务抛 `EXECUTOR_TRANSACTION_NESTED`（PG 没有真正的嵌套事务，静默降级成 savepoint 会让
 *    调用方误以为已回滚）；
 * 3. **连接池**：`pg.Pool` 的池化连接；`statement_timeout` / `query_timeout` / `connectionTimeoutMillis`
 *    全部来自共享配置，卡住的查询由驱动层主动断开；
 * 4. **统一错误脱敏**：任何驱动异常先经 `postgres-error.ts` 收敛 —— 只保留 SQLSTATE、severity、
 *    routine 与结构名（schema/table/column/constraint），丢弃 `detail` / `hint` / `where` / `query`，
 *    并擦除连接串凭据与口令片段；**不把原始错误挂成 `cause`**，避免下游日志把原文带回。
 *
 * ## attest 约束
 * `createPostgresSqlConnectionFactory` 不接受「自称生产可用」的对象字面量：
 * - 它只通过登记表 `attest()` 取得**封存声明**（不可伪造、深度冻结、WeakSet 身份校验）；
 * - 产出后立刻用 `assertVerifiedSqlExecutor` 判定整份契约（封存身份、后端、参数化、事务、
 *   验证来源证据、schema/迁移就绪证据）；证据缺失 / 过期 / 冲突一律抛错，**工厂根本返回不了**；
 * - 每次 `connect()` 交出的连接还要再判一次同一契约（形参槽 + `transaction` 存在性），
 *   因此「换成一个不带参数槽的替身」在运行期同样会被拦下。
 *
 * ## 边界事实
 * - 本文件**不 import `pg`**：驱动只在 `postgres-driver.ts` 里出现，池通过 `PoolLike` 结构端口注入；
 * - `createPostgresConnection`（无 attest）只供**迁移入口与集成测试**使用，业务 adapter 必须拿到
 *   受 attest 约束的工厂（门禁在 `db/persistence/postgres-adapter-registry.ts`）；
 * - 执行器不解析连接串语义、不做重试与熔断：这些属于共享配置与上层职责。
 */

/** 未完成 attest 时的后端标识（迁移入口 / 集成测试的连接如实声明「未验证」） */
export const UNATTESTED_POSTGRES_BACKEND = 'postgres-unattested';

/**
 * 迁移入口 / 集成测试用的核心连接能力声明。
 * 它**不声称生产可用**，因此拿不到执行器契约的封存身份，也不可能被当成生产执行器。
 */
export const UNATTESTED_POSTGRES_CAPABILITIES: PersistenceCapabilities = Object.freeze({
  backend: UNATTESTED_POSTGRES_BACKEND,
  persistent: true,
  productionReady: false,
});

export interface PostgresConnectionOptions {
  readonly profile: PostgresPoolProfile;
  readonly capabilities: PersistenceCapabilities;
  /** 池工厂；省略时使用真实 `pg` 实现 */
  readonly poolFactory?: PostgresPoolFactory;
}

/** `ResolvedDatabaseConfig` → 池档案（唯一一次从共享配置取连接参数） */
export function toPostgresPoolProfile(config: ResolvedDatabaseConfig): PostgresPoolProfile {
  return {
    connectionString: config.connectionString,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    applicationName: config.applicationName,
    poolMax: config.poolMax,
    connectTimeoutMs: config.connectTimeoutMs,
    statementTimeoutMs: config.statementTimeoutMs,
    ssl: config.ssl,
    ...(config.tls.caPath !== undefined ? { tlsCaPath: config.tls.caPath } : {}),
    ...(config.tls.certPath !== undefined ? { tlsCertPath: config.tls.certPath } : {}),
    ...(config.tls.keyPath !== undefined ? { tlsKeyPath: config.tls.keyPath } : {}),
  };
}

function normalizeResult(result: {
  readonly rows?: unknown;
  readonly rowCount?: number | null;
}): SqlQueryResult {
  const rows = result.rows;
  if (!Array.isArray(rows)) {
    throw new PostgresExecutorError(
      'EXECUTOR_RESULT_INVALID',
      '驱动返回的结果缺少 rows 数组：拒绝把不可信结果交给调用方',
    );
  }
  const rowCount = typeof result.rowCount === 'number' ? result.rowCount : rows.length;
  return { rows, rowCount };
}

/** 驱动异常 → 脱敏后的执行器异常（绝不携带原始错误对象） */
function toExecutorError(
  code: 'EXECUTOR_CONNECT_FAILED' | 'EXECUTOR_QUERY_FAILED' | 'EXECUTOR_TRANSACTION_FAILED',
  error: unknown,
  secrets: readonly string[],
): PostgresExecutorError {
  const redacted = redactPostgresError(error, secrets);
  const stage =
    code === 'EXECUTOR_CONNECT_FAILED'
      ? '连接'
      : code === 'EXECUTOR_QUERY_FAILED'
        ? '查询'
        : '事务';
  return new PostgresExecutorError(
    code,
    `PostgreSQL ${stage}失败（已脱敏）：${redacted.description}`,
    [describeRedactedError(redacted)],
  );
}

interface ConnectionState {
  closed: boolean;
  pool?: PoolLike;
  transactionActive: boolean;
}

/**
 * 核心连接构造（**不含 attest**）：只做参数槽、事务、错误脱敏与结果归一化。
 *
 * 仅供迁移入口与集成测试使用；业务 adapter 必须通过 `createPostgresSqlConnectionFactory` 取得
 * 受 attest 约束的工厂。
 */
export function createPostgresConnection(options: PostgresConnectionOptions): SqlConnection {
  const { profile, capabilities } = options;
  const createPool = options.poolFactory ?? NODE_POSTGRES_POOL_FACTORY;
  const secrets = extractConnectionSecrets(profile.connectionString);
  const state: ConnectionState = { closed: false, transactionActive: false };

  const ensurePool = (): PoolLike => {
    if (state.closed) {
      throw new PostgresExecutorError('EXECUTOR_CLOSED', '连接已关闭：不得继续执行 SQL');
    }
    state.pool ??= createPool(profile);
    return state.pool;
  };

  const runOn = async <Row = Record<string, unknown>>(
    client: Pick<PoolClientLike, 'query'>,
    sql: string,
    parameters: readonly unknown[] | undefined,
  ): Promise<SqlQueryResult<Row>> => {
    try {
      assertQueryParameterSlots(sql, parameters);
    } catch (error) {
      if (error instanceof SqlParameterSlotError) {
        throw new PostgresExecutorError(
          'EXECUTOR_PARAMETER_SLOT_MISMATCH',
          `SQL 参数槽与传入参数不配对（${error.issues.length} 项）：拒绝执行`,
          error.issues.map((issue) => ({ code: issue.code, detail: issue.detail })),
        );
      }
      throw error;
    }

    let raw: { readonly rows?: unknown; readonly rowCount?: number | null };
    try {
      raw = await client.query(sql, parameters === undefined ? undefined : [...parameters]);
    } catch (error) {
      throw toExecutorError('EXECUTOR_QUERY_FAILED', error, secrets);
    }
    return normalizeResult(raw) as SqlQueryResult<Row>;
  };

  const connection: SqlConnection = {
    capabilities,
    // `async` 保证 fail-closed 的抛出也表现为**被拒绝的 Promise**：
    // 调用方按接口拿到的是 Promise，不应出现「同步抛错」这种需要 try/catch 两次的形态。
    async query<Row = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<SqlQueryResult<Row>> {
      return runOn<Row>(ensurePool(), sql, parameters);
    },
    async transaction<Result>(run: (executor: SqlExecutor) => Promise<Result>): Promise<Result> {
      const pool = ensurePool();
      if (state.transactionActive) {
        throw new PostgresExecutorError(
          'EXECUTOR_TRANSACTION_NESTED',
          '连接上已有进行中的事务：PG 不支持真正的嵌套事务，拒绝静默降级为 savepoint',
        );
      }
      state.transactionActive = true;

      let client: PoolClientLike;
      try {
        client = await pool.connect();
      } catch (error) {
        state.transactionActive = false;
        throw toExecutorError('EXECUTOR_CONNECT_FAILED', error, secrets);
      }

      let destroy = false;
      let finished = false;
      try {
        try {
          await client.query('BEGIN');
        } catch (error) {
          destroy = true;
          throw toExecutorError('EXECUTOR_TRANSACTION_FAILED', error, secrets);
        }

        const scoped: SqlExecutor = {
          capabilities,
          async query<Row = Record<string, unknown>>(
            sql: string,
            parameters?: readonly unknown[],
          ): Promise<SqlQueryResult<Row>> {
            if (finished) {
              throw new PostgresExecutorError(
                'EXECUTOR_TRANSACTION_ESCAPED',
                '事务回调已结束：事务内执行器不得逃逸出回调继续使用',
              );
            }
            return runOn<Row>(client, sql, parameters);
          },
        };

        let result: Result;
        try {
          result = await run(scoped);
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // 回滚失败：连接状态已不可信，归还时必须销毁
            destroy = true;
          }
          finished = true;
          throw error;
        }

        try {
          await client.query('COMMIT');
        } catch (error) {
          destroy = true;
          throw toExecutorError('EXECUTOR_TRANSACTION_FAILED', error, secrets);
        }
        finished = true;
        return result;
      } finally {
        finished = true;
        state.transactionActive = false;
        client.release(destroy);
      }
    },
    async close() {
      const pool = state.pool;
      state.closed = true;
      state.pool = undefined;
      if (pool !== undefined) {
        await pool.end();
      }
    },
  };

  return connection;
}

export interface PostgresSqlConnectionFactoryOptions {
  /** 共享数据库配置（含 TLS 档位与证书路径） */
  readonly config: ResolvedDatabaseConfig;
  /** 封存身份集合：生产装配只应使用默认登记表 */
  readonly registry: SqlExecutorVerificationRegistry;
  /** 已经登记进 `registry` 的取证结果（见 `postgres-attestation.ts`） */
  readonly attestation: {
    readonly backend: string;
    readonly persistent: boolean;
    readonly productionReady: boolean;
    readonly parameterizedQueries: boolean;
    readonly transactions: boolean;
    readonly evidenceId: string;
    readonly verifiedAt: string;
    readonly readinessId: string;
    readonly checkedAt: string;
  };
  readonly nodeEnv: string;
  /** 判定时刻；省略时取当前时间（测试应显式注入） */
  readonly now?: string;
  readonly label?: string;
  /** 池工厂；省略时使用真实 `pg` 实现 */
  readonly poolFactory?: PostgresPoolFactory;
}

/**
 * 创建**受 attest 约束**的执行器工厂。
 *
 * 步骤：`registry.attest(取证输入)` → 封存声明 → 立刻按执行器契约判定 → 返回工厂。
 * 判定不通过（证据未登记 / 过期 / 迁移版本不一致 / 形参槽不足）时**抛错**，
 * 因此装配层拿不到一个「看起来能用但没被验证过」的执行器。
 */
export function createPostgresSqlConnectionFactory(
  options: PostgresSqlConnectionFactoryOptions,
): SqlConnectionFactory {
  const declaration = options.registry.attest({
    backend: options.attestation.backend,
    persistent: options.attestation.persistent,
    productionReady: options.attestation.productionReady,
    parameterizedQueries: options.attestation.parameterizedQueries,
    transactions: options.attestation.transactions,
    evidenceId: options.attestation.evidenceId,
    verifiedAt: options.attestation.verifiedAt,
    readinessId: options.attestation.readinessId,
    checkedAt: options.attestation.checkedAt,
  });

  const label = options.label ?? 'SQL_CONNECTION_FACTORY';
  const profile = toPostgresPoolProfile(options.config);

  const factory: SqlConnectionFactory = {
    capabilities: declaration,
    async connect(config: ResolvedDatabaseConfig): Promise<SqlConnection> {
      const now = options.now ?? new Date().toISOString();
      if (config.connectionString !== options.config.connectionString) {
        throw new PostgresExecutorError(
          'EXECUTOR_NOT_CONFIGURED',
          'connect() 收到的配置与工厂绑定的共享配置不一致：拒绝把执行器重定向到另一个后端',
        );
      }
      // 工厂层先自证一次（封存身份 + 证据 + 迁移就绪）：证据在装配后被撤下也拦得住
      assertVerifiedSqlExecutor({
        nodeEnv: options.nodeEnv,
        declaration: factory.capabilities,
        surface: inspectSqlExecutorSurface(factory),
        registry: options.registry,
        now,
        requireAttestation: true,
        label,
      });

      const connection = createPostgresConnection({
        profile,
        capabilities: declaration,
        ...(options.poolFactory !== undefined ? { poolFactory: options.poolFactory } : {}),
      });

      // 连接契约：交到业务代码前再判一次（形参槽 ≥ 2 且暴露 transaction）
      const collected = collectSqlExecutorVerificationInput(connection, {
        registry: options.registry,
        nodeEnv: options.nodeEnv,
        now,
        label: `${label}.connection`,
      });
      assertVerifiedSqlExecutor({
        ...(collected ?? {
          nodeEnv: options.nodeEnv,
          declaration: connection.capabilities,
          surface: inspectSqlExecutorSurface(connection),
          registry: options.registry,
          now,
          label,
        }),
        requireAttestation: true,
      });

      return connection;
    },
  };

  return factory;
}
