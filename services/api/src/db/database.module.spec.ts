import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ModuleRef } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { loadEnv, type AppEnv } from '../config/env';
import { DatabaseConfigError, describeDatabaseConfig } from './config/database-config';
import {
  createAppSqlConnectionFactory,
  DATABASE_CONFIG,
  PersistenceBoundaryService,
  resolveAppDatabaseConfig,
} from './database.module';
import {
  bindingTokenName,
  NON_PERSISTENCE_PORTS,
  PERSISTENCE_BINDINGS,
} from './persistence-bindings';
import { PersistenceBoundaryError } from './persistence/production-guard';
import { MIGRATION_DEPLOYMENT_GUARD_CONTRACT } from './migrations/migration-deployment-guard';
import {
  DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
  SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
  SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
  type SqlExecutorVerificationMethod,
} from './ports/sql-executor-verification';
import {
  DatabaseUnavailableError,
  SQL_CONNECTION_FACTORY,
  UNVERIFIED_DRIVER_BACKEND,
  type PersistenceCapabilities,
  type VerifiedSqlExecutorCapabilities,
} from './ports/sql-executor.port';

const IN_MEMORY: PersistenceCapabilities = {
  backend: 'in-memory-baseline',
  persistent: false,
  productionReady: false,
};

const VERIFIED_POSTGRES: PersistenceCapabilities = {
  backend: 'postgres',
  persistent: true,
  productionReady: true,
};

const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';

function devEnv(overrides: Record<string, string> = {}): AppEnv {
  return loadEnv({ NODE_ENV: 'test', ...overrides });
}

/** 最小 ModuleRef 替身：只实现本服务用到的 `get(token, { strict: false })` */
class FakeModuleRef {
  private readonly instances: Map<symbol, unknown>;

  constructor(instances: Map<symbol, unknown>) {
    this.instances = instances;
  }

  get(token: symbol): unknown {
    if (!this.instances.has(token)) {
      throw new Error(`未找到令牌: ${bindingTokenName(token)}`);
    }
    return this.instances.get(token);
  }
}

function bindingInstances(capabilities: PersistenceCapabilities): Map<symbol, unknown> {
  return new Map(PERSISTENCE_BINDINGS.map((descriptor) => [descriptor.token, { capabilities }]));
}

function buildService(
  env: AppEnv,
  capabilities: PersistenceCapabilities | undefined,
): PersistenceBoundaryService {
  const instances =
    capabilities === undefined ? new Map<symbol, unknown>() : bindingInstances(capabilities);
  const resolution = resolveAppDatabaseConfig(env);
  return new PersistenceBoundaryService(
    new FakeModuleRef(instances) as unknown as ModuleRef,
    resolution,
    env,
  );
}

/** 与 `buildService` 同构，但把 `SQL_CONNECTION_FACTORY` 换成测试给定的实例（执行器形态或替身） */
function buildServiceWithSqlInstance(
  env: AppEnv,
  capabilities: PersistenceCapabilities,
  sqlInstance: unknown,
): PersistenceBoundaryService {
  const instances = bindingInstances(capabilities);
  instances.set(SQL_CONNECTION_FACTORY, sqlInstance);
  return new PersistenceBoundaryService(
    new FakeModuleRef(instances) as unknown as ModuleRef,
    resolveAppDatabaseConfig(env),
    env,
  );
}

/** 捕获边界判定失败（未失败即测试前置错误） */
function captureBoundaryFailure(service: PersistenceBoundaryService): PersistenceBoundaryError {
  try {
    service.verify();
  } catch (error) {
    if (error instanceof PersistenceBoundaryError) {
      return error;
    }
    throw error;
  }
  throw new Error('测试前置失败：期望持久化边界 fail-closed，但没有抛出 PersistenceBoundaryError');
}

/** 只取执行器契约违规码（边界级违规如 SQL_EXECUTOR_VERIFICATION_REQUIRED 不在其中） */
function executorCodes(error: PersistenceBoundaryError): readonly (string | undefined)[] {
  return error.violations
    .filter((item) => item.rule === 'SQL_EXECUTOR_VERIFICATION_FAILED')
    .map((item) => item.executorCode);
}

