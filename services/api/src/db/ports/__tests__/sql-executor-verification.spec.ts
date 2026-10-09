import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../config/env';
import {
  createAppSqlConnectionFactory,
  PersistenceBoundaryService,
  resolveAppDatabaseConfig,
} from '../../database.module';
import { MIGRATION_DEPLOYMENT_GUARD_CONTRACT } from '../../migrations/migration-deployment-guard';
import { bindingTokenName, PERSISTENCE_BINDINGS } from '../../persistence-bindings';
import {
  isForbiddenDriverSpecifier,
  isAuthorizedDriverSpecifier,
} from '../../persistence/postgres-adapter-registry';
import {
  assertPersistenceBoundary,
  evaluatePersistenceBoundary,
  PersistenceBoundaryError,
  type PersistenceBinding,
} from '../../persistence/production-guard';
import {
  assertSchemaReadinessShape,
  assertVerificationEvidenceShape,
  assertVerifiedSqlExecutor,
  collectSqlExecutorVerificationInput,
  createSqlExecutorVerificationRegistry,
  DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
  evaluateSqlExecutorVerification,
  inspectSqlExecutorSurface,
  isDeeplyImmutableDeclaration,
  isInMemoryBackendMarker,
  POSTGRES_EXECUTOR_BACKEND,
  SQL_EXECUTOR_ACCEPTED_EVIDENCE_METHODS,
  SQL_EXECUTOR_VERIFICATION_CONTRACT,
  SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
  SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
  SqlExecutorVerificationError,
  type SchemaMigrationReadinessEvidence,
  type SqlExecutorAttestationInput,
  type SqlExecutorSurfaceFacts,
  type SqlExecutorVerificationEvidence,
  type SqlExecutorVerificationInput,
  type SqlExecutorVerificationRegistry,
} from '../sql-executor-verification';
import {
  UNVERIFIED_DRIVER_BACKEND,
  type PersistenceCapabilities,
  type VerifiedSqlExecutorCapabilities,
} from '../sql-executor.port';

/**
 * SQL 执行器验证契约专项门禁（**生产执行器准入的 fail-closed 契约**）。
 *
 * ## 这道门禁回答什么问题
 * 能力声明（`PersistenceCapabilities`）是自述：任何字面量都能声称 `backend = postgres` /
 * `productionReady = true`，且随时可被改写。本文件证明生产准入契约把「生产执行器」收紧成
 * 可机器判定的清单，并且**每一项检查都是承重的**（能单独失败，而不是靠别的检查顺带拦下）：
 * - 封存声明不可伪造（登记表身份）且不可变（深度冻结 / 自持原型 / 只允许数据属性）；
 * - 参数化查询能力与事务能力必须由声明 + 实例结构事实共同证明；
 * - 验证来源必须已登记、齐全、可核对、落在新鲜度窗口内且与声明不冲突；
 * - schema / 迁移就绪证据必须锚定迁移部署守卫契约身份，且「已应用 = 可用」；
 * - 内存替身、非参数化执行器、缺失/过期/冲突证据一律拒绝；
 * - 真实装配里目前**没有任何**已封存的生产执行器（默认工厂是 fail-closed 未验证驱动），
 *   因此生产边界必然拒绝启动；开发/测试仍允许普通能力声明。
 *
 * 判定逻辑在 `../sql-executor-verification.ts`（纯函数 + 登记表），本文件只负责构造事实、
 * 固定断言与真实装配取证；不引入任何数据库驱动、不建连接、不执行 SQL。
 */

const REPO_ROOT = findRepoRoot(process.cwd());
const SRC_ROOT = join(REPO_ROOT, 'services', 'api', 'src');
const PORTS_ROOT = join(SRC_ROOT, 'db', 'ports');
const CONTRACT_SOURCE = join(PORTS_ROOT, 'sql-executor-verification.ts');
const PORT_SOURCE = join(PORTS_ROOT, 'sql-executor.port.ts');

const NOW = '2026-10-09T00:00:00.000Z';
const VERIFIED_AT = '2026-10-08T00:00:00.000Z';
const CHECKED_AT = '2026-10-08T00:00:00.000Z';
const STALE_NOW = '2027-06-01T00:00:00.000Z';
const FUTURE_VERIFIED_AT = '2026-10-09T06:00:00.000Z';
const EVIDENCE_ID = 'pg-integration-2026-10-08';
const READINESS_ID = 'pg-schema-readiness-2026-10-08';
const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';

const IN_MEMORY: PersistenceCapabilities = {
  backend: 'in-memory-baseline',
  persistent: false,
  productionReady: false,
};

/** 自述「生产可用」但**未经任何验证**的能力声明：正是本契约要拦下的形状 */
const UNSEALED_POSTGRES: PersistenceCapabilities = {
  backend: POSTGRES_EXECUTOR_BACKEND,
  persistent: true,
  productionReady: true,
};

// ---------------------------------------------------------------------------
// 事实构造
// ---------------------------------------------------------------------------

function evidence(
  overrides: Partial<SqlExecutorVerificationEvidence> = {},
): SqlExecutorVerificationEvidence {
  return {
    evidenceId: EVIDENCE_ID,
    backend: POSTGRES_EXECUTOR_BACKEND,
    contractId: SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
    contractVersion: SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
    verifiedBy: 'ci://rm-integration-pg',
    verifiedAt: VERIFIED_AT,
    method: 'integration-test',
    parameterizedQueries: true,
    transactions: true,
    evidenceRef: 'services/api/test/integration/pg-executor.spec.ts#参数化查询与事务',
    ...overrides,
  };
}

function readiness(
  overrides: Partial<SchemaMigrationReadinessEvidence> = {},
): SchemaMigrationReadinessEvidence {
  return {
    readinessId: READINESS_ID,
    backend: POSTGRES_EXECUTOR_BACKEND,
    migrationContractId: MIGRATION_DEPLOYMENT_GUARD_CONTRACT.id,
    migrationContractVersion: MIGRATION_DEPLOYMENT_GUARD_CONTRACT.version,
    availableVersions: ['0001'],
    appliedVersions: ['0001'],
    checkedBy: 'ci://rm-migration-check',
    checkedAt: CHECKED_AT,
    readinessRef: 'db/migrations/0001_bootstrap.sql#schema_migrations',
    ...overrides,
  };
}

function attestationInput(
  overrides: Partial<SqlExecutorAttestationInput> = {},
): SqlExecutorAttestationInput {
  return {
    backend: POSTGRES_EXECUTOR_BACKEND,
    persistent: true,
    productionReady: true,
    parameterizedQueries: true,
    transactions: true,
    evidenceId: EVIDENCE_ID,
    verifiedAt: VERIFIED_AT,
    readinessId: READINESS_ID,
    checkedAt: CHECKED_AT,
    ...overrides,
  };
}

/** 参数化查询 + 事务 + 关闭：生产执行器应有的形参槽结构 */
function executorSurface(
  overrides: Partial<SqlExecutorSurfaceFacts> = {},
): SqlExecutorSurfaceFacts {
  return {
    kind: 'executor',
    hasConnect: false,
    hasQuery: true,
    queryParameterSlots: 2,
    hasTransaction: true,
    transactionParameterSlots: 1,
    hasClose: true,
    ...overrides,
  };
}

