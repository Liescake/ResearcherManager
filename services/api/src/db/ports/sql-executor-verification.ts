import { MIGRATION_DEPLOYMENT_GUARD_CONTRACT } from '../migrations/migration-deployment-guard';
import {
  UNVERIFIED_DRIVER_BACKEND,
  type VerifiedSqlExecutorCapabilities,
} from './sql-executor.port';

/**
 * SQL 执行器验证契约（**生产执行器的 fail-closed 准入契约**）。
 *
 * ## 为什么需要它
 * `sql-executor.port.ts` 的能力声明（`PersistenceCapabilities`）是**自述**：任何对象字面量都能声称
 * `backend = postgres` / `persistent = true` / `productionReady = true`，`assertProductionReadyExecutor`
 * 只读这三个字段，因此「伪造声明」与「可变声明」都能通过；它也不检查参数化查询、事务能力、
 * 验证来源与 schema 迁移就绪证据。本契约把「生产执行器」收紧成一份机器可判定的准入清单：
 *
 * 1. **不可伪造 / 不可变**：执行器的 `capabilities` 必须是本模块登记表产出的封存声明
 *    （WeakSet 身份校验 + 深度冻结 + 自持原型 + 只允许数据属性）。对象展开、`structuredClone`、
 *    JSON 往返、`Object.create(封存声明)` 与事后改字段都拿不到封存身份或通过完整性判定；
 * 2. **参数化查询能力**：声明必须为 `parameterizedQueries: true`，且实例结构事实（`query` 的形参
 *    槽数量 ≥ 2）必须真的接受参数槽 —— 单参 `query(sql)` 的非参数化执行器一律拒绝；
 * 3. **事务能力**：声明必须为 `transactions: true`，且执行器必须暴露 `transaction(run)`；
 * 4. **验证来源**：声明必须引用一条**已登记**的验证证据（`evidenceId`）；证据必须字段齐全、
 *    可核对（`verifiedBy` / `evidenceRef` / 方法），时间落在新鲜度窗口内（过期或超前均判
 *    `EVIDENCE_STALE`），且与声明不冲突（后端、契约身份、参数化/事务声明、时间戳必须一致）；
 * 5. **schema / migration readiness 证据**：声明必须引用一条**已登记**的就绪证据，该证据必须锚定
 *    迁移部署守卫契约身份（`migrationContractId` / `migrationContractVersion`），迁移版本序列必须是
 *    「已应用 = 可用」的完整前缀（有未应用迁移、乱序、库里有代码里没有的版本都拒绝）；
 * 6. **内存替身**：不可信或不存在的声明，只要后端非持久（`persistent !== true` 或内存标记 backend），
 *    在前提是生产环境时一律判 `IN_MEMORY_DOUBLE`。
 *
 * ## 边界事实
 * - **不引入任何数据库驱动、不建连接、不执行 SQL**：只做对象结构、冻结状态与登记表身份判定；
 * - `evaluateSqlExecutorVerification` 是纯函数（不读环境变量、不读磁盘、不写日志、不调用执行器的
 *   任何方法）；时间通过 `now` 显式注入，同一输入判定可复现；
 * - 迁移侧契约身份以**常量**方式取自 `MIGRATION_DEPLOYMENT_GUARD_CONTRACT`（只读它的 id/version，
 *   不枚举迁移目录、不读任何文件），因此本模块既不依赖文件系统也不依赖运行期配置；
 * - 非生产环境允许普通能力声明（内存基线仍可在开发/测试使用）；**声明一旦被封存**（或环境为
 *   production）就必须自洽，避免「开发期封存的声明带着过期证据上线」；
 * - 违规信息只含标识、契约版本、布尔与枚举能力值，**不含连接串、口令或业务字段取值**（本层不接触）。
 */

/** 契约身份：版本变化意味着准入规则变化，调用方据此判断是否需要重新验证 */
export const SQL_EXECUTOR_VERIFICATION_CONTRACT_ID = 'sql-executor-verification';
export const SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION = 1;

/** 唯一允许的生产执行器后端标识 */
export const POSTGRES_EXECUTOR_BACKEND = 'postgres';

/** 内存 / 非持久替身的后端标识识别口径（无法读 `persistent` 时用它兜底） */
export const IN_MEMORY_BACKEND_MARKERS = ['in-memory', 'inmemory', 'memory'] as const;

/** 验证方式：`integration-test` 是真实驱动集成测试，也是生产唯一可接受的来源 */
export type SqlExecutorVerificationMethod = 'integration-test' | 'contract-test' | 'manual-review';

/** 允许登记的验证方式集合（登记不限于生产可接受的方式） */
export const SQL_EXECUTOR_VERIFICATION_METHODS: readonly SqlExecutorVerificationMethod[] = [
  'integration-test',
  'contract-test',
  'manual-review',
];

/** 生产可接受的证据方式：只有真实集成测试能证明「驱动接得上、参数化真的生效」 */
export const SQL_EXECUTOR_ACCEPTED_EVIDENCE_METHODS: readonly SqlExecutorVerificationMethod[] = [
  'integration-test',
];

/**
 * 契约参数（与迁移部署守卫契约**同源**：迁移就绪证据必须锚定同一个契约身份，防止两份契约各自漂移）。
 * `migrationContractId` / `migrationContractVersion` 直接取自 `MIGRATION_DEPLOYMENT_GUARD_CONTRACT`。
 */
