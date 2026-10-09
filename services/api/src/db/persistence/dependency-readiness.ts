import {
  freezeDeep,
  isDeeplyImmutableDeclaration,
  isInMemoryBackendMarker,
  isIsoTimestamp,
  isNonBlankString,
} from '../ports/sql-executor-verification';

/**
 * 生产依赖就绪契约（**生产持久化依赖的「封存 + 证据 + 认证先行」准入契约**）。
 *
 * ## 为什么需要它
 * `production-guard.ts` 的生产判定只读绑定**自述**的三个能力布尔
 * （`backend` / `persistent` / `productionReady`）。自述是可以伪造的：任何对象字面量都能声称
 * `backend = postgres`、`persistent = true`、`productionReady = true`，于是「把会话存储或业务仓储
 * 换绑成一个自述生产可用的替身」就能绕过生产边界 —— 重启即丢数据，且无人察觉。
 * 本契约把「依赖就绪」收紧成一份机器可判定的准入清单：
 *
 * 1. **分阶段，认证先行**：先判 `authentication` 角色（会话存储是认证链路的根），
 *    认证阶段不通过就**不评估业务阶段**（业务端口根本不会被读取）—— 不允许「业务依赖宣称就绪」
 *    掩盖「认证不可信」。判定顺序由 `DEPENDENCY_ROLE_ORDER` 固定，不依赖调用方传参顺序。
 * 2. **封存声明**：自称 `persistent = true` 且 `productionReady = true` 的绑定，其 `capabilities`
 *    必须是本登记表 `attest()` 产出的封存声明（WeakSet 身份 + 深度冻结 + 自持原型 + 只允许数据
 *    属性）：对象展开、`structuredClone`、JSON 往返、`Object.create(封存声明)` 与事后改字段都拿不到
 *    封存身份；封存声明的 `token`/`role` 必须与实际绑定一致，禁止把别的依赖的封存声明挪用到本端口。
 * 3. **验证证据**：封存声明必须引用一条**已登记**的验证证据（`evidenceId`）；证据必须字段齐全、
 *    可核对（`verifiedBy` / `evidenceRef`）、方式被生产接受（`integration-test`）、时间落在新鲜度
 *    窗口内，并与声明逐项一致（端口、角色、后端、持久/生产可用、时间戳）。缺失 / 未知 / 冲突 /
 *    过期 / 方式不可接受一律拒绝。
 * 4. **内存替身与未验证后端**：非持久或内存标记的后端判 `DEPENDENCY_NOT_PERSISTENT`
 *    （`InMemorySessionStore` 与全部内存基线仓储都属于这一类）；`persistent = true` 但
 *    `productionReady = false` 判 `DEPENDENCY_NOT_VERIFIED`。
 * 5. **门槛档位**：生产环境、**或已配置数据库**（`DATABASE_URL` 存在，与 `NODE_ENV` 无关）时门禁
 *    生效；开发/测试且无数据库时门禁不生效（`not-required`），此时**连端口都不会被读取** ——
 *    无数据库默认启动保持现状。
 *
 * ## 与能力边界的分工
 * 本契约回答「这个依赖是否经过封存与证据验证」；`production-guard.ts` 回答「能力声明是否齐全、
 * 生产环境是否有数据库、SQL 执行器是否 attest」。两道门禁都在启动阶段执行（本契约在前），
 * 任一不通过都 fail-closed，因此不存在「用自述绕过其中一道」的路径。
 *
 * ## 边界事实
 * - **纯判定 / 纯登记**：不读环境变量、不读磁盘、不建连接、不调用任何依赖的方法；
 *   判定时刻 `now` 由调用方显式注入，同一输入判定可复现；
 * - **不引入任何驱动 / ORM，也不提供任何真实生产实现**：默认登记表是**空集**，因此本仓库当前
 *   没有任何依赖能通过生产门禁 —— 空集本身就是一条证据；
 * - 违规信息只含端口名、角色、后端标识与布尔/枚举值，**不含连接串、口令、证据引用或业务字段取值**。
 */

// ---------------------------------------------------------------------------
// 契约身份与参数
// ---------------------------------------------------------------------------

/** 契约身份：版本变化意味着准入规则变化，调用方据此判断是否需要重新验证 */
export const DEPENDENCY_READINESS_CONTRACT_ID = 'production-dependency-readiness';
export const DEPENDENCY_READINESS_CONTRACT_VERSION = 1;