/** 连接工厂形态：只暴露 connect（参数化与事务由声明 + 集成证据覆盖） */
function factorySurface(overrides: Partial<SqlExecutorSurfaceFacts> = {}): SqlExecutorSurfaceFacts {
  return executorSurface({
    kind: 'connection-factory',
    hasConnect: true,
    hasQuery: false,
    queryParameterSlots: 0,
    hasTransaction: false,
    transactionParameterSlots: 0,
    hasClose: false,
    ...overrides,
  });
}

interface Fixture {
  readonly registry: SqlExecutorVerificationRegistry;
  readonly declaration: VerifiedSqlExecutorCapabilities;
}

/** 组装一份「本该通过」的生产执行器事实：可核对证据 + 迁移就绪证据 + 封存声明 */
function fixture(
  options: {
    readonly evidenceOverrides?: Partial<SqlExecutorVerificationEvidence>;
    readonly readinessOverrides?: Partial<SchemaMigrationReadinessEvidence>;
    readonly attestationOverrides?: Partial<SqlExecutorAttestationInput>;
    readonly registerEvidence?: boolean;
    readonly registerReadiness?: boolean;
  } = {},
): Fixture {
  const registry = createSqlExecutorVerificationRegistry();
  if (options.registerEvidence !== false) {
    registry.registerVerificationEvidence(evidence(options.evidenceOverrides));
  }
  if (options.registerReadiness !== false) {
    registry.registerSchemaReadiness(readiness(options.readinessOverrides));
  }
  return { registry, declaration: registry.attest(attestationInput(options.attestationOverrides)) };
}

function evaluationInput(
  target: Fixture,
  overrides: Partial<SqlExecutorVerificationInput> = {},
): SqlExecutorVerificationInput {
  return {
    nodeEnv: 'production',
    declaration: target.declaration,
    surface: executorSurface(),
    registry: target.registry,
    now: NOW,
    ...overrides,
  };
}

function evaluate(
  target: Fixture,
  overrides: Partial<SqlExecutorVerificationInput> = {},
): ReturnType<typeof evaluateSqlExecutorVerification> {
  return evaluateSqlExecutorVerification(evaluationInput(target, overrides));
}

function codesOf(report: { readonly violations: readonly { readonly code: string }[] }): string[] {
  return report.violations.map((item) => item.code);
}

/** 一个「自称已封存」的登记表：用于证明完整性检查独立于封存身份（纵深防御） */
function registryClaimingSealed(
  base: SqlExecutorVerificationRegistry,
  sealedValues: readonly unknown[],
): SqlExecutorVerificationRegistry {
  return {
    ...base,
    isSealed: (value) => sealedValues.includes(value),
  };
}

/** 手工构造的普通声明对象：用于证明「声称已封存」也无法绕过完整性/契约/证据检查 */
function plainDeclaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractId: SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
    contractVersion: SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
    backend: POSTGRES_EXECUTOR_BACKEND,
    persistent: true,
    productionReady: true,
    parameterizedQueries: true,
    transactions: true,
    verification: { evidenceId: EVIDENCE_ID, verifiedAt: VERIFIED_AT },
    schemaReadiness: { readinessId: READINESS_ID, checkedAt: CHECKED_AT },
    ...overrides,
  };
}

/**
 * 用「自证已封存的登记表 + 手工声明」构造输入：登记表先登记好证据与就绪证据，
 * 因此违规只能来自被测的那一项检查。
 */
function poisonedRegistryInput(
  declaration: Record<string, unknown>,
  registerEvidence = true,
  registerReadiness = true,
): SqlExecutorVerificationInput {
  const registry = createSqlExecutorVerificationRegistry();
  if (registerEvidence) {
    registry.registerVerificationEvidence(evidence());
  }
  if (registerReadiness) {
    registry.registerSchemaReadiness(readiness());
  }
  return {
    nodeEnv: 'production',
    declaration,
    surface: executorSurface(),
    registry: registryClaimingSealed(registry, [declaration]),
    now: NOW,
  };
}

function verificationError(run: () => unknown): SqlExecutorVerificationError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof SqlExecutorVerificationError ? error : undefined;
  }
}

// ---------------------------------------------------------------------------
// 契约身份：与迁移部署守卫契约同源，规则集合固定
// ---------------------------------------------------------------------------

