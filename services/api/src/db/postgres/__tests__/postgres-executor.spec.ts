import { describe, expect, it, vi } from 'vitest';
import type { ResolvedDatabaseConfig } from '../../config/database-config';
import {
  createSqlExecutorVerificationRegistry,
  SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
  SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
  SqlExecutorVerificationError,
  type SqlExecutorVerificationRegistry,
} from '../../ports/sql-executor-verification';
import {
  registerPostgresExecutorAttestation,
  type PostgresExecutorAttestationFacts,
} from '../postgres-attestation';
import {
  createPostgresConnection,
  createPostgresSqlConnectionFactory,
  toPostgresPoolProfile,
  UNATTESTED_POSTGRES_CAPABILITIES,
} from '../postgres-executor';
import { PostgresExecutorError } from '../postgres-error';
import type {
  PoolClientLike,
  PoolLike,
  PoolQueryResultLike,
  PostgresPoolFactory,
  PostgresPoolProfile,
} from '../postgres-pool';

/**
 * 执行器单元测试：**不连数据库**，用确定性池替身穷举行为。
 *
 * 覆盖四类必须在交付前证明的性质：
 * 1. 参数化：参数槽与传入参数不配对时**一个 SQL 都不下发**；
 * 2. 事务：`BEGIN/COMMIT/ROLLBACK` 的真实到达顺序、逃逸与嵌套拒绝、回滚失败时销毁连接；
 * 3. 脱敏：驱动异常只输出 SQLSTATE 与结构名，不携带连接串/口令/驱动原文；
 * 4. attest 约束：证据缺失、证据过期、迁移就绪不一致时**工厂根本创建不出来**。
 */
const CONNECTION_STRING =
  'postgresql://rm_user:sup3r-s3cret@db.example.com:5432/researcher_manager';

const CONFIG: ResolvedDatabaseConfig = {
  connectionString: CONNECTION_STRING,
  host: 'db.example.com',
  port: 5432,
  database: 'researcher_manager',
  user: 'rm_user',
  ssl: 'require',
  tls: {},
  poolMax: 5,
  connectTimeoutMs: 1000,
  statementTimeoutMs: 1000,
  applicationName: 'researcher-manager-test',
  redactedUrl: 'postgresql://***:***@db.example.com:5432/researcher_manager',
};

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

interface FakePool {
  readonly pool: PoolLike;
  readonly queries: RecordedQuery[];
  readonly releases: boolean[];
  connectionCount: number;
}

function createFakePool(
  handler: (text: string, values: readonly unknown[] | undefined) => PoolQueryResultLike,
  options: { readonly rollbackFails?: boolean } = {},
): FakePool {
  const queries: RecordedQuery[] = [];
  const releases: boolean[] = [];
  const state = { connectionCount: 0 };

  const run = (text: string, values: readonly unknown[] | undefined): PoolQueryResultLike => {
    queries.push({ text, values });
    if (text === 'ROLLBACK' && options.rollbackFails === true) {
      throw Object.assign(new Error('rollback failed'), { code: '08006' });
    }
    return handler(text, values);
  };

  const pool: PoolLike = {
    connect(): Promise<PoolClientLike> {
      state.connectionCount += 1;
      return Promise.resolve({
        query: (text, values) => Promise.resolve(run(text, values)),
        release: (destroy) => {
          releases.push(destroy ?? false);
        },
      });
    },
    query: (text, values) => Promise.resolve(run(text, values)),
    end: () => Promise.resolve(),
  };

  return {
    pool,
    queries,
    releases,
    get connectionCount() {
      return state.connectionCount;
    },
  };
}

function rows(values: readonly Record<string, unknown>[]): PoolQueryResultLike {
  return { rows: values, rowCount: values.length };
}

const FACTS: PostgresExecutorAttestationFacts = {
  evidenceId: 'ev-postgres-executor-1',
  verifiedBy: 'ci/integration',
  verifiedAt: new Date().toISOString(),
  evidenceRef: 'services/api/src/db/postgres/__tests__/postgres-integration.spec.ts',
  readinessId: 'rd-postgres-schema-1',
  checkedBy: 'ci/integration',
  checkedAt: new Date().toISOString(),
  readinessRef: 'pnpm db:migrate:status',
  availableVersions: ['0001'],
  appliedVersions: ['0001'],
};