/** 验证方式：`integration-test` 是真实集成测试，也是生产唯一可接受的来源 */
export type DependencyEvidenceMethod = 'integration-test' | 'contract-test' | 'manual-review';

/** 允许登记的验证方式（登记不限于生产可接受的方式） */
export const DEPENDENCY_EVIDENCE_METHODS: readonly DependencyEvidenceMethod[] = [
  'integration-test',
  'contract-test',
  'manual-review',
];

/** 生产可接受的证据方式：只有真实集成测试能证明「换绑后的实现真的可用」 */
export const DEPENDENCY_ACCEPTED_EVIDENCE_METHODS: readonly DependencyEvidenceMethod[] = [
  'integration-test',
];

/** 验证证据最长有效天数：超期必须重新验证，不得「一次验证永久生产可用」 */
export const DEPENDENCY_EVIDENCE_MAX_AGE_DAYS = 90;

/** 允许的时钟偏移（证据时间超前于判定时刻的上限） */
export const DEPENDENCY_CLOCK_SKEW_MINUTES = 15;

// ---------------------------------------------------------------------------
// 角色与门禁档位
// ---------------------------------------------------------------------------

/**
 * 依赖角色：决定判定顺序与「认证先行」语义。
 * - `authentication`：会话/凭证存储，认证链路的根，必须最先就绪；
 * - `business`：业务持久化依赖（画像、小组、成果、审计、导出……）。
 */
export type DependencyRole = 'authentication' | 'business';

/** 判定顺序（越小越先）：认证先于业务，且认证失败时业务阶段整体不评估 */
export const DEPENDENCY_ROLE_ORDER: readonly DependencyRole[] = ['authentication', 'business'];

export function isDependencyRole(value: unknown): value is DependencyRole {
  return (DEPENDENCY_ROLE_ORDER as readonly unknown[]).includes(value);
}

/** 门禁档位：`not-required`（开发/测试且无数据库）与 `required`（生产，或数据库已配置） */
export type DependencyReadinessTier = 'not-required' | 'required';

/**
 * 门禁档位判定（**运行时与运维信息共用的唯一口径**）。
 *
 * 为什么把「已配置数据库」也算作生效：`NODE_ENV=test` 只说明「当前不是生产进程」，不说明
 * 「没有数据库」。一旦 `DATABASE_URL` 解析成功，业务数据就会落到该后端，因此开发/测试环境同样
 * 必须持封存声明与完整证据；否则会出现「本地接上一个未经验证的持久化后端，门禁被环境名绕过」。
 */
export function describeDependencyReadinessTier(
  nodeEnv: string,
  databaseConfigured: boolean,
): DependencyReadinessTier {
  return nodeEnv === 'production' || databaseConfigured ? 'required' : 'not-required';
}

/** 布尔形式：调用点只想问「门禁是否生效」时使用（口径与上者完全一致） */
export function isDependencyReadinessRequired(
  nodeEnv: string,
  databaseConfigured: boolean,
): boolean {
  return describeDependencyReadinessTier(nodeEnv, databaseConfigured) === 'required';
}

// ---------------------------------------------------------------------------
// 违规
// ---------------------------------------------------------------------------

/** 违规码：每个代码对应一类可机器判定的「生产依赖不可信」 */
export type DependencyReadinessCode =
  // 能力自述面
  | 'DEPENDENCY_CAPABILITIES_MISSING'
  | 'DEPENDENCY_NOT_PERSISTENT'
  | 'DEPENDENCY_NOT_VERIFIED'
  // 封存身份
  | 'DEPENDENCY_NOT_SEALED'
  | 'DEPENDENCY_MUTABLE'
  | 'DEPENDENCY_CONTRACT_MISMATCH'
  | 'DEPENDENCY_BINDING_MISMATCH'
  // 验证证据
  | 'DEPENDENCY_EVIDENCE_UNKNOWN'
  | 'DEPENDENCY_EVIDENCE_CONFLICTING'
  | 'DEPENDENCY_EVIDENCE_METHOD_NOT_ACCEPTED'
  | 'DEPENDENCY_EVIDENCE_STALE';

export interface DependencyReadinessViolation {
  readonly code: DependencyReadinessCode;
  /** 违规端口（DI 令牌的可读名，例如 `SESSION_STORE`） */
  readonly token: string;
  /** 违规端口所属角色（形状校验类违规可能无法确定角色，此时省略） */
  readonly role?: DependencyRole;
  /** 只含标识、契约版本、布尔与枚举能力值，不含机密与证据引用 */
  readonly detail: string;
}