describe('契约身份与跨契约同步', () => {
  it('契约身份、后端与生产可接受的验证方式都是固定值', () => {
    expect(SQL_EXECUTOR_VERIFICATION_CONTRACT_ID).toBe('sql-executor-verification');
    expect(SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION).toBe(1);
    expect(POSTGRES_EXECUTOR_BACKEND).toBe('postgres');
    expect(SQL_EXECUTOR_ACCEPTED_EVIDENCE_METHODS).toEqual(['integration-test']);
    expect(SQL_EXECUTOR_VERIFICATION_CONTRACT).toMatchObject({
      id: SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
      version: SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
      backend: POSTGRES_EXECUTOR_BACKEND,
    });
    // 新鲜度窗口必须是有限正值：不得出现「验证一次、永久生产可用」的窗口
    expect(SQL_EXECUTOR_VERIFICATION_CONTRACT.evidenceMaxAgeDays).toBeGreaterThan(0);
    expect(SQL_EXECUTOR_VERIFICATION_CONTRACT.readinessMaxAgeDays).toBeGreaterThan(0);
    expect(SQL_EXECUTOR_VERIFICATION_CONTRACT.readinessMaxAgeDays).toBeLessThanOrEqual(
      SQL_EXECUTOR_VERIFICATION_CONTRACT.evidenceMaxAgeDays,
    );
  });

  it('迁移就绪证据锚定的契约身份直接取自迁移部署守卫契约（不允许两份契约各自漂移）', () => {
    expect(SQL_EXECUTOR_VERIFICATION_CONTRACT.migrationContractId).toBe(
      MIGRATION_DEPLOYMENT_GUARD_CONTRACT.id,
    );
    expect(SQL_EXECUTOR_VERIFICATION_CONTRACT.migrationContractVersion).toBe(
      MIGRATION_DEPLOYMENT_GUARD_CONTRACT.version,
    );
    expect(SQL_EXECUTOR_VERIFICATION_CONTRACT.migrationContractId).toBe(
      'migration-deployment-guard',
    );
  });

  it('内存/非持久后端标识识别口径有效（避免「没扫到」冒充「没有」）', () => {
    expect(isInMemoryBackendMarker('in-memory-baseline')).toBe(true);
    expect(isInMemoryBackendMarker('IN-MEMORY')).toBe(true);
    expect(isInMemoryBackendMarker('memory')).toBe(true);
    expect(isInMemoryBackendMarker('postgres')).toBe(false);
    expect(isInMemoryBackendMarker('unverified-driver')).toBe(false);
    expect(isInMemoryBackendMarker(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1. 封存声明：不可伪造 + 不可变
// ---------------------------------------------------------------------------

describe('封存声明：不可伪造、不可变', () => {
  it('attest 产出的声明被深度冻结，改字段会直接抛错', () => {
    const { declaration } = fixture();
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.isFrozen(declaration.verification)).toBe(true);
    expect(Object.isFrozen(declaration.schemaReadiness)).toBe(true);
    expect(Object.isExtensible(declaration)).toBe(false);
    expect(declaration).toMatchObject({
      contractId: SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
      contractVersion: SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
      backend: POSTGRES_EXECUTOR_BACKEND,
      persistent: true,
      productionReady: true,
      parameterizedQueries: true,
      transactions: true,
    });

    // 篡改声明（严格模式下写入冻结对象抛 TypeError）
    expect(() => {
      (declaration as { backend: string }).backend = 'in-memory-baseline';
    }).toThrow(TypeError);
    expect(() => {
      (declaration as { productionReady: boolean }).productionReady = false;
    }).toThrow(TypeError);
    expect(() => {
      (declaration.verification as { evidenceId: string }).evidenceId = '伪造证据';
    }).toThrow(TypeError);
    expect(declaration.backend).toBe(POSTGRES_EXECUTOR_BACKEND);
  });

  it('复制、克隆、JSON 往返与原型继承都拿不到封存身份', () => {
    const { declaration, registry } = fixture();
    expect(registry.isSealed(declaration)).toBe(true);
    expect(registry.isSealed({ ...declaration })).toBe(false);
    expect(registry.isSealed(structuredClone(declaration))).toBe(false);
    expect(registry.isSealed(JSON.parse(JSON.stringify(declaration)))).toBe(false);
    expect(registry.isSealed(Object.create(declaration))).toBe(false);
    expect(registry.isSealed(plainDeclaration())).toBe(false);
    expect(registry.isSealed(undefined)).toBe(false);

    // 完整性判定也识别这些伪造形状：展开副本未深度冻结、继承对象不自持
    expect(isDeeplyImmutableDeclaration(declaration)).toBe(true);
    const shallow = { ...declaration, verification: { ...declaration.verification } };
    expect(isDeeplyImmutableDeclaration(shallow)).toBe(false);
    expect(isDeeplyImmutableDeclaration(Object.create(declaration))).toBe(false);
  });

  it('访问器属性（getter）不算不可变声明：同一份声明会随时间给出不同值', () => {
    const withGetter: Record<string, unknown> = { backend: POSTGRES_EXECUTOR_BACKEND };
    Object.defineProperty(withGetter, 'persistent', {
      enumerable: true,
      configurable: false,
      get: () => true,
    });
    Object.freeze(withGetter);
    expect(isDeeplyImmutableDeclaration(withGetter)).toBe(false);
  });

  it('空登记表不封存任何声明（登记表身份是唯一来源）', () => {
    const registry = createSqlExecutorVerificationRegistry();
    expect(registry.isSealed(plainDeclaration())).toBe(false);
    expect(registry.describe()).toEqual({
      sealedDeclarations: 0,
      verificationEvidence: 0,
      schemaReadiness: 0,
    });
  });

  it.each([
    {
      name: '后端不是 postgres',
      input: attestationInput({ backend: 'sqlite' }),
      code: 'BACKEND_NOT_POSTGRES',
    },
    {
      name: '内存替身后端',
      input: attestationInput({ backend: 'in-memory-baseline' }),
      code: 'IN_MEMORY_DOUBLE',
    },
    {
      name: 'persistent 被降级',
      input: attestationInput({ persistent: false }),
      code: 'IN_MEMORY_DOUBLE',
    },
    {
      name: '未验证就声称生产可用',
      input: attestationInput({ productionReady: false }),
      code: 'NOT_PRODUCTION_READY',
    },
    {
      name: '非参数化执行器',
      input: attestationInput({ parameterizedQueries: false }),
      code: 'PARAMETERIZATION_NOT_ATTESTED',
    },
    {
      name: '无事务能力',
      input: attestationInput({ transactions: false }),
      code: 'TRANSACTION_NOT_ATTESTED',
    },
    {
      name: '缺验证证据 id',
      input: attestationInput({ evidenceId: '  ' }),
      code: 'EVIDENCE_MISSING',
    },
    {
      name: '验证时间非法',
      input: attestationInput({ verifiedAt: '2026-10-08' }),
      code: 'EVIDENCE_MISSING',
    },
    {
      name: '缺迁移就绪证据 id',
      input: attestationInput({ readinessId: '' }),
      code: 'SCHEMA_READINESS_MISSING',
    },
    {
      name: '迁移就绪核对时间非法',
      input: attestationInput({ checkedAt: '昨天' }),
      code: 'SCHEMA_READINESS_MISSING',
    },
  ])('attest 拒绝不合规的封存输入：$name → $code', ({ input, code }) => {
    const registry = createSqlExecutorVerificationRegistry();
    const error = verificationError(() => registry.attest(input));
    expect(error).toBeInstanceOf(SqlExecutorVerificationError);
    expect(error?.violations.map((item) => item.code)).toContain(code);
    // 拒绝时不得写入登记表：失败不得留下半封存状态
    expect(registry.describe().sealedDeclarations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 实例结构事实：只读，不调用执行器
// ---------------------------------------------------------------------------

describe('实例结构事实：识别执行器形态与形参槽（不调用任何方法）', () => {
  it('连接工厂：只暴露 connect 时判定为 connection-factory', () => {
    const calls: string[] = [];
    const factory = {
      capabilities: UNSEALED_POSTGRES,
      connect(_config: unknown): Promise<never> {
        calls.push('connect');
        return Promise.reject(new Error('不应被调用'));
      },
    };
    expect(inspectSqlExecutorSurface(factory)).toEqual({
      kind: 'connection-factory',
      hasConnect: true,
      hasQuery: false,
      queryParameterSlots: 0,
      hasTransaction: false,
      transactionParameterSlots: 0,
      hasClose: false,
    });
    expect(calls).toEqual([]);
  });

  it('执行器/连接：query(sql, parameters) + transaction(run) + close 被如实计数', () => {
    const calls: string[] = [];
    const connection = {
      capabilities: UNSEALED_POSTGRES,
      query(_sql: string, _parameters?: readonly unknown[]): Promise<never> {
        calls.push('query');
        return Promise.reject(new Error('不应被调用'));
      },
      transaction(_run: unknown): Promise<never> {
        calls.push('transaction');
        return Promise.reject(new Error('不应被调用'));
      },
      close(): Promise<void> {
        calls.push('close');
        return Promise.resolve();
      },
    };
    expect(inspectSqlExecutorSurface(connection)).toEqual({
      kind: 'executor',
      hasConnect: false,
      hasQuery: true,
      queryParameterSlots: 2,
      hasTransaction: true,
      transactionParameterSlots: 1,
      hasClose: true,
    });
    expect(calls).toEqual([]);
  });

  it('单参 query(sql) 被识别为未声明参数槽（非参数化执行器）', () => {
    const surface = inspectSqlExecutorSurface({
      query(_sql: string): Promise<never> {
        return Promise.reject(new Error('不应被调用'));
      },
    });
    expect(surface.hasQuery).toBe(true);
    expect(surface.queryParameterSlots).toBe(1);
    expect(surface.hasTransaction).toBe(false);
  });

  it.each([
    { name: '只有 capabilities 的替身', instance: { capabilities: IN_MEMORY } },
    { name: '空对象', instance: {} },
    { name: 'null', instance: null },
    { name: '字符串', instance: 'sql' },
  ])('$name 不属于执行器形态', ({ instance }) => {
    expect(inspectSqlExecutorSurface(instance).kind).toBe('not-an-executor');
  });
});

// ---------------------------------------------------------------------------
// 3. 登记表：验证来源与迁移就绪证据
// ---------------------------------------------------------------------------

describe('登记表：证据形状校验与冲突留存', () => {
  it('合法证据可登记，内容相同的重复登记是幂等的', () => {
    const registry = createSqlExecutorVerificationRegistry();
    registry.registerVerificationEvidence(evidence());
    registry.registerVerificationEvidence(evidence());
    expect(registry.verificationEvidence(EVIDENCE_ID)).toHaveLength(1);
    expect(registry.describe()).toEqual({
      sealedDeclarations: 0,
      verificationEvidence: 1,
      schemaReadiness: 0,
    });
  });

  it('同一 evidenceId 登记出不同内容时两条并存（构成冲突证据，绝不静默覆盖）', () => {
    const registry = createSqlExecutorVerificationRegistry();
    registry.registerVerificationEvidence(evidence());
    registry.registerVerificationEvidence(evidence({ transactions: false }));
    expect(registry.verificationEvidence(EVIDENCE_ID)).toHaveLength(2);
  });

  it('合法的迁移就绪证据可登记并可按 id 取回', () => {
    const registry = createSqlExecutorVerificationRegistry();
    registry.registerSchemaReadiness(readiness());
    expect(registry.schemaReadiness(READINESS_ID)).toHaveLength(1);
    expect(registry.schemaReadiness('未登记')).toEqual([]);
  });

  it.each([
    {
      name: '缺 evidenceId',
      record: evidence({ evidenceId: ' ' }),
      code: 'EVIDENCE_MISSING',
    },
    {
      name: '缺 verifiedBy',
      record: evidence({ verifiedBy: '' }),
      code: 'EVIDENCE_MISSING',
    },
    {
      name: '缺可核对的 evidenceRef',
      record: evidence({ evidenceRef: '  ' }),
      code: 'EVIDENCE_MISSING',
    },
    {
      name: 'verifiedAt 不是带时区的 ISO 时间',
      record: evidence({ verifiedAt: '2026-10-08 00:00' }),
      code: 'EVIDENCE_MISSING',
    },
    {
      name: '契约身份不符',
      record: evidence({ contractId: 'legacy-contract' }),
      code: 'EVIDENCE_CONFLICTING',
    },
    {
      name: '契约版本不符',
      record: evidence({ contractVersion: 0 }),
      code: 'EVIDENCE_CONFLICTING',
    },
    {
      name: '验证方式不在允许集合',
      record: evidence({ method: 'self-declared' as SqlExecutorVerificationEvidence['method'] }),
      code: 'EVIDENCE_METHOD_NOT_ACCEPTED',
    },
  ])('验证证据形状校验拒绝：$name → $code', ({ record, code }) => {
    const error = verificationError(() => assertVerificationEvidenceShape(record));
    expect(error?.violations.map((item) => item.code)).toContain(code);
    const registry = createSqlExecutorVerificationRegistry();
    expect(verificationError(() => registry.registerVerificationEvidence(record))).toBeInstanceOf(
      SqlExecutorVerificationError,
    );
    expect(registry.describe().verificationEvidence).toBe(0);
  });

  it.each([
    {
      name: '缺 readinessId',
      record: readiness({ readinessId: '' }),
      code: 'SCHEMA_READINESS_MISSING',
    },
    {
      name: '缺 checkedBy',
      record: readiness({ checkedBy: '' }),
      code: 'SCHEMA_READINESS_MISSING',
    },
    {
      name: '缺可核对的 readinessRef',
      record: readiness({ readinessRef: '' }),
      code: 'SCHEMA_READINESS_MISSING',
    },
    {
      name: 'checkedAt 非法',
      record: readiness({ checkedAt: '刚刚' }),
      code: 'SCHEMA_READINESS_MISSING',
    },
    {
      name: '版本数组缺失',
      record: {
        ...readiness(),
        availableVersions: undefined,
      } as unknown as SchemaMigrationReadinessEvidence,
      code: 'SCHEMA_READINESS_MISSING',
    },
    {
      name: '缺迁移契约身份',
      record: readiness({ migrationContractId: '' }),
      code: 'SCHEMA_READINESS_CONTRACT_MISMATCH',
    },
    {
      name: '迁移契约版本不是整数',
      record: {
        ...readiness(),
        migrationContractVersion: 1.5,
      } as unknown as SchemaMigrationReadinessEvidence,
      code: 'SCHEMA_READINESS_CONTRACT_MISMATCH',
    },
  ])('迁移就绪证据形状校验拒绝：$name → $code', ({ record, code }) => {
    const error = verificationError(() => assertSchemaReadinessShape(record));
    expect(error?.violations.map((item) => item.code)).toContain(code);
    const registry = createSqlExecutorVerificationRegistry();
    expect(verificationError(() => registry.registerSchemaReadiness(record))).toBeInstanceOf(
      SqlExecutorVerificationError,
    );
    expect(registry.describe().schemaReadiness).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. 判定器：正向路径（生产放行需要「封存声明 + 全部证据到位」）
// ---------------------------------------------------------------------------

describe('判定器：生产环境的正向路径', () => {
  it('执行器形态（query(sql, parameters) + transaction）通过，并回填契约事实', () => {
    const target = fixture();
    expect(evaluate(target)).toEqual({
      ok: true,
      violations: [],
      declaredBackend: POSTGRES_EXECUTOR_BACKEND,
      evidenceId: EVIDENCE_ID,
      readinessId: READINESS_ID,
    });
    expect(assertVerifiedSqlExecutor(evaluationInput(target)).ok).toBe(true);
  });

  it('连接工厂形态（只暴露 connect）同样通过：参数化与事务由声明 + 集成证据覆盖', () => {
    const target = fixture();
    const report = evaluate(target, { surface: factorySurface() });
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('同一份证据被多条声明引用时仍然放行（证据登记表按 id 复用）', () => {
    const registry = createSqlExecutorVerificationRegistry();
    registry.registerVerificationEvidence(evidence());
    registry.registerSchemaReadiness(readiness());
    const first = registry.attest(attestationInput());
    const second = registry.attest(attestationInput());
    expect(registry.describe().sealedDeclarations).toBe(2);
    expect(first).not.toBe(second);
    for (const declaration of [first, second]) {
      expect(
        evaluateSqlExecutorVerification({
          nodeEnv: 'production',
          declaration,
          surface: executorSurface(),
          registry,
          now: NOW,
        }).ok,
      ).toBe(true);
    }
  });

  it('就绪证据覆盖当前仓库真实迁移集合：已应用 = 可用才放行', () => {
    // 就绪证据直接用磁盘上的真实迁移集合构造：新增迁移时本用例自动跟随，
    // 不会因为「硬编码的版本清单过期」而产生与被测契约无关的假失败。
    const available = [...REAL_MIGRATION_VERSIONS];
    expect(available.length).toBeGreaterThan(0);
    expect(available).toEqual([...available].sort());

    const target = fixture({
      readinessOverrides: { availableVersions: available, appliedVersions: available },
    });
    expect(evaluate(target).ok).toBe(true);
  });

  it('判定时刻必须是可复现的带时区 ISO 时间戳（否则属于调用方错误）', () => {
    const target = fixture();
    expect(() => evaluate(target, { now: '2026-10-09' })).toThrow(TypeError);
    expect(() => evaluate(target, { now: 'not-a-time' })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 5. 判定器：拒绝路径（每条检查单独承重）
// ---------------------------------------------------------------------------

describe('判定器：生产环境拒绝不可信执行器', () => {
  it.each([
    {
      name: '没有能力声明',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture(), { declaration: undefined }),
      code: 'DECLARATION_MISSING',
    },
    {
      name: '普通对象字面量自述生产可用（未封存）',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture(), { declaration: UNSEALED_POSTGRES }),
      code: 'DECLARATION_NOT_SEALED',
    },
    {
      name: '声明被 JSON 往返复制（身份不同）',
      build: (): SqlExecutorVerificationInput => {
        const target = fixture();
        return evaluationInput(target, {
          declaration: JSON.parse(JSON.stringify(target.declaration)),
        });
      },
      code: 'DECLARATION_NOT_SEALED',
    },
    {
      name: '声明通过原型继承伪造（不自持）',
      build: (): SqlExecutorVerificationInput => {
        const target = fixture();
        return evaluationInput(target, { declaration: Object.create(target.declaration) });
      },
      code: 'DECLARATION_MUTABLE',
    },
    {
      name: '登记表声称已封存但声明实际可变（未冻结）',
      build: (): SqlExecutorVerificationInput => poisonedRegistryInput(plainDeclaration()),
      code: 'DECLARATION_MUTABLE',
    },
    {
      name: '契约身份过期',
      build: (): SqlExecutorVerificationInput =>
        poisonedRegistryInput(
          plainDeclaration({ contractId: 'legacy-contract', contractVersion: 0 }),
        ),
      code: 'DECLARATION_CONTRACT_MISMATCH',
    },
    {
      name: '后端不是 postgres',
      build: (): SqlExecutorVerificationInput => {
        const registry = createSqlExecutorVerificationRegistry();
        registry.registerVerificationEvidence(evidence({ backend: 'sqlite' }));
        registry.registerSchemaReadiness(readiness({ backend: 'sqlite' }));
        const declaration = plainDeclaration({ backend: 'sqlite' });
        return {
          nodeEnv: 'production',
          declaration,
          surface: executorSurface(),
          registry: registryClaimingSealed(registry, [declaration]),
          now: NOW,
        };
      },
      code: 'BACKEND_NOT_POSTGRES',
    },
    {
      name: '内存替身声明',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture(), { declaration: IN_MEMORY }),
      code: 'IN_MEMORY_DOUBLE',
    },
    {
      name: '未验证驱动工厂（非持久替身）',
      build: (): SqlExecutorVerificationInput => {
        const factory = createAppSqlConnectionFactory();
        return {
          nodeEnv: 'production',
          declaration: factory.capabilities,
          surface: factorySurface(),
          registry: DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
          now: NOW,
        };
      },
      code: 'IN_MEMORY_DOUBLE',
    },
    {
      name: '未验证就声称生产可用',
      build: (): SqlExecutorVerificationInput =>
        poisonedRegistryInput(plainDeclaration({ productionReady: false })),
      code: 'NOT_PRODUCTION_READY',
    },
    {
      name: '参数化能力未声明',
      build: (): SqlExecutorVerificationInput =>
        poisonedRegistryInput(plainDeclaration({ parameterizedQueries: false })),
      code: 'PARAMETERIZATION_NOT_ATTESTED',
    },
    {
      name: '非参数化执行器（单参 query）',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture(), { surface: executorSurface({ queryParameterSlots: 1 }) }),
      code: 'PARAMETERIZATION_UNSUPPORTED',
    },
    {
      name: '事务能力未声明',
      build: (): SqlExecutorVerificationInput =>
        poisonedRegistryInput(plainDeclaration({ transactions: false })),
      code: 'TRANSACTION_NOT_ATTESTED',
    },
    {
      name: '执行器缺少 transaction 方法',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture(), {
          surface: executorSurface({ hasTransaction: false, transactionParameterSlots: 0 }),
        }),
      code: 'TRANSACTION_UNSUPPORTED',
    },
    {
      name: '实例既不是执行器也不是连接工厂',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture(), {
          surface: executorSurface({
            kind: 'not-an-executor',
            hasConnect: false,
            hasQuery: false,
            queryParameterSlots: 0,
            hasTransaction: false,
            transactionParameterSlots: 0,
            hasClose: false,
          }),
        }),
      code: 'EXECUTOR_SURFACE_UNSUPPORTED',
    },
    {
      name: '声明缺少验证来源引用',
      build: (): SqlExecutorVerificationInput =>
        poisonedRegistryInput(plainDeclaration({ verification: undefined })),
      code: 'EVIDENCE_MISSING',
    },
    {
      name: '验证证据未登记',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture({ registerEvidence: false })),
      code: 'EVIDENCE_UNKNOWN',
    },
    {
      name: '验证证据过期',
      build: (): SqlExecutorVerificationInput => evaluationInput(fixture(), { now: STALE_NOW }),
      code: 'EVIDENCE_STALE',
    },
    {
      name: '验证时间超前于允许的时钟偏移',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(
          fixture({
            evidenceOverrides: { verifiedAt: FUTURE_VERIFIED_AT },
            attestationOverrides: { verifiedAt: FUTURE_VERIFIED_AT },
          }),
        ),
      code: 'EVIDENCE_STALE',
    },
    {
      name: '同一 evidenceId 出现冲突登记',
      build: (): SqlExecutorVerificationInput => {
        const target = fixture();
        target.registry.registerVerificationEvidence(
          evidence({ evidenceRef: '另一份来源不明的「验证」' }),
        );
        return evaluationInput(target);
      },
      code: 'EVIDENCE_CONFLICTING',
    },
    {
      name: '验证证据与声明的能力互相矛盾',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture({ evidenceOverrides: { transactions: false } })),
      code: 'EVIDENCE_CONFLICTING',
    },
    {
      name: '验证证据后端与声明不一致',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture({ evidenceOverrides: { backend: 'mysql' } })),
      code: 'EVIDENCE_CONFLICTING',
    },
    {
      name: '验证方式不是集成测试',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture({ evidenceOverrides: { method: 'manual-review' } })),
      code: 'EVIDENCE_METHOD_NOT_ACCEPTED',
    },
    {
      name: '声明缺少迁移就绪引用',
      build: (): SqlExecutorVerificationInput =>
        poisonedRegistryInput(plainDeclaration({ schemaReadiness: undefined })),
      code: 'SCHEMA_READINESS_MISSING',
    },
    {
      name: '迁移就绪证据未登记',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture({ registerReadiness: false })),
      code: 'SCHEMA_READINESS_UNKNOWN',
    },
    {
      name: '就绪证据锚定了别的迁移契约',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture({ readinessOverrides: { migrationContractVersion: 99 } })),
      code: 'SCHEMA_READINESS_CONTRACT_MISMATCH',
    },
    {
      name: '就绪证据过期',
      build: (): SqlExecutorVerificationInput => evaluationInput(fixture(), { now: STALE_NOW }),
      code: 'SCHEMA_READINESS_STALE',
    },
    {
      name: '仍有未应用迁移',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(
          fixture({
            readinessOverrides: { availableVersions: ['0001', '0002'], appliedVersions: ['0001'] },
          }),
        ),
      code: 'SCHEMA_READINESS_PENDING_MIGRATIONS',
    },
    {
      name: '已应用版本不是可用版本的前缀',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(
          fixture({
            readinessOverrides: { availableVersions: ['0001', '0002'], appliedVersions: ['0002'] },
          }),
        ),
      code: 'SCHEMA_READINESS_SEQUENCE_MISMATCH',
    },
    {
      name: '库中存在代码里没有的版本',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture({ readinessOverrides: { appliedVersions: ['0001', '0009'] } })),
      code: 'SCHEMA_READINESS_SEQUENCE_MISMATCH',
    },
    {
      name: '可用迁移版本为空（schema 无法确认）',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(
          fixture({ readinessOverrides: { availableVersions: [], appliedVersions: [] } }),
        ),
      code: 'SCHEMA_READINESS_UNVERIFIABLE',
    },
    {
      name: '就绪证据出现冲突登记',
      build: (): SqlExecutorVerificationInput => {
        const target = fixture();
        target.registry.registerSchemaReadiness(
          readiness({ availableVersions: ['0001', '0002'], appliedVersions: ['0001'] }),
        );
        return evaluationInput(target);
      },
      code: 'SCHEMA_READINESS_CONFLICTING',
    },
    {
      name: '就绪证据的核对时间与声明不一致',
      build: (): SqlExecutorVerificationInput => {
        const registry = createSqlExecutorVerificationRegistry();
        registry.registerVerificationEvidence(evidence());
        registry.registerSchemaReadiness(readiness({ checkedAt: '2026-10-07T00:00:00.000Z' }));
        return {
          nodeEnv: 'production',
          declaration: registry.attest(attestationInput()),
          surface: executorSurface(),
          registry,
          now: NOW,
        };
      },
      code: 'SCHEMA_READINESS_CONFLICTING',
    },
    {
      name: '就绪证据后端与声明不一致',
      build: (): SqlExecutorVerificationInput =>
        evaluationInput(fixture({ readinessOverrides: { backend: 'mysql' } })),
      code: 'SCHEMA_READINESS_CONFLICTING',
    },
  ])('拒绝路径：$name → $code', ({ build, code }) => {
    const report = evaluateSqlExecutorVerification(build());
    expect(codesOf(report)).toContain(code);
    expect(report.ok).toBe(false);
    // 拒绝信息不得携带连接串或口令
    for (const item of report.violations) {
      expect(item.detail).not.toContain('://');
      expect(item.detail).not.toContain('password');
    }
  });

  it('断言版抛出 SqlExecutorVerificationError，并列出全部违规主体与代码', () => {
    const error = verificationError(() =>
      assertVerifiedSqlExecutor(
        evaluationInput(fixture(), {
          label: 'SQL_CONNECTION_FACTORY',
          declaration: UNSEALED_POSTGRES,
        }),
      ),
    );
    expect(error).toBeInstanceOf(SqlExecutorVerificationError);
    expect(error?.violations.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'DECLARATION_NOT_SEALED',
        'DECLARATION_MUTABLE',
        'DECLARATION_CONTRACT_MISMATCH',
        'EVIDENCE_MISSING',
        'SCHEMA_READINESS_MISSING',
      ]),
    );
    expect(error?.message).toContain('SQL_CONNECTION_FACTORY[DECLARATION_NOT_SEALED]');
    expect(error?.message).not.toContain('://');
  });

  it('封存声明 + 未登记证据 + 未登记就绪证据：逐项报告缺失而不是笼统拒绝', () => {
    const target = fixture({ registerEvidence: false, registerReadiness: false });
    expect(codesOf(evaluate(target))).toEqual(['EVIDENCE_UNKNOWN', 'SCHEMA_READINESS_UNKNOWN']);
  });

  it('非参数化执行器的拒绝理由指向 query 的形参槽数量', () => {
    const report = evaluate(fixture(), { surface: executorSurface({ queryParameterSlots: 1 }) });
    const violation = report.violations.find(
      (item) => item.code === 'PARAMETERIZATION_UNSUPPORTED',
    );
    expect(violation?.detail).toContain('1 个形参槽');
  });

  it('「声称已封存」也无法掩盖可变声明：只报未冻结这一项', () => {
    const report = evaluateSqlExecutorVerification(poisonedRegistryInput(plainDeclaration()));
    expect(codesOf(report)).toEqual(['DECLARATION_MUTABLE']);
  });

  it('契约身份过期时只报契约不符（登记表自证封存 + 证据齐全）', () => {
    const report = evaluateSqlExecutorVerification(
      poisonedRegistryInput(plainDeclaration({ contractId: 'legacy', contractVersion: 0 })),
    );
    expect(codesOf(report)).toEqual(['DECLARATION_MUTABLE', 'DECLARATION_CONTRACT_MISMATCH']);
  });
});

// ---------------------------------------------------------------------------
// 6. 环境语义：开发/测试允许普通声明，封存声明在任何环境都必须自洽
// ---------------------------------------------------------------------------

describe('判定器：环境语义', () => {
  it('开发/测试环境放行普通能力声明（内存基线仍是合法开发形态）', () => {
    for (const nodeEnv of ['test', 'development']) {
      const report = evaluateSqlExecutorVerification({
        nodeEnv,
        declaration: IN_MEMORY,
        surface: executorSurface(),
        registry: DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
        now: NOW,
      });
      expect(report).toEqual({ ok: true, violations: [], declaredBackend: 'in-memory-baseline' });
    }
  });

  it('开发/测试环境缺少声明也不拦截（生产才强制）', () => {
    const report = evaluateSqlExecutorVerification({
      nodeEnv: 'test',
      declaration: undefined,
      surface: executorSurface(),
      registry: DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
      now: NOW,
    });
    expect(report.ok).toBe(true);
  });

  it('声明一旦被封存，任何环境都必须自洽：过期证据在测试环境也被拒绝', () => {
    const report = evaluate(fixture(), { nodeEnv: 'test', now: STALE_NOW });
    expect(codesOf(report)).toEqual(['EVIDENCE_STALE', 'SCHEMA_READINESS_STALE']);
  });

  it('生产环境缺少声明即拒绝（不因缺少声明而跳过检查）', () => {
    const report = evaluateSqlExecutorVerification({
      nodeEnv: 'production',
      declaration: undefined,
      surface: executorSurface(),
      registry: DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
      now: NOW,
    });
    expect(codesOf(report)).toEqual(['DECLARATION_MISSING']);
  });

  it('开发环境不因非参数化替身失败（结构事实只在生产或已封存时强制）', () => {
    const report = evaluateSqlExecutorVerification({
      nodeEnv: 'development',
      declaration: IN_MEMORY,
      surface: executorSurface({ queryParameterSlots: 1, hasTransaction: false }),
      registry: DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
      now: NOW,
    });
    expect(report.ok).toBe(true);
  });

  it('封存声明 + 非参数化执行器：即使证据齐全也必须拒绝', () => {
    const report = evaluate(fixture(), {
      nodeEnv: 'test',
      surface: executorSurface({ queryParameterSlots: 1 }),
    });
    expect(codesOf(report)).toEqual(['PARAMETERIZATION_UNSUPPORTED']);
  });
});

// ---------------------------------------------------------------------------
// 7. 事实采集：只对执行器形态生效，不调用执行器方法
// ---------------------------------------------------------------------------

describe('collectSqlExecutorVerificationInput：只采集、不调用', () => {
  it('连接工厂实例被采集为契约输入，声明取自 capabilities', () => {
    const factory = {
      capabilities: UNSEALED_POSTGRES,
      connect(_config: unknown): Promise<never> {
        return Promise.reject(new Error('不应被调用'));
      },
    };
    const input = collectSqlExecutorVerificationInput(factory, {
      registry: DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
      nodeEnv: 'production',
      now: NOW,
      label: 'SQL_CONNECTION_FACTORY',
    });
    expect(input).toMatchObject({
      nodeEnv: 'production',
      declaration: UNSEALED_POSTGRES,
      now: NOW,
      label: 'SQL_CONNECTION_FACTORY',
    });
    expect(input?.surface.kind).toBe('connection-factory');
  });

  it('只有能力声明的替身不属于契约范围（返回 undefined，由能力守卫判定）', () => {
    expect(
      collectSqlExecutorVerificationInput(
        { capabilities: UNSEALED_POSTGRES },
        { registry: DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY, nodeEnv: 'production', now: NOW },
      ),
    ).toBeUndefined();
    expect(
      collectSqlExecutorVerificationInput(null, {
        registry: DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
        nodeEnv: 'production',
        now: NOW,
      }),
    ).toBeUndefined();
  });

  it('省略 now 时使用运行期时刻（合法 ISO），且不调用执行器方法', () => {
    const calls: string[] = [];
    const connection = {
      capabilities: UNSEALED_POSTGRES,
      query(_sql: string, _parameters?: readonly unknown[]): Promise<never> {
        calls.push('query');
        return Promise.reject(new Error('不应被调用'));
      },
      transaction(_run: unknown): Promise<never> {
        calls.push('transaction');
        return Promise.reject(new Error('不应被调用'));
      },
    };
    const input = collectSqlExecutorVerificationInput(connection, {
      registry: DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
      nodeEnv: 'test',
    });
    expect(input).toBeDefined();
    expect(Number.isNaN(Date.parse(input?.now ?? ''))).toBe(false);
    expect(input?.label).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. 真实装配：生产持久化边界（生产必然拒绝，开发/测试不被误伤）
// ---------------------------------------------------------------------------

const VERIFIED_CAPABILITIES: PersistenceCapabilities = {
  backend: POSTGRES_EXECUTOR_BACKEND,
  persistent: true,
  productionReady: true,
};

class FakeModuleRef {
  constructor(private readonly instances: Map<symbol, unknown>) {}

  get(token: symbol): unknown {
    if (!this.instances.has(token)) {
      throw new Error(`未找到令牌: ${bindingTokenName(token)}`);
    }
    return this.instances.get(token);
  }
}

function serviceWithSqlBinding(
  env: ReturnType<typeof loadEnv>,
  sqlInstance: unknown,
): PersistenceBoundaryService {
  const instances = new Map<symbol, unknown>(
    PERSISTENCE_BINDINGS.map((descriptor) => [
      descriptor.token,
      { capabilities: VERIFIED_CAPABILITIES },
    ]),
  );
  const sqlToken = PERSISTENCE_BINDINGS.find(
    (descriptor) => bindingTokenName(descriptor.token) === 'SQL_CONNECTION_FACTORY',
  )?.token;
  if (sqlToken === undefined) {
    throw new Error('测试前置失败：登记表中没有 SQL_CONNECTION_FACTORY');
  }
  instances.set(sqlToken, sqlInstance);
  return new PersistenceBoundaryService(
    new FakeModuleRef(instances) as unknown as ConstructorParameters<
      typeof PersistenceBoundaryService
    >[0],
    resolveAppDatabaseConfig(env),
    env,
  );
}

const productionEnv = (): ReturnType<typeof loadEnv> =>
  loadEnv({ NODE_ENV: 'production', DATABASE_URL: LOOPBACK_URL, DATABASE_SSL_MODE: 'verify-full' });

describe('真实装配：启动期持久化边界把执行器契约一起判定', () => {
  it('默认工厂（fail-closed 未验证驱动）不持有任何封存声明：默认登记表是空的', () => {
    expect(DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY.describe()).toEqual({
      sealedDeclarations: 0,
      verificationEvidence: 0,
      schemaReadiness: 0,
    });
    const factory = createAppSqlConnectionFactory();
    expect(factory.capabilities).toMatchObject({
      backend: UNVERIFIED_DRIVER_BACKEND,
      persistent: false,
      productionReady: false,
    });
    expect(DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY.isSealed(factory.capabilities)).toBe(false);
  });

  it('生产环境绑定未封存的执行器：边界判定失败并落到执行器契约规则上', () => {
    const binding: PersistenceBinding = {
      token: 'SQL_CONNECTION_FACTORY',
      label: 'SQL 连接工厂',
      capabilities: UNSEALED_POSTGRES,
    };
    const executorVerifications = [
      {
        token: 'SQL_CONNECTION_FACTORY',
        input: {
          nodeEnv: 'production',
          declaration: UNSEALED_POSTGRES,
          surface: factorySurface(),
          registry: DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
          now: NOW,
          label: 'SQL_CONNECTION_FACTORY',
        },
      },
    ];

    const report = evaluatePersistenceBoundary({
      nodeEnv: 'production',
      databaseConfigured: true,
      bindings: [binding],
      executorVerifications,
    });
    expect(report.ok).toBe(false);
    const executorViolations = report.violations.filter(
      (item) => item.rule === 'SQL_EXECUTOR_VERIFICATION_FAILED',
    );
    expect(executorViolations.map((item) => item.executorCode)).toEqual(
      expect.arrayContaining([
        'DECLARATION_NOT_SEALED',
        'DECLARATION_MUTABLE',
        'DECLARATION_CONTRACT_MISMATCH',
        'EVIDENCE_MISSING',
        'SCHEMA_READINESS_MISSING',
      ]),
    );
    expect(executorViolations.every((item) => item.token === 'SQL_CONNECTION_FACTORY')).toBe(true);

    let captured: unknown;
    try {
      assertPersistenceBoundary({
        nodeEnv: 'production',
        databaseConfigured: true,
        bindings: [binding],
        executorVerifications,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PersistenceBoundaryError);
    expect((captured as PersistenceBoundaryError).message).toContain(
      'SQL_CONNECTION_FACTORY[SQL_EXECUTOR_VERIFICATION_FAILED]',
    );
    expect((captured as PersistenceBoundaryError).message).not.toContain('://');
  });

  it('生产环境 + 封存声明 + 已登记证据：边界放行（契约可通过，不是死路）', () => {
    const target = fixture();
    const report = assertPersistenceBoundary({
      nodeEnv: 'production',
      databaseConfigured: true,
      bindings: [
        {
          token: 'SQL_CONNECTION_FACTORY',
          label: 'SQL 连接工厂',
          capabilities: target.declaration,
        },
      ],
      executorVerifications: [{ token: 'SQL_CONNECTION_FACTORY', input: evaluationInput(target) }],
    });
    expect(report).toEqual({
      ok: true,
      violations: [],
      checkedTokens: ['SQL_CONNECTION_FACTORY'],
    });
  });

  it('PersistenceBoundaryService：生产环境绑定执行器形态的未封存工厂时拒绝启动', () => {
    const sqlInstance = {
      capabilities: UNSEALED_POSTGRES,
      connect(_config: unknown): Promise<never> {
        return Promise.reject(new Error('不应被调用'));
      },
    };
    const service = serviceWithSqlBinding(productionEnv(), sqlInstance);

    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PersistenceBoundaryError);
    const violations = (captured as PersistenceBoundaryError).violations;
    expect(violations.every((item) => item.rule === 'SQL_EXECUTOR_VERIFICATION_FAILED')).toBe(true);
    expect(violations.map((item) => item.executorCode)).toEqual(
      expect.arrayContaining(['DECLARATION_NOT_SEALED', 'EVIDENCE_MISSING']),
    );
  });

  it('PersistenceBoundaryService：测试环境不因执行器契约失败（内存/未验证替身仍可开发）', () => {
    const sqlInstance = {
      capabilities: IN_MEMORY,
      connect(_config: unknown): Promise<never> {
        return Promise.reject(new Error('不应被调用'));
      },
    };
    const service = serviceWithSqlBinding(loadEnv({ NODE_ENV: 'test' }), sqlInstance);
    expect(service.verify().ok).toBe(true);
  });

  it('PersistenceBoundaryService：只有能力声明的替身在数据库已配置时判「缺少执行器契约事实」', () => {
    const service = serviceWithSqlBinding(productionEnv(), { capabilities: VERIFIED_CAPABILITIES });

    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PersistenceBoundaryError);
    const violations = (captured as PersistenceBoundaryError).violations;
    // 不是执行器形态 ⇒ 不进执行器契约的内部判定（没有任何执行器违规码）……
    expect(violations.some((item) => item.rule === 'SQL_EXECUTOR_VERIFICATION_FAILED')).toBe(false);
    // ……但数据库已配置时「没有契约事实」本身就是违规：能力自述（persistent/productionReady）
    // 不再能绕过 attest 契约。
    expect(violations.map((item) => item.rule)).toEqual(['SQL_EXECUTOR_VERIFICATION_REQUIRED']);
    expect(violations[0]?.token).toBe('SQL_CONNECTION_FACTORY');
  });

  it('PersistenceBoundaryService：无数据库装配不要求执行器契约（非执行器替身不受影响）', () => {
    const service = serviceWithSqlBinding(loadEnv({ NODE_ENV: 'test' }), {
      capabilities: VERIFIED_CAPABILITIES,
    });
    const report = service.verify();
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. 边界事实：不引入真实驱动、不读磁盘、不建连接
// ---------------------------------------------------------------------------

describe('端口层边界：不引入驱动、不建连接、不读磁盘', () => {
  it('ports 目录的源码不 import 任何被禁的 PostgreSQL 驱动 / ORM', () => {
    const specifiers = portSourceFiles().flatMap((file) =>
      importSpecifiers(file.content).map((specifier) => ({ file: file.relative, specifier })),
    );
    expect(specifiers.filter((item) => isForbiddenDriverSpecifier(item.specifier))).toEqual([]);
    // 提取器自证有效：官方 `pg` 已授权（不再判「被禁」，但由驱动层收敛规则单独管），
    // 未授权的驱动与 ORM 仍必须被识别
    expect(
      importSpecifiers("import { Pool } from 'pg';").filter((value) =>
        isForbiddenDriverSpecifier(value),
      ),
    ).toEqual([]);
    expect(isAuthorizedDriverSpecifier('pg')).toBe(true);
    expect(
      importSpecifiers("import Postgres from 'postgres';").filter((value) =>
        isForbiddenDriverSpecifier(value),
      ),
    ).toEqual(['postgres']);
    expect(
      importSpecifiers("import { DataSource } from 'typeorm';").filter((value) =>
        isForbiddenDriverSpecifier(value),
      ),
    ).toEqual(['typeorm']);
  });

  it('验证契约模块自身不 import node: 内置模块（不读磁盘、不连网、不建连接）', () => {
    const content = readFileSync(CONTRACT_SOURCE, 'utf8');
    expect(importSpecifiers(content).filter((specifier) => specifier.startsWith('node:'))).toEqual(
      [],
    );
    expect(content).not.toContain('new Pool');
    expect(content).not.toContain('createConnection');
  });

  it('端口契约只声明类型与纯判定函数，不含任何驱动实现痕迹', () => {
    const content = readFileSync(PORT_SOURCE, 'utf8');
    expect(importSpecifiers(content).filter((specifier) => specifier.startsWith('node:'))).toEqual(
      [],
    );
    expect(content).toContain('VerifiedSqlExecutorCapabilities');
  });
});

// ---------------------------------------------------------------------------
// 采集辅助
// ---------------------------------------------------------------------------

interface SourceFile {
  readonly relative: string;
  readonly content: string;
}

/** `src/db/ports` 下全部 `.ts`（含 spec：spec 也属于端口层的依赖边界） */
function portSourceFiles(): readonly SourceFile[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
  };
  walk(PORTS_ROOT);
  return files.map((absolute) => ({
    relative: absolute.startsWith(`${PORTS_ROOT}${sep}`)
      ? absolute.slice(PORTS_ROOT.length + 1)
      : absolute,
    content: readFileSync(absolute, 'utf8'),
  }));
}

/** 行锚定的 import 提取器：只认「行首 import/export ... from」与 require/import 调用 */
const IMPORT_SPECIFIER_PATTERN =
  /^\s*(?:import|export)\b[^\n]*?\bfrom\s*['"](?<fromSpecifier>[^'"]+)['"]|^\s*import\s*['"](?<sideEffect>[^'"]+)['"]|\brequire\s*\(\s*['"](?<require>[^'"]+)['"]\s*\)|\bimport\s*\(\s*['"](?<dynamic>[^'"]+)['"]\s*\)/gmu;

function importSpecifiers(content: string): readonly string[] {
  const specifiers = new Set<string>();
  for (const match of content.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier =
      match.groups?.['fromSpecifier'] ??
      match.groups?.['sideEffect'] ??
      match.groups?.['require'] ??
      match.groups?.['dynamic'];
    if (specifier !== undefined) {
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

/** 真实迁移目录里的迁移版本（升序）：与就绪证据的「可用版本」同口径 */
const REAL_MIGRATION_VERSIONS: readonly string[] = readMigrationVersions(
  join(REPO_ROOT, 'db', 'migrations'),
);

function readMigrationVersions(directory: string): readonly string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((entry) => entry !== 'README.md' && !entry.startsWith('.'))
    .map((entry) => /^(\d{4})_[a-z0-9_]+\.sql$/u.exec(entry)?.[1])
    .filter((version): version is string => version !== undefined)
    .sort();
}

/** 从当前工作目录向上寻找仓库根（含 pnpm-workspace.yaml） */
function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = resolve(current, '..');
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error('未找到仓库根目录（缺少 pnpm-workspace.yaml）');
}