/** 记录执行器方法调用的探针：用于断言「门禁判定不建连接」 */
interface ExecutorCallLog {
  readonly calls: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 夹具时间基准：证据/就绪时间都在判定时刻之前，避免测试自身引入时钟偏移 */
const FIXTURE_NOW_MS = Date.now();

function isoDaysAgo(days: number): string {
  return new Date(FIXTURE_NOW_MS - days * DAY_MS).toISOString();
}

let fixtureSequence = 0;

function nextFixtureSuffix(): string {
  fixtureSequence += 1;
  return String(fixtureSequence);
}

interface AttestedExecutorOverrides {
  readonly evidenceId?: string;
  readonly readinessId?: string;
  readonly evidenceVerifiedAt?: string;
  readonly readinessCheckedAt?: string;
  readonly availableVersions?: readonly string[];
  readonly appliedVersions?: readonly string[];
  readonly migrationContractId?: string;
  readonly migrationContractVersion?: number;
  readonly evidenceMethod?: SqlExecutorVerificationMethod;
}

/**
 * 构造**经过 attest 且证据完整**的执行器实例（执行器形态：`connect` + `query` + `transaction`）。
 *
 * 证据登记进 `DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY`：`PersistenceBoundaryService` 生产装配
 * 用的就是这份登记表，因此这是「真实装配能通过门禁」的唯一途径。每次调用使用唯一 id，
 * 避免同一份登记表里出现内容不一致的冲突证据。
 */
function attestedExecutor(
  overrides: AttestedExecutorOverrides = {},
  recorder?: ExecutorCallLog,
): unknown {
  const registry = DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY;
  const suffix = nextFixtureSuffix();
  const evidenceId = overrides.evidenceId ?? `evidence-attested-${suffix}`;
  const readinessId = overrides.readinessId ?? `readiness-attested-${suffix}`;
  const verifiedAt = overrides.evidenceVerifiedAt ?? isoDaysAgo(1);
  const checkedAt = overrides.readinessCheckedAt ?? isoDaysAgo(1);
  const availableVersions = overrides.availableVersions ?? ['0001'];
  const appliedVersions = overrides.appliedVersions ?? [...availableVersions];

  registry.registerVerificationEvidence({
    evidenceId,
    backend: 'postgres',
    contractId: SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
    contractVersion: SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
    verifiedBy: 'fixture-ci',
    verifiedAt,
    method: overrides.evidenceMethod ?? 'integration-test',
    parameterizedQueries: true,
    transactions: true,
    evidenceRef: `fixture-integration-run-${suffix}`,
  });
  registry.registerSchemaReadiness({
    readinessId,
    backend: 'postgres',
    migrationContractId: overrides.migrationContractId ?? MIGRATION_DEPLOYMENT_GUARD_CONTRACT.id,
    migrationContractVersion:
      overrides.migrationContractVersion ?? MIGRATION_DEPLOYMENT_GUARD_CONTRACT.version,
    availableVersions,
    appliedVersions,
    checkedBy: 'fixture-migration-check',
    checkedAt,
    readinessRef: `fixture-migration-readiness-${suffix}`,
  });
  const capabilities = registry.attest({
    backend: 'postgres',
    persistent: true,
    productionReady: true,
    parameterizedQueries: true,
    transactions: true,
    evidenceId,
    verifiedAt,
    readinessId,
    checkedAt,
  });

  const executor = {
    capabilities,
    connect(): Promise<never> {
      recorder?.calls.push('connect');
      return Promise.reject(new Error('测试夹具不得建立连接'));
    },
    query(_sql: string, _parameters?: readonly unknown[]): Promise<{ rowCount: number }> {
      recorder?.calls.push('query');
      return Promise.resolve({ rowCount: 0 });
    },
    transaction(run: (value: unknown) => Promise<unknown>): Promise<unknown> {
      recorder?.calls.push('transaction');
      return run(executor);
    },
  };
  return executor;
}

/** 执行器形态但**未封存**的能力自述（能力降级 / 自述生产可用的替身） */
function unsealedExecutor(recorder?: ExecutorCallLog): unknown {
  return {
    capabilities: VERIFIED_POSTGRES,
    connect(): Promise<never> {
      recorder?.calls.push('connect');
      return Promise.reject(new Error('测试夹具不得建立连接'));
    },
    query(_sql: string, _parameters?: readonly unknown[]): Promise<{ rowCount: number }> {
      recorder?.calls.push('query');
      return Promise.resolve({ rowCount: 0 });
    },
    transaction(run: (value: unknown) => Promise<unknown>): Promise<unknown> {
      recorder?.calls.push('transaction');
      return run(unsealedExecutor());
    },
  };
}

describe('数据库配置工厂：fail-closed', () => {
  it('开发/测试环境未配置 DATABASE_URL 时返回 absent（允许无库启动）', () => {
    expect(resolveAppDatabaseConfig(devEnv())).toMatchObject({ status: 'absent' });
  });

  it('生产环境未配置 DATABASE_URL 时抛 DatabaseConfigError（启动即失败）', () => {
    const env = loadEnv({ NODE_ENV: 'production' });
    expect(() => resolveAppDatabaseConfig(env)).toThrowError(DatabaseConfigError);
    try {
      resolveAppDatabaseConfig(env);
    } catch (error) {
      expect((error as DatabaseConfigError).code).toBe('DATABASE_URL_REQUIRED_IN_PRODUCTION');
    }
  });

  it('生产环境对非回环主机关闭 TLS 时同样拒绝（配置 fail-closed）', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://rm:pw@db.example.com:5432/researcher_manager',
      DATABASE_SSL: 'false',
    });
    expect(() => resolveAppDatabaseConfig(env)).toThrowError(DatabaseConfigError);
  });

  it('生产环境配置完整时解析出共享配置，且对外摘要不含口令', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: LOOPBACK_URL,
      DATABASE_SSL: 'false',
      DATABASE_POOL_MAX: '20',
    });
    const resolution = resolveAppDatabaseConfig(env);
    expect(resolution).toMatchObject({
      status: 'configured',
      config: { poolMax: 20, applicationName: 'researcher-manager-api', ssl: 'disable' },
    });
    if (resolution.status !== 'configured') {
      throw new Error('测试前置失败：配置应为 configured');
    }

    // 机密只允许存在于交给驱动的 connectionString 里
    expect(resolution.config.connectionString).toBe(LOOPBACK_URL);
    // 可写日志/可对外展示的投影必须已脱敏
    const summary = JSON.stringify(describeDatabaseConfig(resolution));
    expect(summary).not.toContain('postgres:postgres');
    expect(summary).toContain('postgresql://***:***@127.0.0.1:5432/researcher_manager');
  });
});