function violation(
  code: DependencyReadinessCode,
  token: string,
  detail: string,
  role?: DependencyRole,
): DependencyReadinessViolation {
  return role === undefined ? { code, token, detail } : { code, token, role, detail };
}

/** 契约判定 / 登记失败：携带全部违规项，供启动日志与测试断言 */
export class DependencyReadinessError extends Error {
  readonly violations: readonly DependencyReadinessViolation[];

  constructor(violations: readonly DependencyReadinessViolation[]) {
    const summary = violations.map((item) => `${item.token}[${item.code}]`).join(', ');
    super(`生产依赖就绪契约拒绝（${violations.length} 项）: ${summary}`);
    this.name = 'DependencyReadinessError';
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// 封存声明、验证证据与登记表
// ---------------------------------------------------------------------------

/**
 * 封存声明：**只能由本模块的登记表产出**，且产出时即深度冻结。
 * 结构上满足 `PersistenceCapabilities` / `SessionBackendCapabilities`，因此可以直接挂在
 * `SESSION_STORE`、业务 repository 的 `capabilities` 上，调用方无需改动接口。
 */
export interface SealedDependencyReadiness {
  readonly contractId: string;
  readonly contractVersion: number;
  /** 该声明服务的端口（必须与实际绑定的端口一致） */
  readonly token: string;
  /** 该声明服务的角色（必须与实际绑定表的角色一致） */
  readonly role: DependencyRole;
  readonly backend: string;
  readonly persistent: true;
  readonly productionReady: true;
  /** 验证来源引用：指向已登记的验证证据，声明方不得自述「已验证」 */
  readonly verification: {
    readonly evidenceId: string;
    readonly verifiedAt: string;
  };
}

/**
 * 验证证据：一次**真的做过**的依赖验证记录。
 * `evidenceRef` 必须是可核对的引用（CI 运行链接、集成测试文件与用例名等），禁止只写「已验证」。
 */
export interface DependencyReadinessEvidence {
  readonly evidenceId: string;
  readonly token: string;
  readonly role: DependencyRole;
  readonly backend: string;
  readonly contractId: string;
  readonly contractVersion: number;
  /** 验证执行者（人 / 流水线） */
  readonly verifiedBy: string;
  readonly verifiedAt: string;
  readonly method: DependencyEvidenceMethod;
  readonly persistent: true;
  readonly productionReady: true;
  readonly evidenceRef: string;
}

/** 封存输入：登记表只接受「持久 + 生产可用 + 有验证来源」的声明 */
export interface DependencyAttestationInput {
  readonly token: string;
  readonly role: DependencyRole;
  readonly backend: string;
  readonly persistent: boolean;
  readonly productionReady: boolean;
  readonly evidenceId: string;
  readonly verifiedAt: string;
}

export interface DependencyReadinessRegistryStats {
  readonly sealedDeclarations: number;
  readonly evidence: number;
}

/** 登记表接口：判定器只依赖它回答「封存身份」与「证据记录」两类问题 */
export interface DependencyReadinessRegistry {
  /** 封存一份声明：只能由本登记表产出，返回值深度冻结；不合格输入直接抛错 */
  attest(input: DependencyAttestationInput): SealedDependencyReadiness;
  /** 登记一条验证证据：形状不合格直接抛错，不写登记表 */
  registerEvidence(record: DependencyReadinessEvidence): void;
  /** 身份校验：只有本登记表 `attest` 返回过的对象为 true（复制/继承一律 false） */
  isSealed(value: unknown): boolean;
  evidence(evidenceId: string): readonly DependencyReadinessEvidence[];
  describe(): DependencyReadinessRegistryStats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 内容指纹：同一键集合按字典序规范化，用于登记去重与「冲突证据」判定 */
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
function pushUnique(
  store: Map<string, DependencyReadinessEvidence[]>,
  key: string,
  value: DependencyReadinessEvidence,
): void {
  const existing = store.get(key) ?? [];
  const fingerprint = canonicalize(value);
  if (!existing.some((item) => canonicalize(item) === fingerprint)) {
    existing.push(value);
  }
  store.set(key, existing);
}

/** 封存声明登记前的形状校验：缺字段 / 角色非法 / 自称不可信一律拒绝，不产出封存身份 */
export function assertDependencyAttestationShape(input: DependencyAttestationInput): void {
  const token = isNonBlankString(input.token) ? input.token : '(未命名端口)';
  const role = isDependencyRole(input.role) ? input.role : undefined;
  const problems: DependencyReadinessViolation[] = [];

  if (!isNonBlankString(input.token)) {
    problems.push(violation('DEPENDENCY_CAPABILITIES_MISSING', token, '封存声明缺少端口名', role));
  }
  if (!isDependencyRole(input.role)) {
    problems.push(
      violation(
        'DEPENDENCY_BINDING_MISMATCH',
        token,
        `封存声明的角色 ${String(input.role)} 不是已登记角色 [${DEPENDENCY_ROLE_ORDER.join(', ')}]`,
      ),
    );
  }
  if (!isNonBlankString(input.backend) || isInMemoryBackendMarker(input.backend)) {
    problems.push(
      violation(
        'DEPENDENCY_NOT_PERSISTENT',
        token,
        `封存声明的后端 ${String(input.backend)} 不是可持久化的生产后端（空值或内存标记一律拒绝）`,
        role,
      ),
    );
  }
  if (input.persistent !== true) {
    problems.push(
      violation(
        'DEPENDENCY_NOT_PERSISTENT',
        token,
        `封存声明必须 persistent=true（当前 ${String(input.persistent)}）：内存替身不得被封存为生产依赖`,
        role,
      ),
    );
  }
  if (input.productionReady !== true) {
    problems.push(
      violation(
        'DEPENDENCY_NOT_VERIFIED',
        token,
        `封存声明必须 productionReady=true（当前 ${String(input.productionReady)}）：未完成验证不得被封存`,
        role,
      ),
    );
  }
  if (!isNonBlankString(input.evidenceId)) {
    problems.push(
      violation('DEPENDENCY_EVIDENCE_UNKNOWN', token, '封存声明缺少 verification.evidenceId', role),
    );
  }
  if (!isIsoTimestamp(input.verifiedAt)) {
    problems.push(
      violation(
        'DEPENDENCY_EVIDENCE_UNKNOWN',
        token,
        '封存声明的 verification.verifiedAt 必须是带时区的 ISO 时间戳',
        role,
      ),
    );
  }
  if (problems.length > 0) {
    throw new DependencyReadinessError(problems);
  }
}

/** 验证证据登记前的形状校验：缺字段 / 时间非法 / 无法核对一律拒绝，不写登记表 */
export function assertDependencyEvidenceShape(record: DependencyReadinessEvidence): void {
  const token = isNonBlankString(record.token) ? record.token : '(未命名端口)';
  const role = isDependencyRole(record.role) ? record.role : undefined;
  const problems: DependencyReadinessViolation[] = [];

  if (!isNonBlankString(record.evidenceId)) {
    problems.push(violation('DEPENDENCY_EVIDENCE_UNKNOWN', token, '验证证据缺少 evidenceId', role));
  }
  if (!isNonBlankString(record.token)) {
    problems.push(violation('DEPENDENCY_EVIDENCE_UNKNOWN', token, '验证证据缺少 token', role));
  }
  if (!isDependencyRole(record.role)) {
    problems.push(
      violation(
        'DEPENDENCY_BINDING_MISMATCH',
        token,
        `验证证据的角色 ${String(record.role)} 不是已登记角色`,
      ),
    );
  }
  if (!isNonBlankString(record.backend) || isInMemoryBackendMarker(record.backend)) {
    problems.push(
      violation(
        'DEPENDENCY_NOT_PERSISTENT',
        token,
        `验证证据的后端 ${String(record.backend)} 不是可持久化的生产后端`,
        role,
      ),
    );
  }
  if (record.contractId !== DEPENDENCY_READINESS_CONTRACT_ID) {
    problems.push(
      violation(
        'DEPENDENCY_EVIDENCE_CONFLICTING',
        token,
        `验证证据 contractId=${String(record.contractId)}，必须是 ${DEPENDENCY_READINESS_CONTRACT_ID}`,
        role,
      ),
    );
  }
  if (record.contractVersion !== DEPENDENCY_READINESS_CONTRACT_VERSION) {
    problems.push(
      violation(
        'DEPENDENCY_EVIDENCE_CONFLICTING',
        token,
        `验证证据 contractVersion=${String(record.contractVersion)}，必须是 ${DEPENDENCY_READINESS_CONTRACT_VERSION}`,
        role,
      ),
    );
  }
  if (!isNonBlankString(record.verifiedBy)) {
    problems.push(
      violation('DEPENDENCY_EVIDENCE_UNKNOWN', token, '验证证据缺少 verifiedBy（谁验证的）', role),
    );
  }
  if (!isIsoTimestamp(record.verifiedAt)) {
    problems.push(
      violation(
        'DEPENDENCY_EVIDENCE_UNKNOWN',
        token,
        '验证证据的 verifiedAt 必须是带时区的 ISO 时间戳',
        role,
      ),
    );
  }
  if (!(DEPENDENCY_EVIDENCE_METHODS as readonly string[]).includes(record.method)) {
    problems.push(
      violation(
        'DEPENDENCY_EVIDENCE_METHOD_NOT_ACCEPTED',
        token,
        `验证方式 ${String(record.method)} 不在允许集合 [${DEPENDENCY_EVIDENCE_METHODS.join(', ')}] 内`,
        role,
      ),
    );
  }
  if (record.persistent !== true || record.productionReady !== true) {
    problems.push(
      violation(
        'DEPENDENCY_NOT_VERIFIED',
        token,
        `验证证据必须声明 persistent=true 且 productionReady=true（当前 ${String(record.persistent)}/${String(record.productionReady)}）`,
        role,
      ),
    );
  }
  if (!isNonBlankString(record.evidenceRef)) {
    problems.push(
      violation(
        'DEPENDENCY_EVIDENCE_UNKNOWN',
        token,
        '验证证据缺少可核对的 evidenceRef（CI 运行 / 用例位置）',
        role,
      ),
    );
  }
  if (problems.length > 0) {
    throw new DependencyReadinessError(problems);
  }
}

/** 组装封存声明：先判「这份声明配不配被称为生产依赖声明」，再深度冻结 */
function buildSealedReadiness(input: DependencyAttestationInput): SealedDependencyReadiness {
  assertDependencyAttestationShape(input);
  const declaration: SealedDependencyReadiness = {
    contractId: DEPENDENCY_READINESS_CONTRACT_ID,
    contractVersion: DEPENDENCY_READINESS_CONTRACT_VERSION,
    token: input.token,
    role: input.role,
    backend: input.backend,
    persistent: true,
    productionReady: true,
    verification: { evidenceId: input.evidenceId, verifiedAt: input.verifiedAt },
  };
  freezeDeep(declaration);
  return declaration;
}

/**
 * 创建登记表：封存声明 + 验证证据。
 *
 * 生产装配只应使用 `DEFAULT_DEPENDENCY_READINESS_REGISTRY`（同一份身份集合）；测试与未来的
 * 多后端场景可以各自建表，避免全局状态互相污染。
 */
export function createDependencyReadinessRegistry(): DependencyReadinessRegistry {
  const sealed = new WeakSet<object>();
  const evidenceStore = new Map<string, DependencyReadinessEvidence[]>();
  let sealedCount = 0;

  return {
    attest(input) {
      const declaration = buildSealedReadiness(input);
      sealed.add(declaration);
      sealedCount += 1;
      return declaration;
    },
    registerEvidence(record) {
      assertDependencyEvidenceShape(record);
      pushUnique(evidenceStore, record.evidenceId, record);
    },
    isSealed(value) {
      return isRecord(value) && sealed.has(value);
    },
    evidence(evidenceId) {
      return evidenceStore.get(evidenceId) ?? [];
    },
    describe() {
      return { sealedDeclarations: sealedCount, evidence: evidenceStore.size };
    },
  };
}

/**
 * 生产装配唯一的封存身份集合。
 *
 * 当前仓库**没有任何**经证实的生产持久化依赖：会话存储仍是 `InMemorySessionStore`，
 * 业务仓储仍是内存基线，十一个 Postgres adapter 都已声明 `productionReady = false` 且未装配。
 * 因此这份登记表是空的，生产/数据库已配置的装配必然被门禁拒绝 —— 空集本身就是一条证据。
 */
export const DEFAULT_DEPENDENCY_READINESS_REGISTRY: DependencyReadinessRegistry =
  createDependencyReadinessRegistry();

// ---------------------------------------------------------------------------
// 候选事实与分阶段判定
// ---------------------------------------------------------------------------

/** 一个待判定的依赖：端口名 + 角色 + 容器里实际绑定的能力声明（未绑定/未声明时为 undefined） */
export interface DependencyReadinessCandidate {
  readonly token: string;
  readonly role: DependencyRole;
  readonly capabilities?: unknown;
}

/** 单阶段判定状态 */
export type DependencyStageState = 'not-required' | 'not-checked' | 'verified' | 'rejected';

export interface DependencyStageInput {
  /** 门禁是否生效（由 `describeDependencyReadinessTier` 决定）；false 时本阶段不做任何判定 */
  readonly required: boolean;
  readonly role: DependencyRole;
  readonly candidates: readonly DependencyReadinessCandidate[];
  readonly registry: DependencyReadinessRegistry;
  /** 判定时刻（带时区 ISO 时间戳）；显式注入，保证同一输入判定可复现 */
  readonly now: string;
}

export interface DependencyStageReport {
  readonly role: DependencyRole;
  readonly state: Exclude<DependencyStageState, 'not-checked'>;
  readonly violations: readonly DependencyReadinessViolation[];
  readonly checkedTokens: readonly string[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

/** 时间可信度：证据时间必须落在 `[now - maxAge, now + clockSkew]` 内（过期与超前同判） */
function isWithinTrustWindow(timestamp: string, nowMs: number): boolean {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return false;
  }
  const newestAllowed = nowMs + DEPENDENCY_CLOCK_SKEW_MINUTES * MS_PER_MINUTE;
  const oldestAllowed = nowMs - DEPENDENCY_EVIDENCE_MAX_AGE_DAYS * MS_PER_DAY;
  return parsed <= newestAllowed && parsed >= oldestAllowed;
}

function isSealedSafely(registry: DependencyReadinessRegistry, value: unknown): boolean {
  try {
    return registry.isSealed(value);
  } catch {
    // 登记表本身异常时按「未封存」处理：fail-closed，不放行未确认的声明
    return false;
  }
}

function readEvidenceSafely(
  registry: DependencyReadinessRegistry,
  evidenceId: string,
): readonly DependencyReadinessEvidence[] {
  try {
    return registry.evidence(evidenceId);
  } catch {
    return [];
  }
}

/**
 * 判定单个候选依赖。
 *
 * 顺序即语义：先看能力自述是否配进入生产（持久 + 生产可用），再要求封存身份与证据；
 * 内存替身与未验证后端由前两步直接拦下，不会退化到「自称生产可用就放行」。
 */
function judgeCandidate(
  candidate: DependencyReadinessCandidate,
  registry: DependencyReadinessRegistry,
  nowMs: number,
): readonly DependencyReadinessViolation[] {
  const { token, role } = candidate;
  const capabilities = candidate.capabilities;

  if (!isRecord(capabilities)) {
    return [
      violation(
        'DEPENDENCY_CAPABILITIES_MISSING',
        token,
        '端口未绑定实现，或实现未声明能力（backend/persistent/productionReady）',
        role,
      ),
    ];
  }

  const backend = capabilities['backend'];
  const persistent = capabilities['persistent'];
  const productionReady = capabilities['productionReady'];

  if (!isNonBlankString(backend) || persistent !== true || isInMemoryBackendMarker(backend)) {
    return [
      violation(
        'DEPENDENCY_NOT_PERSISTENT',
        token,
        `绑定到非持久 / 内存后端（backend=${String(backend)}, persistent=${String(persistent)}）：生产环境禁止以内存实现承担持久化职责（会话存储与业务仓储同样适用）`,
        role,
      ),
    ];
  }

  if (productionReady !== true) {
    return [
      violation(
        'DEPENDENCY_NOT_VERIFIED',
        token,
        `后端 ${String(backend)} 的 productionReady=${String(productionReady)}，必须是 true：未完成验证不得作为生产依赖`,
        role,
      ),
    ];
  }

  // ---- 自称「持久 + 生产可用」：必须持封存声明与已登记证据，自述不能作为准入依据 ----
  const problems: DependencyReadinessViolation[] = [];
  if (!isSealedSafely(registry, capabilities)) {
    problems.push(
      violation(
        'DEPENDENCY_NOT_SEALED',
        token,
        '能力声明不是经验证的封存声明（不是由登记表签发的身份）：对象字面量、展开副本、结构化克隆与原型继承一律不被接受',
        role,
      ),
    );
    if (!isDeeplyImmutableDeclaration(capabilities)) {
      problems.push(
        violation(
          'DEPENDENCY_MUTABLE',
          token,
          '能力声明可变（未深度冻结 / 含访问器属性 / 由原型继承）：验证通过后仍可能被改写',
          role,
        ),
      );
    }
    return problems;
  }

  if (
    capabilities['contractId'] !== DEPENDENCY_READINESS_CONTRACT_ID ||
    capabilities['contractVersion'] !== DEPENDENCY_READINESS_CONTRACT_VERSION
  ) {
    problems.push(
      violation(
        'DEPENDENCY_CONTRACT_MISMATCH',
        token,
        `声明契约身份为 ${String(capabilities['contractId'])}@${String(capabilities['contractVersion'])}，必须是 ${DEPENDENCY_READINESS_CONTRACT_ID}@${DEPENDENCY_READINESS_CONTRACT_VERSION}`,
        role,
      ),
    );
  }

  if (capabilities['token'] !== token || capabilities['role'] !== role) {
    problems.push(
      violation(
        'DEPENDENCY_BINDING_MISMATCH',
        token,
        `封存声明的端口/角色（${String(capabilities['token'])}/${String(capabilities['role'])}）与实际绑定（${token}/${role}）不一致：不得把别的依赖的封存声明挪用到本端口`,
        role,
      ),
    );
  }

  const verification = capabilities['verification'];
  const evidenceId = isRecord(verification) ? verification['evidenceId'] : undefined;
  const pinnedVerifiedAt = isRecord(verification) ? verification['verifiedAt'] : undefined;
  if (
    !isRecord(verification) ||
    !isNonBlankString(evidenceId) ||
    !isIsoTimestamp(pinnedVerifiedAt)
  ) {
    problems.push(
      violation(
        'DEPENDENCY_EVIDENCE_UNKNOWN',
        token,
        '封存声明缺少验证来源引用（verification.evidenceId + verification.verifiedAt）',
        role,
      ),
    );
    return problems;
  }

  const records = readEvidenceSafely(registry, evidenceId);
  if (records.length === 0) {
    problems.push(
      violation(
        'DEPENDENCY_EVIDENCE_UNKNOWN',
        token,
        `验证证据 ${evidenceId} 未登记：声明不得自述「已验证」，必须指向登记表中的证据记录`,
        role,
      ),
    );
    return problems;
  }
  if (records.length > 1) {
    problems.push(
      violation(
        'DEPENDENCY_EVIDENCE_CONFLICTING',
        token,
        `验证证据 ${evidenceId} 存在 ${records.length} 条内容不一致的登记：冲突证据必须人工消解`,
        role,
      ),
    );
  }

  const record = records[0];
  if (record !== undefined) {
    if (!isNonBlankString(record.verifiedBy) || !isNonBlankString(record.evidenceRef)) {
      problems.push(
        violation(
          'DEPENDENCY_EVIDENCE_UNKNOWN',
          token,
          `验证证据 ${evidenceId} 缺少 verifiedBy 或可核对的 evidenceRef`,
          role,
        ),
      );
    }
    if (
      record.token !== token ||
      record.role !== role ||
      record.backend !== capabilities['backend'] ||
      record.persistent !== true ||
      record.productionReady !== true ||
      record.contractId !== DEPENDENCY_READINESS_CONTRACT_ID ||
      record.contractVersion !== DEPENDENCY_READINESS_CONTRACT_VERSION ||
      record.verifiedAt !== pinnedVerifiedAt
    ) {
      problems.push(
        violation(
          'DEPENDENCY_EVIDENCE_CONFLICTING',
          token,
          `验证证据 ${evidenceId}（token=${String(record.token)}, role=${String(record.role)}, backend=${String(record.backend)}, verifiedAt=${String(record.verifiedAt)}）与声明不一致`,
          role,
        ),
      );
    }
    if (!(DEPENDENCY_ACCEPTED_EVIDENCE_METHODS as readonly string[]).includes(record.method)) {
      problems.push(
        violation(
          'DEPENDENCY_EVIDENCE_METHOD_NOT_ACCEPTED',
          token,
          `验证方式 ${String(record.method)} 不可用于生产：只接受 [${DEPENDENCY_ACCEPTED_EVIDENCE_METHODS.join(', ')}]`,
          role,
        ),
      );
    }
    for (const timestamp of new Set([pinnedVerifiedAt, record.verifiedAt])) {
      if (!isWithinTrustWindow(timestamp, nowMs)) {
        problems.push(
          violation(
            'DEPENDENCY_EVIDENCE_STALE',
            token,
            `验证证据 ${evidenceId} 的时间 ${timestamp} 不在可信窗口内（最长 ${DEPENDENCY_EVIDENCE_MAX_AGE_DAYS} 天、允许时钟偏移 ${DEPENDENCY_CLOCK_SKEW_MINUTES} 分钟）：必须重新验证`,
            role,
          ),
        );
      }
    }
  }

  return problems;
}

/**
 * 纯函数判定单个阶段：不读环境变量、不读磁盘、不建连接、不调用依赖方法。
 * `required = false` 时直接返回 `not-required`，**不触碰任何候选**（无数据库的默认启动不受影响）。
 */
export function evaluateDependencyStage(input: DependencyStageInput): DependencyStageReport {
  if (!input.required) {
    return {
      role: input.role,
      state: 'not-required',
      violations: [],
      checkedTokens: [],
    };
  }

  const parsedNow = Date.parse(input.now);
  if (!isIsoTimestamp(input.now) || Number.isNaN(parsedNow)) {
    throw new TypeError(`生产依赖就绪契约要求带时区的 ISO 判定时刻 now，收到 ${String(input.now)}`);
  }

  const violations: DependencyReadinessViolation[] = [];
  for (const candidate of input.candidates) {
    violations.push(...judgeCandidate(candidate, input.registry, parsedNow));
  }

  return {
    role: input.role,
    state: violations.length === 0 ? 'verified' : 'rejected',
    violations,
    checkedTokens: input.candidates.map((candidate) => candidate.token),
  };
}

export interface DependencyReadinessReport {
  readonly ok: boolean;
  readonly tier: DependencyReadinessTier;
  readonly authentication: DependencyStageState;
  /** `not-checked` 表示认证阶段未通过，业务阶段**没有**被评估（也没有被读取） */
  readonly business: DependencyStageState;
  readonly checkedTokens: readonly string[];
  readonly violations: readonly DependencyReadinessViolation[];
}

export interface DependencyReadinessInput {
  readonly required: boolean;
  /**
   * 认证阶段的候选（**惰性**）：`required = false` 时不会被调用，
   * 因此开发/测试且无数据库的装配不会为了判定而去读取容器。
   */
  readonly authentication: () => readonly DependencyReadinessCandidate[];
  /** 业务阶段的候选（**惰性**）：认证阶段未通过时不会被调用 */
  readonly business: () => readonly DependencyReadinessCandidate[];
  readonly registry: DependencyReadinessRegistry;
  readonly now: string;
}

/**
 * 纯函数判定整个门禁：**认证先于业务**，且认证阶段失败时业务阶段整体短路。
 *
 * 短路是契约的一部分（不是优化）：它保证「认证不可信」不会被「业务就绪」稀释，也不会在认证
 * 已失败时继续对业务端口做任何读取或判定。调用方通过两个惰性函数提供候选，从而让这个性质
 * 在容器层可观测（业务端口不会被 `ModuleRef` 读到）。
 */
export function evaluateDependencyReadiness(
  input: DependencyReadinessInput,
): DependencyReadinessReport {
  if (!input.required) {
    return {
      ok: true,
      tier: 'not-required',
      authentication: 'not-required',
      business: 'not-required',
      checkedTokens: [],
      violations: [],
    };
  }

  const authentication = evaluateDependencyStage({
    required: true,
    role: 'authentication',
    candidates: input.authentication(),
    registry: input.registry,
    now: input.now,
  });

  if (authentication.state !== 'verified') {
    return {
      ok: false,
      tier: 'required',
      authentication: 'rejected',
      business: 'not-checked',
      checkedTokens: [...authentication.checkedTokens],
      violations: [...authentication.violations],
    };
  }

  const business = evaluateDependencyStage({
    required: true,
    role: 'business',
    candidates: input.business(),
    registry: input.registry,
    now: input.now,
  });

  return {
    ok: business.state === 'verified',
    tier: 'required',
    authentication: 'verified',
    business: business.state,
    checkedTokens: [...authentication.checkedTokens, ...business.checkedTokens],
    violations: [...business.violations],
  };
}

/** 断言门禁成立，失败即抛 `DependencyReadinessError`（fail-closed） */
export function assertDependencyReadiness(
  input: DependencyReadinessInput,
): DependencyReadinessReport {
  const report = evaluateDependencyReadiness(input);
  if (!report.ok) {
    throw new DependencyReadinessError(report.violations);
  }
  return report;
}