export const SQL_EXECUTOR_VERIFICATION_CONTRACT = {
  id: SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
  version: SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
  backend: POSTGRES_EXECUTOR_BACKEND,
  /** 验证证据最长有效天数：超期必须重新验证，不得「一次验证永久生产可用」 */
  evidenceMaxAgeDays: 90,
  /** 迁移就绪证据最长有效天数 */
  readinessMaxAgeDays: 30,
  /** 允许的时钟偏移（证据时间超前于判定时刻的上限） */
  clockSkewMinutes: 15,
  acceptedEvidenceMethods: SQL_EXECUTOR_ACCEPTED_EVIDENCE_METHODS,
  migrationContractId: MIGRATION_DEPLOYMENT_GUARD_CONTRACT.id,
  migrationContractVersion: MIGRATION_DEPLOYMENT_GUARD_CONTRACT.version,
} as const;

/** 违规代码：每个代码对应一类可机器判定的「生产执行器不可信」 */
export type SqlExecutorVerificationCode =
  // 封存声明（不可伪造 / 不可变 / 契约身份）
  | 'DECLARATION_MISSING'
  | 'DECLARATION_NOT_SEALED'
  | 'DECLARATION_MUTABLE'
  | 'DECLARATION_CONTRACT_MISMATCH'
  // 后端与能力面
  | 'BACKEND_NOT_POSTGRES'
  | 'IN_MEMORY_DOUBLE'
  | 'NOT_PRODUCTION_READY'
  | 'PARAMETERIZATION_NOT_ATTESTED'
  | 'PARAMETERIZATION_UNSUPPORTED'
  | 'TRANSACTION_NOT_ATTESTED'
  | 'TRANSACTION_UNSUPPORTED'
  | 'EXECUTOR_SURFACE_UNSUPPORTED'
  // 验证来源
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_UNKNOWN'
  | 'EVIDENCE_STALE'
  | 'EVIDENCE_CONFLICTING'
  | 'EVIDENCE_METHOD_NOT_ACCEPTED'
  // schema / 迁移就绪证据
  | 'SCHEMA_READINESS_MISSING'
  | 'SCHEMA_READINESS_UNKNOWN'
  | 'SCHEMA_READINESS_CONTRACT_MISMATCH'
  | 'SCHEMA_READINESS_STALE'
  | 'SCHEMA_READINESS_PENDING_MIGRATIONS'
  | 'SCHEMA_READINESS_SEQUENCE_MISMATCH'
  | 'SCHEMA_READINESS_UNVERIFIABLE'
  | 'SCHEMA_READINESS_CONFLICTING';

export interface SqlExecutorVerificationViolation {
  readonly code: SqlExecutorVerificationCode;
  /** 违规主体：执行器标签 / 后端标识 / 证据 id */
  readonly subject: string;
  /** 只含标识、契约版本与布尔/枚举能力值，不含机密与字段取值 */
  readonly detail: string;
}

export interface SqlExecutorVerificationReport {
  readonly ok: boolean;
  readonly violations: readonly SqlExecutorVerificationViolation[];
  /** 声明里的后端标识（未声明时省略） */
  readonly declaredBackend?: string;
  /** 被解释的验证证据 id（未声明时省略） */
  readonly evidenceId?: string;
  /** 被解释的迁移就绪证据 id（未声明时省略） */
  readonly readinessId?: string;
}

/** 契约判定失败：携带全部违规项，供启动日志与测试断言 */
export class SqlExecutorVerificationError extends Error {
  readonly violations: readonly SqlExecutorVerificationViolation[];