function attestedRegistry(
  overrides: Partial<PostgresExecutorAttestationFacts> = {},
): SqlExecutorVerificationRegistry {
  const registry = createSqlExecutorVerificationRegistry();
  registerPostgresExecutorAttestation(registry, {
    facts: { ...FACTS, ...overrides },
    method: 'integration-test',
  });
  return registry;
}

function attestedOptions(
  registry: SqlExecutorVerificationRegistry,
  poolFactory: PostgresPoolFactory,
  config: ResolvedDatabaseConfig = CONFIG,
): Parameters<typeof createPostgresSqlConnectionFactory>[0] {
  return {
    config,
    registry,
    attestation: {
      backend: 'postgres',
      persistent: true,
      productionReady: true,
      parameterizedQueries: true,
      transactions: true,
      evidenceId: FACTS.evidenceId,
      verifiedAt: FACTS.verifiedAt,
      readinessId: FACTS.readinessId,
      checkedAt: FACTS.checkedAt,
    },
    nodeEnv: 'test',
    poolFactory,
  };
}

describe('参数化：参数槽与传入参数必须严格配对', () => {
  it('配对时按占位符绑定下发（SQL 文本与参数原样交给驱动，绝不拼接）', async () => {
    const fake = createFakePool(() => rows([{ one: 1 }]));
    const connection = createPostgresConnection({
      profile: toPostgresPoolProfile(CONFIG),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
      poolFactory: () => fake.pool,
    });

    const result = await connection.query('SELECT $1::uuid AS owner', [
      '11111111-1111-1111-1111-111111111111',
    ]);
    expect(result.rowCount).toBe(1);
    expect(fake.queries).toEqual([
      {
        text: 'SELECT $1::uuid AS owner',
        values: ['11111111-1111-1111-1111-111111111111'],
      },
    ]);
  });

  it('槽位与参数数量不符 / 缺号 / $0：抛 EXECUTOR_PARAMETER_SLOT_MISMATCH 且一个 SQL 都不下发', async () => {
    const fake = createFakePool(() => rows([]));
    const connection = createPostgresConnection({
      profile: toPostgresPoolProfile(CONFIG),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
      poolFactory: () => fake.pool,
    });

    for (const [sql, parameters] of [
      ['SELECT $1, $2', ['only-one']],
      ['SELECT $1, $3', ['a', 'b']],
      ['SELECT $0', [1]],
    ] as const) {
      await expect(connection.query(sql, parameters)).rejects.toBeInstanceOf(PostgresExecutorError);
    }
    expect(fake.queries).toEqual([]);
  });

  it('驱动返回非法结果形状（缺 rows 数组）时判 EXECUTOR_RESULT_INVALID', async () => {
    // 驱动/替身返回缺 rows 数组的结果：模拟实现缺陷
    const malformed = { rowCount: 0 } as unknown as PoolQueryResultLike;
    const fake = createFakePool(() => malformed);
    const connection = createPostgresConnection({
      profile: toPostgresPoolProfile(CONFIG),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
      poolFactory: () => fake.pool,
    });
    await expect(connection.query('SELECT 1')).rejects.toMatchObject({
      code: 'EXECUTOR_RESULT_INVALID',
    });
  });
});