describe('SQL 连接工厂：默认绑定未验证驱动（不切换运行时 provider）', () => {
  it('能力声明为未验证驱动，且 connect 一律拒绝', async () => {
    const factory = createAppSqlConnectionFactory();
    expect(factory.capabilities).toEqual({
      backend: UNVERIFIED_DRIVER_BACKEND,
      persistent: false,
      productionReady: false,
    });

    const env = devEnv({ DATABASE_URL: LOOPBACK_URL });
    const resolution = resolveAppDatabaseConfig(env);
    if (resolution.status !== 'configured') {
      throw new Error('测试前置失败：配置应为 configured');
    }
    await expect(factory.connect(resolution.config)).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    );
  });
});

describe('PersistenceBoundaryService：生产边界守卫', () => {
  it('测试环境放行内存基线（不因默认装配失败）', () => {
    const service = buildService(devEnv(), IN_MEMORY);
    const report = service.verify();
    expect(report.ok).toBe(true);
    expect(report.checkedTokens).toHaveLength(PERSISTENCE_BINDINGS.length);
  });

  it('生产环境 + 内存基线：拒绝启动并逐端口报告违规', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: LOOPBACK_URL,
      DATABASE_SSL: 'false',
    });
    const service = buildService(env, IN_MEMORY);
    const boundaryError = captureBoundaryFailure(service);

    // 17 个已登记端口全部判内存基线违规（逐端口报告）
    const inMemory = boundaryError.violations.filter(
      (item) => item.rule === 'IN_MEMORY_BACKEND_IN_PRODUCTION',
    );
    expect(inMemory).toHaveLength(PERSISTENCE_BINDINGS.length);
    expect(boundaryError.message).toContain('GROUP_REPOSITORY[IN_MEMORY_BACKEND_IN_PRODUCTION]');
    // 另有 1 条边界级违规：数据库已配置，但 SQL 执行器端口只有能力自述、没有契约事实
    expect(
      boundaryError.violations.filter((item) => item.rule !== 'IN_MEMORY_BACKEND_IN_PRODUCTION'),
    ).toEqual([
      expect.objectContaining({
        rule: 'SQL_EXECUTOR_VERIFICATION_REQUIRED',
        token: 'SQL_CONNECTION_FACTORY',
      }),
    ]);
  });

  it('生产环境 + 未配置 DATABASE_URL：报配置 fail-closed（内存基线的第二个违规来源）', () => {
    const env = loadEnv({ NODE_ENV: 'production' });
    // 直接构造服务（跳过配置工厂），验证守卫自身的配置判定
    const service = new PersistenceBoundaryService(
      new FakeModuleRef(bindingInstances(VERIFIED_POSTGRES)) as unknown as ModuleRef,
      { status: 'absent', detail: '测试构造' },
      env,
    );

    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }
    const violations = (captured as PersistenceBoundaryError).violations;
    expect(violations.map((item) => item.rule)).toEqual(['DATABASE_NOT_CONFIGURED_IN_PRODUCTION']);
    expect(violations[0]?.token).toBe('DATABASE_CONFIG');
  });

  it('生产环境 + 已声明持久且生产可用的后端 + 已配置数据库 + 已 attest 的执行器：放行', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: LOOPBACK_URL,
      DATABASE_SSL: 'false',
    });
    const service = buildServiceWithSqlInstance(env, VERIFIED_POSTGRES, attestedExecutor());
    expect(service.verify().ok).toBe(true);
  });

  it('生产环境 + 只有能力自述（没有执行器契约事实）：自述不能绕过 attest，拒绝启动', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: LOOPBACK_URL,
      DATABASE_SSL: 'false',
    });
    const service = buildService(env, VERIFIED_POSTGRES);
    const boundaryError = captureBoundaryFailure(service);

    expect(boundaryError.violations.map((item) => item.rule)).toEqual([
      'SQL_EXECUTOR_VERIFICATION_REQUIRED',
    ]);
    expect(boundaryError.violations[0]?.token).toBe('SQL_CONNECTION_FACTORY');
  });

  it('端口未绑定（或未声明能力）时在任何环境都判 MISSING_CAPABILITIES', () => {
    const service = buildService(devEnv(), undefined);
    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }
    const violations = (captured as PersistenceBoundaryError).violations;
    expect(violations).toHaveLength(PERSISTENCE_BINDINGS.length);
    expect(violations.every((item) => item.rule === 'MISSING_CAPABILITIES')).toBe(true);
  });
});

