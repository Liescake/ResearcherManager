/**
 * PostgreSQL 执行器的 **attest 取证入口**（驱动无关）。
 *
 * ## 这道层解决什么问题
 * `db/ports/sql-executor-verification.ts` 的准入契约要求生产执行器持有一份**封存声明**，
 * 且声明必须引用两条**已登记**证据：验证来源（谁、何时、依据什么验证过）与 schema/迁移就绪
 * （代码侧可用迁移版本 vs 数据库侧已应用版本）。契约本身**不生产证据**，它只回答
 * 「这份声明配不配被当作生产执行器」。
 *
 * 本模块负责把**取证方提供的事实**翻译成契约要的事实，严格保持「不臆造」：
 * - 所有字段都必须由外部显式给出（环境变量，或调用方直接传入的对象）；
 * - 缺任何一项即返回 `undefined`，调用方据此退回 fail-closed 的未验证驱动工厂 ——
 *   绝不生成「已验证」这种自述；
 * - `availableVersions` / `appliedVersions` 由取证方给出（契约明确「本层不查询数据库」）：
 *   运维/CI 必须真的核对过 schema 版本，代码不做推测。
 *
 * ## 边界事实
 * - 不读环境变量以外的东西、不建连接、不执行 SQL、不读磁盘；
 * - 违规/缺失信息只含**变量名**，不含变量值（值可能包含内部 URI 与人员标识）。
 */

import {
  assertVerificationEvidenceShape,
  assertSchemaReadinessShape,
  type SchemaMigrationReadinessEvidence,
  type SqlExecutorAttestationInput,
  type SqlExecutorVerificationEvidence,
  type SqlExecutorVerificationMethod,
  type SqlExecutorVerificationRegistry,
  SQL_EXECUTOR_VERIFICATION_CONTRACT,
  SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
  SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
  POSTGRES_EXECUTOR_BACKEND,
} from '../ports/sql-executor-verification';

/** 取证方必须提供的字段（全部来自显式输入，缺一不可） */
export interface PostgresExecutorAttestationFacts {
  readonly evidenceId: string;
  readonly verifiedBy: string;
  /** 带时区的 ISO 时间戳 */
  readonly verifiedAt: string;
  readonly evidenceRef: string;
  readonly readinessId: string;
  readonly checkedBy: string;
  /** 带时区的 ISO 时间戳 */
  readonly checkedAt: string;
  readonly readinessRef: string;
  /** 代码侧可用迁移版本（升序） */
  readonly availableVersions: readonly string[];
  /** 数据库侧已应用迁移版本（升序；就绪要求它等于 `availableVersions`） */
  readonly appliedVersions: readonly string[];
}

/** 环境变量来源：与其它数据库配置一样，只接受字符串（空串视为未配置） */
export interface PostgresAttestationSource {
  readonly DATABASE_EXECUTOR_EVIDENCE_ID?: string | undefined;
  readonly DATABASE_EXECUTOR_VERIFIED_BY?: string | undefined;
  readonly DATABASE_EXECUTOR_VERIFIED_AT?: string | undefined;
  readonly DATABASE_EXECUTOR_EVIDENCE_REF?: string | undefined;
  /** 验证方式；缺省为生产唯一可接受的 `integration-test` */
  readonly DATABASE_EXECUTOR_EVIDENCE_METHOD?: string | undefined;
  readonly DATABASE_SCHEMA_READINESS_ID?: string | undefined;
  readonly DATABASE_SCHEMA_CHECKED_BY?: string | undefined;
  readonly DATABASE_SCHEMA_CHECKED_AT?: string | undefined;
  readonly DATABASE_SCHEMA_READINESS_REF?: string | undefined;
  /** 逗号分隔的迁移版本（升序），例如 `0001,0002` */
  readonly DATABASE_MIGRATION_AVAILABLE_VERSIONS?: string | undefined;
  readonly DATABASE_MIGRATION_APPLIED_VERSIONS?: string | undefined;
}