  constructor(violations: readonly SqlExecutorVerificationViolation[]) {
    const summary = violations.map((item) => `${item.subject}[${item.code}]`).join(', ');
    super(`SQL 执行器验证契约拒绝（${violations.length} 项）: ${summary}`);
    this.name = 'SqlExecutorVerificationError';
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// 验证来源与迁移就绪证据（登记表回答「谁在什么时候依据什么验证过」）
// ---------------------------------------------------------------------------

/**
 * 验证证据：一次**真的做过**的执行器验证记录。
 * `evidenceRef` 必须是可核对的引用（CI 运行链接、集成测试文件与用例名等），禁止只写「已验证」。
 */
export interface SqlExecutorVerificationEvidence {
  readonly evidenceId: string;
  /** 被验证的后端标识（必须与声明一致） */
  readonly backend: string;
  readonly contractId: string;
  readonly contractVersion: number;
  /** 验证执行者（人 / 流水线） */
  readonly verifiedBy: string;
  readonly verifiedAt: string;
  readonly method: SqlExecutorVerificationMethod;
  readonly parameterizedQueries: boolean;
  readonly transactions: boolean;
  readonly evidenceRef: string;
}

/**
 * 迁移就绪证据：验证执行时数据库侧看到的事实（可用迁移版本与已应用版本）。
 * 本层只比对这些事实的自洽性，**不查询数据库、不读迁移目录**；可用版本集合由取证方提供。
 */
export interface SchemaMigrationReadinessEvidence {
  readonly readinessId: string;
  /** 被核对的后端标识（必须与声明一致） */
  readonly backend: string;
  readonly migrationContractId: string;
  readonly migrationContractVersion: number;
  /** 代码侧可用迁移版本（升序，例如 `['0001']`） */
  readonly availableVersions: readonly string[];
  /** 数据库侧已应用迁移版本（升序；就绪要求它等于 `availableVersions`） */
  readonly appliedVersions: readonly string[];
  readonly checkedBy: string;
  readonly checkedAt: string;
  /** 可核对的引用（迁移核对命令与输出位置等） */
  readonly readinessRef: string;
}

// ---------------------------------------------------------------------------
// 实例结构事实（只读，不调用执行器）
// ---------------------------------------------------------------------------

export interface SqlExecutorSurfaceFacts {
  readonly kind: 'connection-factory' | 'executor' | 'not-an-executor';
  readonly hasConnect: boolean;
  readonly hasQuery: boolean;
  /** `query` 声明的形参槽数量（`Function.length`）：< 2 视为未声明参数槽 */
  readonly queryParameterSlots: number;
  readonly hasTransaction: boolean;
  /** `transaction` 声明的形参槽数量（`Function.length`）：< 1 视为不接受事务回调 */
  readonly transactionParameterSlots: number;
  readonly hasClose: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMember(instance: unknown, key: string): unknown {
  if (!isRecord(instance)) {
    return undefined;
  }
  return instance[key];
}

function hasFunctionMember(instance: unknown, key: string): boolean {
  return typeof readMember(instance, key) === 'function';
}

function functionArity(instance: unknown, key: string): number {
  const member = readMember(instance, key);
  return typeof member === 'function' ? member.length : 0;
}

/**
 * 读取实例的**结构事实**：识别它是否暴露 `connect` / `query` / `transaction` / `close`，
 * 以及 `query` / `transaction` 声明的形参槽数量。
 *
 * 只做 `typeof` 与 `Function.length` 判定：**不调用任何方法、不建连接、不执行 SQL**。
 * 形参槽是结构与声明层面的证据；参数化是否真的生效由集成测试证据（`evidenceRef`）与代码评审覆盖。
 */
export function inspectSqlExecutorSurface(instance: unknown): SqlExecutorSurfaceFacts {
  const hasConnect = hasFunctionMember(instance, 'connect');
  const hasQuery = hasFunctionMember(instance, 'query');
  return {
    kind: hasConnect ? 'connection-factory' : hasQuery ? 'executor' : 'not-an-executor',
    hasConnect,
    hasQuery,
    queryParameterSlots: functionArity(instance, 'query'),
    hasTransaction: hasFunctionMember(instance, 'transaction'),
    transactionParameterSlots: functionArity(instance, 'transaction'),
    hasClose: hasFunctionMember(instance, 'close'),
  };
}

// ---------------------------------------------------------------------------
// 声明完整性：深度冻结、自持原型、只允许数据属性
// ---------------------------------------------------------------------------

/** 深度冻结（对象、数组与嵌套值）：封存声明必须在任何环境都不可改写 */
function freezeDeep(value: unknown, seen = new Set<unknown>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) {
      freezeDeep(descriptor.value, seen);
    }
  }
  Object.freeze(value);
}

/**
 * 深度不可变判定：每一层都必须是冻结对象，全部属性必须是**非可写数据属性**（访问器属性拒绝：
 * getter 能让同一个声明在不同时刻给出不同值），且容器必须是自持的普通对象（原型为 `Object.prototype`
 * 或 `null`，拒绝 `Object.create(封存声明)` 这类继承伪造）。
 */
export function isDeeplyImmutableDeclaration(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value !== 'object' || value === null) {
    return true;
  }
  if (seen.has(value)) {
    return true;
  }
  seen.add(value);

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  if (!Object.isFrozen(value)) {
    return false;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      return false;
    }
    if (descriptor.writable) {
      return false;
    }
    if (!isDeeplyImmutableDeclaration(descriptor.value, seen)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 登记表：封存声明 + 验证证据 + 迁移就绪证据
// ---------------------------------------------------------------------------

export interface SqlExecutorAttestationInput {
  readonly backend: string;
  readonly persistent: boolean;
  readonly productionReady: boolean;
  readonly parameterizedQueries: boolean;
  readonly transactions: boolean;
  readonly evidenceId: string;
  readonly verifiedAt: string;
  readonly readinessId: string;
  readonly checkedAt: string;
}

export interface SqlExecutorVerificationRegistryStats {
  readonly sealedDeclarations: number;
  readonly verificationEvidence: number;
  readonly schemaReadiness: number;
}

/** 登记表接口：判定器只依赖它回答「封存身份、证据记录」两类问题 */
export interface SqlExecutorVerificationRegistry {
  /** 封存一份声明：只能由本登记表产出，返回值深度冻结 */
  attest(input: SqlExecutorAttestationInput): VerifiedSqlExecutorCapabilities;
  registerVerificationEvidence(record: SqlExecutorVerificationEvidence): void;
  registerSchemaReadiness(record: SchemaMigrationReadinessEvidence): void;
  /** 身份校验：只有本登记表 `attest` 返回过的对象为 true（复制/继承一律 false） */
  isSealed(value: unknown): boolean;
  verificationEvidence(evidenceId: string): readonly SqlExecutorVerificationEvidence[];
  schemaReadiness(readinessId: string): readonly SchemaMigrationReadinessEvidence[];
  describe(): SqlExecutorVerificationRegistryStats;
}

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_TIMESTAMP_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function violation(
  code: SqlExecutorVerificationCode,
  subject: string,
  detail: string,
): SqlExecutorVerificationViolation {
  return { code, subject, detail };
}

/** 内存 / 非持久替身判定：内存标记 backend 或明确的非持久声明 */
export function isInMemoryBackendMarker(backend: unknown): boolean {
  if (typeof backend !== 'string') {
    return false;
  }
  const normalized = backend.trim().toLowerCase();
  return (IN_MEMORY_BACKEND_MARKERS as readonly string[]).some((marker) =>
    normalized.includes(marker),
  );
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** 按内容去重：完全相同的重复登记是幂等的，内容不同的登记会并存并构成「冲突证据」 */
function pushUnique<T>(store: Map<string, T[]>, key: string, value: T): void {
  const existing = store.get(key) ?? [];
  const fingerprint = canonicalize(value);
  if (!existing.some((item) => canonicalize(item) === fingerprint)) {
    existing.push(value);
  }
  store.set(key, existing);
}

/** 验证证据登记前的形状校验：缺字段/时间非法/无法核对一律拒绝，不写登记表 */
export function assertVerificationEvidenceShape(record: SqlExecutorVerificationEvidence): void {
  const subject = isNonBlankString(record.evidenceId) ? record.evidenceId : '(未命名证据)';
  const problems: SqlExecutorVerificationViolation[] = [];
  if (!isNonBlankString(record.evidenceId)) {
    problems.push(violation('EVIDENCE_MISSING', subject, '验证证据缺少 evidenceId'));
  }
  if (!isNonBlankString(record.backend)) {
    problems.push(violation('EVIDENCE_MISSING', subject, '验证证据缺少 backend'));
  }
  if (record.contractId !== SQL_EXECUTOR_VERIFICATION_CONTRACT_ID) {
    problems.push(
      violation(
        'EVIDENCE_CONFLICTING',
        subject,
        `验证证据 contractId=${String(record.contractId)}，必须是 ${SQL_EXECUTOR_VERIFICATION_CONTRACT_ID}`,
      ),
    );
  }
  if (record.contractVersion !== SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION) {
    problems.push(
      violation(
        'EVIDENCE_CONFLICTING',
        subject,
        `验证证据 contractVersion=${String(record.contractVersion)}，必须是 ${SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION}`,
      ),
    );
  }
  if (!isNonBlankString(record.verifiedBy)) {
    problems.push(violation('EVIDENCE_MISSING', subject, '验证证据缺少 verifiedBy（谁验证的）'));
  }
  if (!isIsoTimestamp(record.verifiedAt)) {
    problems.push(
      violation('EVIDENCE_MISSING', subject, '验证证据的 verifiedAt 必须是带时区的 ISO 时间戳'),
    );
  }
  if (!(SQL_EXECUTOR_VERIFICATION_METHODS as readonly string[]).includes(record.method)) {
    problems.push(
      violation(
        'EVIDENCE_METHOD_NOT_ACCEPTED',
        subject,
        `验证方式 ${String(record.method)} 不在允许集合 [${SQL_EXECUTOR_VERIFICATION_METHODS.join(', ')}] 内`,
      ),
    );
  }
  if (
    typeof record.parameterizedQueries !== 'boolean' ||
    typeof record.transactions !== 'boolean'
  ) {
    problems.push(
      violation(
        'EVIDENCE_MISSING',
        subject,
        '验证证据必须声明 parameterizedQueries 与 transactions',
      ),
    );
  }
  if (!isNonBlankString(record.evidenceRef)) {
    problems.push(
      violation(
        'EVIDENCE_MISSING',
        subject,
        '验证证据缺少可核对的 evidenceRef（CI 运行 / 用例位置）',
      ),
    );
  }
  if (problems.length > 0) {
    throw new SqlExecutorVerificationError(problems);
  }
}

/** 迁移就绪证据登记前的形状校验 */
export function assertSchemaReadinessShape(record: SchemaMigrationReadinessEvidence): void {
  const subject = isNonBlankString(record.readinessId) ? record.readinessId : '(未命名就绪证据)';
  const problems: SqlExecutorVerificationViolation[] = [];
  if (!isNonBlankString(record.readinessId)) {
    problems.push(violation('SCHEMA_READINESS_MISSING', subject, '就绪证据缺少 readinessId'));
  }
  if (!isNonBlankString(record.backend)) {
    problems.push(violation('SCHEMA_READINESS_MISSING', subject, '就绪证据缺少 backend'));
  }
  if (!isNonBlankString(record.migrationContractId)) {
    problems.push(
      violation('SCHEMA_READINESS_CONTRACT_MISMATCH', subject, '就绪证据缺少 migrationContractId'),
    );
  }
  if (
    typeof record.migrationContractVersion !== 'number' ||
    !Number.isInteger(record.migrationContractVersion)
  ) {
    problems.push(
      violation(
        'SCHEMA_READINESS_CONTRACT_MISMATCH',
        subject,
        '就绪证据缺少整数 migrationContractVersion',
      ),
    );
  }
  if (!Array.isArray(record.availableVersions) || !Array.isArray(record.appliedVersions)) {
    problems.push(
      violation(
        'SCHEMA_READINESS_MISSING',
        subject,
        '就绪证据必须给出 availableVersions 与 appliedVersions 数组',
      ),
    );
  }
  if (!isNonBlankString(record.checkedBy)) {
    problems.push(violation('SCHEMA_READINESS_MISSING', subject, '就绪证据缺少 checkedBy'));
  }
  if (!isIsoTimestamp(record.checkedAt)) {
    problems.push(
      violation(
        'SCHEMA_READINESS_MISSING',
        subject,
        '就绪证据的 checkedAt 必须是带时区的 ISO 时间戳',
      ),
    );
  }
  if (!isNonBlankString(record.readinessRef)) {
    problems.push(
      violation(
        'SCHEMA_READINESS_MISSING',
        subject,
        '就绪证据缺少可核对的 readinessRef（迁移核对命令与输出位置）',
      ),
    );
  }
  if (problems.length > 0) {
    throw new SqlExecutorVerificationError(problems);
  }
}

/** 组装封存声明：先判「这份声明配不配被称为生产执行器声明」，再冻结 */
function buildSealedDeclaration(
  input: SqlExecutorAttestationInput,
): VerifiedSqlExecutorCapabilities {
  const subject = isNonBlankString(input.backend) ? input.backend : '(未声明后端)';
  const problems: SqlExecutorVerificationViolation[] = [];

  if (input.backend !== POSTGRES_EXECUTOR_BACKEND) {
    const code: SqlExecutorVerificationCode = isInMemoryBackendMarker(input.backend)
      ? 'IN_MEMORY_DOUBLE'
      : 'BACKEND_NOT_POSTGRES';
    problems.push(
      violation(
        code,
        subject,
        `封存声明的 backend 必须是 ${POSTGRES_EXECUTOR_BACKEND}（当前 ${String(input.backend)}）`,
      ),
    );
  }
  if (input.persistent !== true) {
    problems.push(
      violation(
        'IN_MEMORY_DOUBLE',
        subject,
        `封存声明必须 persistent=true（当前 ${String(input.persistent)}）：内存替身不得被封存为生产执行器`,
      ),
    );
  }
  if (input.productionReady !== true) {
    problems.push(
      violation(
        'NOT_PRODUCTION_READY',
        subject,
        `封存声明必须 productionReady=true（当前 ${String(input.productionReady)}）：未完成验证不得封存`,
      ),
    );
  }
  if (input.parameterizedQueries !== true) {
    problems.push(
      violation(
        'PARAMETERIZATION_NOT_ATTESTED',
        subject,
        '封存声明必须 parameterizedQueries=true：非参数化执行器不得被封存',
      ),
    );
  }
  if (input.transactions !== true) {
    problems.push(
      violation(
        'TRANSACTION_NOT_ATTESTED',
        subject,
        '封存声明必须 transactions=true：无事务能力不得被封存',
      ),
    );
  }
  if (!isNonBlankString(input.evidenceId)) {
    problems.push(violation('EVIDENCE_MISSING', subject, '封存声明缺少 verification.evidenceId'));
  }
  if (!isIsoTimestamp(input.verifiedAt)) {
    problems.push(
      violation(
        'EVIDENCE_MISSING',
        subject,
        '封存声明缺少合法的 verification.verifiedAt（带时区 ISO 时间戳）',
      ),
    );
  }
  if (!isNonBlankString(input.readinessId)) {
    problems.push(
      violation('SCHEMA_READINESS_MISSING', subject, '封存声明缺少 schemaReadiness.readinessId'),
    );
  }
  if (!isIsoTimestamp(input.checkedAt)) {
    problems.push(
      violation(
        'SCHEMA_READINESS_MISSING',
        subject,
        '封存声明缺少合法的 schemaReadiness.checkedAt（带时区 ISO 时间戳）',
      ),
    );
  }
  if (problems.length > 0) {
    throw new SqlExecutorVerificationError(problems);
  }

  const declaration: VerifiedSqlExecutorCapabilities = {
    contractId: SQL_EXECUTOR_VERIFICATION_CONTRACT_ID,
    contractVersion: SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION,
    backend: POSTGRES_EXECUTOR_BACKEND,
    persistent: true,
    productionReady: true,
    parameterizedQueries: true,
    transactions: true,
    verification: { evidenceId: input.evidenceId, verifiedAt: input.verifiedAt },
    schemaReadiness: { readinessId: input.readinessId, checkedAt: input.checkedAt },
  };
  freezeDeep(declaration);
  return declaration;
}

/**
 * 创建登记表：封存声明 + 验证证据 + 迁移就绪证据。
 *
 * 生产装配只应使用 `DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY`（同一份身份集合）；测试与
 * 未来的多后端场景可以各自建表，避免全局状态互相污染。
 */
export function createSqlExecutorVerificationRegistry(): SqlExecutorVerificationRegistry {
  const sealed = new WeakSet<object>();
  const evidenceStore = new Map<string, SqlExecutorVerificationEvidence[]>();
  const readinessStore = new Map<string, SchemaMigrationReadinessEvidence[]>();
  let sealedCount = 0;

  return {
    attest(input) {
      const declaration = buildSealedDeclaration(input);
      sealed.add(declaration);
      sealedCount += 1;
      return declaration;
    },
    registerVerificationEvidence(record) {
      assertVerificationEvidenceShape(record);
      pushUnique(evidenceStore, record.evidenceId, record);
    },
    registerSchemaReadiness(record) {
      assertSchemaReadinessShape(record);
      pushUnique(readinessStore, record.readinessId, record);
    },
    isSealed(value) {
      return isRecord(value) && sealed.has(value);
    },
    verificationEvidence(evidenceId) {
      return evidenceStore.get(evidenceId) ?? [];
    },
    schemaReadiness(readinessId) {
      return readinessStore.get(readinessId) ?? [];
    },
    describe() {
      return {
        sealedDeclarations: sealedCount,
        verificationEvidence: evidenceStore.size,
        schemaReadiness: readinessStore.size,
      };
    },
  };
}

/**
 * 生产装配唯一的封存身份集合。
 *
 * 当前仓库**没有**任何经证实的生产执行器：默认绑定的 `createUnavailableSqlConnectionFactory()`
 * 如实声明未验证驱动，因此它拿不到封存身份，生产启动必然被本契约拒绝 —— 空集本身就是一条证据。
 */
export const DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY: SqlExecutorVerificationRegistry =
  createSqlExecutorVerificationRegistry();

// ---------------------------------------------------------------------------
// 判定器（纯函数）
// ---------------------------------------------------------------------------

export interface SqlExecutorVerificationInput {
  readonly nodeEnv: string;
  /** 执行器的能力声明（通常是 `executor.capabilities`）；未提供表示没有声明 */
  readonly declaration: unknown;
  readonly surface: SqlExecutorSurfaceFacts;
  readonly registry: SqlExecutorVerificationRegistry;
  /** 判定时刻（带时区 ISO 时间戳）；显式注入，保证同一输入判定可复现 */
  readonly now: string;
  /** 违规主体名（默认 `SQL_EXECUTOR`） */
  readonly label?: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

/**
 * 时间可信度：证据时间必须落在 `[now - maxAge, now + clockSkew]` 内。
 * 过期与超前共用 `EVIDENCE_STALE` / `SCHEMA_READINESS_STALE`（同一个「不在可信窗口内」语义）。
 */
function isWithinTrustWindow(timestamp: string, nowMs: number, maxAgeDays: number): boolean {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return false;
  }
  const newestAllowed = nowMs + SQL_EXECUTOR_VERIFICATION_CONTRACT.clockSkewMinutes * MS_PER_MINUTE;
  const oldestAllowed = nowMs - maxAgeDays * MS_PER_DAY;
  return parsed <= newestAllowed && parsed >= oldestAllowed;
}

function declarationIsSealed(registry: SqlExecutorVerificationRegistry, value: unknown): boolean {
  try {
    return registry.isSealed(value);
  } catch {
    // 登记表本身异常时按「未封存」处理：fail-closed，不放行未确认的声明
    return false;
  }
}

/**
 * 纯函数判定：把「环境 + 声明 + 实例结构事实 + 登记表事实」判成违规清单。
 * 不读环境变量、不读磁盘、不建连接、不调用执行器方法，便于在测试里穷举。
 */
export function evaluateSqlExecutorVerification(
  input: SqlExecutorVerificationInput,
): SqlExecutorVerificationReport {
  const subject = input.label ?? 'SQL_EXECUTOR';
  const violations: SqlExecutorVerificationViolation[] = [];
  const isProduction = input.nodeEnv === 'production';
  const parsedNow = Date.parse(input.now);

  if (!isIsoTimestamp(input.now) || Number.isNaN(parsedNow)) {
    throw new TypeError(
      `SQL 执行器验证契约要求带时区的 ISO 判定时刻 now，收到 ${String(input.now)}`,
    );
  }

  const declaration = input.declaration;
  const sealed = declarationIsSealed(input.registry, declaration);
  const declarationPresent = isRecord(declaration);

  // ---- 1. 封存声明：生产必须有；一旦存在就必须不可伪造且不可变 ----
  if (!declarationPresent) {
    if (isProduction) {
      violations.push(
        violation(
          'DECLARATION_MISSING',
          subject,
          '生产执行器必须提供封存的能力声明（contractId/contractVersion + 参数化 + 事务 + 验证来源 + 迁移就绪证据）',
        ),
      );
    }
  } else if (!sealed && isProduction) {
    violations.push(
      violation(
        'DECLARATION_NOT_SEALED',
        subject,
        '能力声明不是经验证的封存声明（无法伪造的身份来源）：对象字面量、展开副本、结构化克隆与原型继承一律不被接受',
      ),
    );
  }

  // 完整性只在「已封存」或「生产环境（未封存也必须证明自己不可变）」下判定，
  // 避免开发/测试的字面量替身被准入契约误伤。
  const enforceProductionClause = sealed || isProduction;
  if (declarationPresent && enforceProductionClause) {
    if (!isDeeplyImmutableDeclaration(declaration)) {
      violations.push(
        violation(
          'DECLARATION_MUTABLE',
          subject,
          '能力声明必须不可变且自持（深度冻结、只允许非可写数据属性、原型必须为 Object.prototype）：可写/继承/访问器声明都可能在验证后被改写',
        ),
      );
    }
    if (
      declaration['contractId'] !== SQL_EXECUTOR_VERIFICATION_CONTRACT_ID ||
      declaration['contractVersion'] !== SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION
    ) {
      violations.push(
        violation(
          'DECLARATION_CONTRACT_MISMATCH',
          subject,
          `声明契约身份为 ${String(declaration['contractId'])}@${String(declaration['contractVersion'])}，必须是 ${SQL_EXECUTOR_VERIFICATION_CONTRACT_ID}@${SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION}`,
        ),
      );
    }

    // ---- 2. 后端与能力面 ----
    const backend = declaration['backend'];
    if (backend !== POSTGRES_EXECUTOR_BACKEND) {
      violations.push(
        violation(
          'BACKEND_NOT_POSTGRES',
          subject,
          `生产执行器后端必须是 ${POSTGRES_EXECUTOR_BACKEND}（当前 ${String(backend)}）`,
        ),
      );
    }
    if (
      declaration['persistent'] !== true ||
      isInMemoryBackendMarker(backend) ||
      backend === UNVERIFIED_DRIVER_BACKEND
    ) {
      violations.push(
        violation(
          'IN_MEMORY_DOUBLE',
          subject,
          `拒绝内存/非持久替身（backend=${String(backend)}, persistent=${String(declaration['persistent'])}）：生产存储必须跨重启保留`,
        ),
      );
    }
    if (declaration['productionReady'] !== true) {
      violations.push(
        violation(
          'NOT_PRODUCTION_READY',
          subject,
          `声明 productionReady=${String(declaration['productionReady'])}，必须是 true：未完成驱动引入与集成验证不得声称生产可用`,
        ),
      );
    }
    if (declaration['parameterizedQueries'] !== true) {
      violations.push(
        violation(
          'PARAMETERIZATION_NOT_ATTESTED',
          subject,
          `声明 parameterizedQueries=${String(declaration['parameterizedQueries'])}，必须是 true：参数一律走占位符绑定`,
        ),
      );
    }
    if (declaration['transactions'] !== true) {
      violations.push(
        violation(
          'TRANSACTION_NOT_ATTESTED',
          subject,
          `声明 transactions=${String(declaration['transactions'])}，必须是 true：必须具备事务边界能力`,
        ),
      );
    }

    // ---- 3. 验证来源：必须引用已登记、齐全、新鲜且不冲突的证据 ----
    const verification = declaration['verification'];
    const evidenceId = isRecord(verification) ? verification['evidenceId'] : undefined;
    const pinnedVerifiedAt = isRecord(verification) ? verification['verifiedAt'] : undefined;
    if (
      !isRecord(verification) ||
      !isNonBlankString(evidenceId) ||
      !isIsoTimestamp(pinnedVerifiedAt)
    ) {
      violations.push(
        violation(
          'EVIDENCE_MISSING',
          subject,
          '声明缺少验证来源引用（verification.evidenceId + verification.verifiedAt）',
        ),
      );
    } else {
      const records = input.registry.verificationEvidence(evidenceId);
      if (records.length === 0) {
        violations.push(
          violation(
            'EVIDENCE_UNKNOWN',
            subject,
            `验证证据 ${evidenceId} 未登记：声明不得自述「已验证」，必须指向登记表中的证据记录`,
          ),
        );
      } else {
        if (records.length > 1) {
          violations.push(
            violation(
              'EVIDENCE_CONFLICTING',
              subject,
              `验证证据 ${evidenceId} 存在 ${records.length} 条内容不一致的登记：冲突证据必须人工消解`,
            ),
          );
        }
        const record = records[0];
        if (record !== undefined) {
          if (!isNonBlankString(record.verifiedBy) || !isNonBlankString(record.evidenceRef)) {
            violations.push(
              violation(
                'EVIDENCE_MISSING',
                subject,
                `验证证据 ${evidenceId} 缺少 verifiedBy 或可核对的 evidenceRef`,
              ),
            );
          }
          if (
            record.backend !== declaration['backend'] ||
            record.contractId !== SQL_EXECUTOR_VERIFICATION_CONTRACT_ID ||
            record.contractVersion !== SQL_EXECUTOR_VERIFICATION_CONTRACT_VERSION ||
            record.parameterizedQueries !== declaration['parameterizedQueries'] ||
            record.transactions !== declaration['transactions'] ||
            record.verifiedAt !== pinnedVerifiedAt
          ) {
            violations.push(
              violation(
                'EVIDENCE_CONFLICTING',
                subject,
                `验证证据 ${evidenceId}（backend=${String(record.backend)}, parameterizedQueries=${String(record.parameterizedQueries)}, transactions=${String(record.transactions)}, verifiedAt=${String(record.verifiedAt)}）与声明不一致`,
              ),
            );
          }
          const acceptedMethods = SQL_EXECUTOR_VERIFICATION_CONTRACT.acceptedEvidenceMethods;
          if (!(acceptedMethods as readonly string[]).includes(record.method)) {
            violations.push(
              violation(
                'EVIDENCE_METHOD_NOT_ACCEPTED',
                subject,
                `验证方式 ${String(record.method)} 不可用于生产：只接受 [${acceptedMethods.join(', ')}]`,
              ),
            );
          }
          for (const timestamp of new Set([pinnedVerifiedAt, record.verifiedAt])) {
            if (
              !isWithinTrustWindow(
                timestamp,
                parsedNow,
                SQL_EXECUTOR_VERIFICATION_CONTRACT.evidenceMaxAgeDays,
              )
            ) {
              violations.push(
                violation(
                  'EVIDENCE_STALE',
                  subject,
                  `验证证据 ${evidenceId} 的时间 ${timestamp} 不在可信窗口内（最长 ${SQL_EXECUTOR_VERIFICATION_CONTRACT.evidenceMaxAgeDays} 天、允许时钟偏移 ${SQL_EXECUTOR_VERIFICATION_CONTRACT.clockSkewMinutes} 分钟）：必须重新验证`,
                ),
              );
            }
          }
        }
      }
    }

    // ---- 4. schema / 迁移就绪证据 ----
    const readiness = declaration['schemaReadiness'];
    const readinessId = isRecord(readiness) ? readiness['readinessId'] : undefined;
    const pinnedCheckedAt = isRecord(readiness) ? readiness['checkedAt'] : undefined;
    if (
      !isRecord(readiness) ||
      !isNonBlankString(readinessId) ||
      !isIsoTimestamp(pinnedCheckedAt)
    ) {
      violations.push(
        violation(
          'SCHEMA_READINESS_MISSING',
          subject,
          '声明缺少迁移就绪证据引用（schemaReadiness.readinessId + schemaReadiness.checkedAt）',
        ),
      );
    } else {
      const records = input.registry.schemaReadiness(readinessId);
      if (records.length === 0) {
        violations.push(
          violation(
            'SCHEMA_READINESS_UNKNOWN',
            subject,
            `迁移就绪证据 ${readinessId} 未登记：生产执行器必须给出可核对的 schema/迁移就绪证据`,
          ),
        );
      } else {
        if (records.length > 1) {
          violations.push(
            violation(
              'SCHEMA_READINESS_CONFLICTING',
              subject,
              `迁移就绪证据 ${readinessId} 存在 ${records.length} 条内容不一致的登记：冲突证据必须人工消解`,
            ),
          );
        }
        const record = records[0];
        if (record !== undefined) {
          if (!isNonBlankString(record.checkedBy) || !isNonBlankString(record.readinessRef)) {
            violations.push(
              violation(
                'SCHEMA_READINESS_MISSING',
                subject,
                `迁移就绪证据 ${readinessId} 缺少 checkedBy 或可核对的 readinessRef`,
              ),
            );
          }
          if (
            record.migrationContractId !== SQL_EXECUTOR_VERIFICATION_CONTRACT.migrationContractId ||
            record.migrationContractVersion !==
              SQL_EXECUTOR_VERIFICATION_CONTRACT.migrationContractVersion
          ) {
            violations.push(
              violation(
                'SCHEMA_READINESS_CONTRACT_MISMATCH',
                subject,
                `就绪证据锚定的迁移契约是 ${String(record.migrationContractId)}@${String(record.migrationContractVersion)}，必须是 ${SQL_EXECUTOR_VERIFICATION_CONTRACT.migrationContractId}@${SQL_EXECUTOR_VERIFICATION_CONTRACT.migrationContractVersion}`,
              ),
            );
          }
          if (record.backend !== declaration['backend'] || record.checkedAt !== pinnedCheckedAt) {
            violations.push(
              violation(
                'SCHEMA_READINESS_CONFLICTING',
                subject,
                `迁移就绪证据 ${readinessId}（backend=${String(record.backend)}, checkedAt=${String(record.checkedAt)}）与声明不一致`,
              ),
            );
          }
          if (
            !isWithinTrustWindow(
              record.checkedAt,
              parsedNow,
              SQL_EXECUTOR_VERIFICATION_CONTRACT.readinessMaxAgeDays,
            )
          ) {
            violations.push(
              violation(
                'SCHEMA_READINESS_STALE',
                subject,
                `迁移就绪证据 ${readinessId} 的核对时间 ${record.checkedAt} 不在可信窗口内（最长 ${SQL_EXECUTOR_VERIFICATION_CONTRACT.readinessMaxAgeDays} 天、允许时钟偏移 ${SQL_EXECUTOR_VERIFICATION_CONTRACT.clockSkewMinutes} 分钟）：必须重新核对`,
              ),
            );
          }

          const available = record.availableVersions;
          const applied = record.appliedVersions;
          if (available.length === 0) {
            violations.push(
              violation(
                'SCHEMA_READINESS_UNVERIFIABLE',
                subject,
                `迁移就绪证据 ${readinessId} 的 availableVersions 为空：无法确认 schema 是否已建立`,
              ),
            );
          } else {
            if (applied.length < available.length) {
              violations.push(
                violation(
                  'SCHEMA_READINESS_PENDING_MIGRATIONS',
                  subject,
                  `尚有未应用迁移（applied=${applied.length}, available=${available.length}）：schema 未就绪，禁止启动生产`,
                ),
              );
            }
            const mismatched = applied.some((version, index) => version !== available[index]);
            if (mismatched || applied.length > available.length) {
              violations.push(
                violation(
                  'SCHEMA_READINESS_SEQUENCE_MISMATCH',
                  subject,
                  `已应用版本 [${applied.join(', ')}] 不是可用版本 [${available.join(', ')}] 的前缀：迁移顺序不一致或库中存在代码里没有的版本`,
                ),
              );
            }
          }
        }
      }
    }
  }

  // ---- 5. 实例结构事实：声明生产可用或处于生产环境时，参数化与事务能力必须可证 ----
  if (enforceProductionClause) {
    if (input.surface.kind === 'not-an-executor') {
      violations.push(
        violation(
          'EXECUTOR_SURFACE_UNSUPPORTED',
          subject,
          '实例既不暴露 connect 也不暴露 query：无法确认它是 SQL 执行器或连接工厂',
        ),
      );
    }
    if (input.surface.hasQuery && input.surface.queryParameterSlots < 2) {
      violations.push(
        violation(
          'PARAMETERIZATION_UNSUPPORTED',
          subject,
          `query 只声明 ${input.surface.queryParameterSlots} 个形参槽：非参数化执行器（必须接受参数数组，禁止把值拼进 SQL）`,
        ),
      );
    }
    if (input.surface.hasQuery && !input.surface.hasTransaction) {
      violations.push(
        violation(
          'TRANSACTION_UNSUPPORTED',
          subject,
          '执行器未暴露 transaction(run)：缺少事务能力，不得用于生产',
        ),
      );
    }
  }

  const declaredBackend = declarationPresent ? declaration['backend'] : undefined;
  const evidenceIdValue = declarationPresent
    ? readMember(declaration['verification'], 'evidenceId')
    : undefined;
  const readinessIdValue = declarationPresent
    ? readMember(declaration['schemaReadiness'], 'readinessId')
    : undefined;

  return {
    ok: violations.length === 0,
    violations,
    ...(typeof declaredBackend === 'string' ? { declaredBackend } : {}),
    ...(typeof evidenceIdValue === 'string' ? { evidenceId: evidenceIdValue } : {}),
    ...(typeof readinessIdValue === 'string' ? { readinessId: readinessIdValue } : {}),
  };
}

/** 断言契约成立，失败即抛 `SqlExecutorVerificationError`（fail-closed） */
export function assertVerifiedSqlExecutor(
  input: SqlExecutorVerificationInput,
): SqlExecutorVerificationReport {
  const report = evaluateSqlExecutorVerification(input);
  if (!report.ok) {
    throw new SqlExecutorVerificationError(report.violations);
  }
  return report;
}

export interface SqlExecutorVerificationContext {
  readonly registry: SqlExecutorVerificationRegistry;
  readonly nodeEnv: string;
  /** 判定时刻；省略时取当前时间（仅运行期使用，测试应显式注入） */
  readonly now?: string;
  readonly label?: string;
}

/**
 * 从实例采集契约输入（事实采集侧，运行期使用）。
 *
 * 非执行器形态的绑定（既不暴露 `connect` 也不暴露 `query`，例如只有 `capabilities` 的替身）返回
 * `undefined`：它不属于本契约的范围，其生产可用性由能力守卫（`production-guard.ts`）判定。
 * 只读实例字段，**不调用** `connect` / `query` / `transaction`。
 */
export function collectSqlExecutorVerificationInput(
  instance: unknown,
  context: SqlExecutorVerificationContext,
): SqlExecutorVerificationInput | undefined {
  const surface = inspectSqlExecutorSurface(instance);
  if (surface.kind === 'not-an-executor') {
    return undefined;
  }
  return {
    nodeEnv: context.nodeEnv,
    declaration: readMember(instance, 'capabilities'),
    surface,
    registry: context.registry,
    now: context.now ?? new Date().toISOString(),
    ...(context.label !== undefined ? { label: context.label } : {}),
  };
}