describe('启动门禁：DATABASE_URL 存在时必须有经过 attest 且证据完整的 SQL 执行器', () => {
  /** 非生产环境 + 已配置数据库：这是本次加固的关键口径（不再靠 NODE_ENV 名判定） */
  const configuredTestEnv = (): AppEnv => loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL });

  it('executor 替换：执行器端口被换成只有能力的替身 → SQL_EXECUTOR_VERIFICATION_REQUIRED', () => {
    // buildService 的 SQL_CONNECTION_FACTORY 就是 `{ capabilities }` 形态（没有 connect/query），
    // 能力自述为 postgres + persistent + productionReady —— 这正是需要被拦下的「替换」路径。
    const service = buildService(configuredTestEnv(), VERIFIED_POSTGRES);
    const boundaryError = captureBoundaryFailure(service);

    expect(boundaryError.violations.map((item) => item.rule)).toEqual([
      'SQL_EXECUTOR_VERIFICATION_REQUIRED',
    ]);
    expect(boundaryError.violations[0]?.token).toBe('SQL_CONNECTION_FACTORY');
    expect(boundaryError.violations[0]?.detail).toContain('数据库已配置');
    // 违规信息不承载连接串/口令
    expect(boundaryError.message).not.toContain('://');
    expect(boundaryError.message).not.toContain('postgres:postgres');
  });

  it('executor 替换：未封存的能力自述（自称 postgres/生产可用）→ 契约失败', () => {
    const service = buildServiceWithSqlInstance(
      configuredTestEnv(),
      VERIFIED_POSTGRES,
      unsealedExecutor(),
    );
    const boundaryError = captureBoundaryFailure(service);

    expect(executorCodes(boundaryError)).toEqual(
      expect.arrayContaining([
        'DECLARATION_NOT_SEALED',
        'DECLARATION_MUTABLE',
        'EVIDENCE_MISSING',
        'SCHEMA_READINESS_MISSING',
      ]),
    );
    expect(boundaryError.violations.every((item) => item.token === 'SQL_CONNECTION_FACTORY')).toBe(
      true,
    );
  });

  it('能力降级：封存声明被复制/替换成可变对象 → DECLARATION_NOT_SEALED + DECLARATION_MUTABLE', () => {
    const attested = attestedExecutor() as { capabilities: VerifiedSqlExecutorCapabilities };
    const downgraded = { ...attested, capabilities: { ...attested.capabilities } };
    const service = buildServiceWithSqlInstance(configuredTestEnv(), VERIFIED_POSTGRES, downgraded);
    const boundaryError = captureBoundaryFailure(service);

    expect(executorCodes(boundaryError)).toEqual(
      expect.arrayContaining(['DECLARATION_NOT_SEALED', 'DECLARATION_MUTABLE']),
    );
  });

  it('能力降级：执行器 surface 退化为单参 query 且无 transaction → 参数化/事务违规', () => {
    const attested = attestedExecutor() as { capabilities: VerifiedSqlExecutorCapabilities };
    const degradedSurface = {
      capabilities: attested.capabilities,
      query(_sql: string): Promise<{ rowCount: number }> {
        return Promise.resolve({ rowCount: 0 });
      },
    };
    const service = buildServiceWithSqlInstance(
      configuredTestEnv(),
      VERIFIED_POSTGRES,
      degradedSurface,
    );
    const boundaryError = captureBoundaryFailure(service);

    expect(executorCodes(boundaryError)).toEqual(
      expect.arrayContaining(['PARAMETERIZATION_UNSUPPORTED', 'TRANSACTION_UNSUPPORTED']),
    );
  });

  it('证据过期：验证证据超出新鲜度窗口 → EVIDENCE_STALE', () => {
    const service = buildServiceWithSqlInstance(
      configuredTestEnv(),
      VERIFIED_POSTGRES,
      attestedExecutor({ evidenceVerifiedAt: isoDaysAgo(120) }),
    );
    const boundaryError = captureBoundaryFailure(service);

    expect(executorCodes(boundaryError)).toEqual(expect.arrayContaining(['EVIDENCE_STALE']));
    expect(boundaryError.violations[0]?.detail).toContain('重新验证');
  });

  it('证据过期：迁移就绪证据超出新鲜度窗口 → SCHEMA_READINESS_STALE', () => {
    const service = buildServiceWithSqlInstance(
      configuredTestEnv(),
      VERIFIED_POSTGRES,
      attestedExecutor({ readinessCheckedAt: isoDaysAgo(45) }),
    );
    const boundaryError = captureBoundaryFailure(service);

    expect(executorCodes(boundaryError)).toEqual(
      expect.arrayContaining(['SCHEMA_READINESS_STALE']),
    );
  });

  it('migration mismatch：存在未应用迁移 → SCHEMA_READINESS_PENDING_MIGRATIONS', () => {
    const service = buildServiceWithSqlInstance(
      configuredTestEnv(),
      VERIFIED_POSTGRES,
      attestedExecutor({ availableVersions: ['0001', '0002'], appliedVersions: ['0001'] }),
    );

    expect(executorCodes(captureBoundaryFailure(service))).toEqual(
      expect.arrayContaining(['SCHEMA_READINESS_PENDING_MIGRATIONS']),
    );
  });

  it('migration mismatch：库中存在代码里没有的版本 → SCHEMA_READINESS_SEQUENCE_MISMATCH', () => {
    const service = buildServiceWithSqlInstance(
      configuredTestEnv(),
      VERIFIED_POSTGRES,
      attestedExecutor({ availableVersions: ['0001'], appliedVersions: ['0001', '0002'] }),
    );

    expect(executorCodes(captureBoundaryFailure(service))).toEqual(
      expect.arrayContaining(['SCHEMA_READINESS_SEQUENCE_MISMATCH']),
    );
  });

  it('migration mismatch：就绪证据锚定别的迁移契约版本 → SCHEMA_READINESS_CONTRACT_MISMATCH', () => {
    const service = buildServiceWithSqlInstance(
      configuredTestEnv(),
      VERIFIED_POSTGRES,
      attestedExecutor({
        migrationContractId: 'other-migration-contract',
        migrationContractVersion: MIGRATION_DEPLOYMENT_GUARD_CONTRACT.version + 1,
      }),
    );

    expect(executorCodes(captureBoundaryFailure(service))).toEqual(
      expect.arrayContaining(['SCHEMA_READINESS_CONTRACT_MISMATCH']),
    );
  });

  it('无数据库：门禁不生效，内存基线与未验证执行器保持默认放行', () => {
    const service = buildServiceWithSqlInstance(devEnv(), IN_MEMORY, unsealedExecutor());
    const report = service.verify();

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('启动顺序：判定先于任何连接，成功与失败路径都不调用执行器方法', () => {
    const successCalls: string[] = [];
    const okService = buildServiceWithSqlInstance(
      configuredTestEnv(),
      VERIFIED_POSTGRES,
      attestedExecutor({}, { calls: successCalls }),
    );
    expect(okService.verify().ok).toBe(true);
    expect(successCalls).toEqual([]);

    const failureCalls: string[] = [];
    const failService = buildServiceWithSqlInstance(
      configuredTestEnv(),
      VERIFIED_POSTGRES,
      unsealedExecutor({ calls: failureCalls }),
    );
    expect(() => failService.verify()).toThrow(PersistenceBoundaryError);
    expect(failureCalls).toEqual([]);
  });

  it('启动顺序：门禁挂在应用引导钩子上（onApplicationBootstrap 即判定，失败终止启动）', () => {
    const service = buildServiceWithSqlInstance(
      configuredTestEnv(),
      VERIFIED_POSTGRES,
      unsealedExecutor(),
    );

    let captured: unknown;
    try {
      service.onApplicationBootstrap();
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(PersistenceBoundaryError);
    expect((captured as PersistenceBoundaryError).message).toContain(
      'SQL_CONNECTION_FACTORY[SQL_EXECUTOR_VERIFICATION_FAILED]',
    );
    expect((captured as PersistenceBoundaryError).message).not.toContain('://');
  });
});

describe('完整 AppModule 装配：运行时仍是内存基线 + fail-closed 连接工厂', () => {
  let app: INestApplication | undefined;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    // 固定配置来源，避免宿主环境的 DATABASE_URL 影响断言（ConfigModule 读 process.env）
    process.env.DATABASE_URL = '';
    process.env.NODE_ENV = 'test';
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('启动阶段完成持久化边界校验，且所有已登记端口都能解析到能力声明', () => {
    const service = app?.get(PersistenceBoundaryService);
    expect(service).toBeInstanceOf(PersistenceBoundaryService);
    const report = service?.verify();
    expect(report?.ok).toBe(true);
    expect(report?.checkedTokens).toEqual(
      PERSISTENCE_BINDINGS.map((d) => bindingTokenName(d.token)),
    );
  });

  it('DATABASE_CONFIG 未配置时是 absent，SQL_CONNECTION_FACTORY 是未验证驱动工厂', () => {
    expect(app?.get(DATABASE_CONFIG)).toMatchObject({ status: 'absent' });
    expect(app?.get(SQL_CONNECTION_FACTORY)).toMatchObject({
      capabilities: { backend: UNVERIFIED_DRIVER_BACKEND, productionReady: false },
    });
  });
});

describe('端口登记表：漂移门禁与卫生检查', () => {
  it('src 下所有 *.port.ts 的 DI 令牌都已登记（或给出非持久化理由）', () => {
    const repoRoot = findRepoRoot(process.cwd());
    const discovered = collectPortTokenNames(join(repoRoot, 'services', 'api', 'src'));
    const registered = [
      ...PERSISTENCE_BINDINGS.map((descriptor) => bindingTokenName(descriptor.token)),
      ...NON_PERSISTENCE_PORTS.map((descriptor) => bindingTokenName(descriptor.token)),
    ];

    // 双向比对：新增端口未登记会失败，登记表里的陈旧条目同样会失败
    expect([...registered].sort()).toEqual([...new Set(discovered)].sort());
  });

  it('登记表无重复，且非持久化端口都给出了理由', () => {
    const names = [
      ...PERSISTENCE_BINDINGS.map((descriptor) => bindingTokenName(descriptor.token)),
      ...NON_PERSISTENCE_PORTS.map((descriptor) => bindingTokenName(descriptor.token)),
    ];
    expect(new Set(names).size).toBe(names.length);

    for (const descriptor of NON_PERSISTENCE_PORTS) {
      expect(descriptor.reason.length).toBeGreaterThanOrEqual(10);
    }
    for (const descriptor of PERSISTENCE_BINDINGS) {
      expect(descriptor.responsibility.length).toBeGreaterThan(0);
    }
  });
});

/** 从当前工作目录向上寻找仓库根（含 pnpm-workspace.yaml） */
function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error('未找到仓库根目录（缺少 pnpm-workspace.yaml）');
}

/** 扫描 `*.port.ts` 里的 `export const X = Symbol(...)` 声明，收集令牌名 */
function collectPortTokenNames(root: string): string[] {
  const names: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.port.ts')) {
        continue;
      }
      const content = readFileSync(fullPath, 'utf8');
      for (const match of content.matchAll(/export const ([A-Z0-9_]+) = Symbol\(/gu)) {
        const name = match[1];
        if (name !== undefined) {
          names.push(name);
        }
      }
    }
  };
  walk(root);
  return names;
}