describe('事务：BEGIN / COMMIT / ROLLBACK 与逃逸、嵌套、销毁', () => {
  it('成功路径按 BEGIN → 语句 → COMMIT 顺序下发，并把连接归还池', async () => {
    const fake = createFakePool(() => rows([]));
    const connection = createPostgresConnection({
      profile: toPostgresPoolProfile(CONFIG),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
      poolFactory: () => fake.pool,
    });

    const value = await connection.transaction(async (executor) => {
      await executor.query('INSERT INTO t (a) VALUES ($1)', ['x']);
      return 'done';
    });

    expect(value).toBe('done');
    expect(fake.queries.map((item) => item.text)).toEqual([
      'BEGIN',
      'INSERT INTO t (a) VALUES ($1)',
      'COMMIT',
    ]);
    expect(fake.releases).toEqual([false]);
  });

  it('回调抛错时回滚，并把原错误原样上抛（回滚不吞掉业务错误）', async () => {
    const fake = createFakePool(() => rows([]));
    const connection = createPostgresConnection({
      profile: toPostgresPoolProfile(CONFIG),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
      poolFactory: () => fake.pool,
    });

    const failure = new Error('owner violation');
    await expect(connection.transaction(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(fake.queries.map((item) => item.text)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(fake.releases).toEqual([false]);
  });

  it('回滚失败时销毁连接（不把状态不可信的连接还给池）', async () => {
    const fake = createFakePool(() => rows([]), { rollbackFails: true });
    const connection = createPostgresConnection({
      profile: toPostgresPoolProfile(CONFIG),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
      poolFactory: () => fake.pool,
    });

    await expect(connection.transaction(() => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(fake.releases).toEqual([true]);
  });

  it('事务内执行器逃逸出回调后使用即判 EXECUTOR_TRANSACTION_ESCAPED', async () => {
    const fake = createFakePool(() => rows([]));
    const connection = createPostgresConnection({
      profile: toPostgresPoolProfile(CONFIG),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
      poolFactory: () => fake.pool,
    });

    let escaped: { query(sql: string): Promise<unknown> } | undefined;
    await connection.transaction((executor) => {
      escaped = executor;
      return Promise.resolve(undefined);
    });

    await expect(escaped?.query('SELECT 1')).rejects.toMatchObject({
      code: 'EXECUTOR_TRANSACTION_ESCAPED',
    });
  });

  it('嵌套事务被拒绝（PG 没有真正的嵌套事务，静默降级会让调用方误判已回滚）', async () => {
    const fake = createFakePool(() => rows([]));
    const connection = createPostgresConnection({
      profile: toPostgresPoolProfile(CONFIG),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
      poolFactory: () => fake.pool,
    });

    // 同一个连接对象上再开事务：必须被拒绝，而不是静默复用外层事务
    const nested = connection.transaction(async () =>
      connection.transaction(() => Promise.resolve(undefined)),
    );
    await expect(nested).rejects.toMatchObject({ code: 'EXECUTOR_TRANSACTION_NESTED' });
    // 外层已 BEGIN 并因内层失败而回滚；只应有一条 BEGIN
    expect(fake.queries.map((item) => item.text).filter((text) => text === 'BEGIN')).toHaveLength(
      1,
    );
  });

  it('连接关闭后一律 EXECUTOR_CLOSED，不再下发任何 SQL', async () => {
    const fake = createFakePool(() => rows([]));
    const connection = createPostgresConnection({
      profile: toPostgresPoolProfile(CONFIG),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
      poolFactory: () => fake.pool,
    });
    await connection.close();
    await expect(connection.query('SELECT 1')).rejects.toMatchObject({ code: 'EXECUTOR_CLOSED' });
  });
});

describe('统一错误脱敏：驱动异常不外发原文', () => {
  it('查询异常只保留 SQLSTATE 与结构名，口令/连接串/字段取值都不出现在错误里', async () => {
    const fake = createFakePool(() => {
      throw Object.assign(new Error(`duplicate key for ${CONNECTION_STRING}`), {
        code: '23505',
        severity: 'ERROR',
        constraint: 'achievements_pkey',
        detail: 'Key (phone)=(13800000000) already exists.',
      });
    });
    const connection = createPostgresConnection({
      profile: toPostgresPoolProfile(CONFIG),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
      poolFactory: () => fake.pool,
    });

    let captured: unknown;
    try {
      await connection.query('SELECT $1', ['13800000000']);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PostgresExecutorError);
    const executorError = captured as PostgresExecutorError;
    expect(executorError.code).toBe('EXECUTOR_QUERY_FAILED');
    expect(executorError.issues[0]?.code).toBe('23505');
    expect(executorError.issues[0]?.detail).toContain('constraint=achievements_pkey');

    const serialized = JSON.stringify(executorError, Object.getOwnPropertyNames(executorError));
    for (const leaked of ['sup3r-s3cret', 'rm_user', '13800000000', 'Key (phone)', 'detail']) {
      expect(serialized).not.toContain(leaked);
    }
    expect(executorError).not.toHaveProperty('cause');
  });

  it('连接失败也只输出脱敏摘要', async () => {
    const poolFactory: PostgresPoolFactory = () => ({
      connect: () => Promise.reject(new Error(`connect failed for ${CONNECTION_STRING}`)),
      query: () => Promise.reject(new Error('unused')),
      end: () => Promise.resolve(),
    });
    const connection = createPostgresConnection({
      profile: toPostgresPoolProfile(CONFIG),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
      poolFactory,
    });

    let captured: unknown;
    try {
      await connection.transaction(() => Promise.resolve(undefined));
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: 'EXECUTOR_CONNECT_FAILED' });
    expect((captured as Error).message).not.toContain('sup3r-s3cret');
    expect((captured as Error).message).not.toContain(CONNECTION_STRING);
  });
});

describe('attest 约束：没有完整证据就创建不出执行器工厂', () => {
  it('证据齐全时工厂创建成功，且能力声明是加密封存的', () => {
    const fake = createFakePool(() => rows([]));
    const registry = attestedRegistry();
    const factory = createPostgresSqlConnectionFactory(attestedOptions(registry, () => fake.pool));
    expect(registry.isSealed(factory.capabilities)).toBe(true);
    expect(factory.capabilities).toMatchObject({
      contractId: SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
      contractVersion: SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
      backend: 'postgres',
      persistent: true,
      productionReady: true,
      parameterizedQueries: true,
      transactions: true,
    });
    expect(Object.isFrozen(factory.capabilities)).toBe(true);
  });

  it('证据未登记：connect() 被契约拒绝（工厂拿不到可用连接）', async () => {
    const fake = createFakePool(() => rows([]));
    const empty = createSqlExecutorVerificationRegistry();
    const factory = createPostgresSqlConnectionFactory(attestedOptions(empty, () => fake.pool));
    await expect(factory.connect(CONFIG)).rejects.toBeInstanceOf(SqlExecutorVerificationError);
    expect(fake.queries).toEqual([]);
  });

  it('迁移就绪证据里仍有未应用迁移：connect() 被拒绝（schema 未就绪不得连库）', async () => {
    const fake = createFakePool(() => rows([]));
    const registry = attestedRegistry({
      availableVersions: ['0001', '0002'],
      appliedVersions: ['0001'],
    });
    const factory = createPostgresSqlConnectionFactory(attestedOptions(registry, () => fake.pool));
    await expect(factory.connect(CONFIG)).rejects.toBeInstanceOf(SqlExecutorVerificationError);
    expect(fake.queries).toEqual([]);
  });

  it('证据过期（超过新鲜度窗口）：connect() 被拒绝', async () => {
    const stale = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const registry = attestedRegistry({ verifiedAt: stale, checkedAt: stale });
    const factory = createPostgresSqlConnectionFactory(
      attestedOptions(registry, () => createFakePool(() => rows([])).pool),
    );
    await expect(factory.connect(CONFIG)).rejects.toBeInstanceOf(SqlExecutorVerificationError);
  });

  it('connect() 收到与工厂绑定的连接串不同的配置：拒绝把执行器重定向到别的后端', async () => {
    const registry = attestedRegistry();
    const factory = createPostgresSqlConnectionFactory(
      attestedOptions(registry, () => createFakePool(() => rows([])).pool),
    );
    await expect(
      factory.connect({ ...CONFIG, connectionString: 'postgresql://other:other@other:5432/other' }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_NOT_CONFIGURED' });
  });

  it('连接交到业务代码前再判一次契约：连接暴露 2 个形参槽与 transaction', async () => {
    const registry = attestedRegistry();
    const fake = createFakePool(() => rows([]));
    const factory = createPostgresSqlConnectionFactory(attestedOptions(registry, () => fake.pool));
    const connection = await factory.connect(CONFIG);
    expect(connection.query.length).toBe(2);
    expect(typeof connection.transaction).toBe('function');
    expect(registry.isSealed(connection.capabilities)).toBe(true);
    await connection.close();
  });
});

describe('池档案：只从共享配置取连接参数', () => {
  it('TLS 档位与证书路径原样进入池档案（不读证书内容）', () => {
    const profile: PostgresPoolProfile = toPostgresPoolProfile({
      ...CONFIG,
      ssl: 'verify-full',
      tls: { caPath: '/etc/rm/ca.pem' },
    });
    expect(profile.ssl).toBe('verify-full');
    expect(profile.tlsCaPath).toBe('/etc/rm/ca.pem');
    expect(profile.connectionString).toBe(CONNECTION_STRING);
  });

  it('spy 未被用于连接：池工厂只在真正 connect 时创建', () => {
    const poolFactory = vi.fn(() => createFakePool(() => rows([])).pool);
    const connection = createPostgresConnection({
      profile: toPostgresPoolProfile(CONFIG),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
      poolFactory,
    });
    expect(poolFactory).not.toHaveBeenCalled();
    void connection;
  });
});