/** 未配置 attest 事实时的说明（出现在日志里，绝不回显任何取值） */
export const POSTGRES_ATTESTATION_ABSENT =
  '未提供 PostgreSQL 执行器 attest 取证事实（DATABASE_EXECUTOR_* / DATABASE_SCHEMA_* / DATABASE_MIGRATION_*）：执行器无法取得封存声明，启动必须 fail-closed';

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** 逗号分隔版本列表：去空白、去空项；空配置视为未提供 */
function parseVersionList(value: string | undefined): readonly string[] | undefined {
  const trimmed = nonBlank(value);
  if (trimmed === undefined) {
    return undefined;
  }
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 验证方式：只接受已登记的三种之一，避免把任意文本带进证据 */
export function parseVerificationMethod(
  value: string | undefined,
): SqlExecutorVerificationMethod | undefined {
  const normalized = nonBlank(value)?.toLowerCase();
  if (normalized === undefined) {
    return 'integration-test';
  }
  return normalized === 'integration-test' ||
    normalized === 'contract-test' ||
    normalized === 'manual-review'
    ? normalized
    : undefined;
}

/**
 * 从显式来源解析取证事实。
 *
 * @returns 事实对象；任何一项缺失或形状非法时返回 `undefined`（调用方据此 fail-closed）
 */
export function resolvePostgresAttestationFacts(
  source: PostgresAttestationSource,
): PostgresExecutorAttestationFacts | undefined {
  const evidenceId = nonBlank(source.DATABASE_EXECUTOR_EVIDENCE_ID);
  const verifiedBy = nonBlank(source.DATABASE_EXECUTOR_VERIFIED_BY);
  const verifiedAt = nonBlank(source.DATABASE_EXECUTOR_VERIFIED_AT);
  const evidenceRef = nonBlank(source.DATABASE_EXECUTOR_EVIDENCE_REF);
  const readinessId = nonBlank(source.DATABASE_SCHEMA_READINESS_ID);
  const checkedBy = nonBlank(source.DATABASE_SCHEMA_CHECKED_BY);
  const checkedAt = nonBlank(source.DATABASE_SCHEMA_CHECKED_AT);
  const readinessRef = nonBlank(source.DATABASE_SCHEMA_READINESS_REF);
  const availableVersions = parseVersionList(source.DATABASE_MIGRATION_AVAILABLE_VERSIONS);
  const appliedVersions = parseVersionList(source.DATABASE_MIGRATION_APPLIED_VERSIONS);

  if (
    evidenceId === undefined ||
    verifiedBy === undefined ||
    verifiedAt === undefined ||
    evidenceRef === undefined ||
    readinessId === undefined ||
    checkedBy === undefined ||
    checkedAt === undefined ||
    readinessRef === undefined ||
    availableVersions === undefined ||
    appliedVersions === undefined
  ) {
    return undefined;
  }

  return {
    evidenceId,
    verifiedBy,
    verifiedAt,
    evidenceRef,
    readinessId,
    checkedBy,
    checkedAt,
    readinessRef,
    availableVersions,
    appliedVersions,
  };
}

/** 取证事实里的验证方式：登记时随证据一起写入 */
export interface PostgresExecutorAttestationRegistration {
  readonly facts: PostgresExecutorAttestationFacts;
  readonly method: SqlExecutorVerificationMethod;
}

/**
 * 把取证事实登记进登记表，并返回契约要的封存输入。
 *
 * 登记前先过契约的形状校验（`assertVerificationEvidenceShape` /
 * `assertSchemaReadinessShape`）：缺字段、时间非法、无法核对一律抛错、不写登记表。
 * 本函数**不**调用 `attest()`：封存动作留给执行器工厂，避免在这里悄悄产生生产身份。
 */
export function registerPostgresExecutorAttestation(
  registry: SqlExecutorVerificationRegistry,
  registration: PostgresExecutorAttestationRegistration,
): SqlExecutorAttestationInput {
  const { facts } = registration;

  const evidence: SqlExecutorVerificationEvidence = {
    evidenceId: facts.evidenceId,
    backend: POSTGRES_EXECUTOR_BACKEND,
    contractId: SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
    contractVersion: SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
    verifiedBy: facts.verifiedBy,
    verifiedAt: facts.verifiedAt,
    method: registration.method,
    parameterizedQueries: true,
    transactions: true,
    evidenceRef: facts.evidenceRef,
  };
  assertVerificationEvidenceShape(evidence);

  const readiness: SchemaMigrationReadinessEvidence = {
    readinessId: facts.readinessId,
    backend: POSTGRES_EXECUTOR_BACKEND,
    migrationContractId: SQL_EXECUTOR_VERIFICATION_CONTRACT.migrationContractId,
    migrationContractVersion: SQL_EXECUTOR_VERIFICATION_CONTRACT.migrationContractVersion,
    availableVersions: [...facts.availableVersions],
    appliedVersions: [...facts.appliedVersions],
    checkedBy: facts.checkedBy,
    checkedAt: facts.checkedAt,
    readinessRef: facts.readinessRef,
  };
  assertSchemaReadinessShape(readiness);

  registry.registerVerificationEvidence(evidence);
  registry.registerSchemaReadiness(readiness);

  return {
    backend: POSTGRES_EXECUTOR_BACKEND,
    persistent: true,
    productionReady: true,
    parameterizedQueries: true,
    transactions: true,
    evidenceId: facts.evidenceId,
    verifiedAt: facts.verifiedAt,
    readinessId: facts.readinessId,
    checkedAt: facts.checkedAt,
  };
}

/** 兼容导出：从环境变量来源一步解析出可登记的取证事实 */
export function resolvePostgresAttestationRegistration(
  source: PostgresAttestationSource,
): PostgresExecutorAttestationRegistration | undefined {
  const facts = resolvePostgresAttestationFacts(source);
  const method = parseVerificationMethod(source.DATABASE_EXECUTOR_EVIDENCE_METHOD);
  if (facts === undefined || method === undefined) {
    return undefined;
  }
  return { facts, method };
}
