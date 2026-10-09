import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ModuleRef } from '@nestjs/core';
import { Logger, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../app.module';
import { ConfigModule } from '../config/config.module';
import { loadEnv, type AppEnv } from '../config/env';
import { InMemorySessionStore } from '../modules/auth/session-store.in-memory';
import { SESSION_STORE } from '../modules/auth/session-subject.port';
import { DatabaseConfigError, describeDatabaseConfig } from './config/database-config';
import type { ResolvedDatabaseConfig } from './config/database-config';
import {
  createAppSqlConnectionFactory,
  DATABASE_CONFIG,
  DatabaseModule,
  DependencyReadinessService,
  PersistenceBoundaryService,
  resolveAppDatabaseConfig,
  type PersistenceBoundaryOptions,
} from './database.module';
import {
  bindingTokenName,
  NON_PERSISTENCE_PORTS,
  PERSISTENCE_BINDINGS,
  type PersistenceBindingRole,
} from './persistence-bindings';
import {
  createDependencyReadinessRegistry,
  DEFAULT_DEPENDENCY_READINESS_REGISTRY,
  DependencyReadinessError,
  DEPENDENCY_READINESS_CONTRACT_ID,
  DEPENDENCY_READINESS_CONTRACT_VERSION,
  type DependencyReadinessRegistry,
  type DependencyRole,
} from './persistence/dependency-readiness';
import { PersistenceBoundaryError } from './persistence/production-guard';
import { MIGRATION_DEPLOYMENT_GUARD_CONTRACT } from './migrations/migration-deployment-guard';
import {
  createSqlExecutorVerificationRegistry,
  DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
  SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
  SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
  SqlExecutorVerificationError,
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
  options: PersistenceBoundaryOptions = {},
): PersistenceBoundaryService {
  const instances =
    capabilities === undefined ? new Map<symbol, unknown>() : bindingInstances(capabilities);
  const resolution = resolveAppDatabaseConfig(env);
  return new PersistenceBoundaryService(
    new FakeModuleRef(instances) as unknown as ModuleRef,
    resolution,
    env,
    options,
  );
}

/** 与 `buildService` 同构，但把 `SQL_CONNECTION_FACTORY` 换成测试给定的实例（执行器形态或替身） */
function buildServiceWithSqlInstance(
  env: AppEnv,
  capabilities: PersistenceCapabilities,
  sqlInstance: unknown,
  options: PersistenceBoundaryOptions = {},
): PersistenceBoundaryService {
  const instances = bindingInstances(capabilities);
  instances.set(SQL_CONNECTION_FACTORY, sqlInstance);
  return new PersistenceBoundaryService(
    new FakeModuleRef(instances) as unknown as ModuleRef,
    resolveAppDatabaseConfig(env),
    env,
    options,
  );
}

/** 记录被读取过的令牌：用于断言门禁「没有读取未参与判定的端口」 */
class RecordingModuleRef extends FakeModuleRef {
  readonly requested: string[] = [];

  override get(token: symbol): unknown {
    this.requested.push(bindingTokenName(token));
    return super.get(token);
  }
}

function readinessService(
  env: AppEnv,
  instances: Map<symbol, unknown>,
  options: PersistenceBoundaryOptions = {},
): { readonly service: DependencyReadinessService; readonly moduleRef: RecordingModuleRef } {
  const moduleRef = new RecordingModuleRef(instances);
  const service = new DependencyReadinessService(
    moduleRef as unknown as ModuleRef,
    resolveAppDatabaseConfig(env),
    env,
    options,
  );
  return { service, moduleRef };
}

/** 每个角色在登记表里的端口名（认证先于业务的口径来自登记表本身） */
function tokensOfRole(role: PersistenceBindingRole): readonly string[] {
  return PERSISTENCE_BINDINGS.filter((descriptor) => descriptor.role === role).map((descriptor) =>
    bindingTokenName(descriptor.token),
  );
}

/**
 * 为「持久 + 生产可用」的端口签发**封存声明 + 验证证据**（唯一能通过依赖就绪门禁的途径）。
 * 每次调用使用唯一证据 id，避免同一份登记表里出现内容不一致的冲突证据。
 */
function sealDependency(
  registry: DependencyReadinessRegistry,
  token: string,
  role: DependencyRole,
  options: {
    readonly backend?: string;
    readonly evidenceMethod?: 'integration-test' | 'contract-test' | 'manual-review';
    readonly verifiedAt?: string;
    readonly evidenceToken?: string;
    readonly evidenceRole?: DependencyRole;
  } = {},
): unknown {
  const suffix = nextFixtureSuffix();
  const evidenceId = `dep-evidence-${suffix}`;
  const backend = options.backend ?? 'postgres';
  const verifiedAt = options.verifiedAt ?? isoDaysAgo(1);
  registry.registerEvidence({
    evidenceId,
    token: options.evidenceToken ?? token,
    role: options.evidenceRole ?? role,
    backend,
    contractId: DEPENDENCY_READINESS_CONTRACT_ID,
    contractVersion: DEPENDENCY_READINESS_CONTRACT_VERSION,
    verifiedBy: 'fixture-ci',
    verifiedAt,
    method: options.evidenceMethod ?? 'integration-test',
    persistent: true,
    productionReady: true,
    evidenceRef: `fixture-dep-run-${suffix}`,
  });
  const declaration = registry.attest({
    token,
    role,
    backend,
    persistent: true,
    productionReady: true,
    evidenceId,
    verifiedAt,
  });
  return { capabilities: declaration };
}

/**
 * 按角色构造绑定实例：给定角色用**封存的**声明，其余用给定的兜底能力声明（默认内存基线）。
 * 返回的 map 覆盖登记表里的全部持久化端口（含基础设施端口，后者不参与就绪判定）。
 */
function instancesWithReadiness(
  registry: DependencyReadinessRegistry,
  sealedRoles: readonly PersistenceBindingRole[],
  fallback: PersistenceCapabilities = IN_MEMORY,
): Map<symbol, unknown> {
  const instances = new Map<symbol, unknown>();
  for (const descriptor of PERSISTENCE_BINDINGS) {
    const token = bindingTokenName(descriptor.token);
    if (descriptor.role !== 'infrastructure' && sealedRoles.includes(descriptor.role)) {
      instances.set(descriptor.token, sealDependency(registry, token, descriptor.role));
      continue;
    }
    instances.set(descriptor.token, { capabilities: fallback });
  }
  return instances;
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
      DATABASE_SSL_MODE: 'verify-full',
      DATABASE_POOL_MAX: '20',
    });
    const resolution = resolveAppDatabaseConfig(env);
    expect(resolution).toMatchObject({
      status: 'configured',
      config: { poolMax: 20, applicationName: 'researcher-manager-api', ssl: 'verify-full' },
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

/**
 * `env.ts` 的取证字段与 `resolvePostgresAttestationRegistration(env)` 的类型契约（本次修复点）：
 * 事实只来自显式配置；缺一项就退回未验证驱动，代码绝不生成「已验证」，也绝不把缺失说成已应用。
 */
describe('SQL 连接工厂：生产取证事实只来自显式配置（不臆造「已验证」）', () => {
  /** 完整、自洽的取证事实：每一项都必须由做过验证的人 / CI 显式提供 */
  const ATTESTATION_ENV: Record<string, string> = {
    DATABASE_EXECUTOR_EVIDENCE_ID: 'ev-clean-checkout-1',
    DATABASE_EXECUTOR_VERIFIED_BY: 'ci/integration',
    DATABASE_EXECUTOR_VERIFIED_AT: '2026-01-01T00:00:00Z',
    DATABASE_EXECUTOR_EVIDENCE_REF:
      'services/api/src/db/postgres/__tests__/postgres-integration.spec.ts',
    DATABASE_EXECUTOR_EVIDENCE_METHOD: 'integration-test',
    DATABASE_SCHEMA_READINESS_ID: 'rd-clean-checkout-1',
    DATABASE_SCHEMA_CHECKED_BY: 'ci/integration',
    DATABASE_SCHEMA_CHECKED_AT: '2026-01-01T00:00:00Z',
    DATABASE_SCHEMA_READINESS_REF: 'pnpm db:migrate:status',
    DATABASE_MIGRATION_AVAILABLE_VERSIONS: '0001',
    DATABASE_MIGRATION_APPLIED_VERSIONS: '0001',
  };

  /** 判定时刻显式注入：与取证时间同为固定值，判定可复现（不读取真实时钟） */
  const JUDGE_NOW = '2026-01-02T00:00:00Z';

  function configuredConfig(env: AppEnv): ResolvedDatabaseConfig {
    const resolution = resolveAppDatabaseConfig(env);
    if (resolution.status !== 'configured') {
      throw new Error('测试前置失败：配置应为 configured');
    }
    return resolution.config;
  }

  it('取证事实缺失：工厂仍是未验证驱动，登记表一条证据都不落', async () => {
    const env = devEnv({ DATABASE_URL: LOOPBACK_URL });
    const registry = createSqlExecutorVerificationRegistry();
    const factory = createAppSqlConnectionFactory(env, resolveAppDatabaseConfig(env), { registry });

    expect(factory.capabilities).toEqual({
      backend: UNVERIFIED_DRIVER_BACKEND,
      persistent: false,
      productionReady: false,
    });
    // 空登记表本身就是一条证据：没有显式事实就不签发封存身份
    expect(registry.describe()).toEqual({
      sealedDeclarations: 0,
      verificationEvidence: 0,
      schemaReadiness: 0,
    });
    await expect(factory.connect(configuredConfig(env))).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    );
  });

  it('取证事实齐全：登记验证证据与迁移就绪证据，并签发封存的生产执行器声明', () => {
    const env = devEnv({ DATABASE_URL: LOOPBACK_URL, ...ATTESTATION_ENV });
    const registry = createSqlExecutorVerificationRegistry();
    const factory = createAppSqlConnectionFactory(env, resolveAppDatabaseConfig(env), { registry });

    expect(registry.describe()).toEqual({
      sealedDeclarations: 1,
      verificationEvidence: 1,
      schemaReadiness: 1,
    });
    expect(factory.capabilities).toMatchObject({
      backend: 'postgres',
      persistent: true,
      productionReady: true,
      parameterizedQueries: true,
      transactions: true,
      verification: { evidenceId: ATTESTATION_ENV.DATABASE_EXECUTOR_EVIDENCE_ID },
    });
    expect(registry.isSealed(factory.capabilities)).toBe(true);
  });

  it('事实缺一项（未给出已应用版本）：同样退回未验证驱动，不把缺失当成「已应用」', () => {
    const env = devEnv({
      DATABASE_URL: LOOPBACK_URL,
      ...ATTESTATION_ENV,
      DATABASE_MIGRATION_APPLIED_VERSIONS: '',
    });
    const registry = createSqlExecutorVerificationRegistry();
    const factory = createAppSqlConnectionFactory(env, resolveAppDatabaseConfig(env), { registry });

    expect(factory.capabilities).toEqual({
      backend: UNVERIFIED_DRIVER_BACKEND,
      persistent: false,
      productionReady: false,
    });
    expect(registry.describe().sealedDeclarations).toBe(0);
  });

  it('事实不一致（尚有未应用迁移）：连接前即被契约拒绝，交不出「已验证」的连接', async () => {
    const env = devEnv({
      DATABASE_URL: LOOPBACK_URL,
      ...ATTESTATION_ENV,
      DATABASE_MIGRATION_AVAILABLE_VERSIONS: '0001,0002',
    });
    const registry = createSqlExecutorVerificationRegistry();
    const factory = createAppSqlConnectionFactory(env, resolveAppDatabaseConfig(env), {
      registry,
      now: JUDGE_NOW,
    });

    let captured: unknown;
    try {
      await factory.connect(configuredConfig(env));
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(SqlExecutorVerificationError);
    expect((captured as SqlExecutorVerificationError).violations.map((item) => item.code)).toEqual([
      'SCHEMA_READINESS_PENDING_MIGRATIONS',
    ]);
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
      DATABASE_SSL_MODE: 'verify-full',
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
      DATABASE_SSL_MODE: 'verify-full',
    });
    const service = buildServiceWithSqlInstance(env, VERIFIED_POSTGRES, attestedExecutor());
    expect(service.verify().ok).toBe(true);
  });

  it('生产环境 + 只有能力自述（没有执行器契约事实）：自述不能绕过 attest，拒绝启动', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: LOOPBACK_URL,
      DATABASE_SSL_MODE: 'verify-full',
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

  it('启动顺序：引导钩子先跑依赖就绪门禁（认证阶段），再跑能力边界与执行器契约', () => {
    // 数据库已配置 ⇒ 依赖就绪门禁生效；绑定全是自述生产可用的字面量 ⇒ 认证端口（SESSION_STORE）
    // 在认证阶段即被拒绝，业务阶段与执行器契约都不会被评估。
    const blocked = buildServiceWithSqlInstance(
      configuredTestEnv(),
      VERIFIED_POSTGRES,
      unsealedExecutor(),
    );

    let readinessError: unknown;
    try {
      blocked.onApplicationBootstrap();
    } catch (error) {
      readinessError = error;
    }
    expect(readinessError).toBeInstanceOf(DependencyReadinessError);
    expect((readinessError as DependencyReadinessError).message).toContain(
      'SESSION_STORE[DEPENDENCY_NOT_SEALED]',
    );
    expect((readinessError as DependencyReadinessError).message).not.toContain('://');
    expect(blocked.readinessReport()).toBeUndefined();

    // 依赖就绪通过后（认证与业务端口都持封存声明 + 已登记证据），执行器契约才是第一个失败点。
    const readyRegistry = createDependencyReadinessRegistry();
    const readyInstances = instancesWithReadiness(readyRegistry, ['authentication', 'business']);
    readyInstances.set(SQL_CONNECTION_FACTORY, unsealedExecutor());
    const readyService = new PersistenceBoundaryService(
      new FakeModuleRef(readyInstances) as unknown as ModuleRef,
      resolveAppDatabaseConfig(configuredTestEnv()),
      configuredTestEnv(),
      { registry: readyRegistry },
    );

    let boundaryError: unknown;
    try {
      readyService.onApplicationBootstrap();
    } catch (error) {
      boundaryError = error;
    }
    expect(boundaryError).toBeInstanceOf(PersistenceBoundaryError);
    expect((boundaryError as PersistenceBoundaryError).message).toContain(
      'SQL_CONNECTION_FACTORY[SQL_EXECUTOR_VERIFICATION_FAILED]',
    );
    expect((boundaryError as PersistenceBoundaryError).message).not.toContain('://');
    // 引导钩子在依赖就绪通过后才记录摘要（能力边界是在其后才失败的）
    expect(readyService.readinessReport()).toMatchObject({
      ok: true,
      tier: 'required',
      authentication: 'verified',
      business: 'verified',
    });
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

  it('每个持久化端口都有角色，且认证角色恰好是会话存储（认证先行的口径来自登记表）', () => {
    const roles = PERSISTENCE_BINDINGS.map((descriptor) => descriptor.role);
    expect(
      roles.every((role) => ['authentication', 'business', 'infrastructure'].includes(role)),
    ).toBe(true);

    // 认证依赖只有一个：会话存储。多一个就会让「认证先行」的判定范围失控。
    expect(tokensOfRole('authentication')).toEqual(['SESSION_STORE']);
    // 基础设施端口（执行器形态）不进入依赖就绪契约，其准入由 SQL 执行器契约承担。
    expect(tokensOfRole('infrastructure')).toEqual(['SQL_CONNECTION_FACTORY']);
    expect(tokensOfRole('business')).toHaveLength(PERSISTENCE_BINDINGS.length - 2);
  });
});

describe('生产依赖就绪门禁：认证先行、封存与证据、伪造能力自述', () => {
  const productionEnv = (): AppEnv =>
    loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: LOOPBACK_URL,
      DATABASE_SSL_MODE: 'verify-full',
    });
  const configuredTestEnv = (): AppEnv => loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL });

  /** 「自称持久且生产可用」的可变字面量：这正是需要被拦下的伪造路径 */
  const FORGED: PersistenceCapabilities = {
    backend: 'postgres',
    persistent: true,
    productionReady: true,
  };

  it('默认登记表是空的：没有任何持久化依赖被签发过封存身份（空集本身就是证据）', () => {
    expect(DEFAULT_DEPENDENCY_READINESS_REGISTRY.describe()).toEqual({
      sealedDeclarations: 0,
      evidence: 0,
    });
    expect(DEFAULT_DEPENDENCY_READINESS_REGISTRY.isSealed(FORGED)).toBe(false);
  });

  it('开发/测试且无数据库：档位 not-required，且门禁不读取任何端口', () => {
    const { service, moduleRef } = readinessService(
      loadEnv({ NODE_ENV: 'test' }),
      bindingInstances(IN_MEMORY),
    );
    // 显式给错时刻也不会被使用：未生效的档位不做任何判定
    const report = service.verify();

    expect(report).toEqual({
      ok: true,
      tier: 'not-required',
      authentication: 'not-required',
      business: 'not-required',
      checkedTokens: [],
      violations: [],
    });
    expect(moduleRef.requested).toEqual([]);
  });

  it('内存会话存储（InMemorySessionStore 能力）在生效档位判 DEPENDENCY_NOT_PERSISTENT，且业务端口零读取', () => {
    const { service, moduleRef } = readinessService(
      configuredTestEnv(),
      bindingInstances(IN_MEMORY),
    );

    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(DependencyReadinessError);
    const error = captured as DependencyReadinessError;
    expect(error.violations).toEqual([
      {
        code: 'DEPENDENCY_NOT_PERSISTENT',
        token: 'SESSION_STORE',
        role: 'authentication',
        detail: expect.stringContaining('in-memory-baseline'),
      },
    ]);
    // 认证先行：业务端口从未被读取（记录里只有认证端口）
    expect(moduleRef.requested).toEqual(['SESSION_STORE']);
    expect(tokensOfRole('business').every((token) => !moduleRef.requested.includes(token))).toBe(
      true,
    );
  });

  it('伪造能力自述：未封存的 persistent + productionReady 字面量在认证阶段即被拒绝', () => {
    const { service, moduleRef } = readinessService(productionEnv(), bindingInstances(FORGED));

    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }

    const counts = new Map<string, number>();
    for (const item of (captured as DependencyReadinessError).violations) {
      counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
    }
    // 认证端口：既不是封存声明，又可变
    expect(counts.get('DEPENDENCY_NOT_SEALED')).toBe(1);
    expect(counts.get('DEPENDENCY_MUTABLE')).toBe(1);
    expect(
      (captured as DependencyReadinessError).violations.every(
        (item) => item.token === 'SESSION_STORE',
      ),
    ).toBe(true);
    expect(moduleRef.requested).toEqual(['SESSION_STORE']);
  });

  it('认证通过后才评估业务：认证端口封存就绪、业务端口仍为内存基线 → 业务阶段拒绝', () => {
    const registry = createDependencyReadinessRegistry();
    const instances = instancesWithReadiness(registry, ['authentication']);
    const { service, moduleRef } = readinessService(productionEnv(), instances, { registry });

    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }

    const violations = (captured as DependencyReadinessError).violations;
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((item) => item.code === 'DEPENDENCY_NOT_PERSISTENT')).toBe(true);
    expect(violations.some((item) => item.token === 'SESSION_STORE')).toBe(false);
    // 认证阶段读了认证端口，认证通过后业务端口才被读取
    expect(moduleRef.requested[0]).toBe('SESSION_STORE');
    expect(moduleRef.requested).toContain('GROUP_REPOSITORY');
  });

  it('真实 InMemorySessionStore 的会话后端在生效档位同样被拒（内存基线无法承担生产会话）', () => {
    const store = new InMemorySessionStore(loadEnv({ NODE_ENV: 'development' }));
    const instances = new Map<symbol, unknown>([[SESSION_STORE, store]]);
    const { service } = readinessService(configuredTestEnv(), instances);

    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(DependencyReadinessError);
    expect((captured as DependencyReadinessError).violations).toEqual([
      {
        code: 'DEPENDENCY_NOT_PERSISTENT',
        token: 'SESSION_STORE',
        role: 'authentication',
        detail: expect.stringContaining('in-memory-baseline'),
      },
    ]);
    // 真实内存基线的能力声明拿不到封存身份：它不能被「升级」成生产依赖
    expect(DEFAULT_DEPENDENCY_READINESS_REGISTRY.isSealed(store.capabilities)).toBe(false);
  });

  it('provider 替换：认证与业务端口都持封存声明 + 已登记证据时放行（不是死路）', () => {
    const registry = createDependencyReadinessRegistry();
    const instances = instancesWithReadiness(registry, ['authentication', 'business']);
    const { service } = readinessService(productionEnv(), instances, { registry });

    const report = service.verify();

    expect(report).toEqual({
      ok: true,
      tier: 'required',
      authentication: 'verified',
      business: 'verified',
      checkedTokens: [...tokensOfRole('authentication'), ...tokensOfRole('business')],
      violations: [],
    });
  });

  it('声明替换：封存声明被展开复制（副本）后不再是封存身份 → DEPENDENCY_NOT_SEALED', () => {
    const registry = createDependencyReadinessRegistry();
    const sealed = sealDependency(registry, 'SESSION_STORE', 'authentication') as {
      capabilities: Record<string, unknown>;
    };
    const instances = new Map<symbol, unknown>(
      PERSISTENCE_BINDINGS.map((descriptor) => [
        descriptor.token,
        { capabilities: { ...sealed.capabilities } },
      ]),
    );
    const { service } = readinessService(productionEnv(), instances, { registry });

    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }
    const codes = (captured as DependencyReadinessError).violations.map((item) => item.code);
    expect(codes).toEqual(['DEPENDENCY_NOT_SEALED', 'DEPENDENCY_MUTABLE']);
  });

  it('声明挪用：把别的端口的封存声明绑定到会话存储 → DEPENDENCY_BINDING_MISMATCH', () => {
    const registry = createDependencyReadinessRegistry();
    // 业务端口的封存声明（token=GROUP_REPOSITORY / role=business）
    const foreign = sealDependency(registry, 'GROUP_REPOSITORY', 'business');
    const instances = new Map<symbol, unknown>(
      PERSISTENCE_BINDINGS.map((descriptor) => [descriptor.token, foreign]),
    );
    const { service } = readinessService(productionEnv(), instances, { registry });

    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }
    const violations = (captured as DependencyReadinessError).violations;
    expect(violations[0]?.code).toBe('DEPENDENCY_BINDING_MISMATCH');
    expect(violations[0]?.token).toBe('SESSION_STORE');
  });

  it('生产降级：未验证后端（productionReady=false）与过期证据都被拒绝', () => {
    const unverified = readinessService(
      productionEnv(),
      bindingInstances({ backend: 'postgres-draft', persistent: true, productionReady: false }),
    );
    let captured: unknown;
    try {
      unverified.service.verify();
    } catch (error) {
      captured = error;
    }
    expect((captured as DependencyReadinessError).violations.map((item) => item.code)).toEqual([
      'DEPENDENCY_NOT_VERIFIED',
    ]);

    // 证据过期：同一份封存声明在超过新鲜度窗口后必须重新验证
    const registry = createDependencyReadinessRegistry();
    const staleInstances = new Map<symbol, unknown>();
    for (const descriptor of PERSISTENCE_BINDINGS) {
      const token = bindingTokenName(descriptor.token);
      staleInstances.set(
        descriptor.token,
        descriptor.role === 'infrastructure'
          ? { capabilities: IN_MEMORY }
          : sealDependency(registry, token, descriptor.role, {
              verifiedAt: isoDaysAgo(120),
            }),
      );
    }
    const stale = readinessService(productionEnv(), staleInstances, { registry });
    let staleCaptured: unknown;
    try {
      stale.service.verify();
    } catch (error) {
      staleCaptured = error;
    }
    const staleCodes = new Set(
      (staleCaptured as DependencyReadinessError).violations.map((item) => item.code),
    );
    expect([...staleCodes]).toEqual(['DEPENDENCY_EVIDENCE_STALE']);
  });

  it('证据必须可核对：验证方式不被生产接受时拒绝', () => {
    const registry = createDependencyReadinessRegistry();
    const instances = new Map<symbol, unknown>();
    for (const descriptor of PERSISTENCE_BINDINGS) {
      const token = bindingTokenName(descriptor.token);
      instances.set(
        descriptor.token,
        descriptor.role === 'infrastructure'
          ? { capabilities: IN_MEMORY }
          : sealDependency(registry, token, descriptor.role, { evidenceMethod: 'manual-review' }),
      );
    }
    const { service } = readinessService(productionEnv(), instances, { registry });

    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }
    const codes = new Set(
      (captured as DependencyReadinessError).violations.map((item) => item.code),
    );
    expect([...codes]).toEqual(['DEPENDENCY_EVIDENCE_METHOD_NOT_ACCEPTED']);
  });

  it('启动日志只写脱敏摘要：不含证据 id、后端标识、连接串与口令', () => {
    const logged: string[] = [];
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    try {
      const registry = createDependencyReadinessRegistry();
      const instances = instancesWithReadiness(registry, ['authentication', 'business']);
      const { service } = readinessService(productionEnv(), instances, { registry });

      service.verify();

      const summary = logged.find((line) => line.includes('生产依赖就绪门禁'));
      expect(summary).toContain('档位=required');
      expect(summary).toContain('认证阶段=通过');
      expect(summary).toContain('业务阶段=通过');
      expect(summary).not.toMatch(/dep-evidence|fixture-dep-run|postgresql|sup3r|password/iu);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('生产依赖就绪门禁：真实 Nest 装配（不建连接）', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSslMode = process.env.DATABASE_SSL_MODE;

  afterAll(() => {
    for (const [key, value] of [
      ['DATABASE_URL', originalDatabaseUrl],
      ['NODE_ENV', originalNodeEnv],
      ['DATABASE_SSL_MODE', originalSslMode],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('生产环境 + 伪造能力自述的持久化绑定：装配在引导阶段被依赖就绪门禁拒绝', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = LOOPBACK_URL;
    process.env.DATABASE_SSL_MODE = 'verify-full';

    const forged = { backend: 'postgres', persistent: true, productionReady: true };

    @Module({
      imports: [ConfigModule, DatabaseModule],
      providers: PERSISTENCE_BINDINGS.map((descriptor) => ({
        provide: descriptor.token,
        useValue: { capabilities: forged },
      })),
    })
    class ForgedReadinessAssembly {}

    const app = await NestFactory.create(ForgedReadinessAssembly, {
      logger: false,
      abortOnError: false,
    });
    try {
      let captured: unknown;
      try {
        await app.init();
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(DependencyReadinessError);
      const error = captured as DependencyReadinessError;
      // 认证先行：真实装配里先失败的是会话存储，业务端口没有被读取
      expect([...new Set(error.violations.map((item) => item.token))]).toEqual(['SESSION_STORE']);
      expect(error.violations.some((item) => item.code === 'DEPENDENCY_NOT_SEALED')).toBe(true);
      expect(error.message).not.toContain('://');
      expect(error.message).not.toContain('postgres:postgres');
      expect(app.get(PersistenceBoundaryService).readinessReport()).toBeUndefined();
    } finally {
      await app.close();
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
