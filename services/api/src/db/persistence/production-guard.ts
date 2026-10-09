import {
  evaluateSqlExecutorVerification,
  type SqlExecutorVerificationCode,
  type SqlExecutorVerificationInput,
} from '../ports/sql-executor-verification';
import type { PersistenceCapabilities } from '../ports/sql-executor.port';

/**
 * 生产持久化边界守卫。
 *
 * 背景：本项目当前所有业务 repository 都是内存基线（`persistent = false`、
 * `productionReady = false`）。内存实现是显式替身，**不是生产存储**；一旦生产环境
 * 带着内存存储启动，就会出现「重启即丢数据」的静默数据丢失。
 *
 * 因此这里集中定义机器可判定的边界：
 * 1. 每个持久化端口都必须声明能力（缺声明属于代码缺陷，任何环境都判违规）；
 * 2. `NODE_ENV=production` 时，任何 `persistent !== true` 或 `productionReady !== true`
 *    的绑定都判违规 —— 未验证的数据库 adapter 也包含在内（禁止把 provider 切到未验证数据库）；
 * 3. `NODE_ENV=production` 且未配置 `DATABASE_URL` 时判违规 —— 配置 fail-closed；
 * 4. 若装配提供了 SQL 执行器契约事实（`executorVerifications`），执行器还必须通过
 *    `ports/sql-executor-verification.ts` 的准入契约：封存（不可伪造/不可变）的 Postgres 能力声明、
 *    参数化查询能力、事务能力、已登记的验证来源与 schema/迁移就绪证据；内存替身、可变声明、
 *    缺失/过期/冲突证据与非参数化执行器都判 `SQL_EXECUTOR_VERIFICATION_FAILED`；
 * 5. `NODE_ENV=production`，**或**调用方声明「数据库已配置」（`requireAttestedExecutor`，见第 6 条）
 *    时，装配必须真的提供执行器契约事实：数据库存在却没有执行器事实（例如把 `SQL_CONNECTION_FACTORY`
 *    换绑成只有 `capabilities` 的替身、或干脆不绑定），判 `SQL_EXECUTOR_VERIFICATION_REQUIRED` ——
 *    否则「自述生产可用」的能力声明可以绕过契约直接上线（fail-closed）；
 * 6. `requireAttestedExecutor` 与 `databaseConfigured` 的组合语义：只要配置了 `DATABASE_URL`，
 *    装配就必须有**经过 attest 且证据完整**的 SQL 执行器；没有数据库时该要求不生效，
 *    无数据库启动（开发/测试的内存基线）保持默认放行；
 * 7. 违规信息只包含端口名/后端名/规则，绝不包含连接串或口令。
 */

export type PersistenceViolationRule =
  | 'MISSING_CAPABILITIES'
  | 'BACKEND_NOT_DECLARED'
  | 'IN_MEMORY_BACKEND_IN_PRODUCTION'
  | 'BACKEND_NOT_PRODUCTION_READY_IN_PRODUCTION'
  | 'DATABASE_NOT_CONFIGURED_IN_PRODUCTION'
  | 'SQL_EXECUTOR_VERIFICATION_REQUIRED'
  | 'SQL_EXECUTOR_VERIFICATION_FAILED';

/**
 * 执行器契约失败时要落到的端口名。
 *
 * 与 `bindingTokenName(SQL_CONNECTION_FACTORY)` 同值（`SQL_CONNECTION_FACTORY`）；这里用字面量
 * 而不是 import 那个 symbol：本函数是纯判定，不依赖 Nest DI 令牌对象，便于在任何装配之外复用。
 */
export const SQL_EXECUTOR_PORT_TOKEN = 'SQL_CONNECTION_FACTORY';

export interface PersistenceViolation {
  readonly rule: PersistenceViolationRule;
  /** 违规端口（DI 令牌的可读名，例如 `GROUP_REPOSITORY`） */
  readonly token: string;
  /** 只包含后端名与布尔能力，不含任何机密 */
  readonly detail: string;
  /** 仅当 `rule = SQL_EXECUTOR_VERIFICATION_FAILED`：执行器契约的原始违规码 */
  readonly executorCode?: SqlExecutorVerificationCode;
}

/** 一个持久化绑定：端口名 + 实际绑定的实现能力声明 */
export interface PersistenceBinding {
  readonly token: string;
  readonly label: string;
  /** 未解析到实现或实现未声明能力时为 undefined（判 MISSING_CAPABILITIES） */
  readonly capabilities?: PersistenceCapabilities | undefined;
}

export interface PersistenceBoundaryInput {
  readonly nodeEnv: string;
  readonly databaseConfigured: boolean;
  readonly bindings: readonly PersistenceBinding[];
  /**
   * 可选的 SQL 执行器契约事实（每个执行器/连接工厂一条）。
   * 装配没有执行器时省略；提供即参与判定，任一违规都让边界判定失败（fail-closed）。
   */
  readonly executorVerifications?: readonly PersistenceExecutorVerificationInput[];
  /**
   * 数据库已配置时装配**必须**提供「经过 attest 且证据完整」的 SQL 执行器契约事实。
   *
   * 由调用点按 `databaseConfigured` 显式传入（启动装配见 `db/database.module.ts`）：
   * 把「有没有数据库」与「这个后端可否被信任」绑在一起判定，避免换绑成只有 `capabilities`
   * 的替身后，能力自述直接绕过执行器契约。数据库未配置时传 false/省略，无数据库启动不受影响。
   */
  readonly requireAttestedExecutor?: boolean;
}

/** 一个执行器的契约事实：违规要落到具体端口上，便于定位 */
export interface PersistenceExecutorVerificationInput {
  /** 违规端口名（DI 令牌的可读名，例如 `SQL_CONNECTION_FACTORY`） */
  readonly token: string;
  readonly input: SqlExecutorVerificationInput;
}

export interface PersistenceBoundaryReport {
  readonly ok: boolean;
  readonly violations: readonly PersistenceViolation[];
  readonly checkedTokens: readonly string[];
}

/** 边界校验失败：携带全部违规项，供启动日志与测试断言 */
export class PersistenceBoundaryError extends Error {
  readonly violations: readonly PersistenceViolation[];

  constructor(violations: readonly PersistenceViolation[]) {
    const summary = violations.map((item) => `${item.token}[${item.rule}]`).join(', ');
    super(`持久化边界校验失败（${violations.length} 项）: ${summary}`);
    this.name = 'PersistenceBoundaryError';
    this.violations = violations;
  }
}

function describeCapabilities(capabilities: PersistenceCapabilities): string {
  return `backend=${capabilities.backend}, persistent=${String(capabilities.persistent)}, productionReady=${String(capabilities.productionReady)}`;
}

/**
 * 纯函数判定：不读环境变量、不建连接、不写日志，便于在测试里穷举组合。
 */
export function evaluatePersistenceBoundary(
  input: PersistenceBoundaryInput,
): PersistenceBoundaryReport {
  const violations: PersistenceViolation[] = [];
  const isProduction = input.nodeEnv === 'production';

  for (const binding of input.bindings) {
    const { capabilities } = binding;
    if (capabilities === undefined) {
      violations.push({
        rule: 'MISSING_CAPABILITIES',
        token: binding.token,
        detail: `${binding.label} 未声明持久化能力（backend/persistent/productionReady）`,
      });
      continue;
    }
    if (capabilities.backend.trim() === '') {
      violations.push({
        rule: 'BACKEND_NOT_DECLARED',
        token: binding.token,
        detail: `${binding.label} 的能力声明缺少 backend 标识`,
      });
      continue;
    }
    if (!isProduction) {
      continue;
    }
    if (!capabilities.persistent) {
      violations.push({
        rule: 'IN_MEMORY_BACKEND_IN_PRODUCTION',
        token: binding.token,
        detail: `${binding.label} 绑定到非持久后端（${describeCapabilities(capabilities)}）：生产环境禁止以内存存储顶替持久化`,
      });
      continue;
    }
    if (!capabilities.productionReady) {
      violations.push({
        rule: 'BACKEND_NOT_PRODUCTION_READY_IN_PRODUCTION',
        token: binding.token,
        detail: `${binding.label} 绑定到未验证后端（${describeCapabilities(capabilities)}）：生产环境禁止启用未验证数据库实现`,
      });
    }
  }

  if (isProduction && !input.databaseConfigured) {
    violations.push({
      rule: 'DATABASE_NOT_CONFIGURED_IN_PRODUCTION',
      token: 'DATABASE_CONFIG',
      detail: '生产环境未配置 DATABASE_URL：配置 fail-closed，拒绝以无数据库状态启动',
    });
  }

  // ---- SQL 执行器准入契约：只在装配提供了执行器事实时判定（没有执行器的装配不受影响） ----
  const executorVerifications = input.executorVerifications ?? [];
  const requireAttestedExecutor = input.requireAttestedExecutor === true;

  // 「数据库已配置」把执行器契约从可选变成必需：没有事实就等于无法证明执行器经过 attest。
  // 与下面的逐项判定分开计数，便于运维区分「没有执行器」和「执行器不合规」。
  if (requireAttestedExecutor && executorVerifications.length === 0) {
    violations.push({
      rule: 'SQL_EXECUTOR_VERIFICATION_REQUIRED',
      token: SQL_EXECUTOR_PORT_TOKEN,
      detail:
        '数据库已配置（DATABASE_URL）但装配没有提供任何 SQL 执行器契约事实：无法证明执行器经过 attest 且证据完整，拒绝启动',
    });
  }

  for (const executor of executorVerifications) {
    // 数据库已配置时强制打开「生产准入」判定（requireAttestation），不依赖 nodeEnv：
    // 否则 dev/test 环境的未封存执行器会通过契约，而它已经接到了真实数据库上。
    const report = evaluateSqlExecutorVerification(
      requireAttestedExecutor ? { ...executor.input, requireAttestation: true } : executor.input,
    );
    for (const item of report.violations) {
      violations.push({
        rule: 'SQL_EXECUTOR_VERIFICATION_FAILED',
        token: executor.token,
        detail: `SQL 执行器契约 ${item.code}：${item.detail}`,
        executorCode: item.code,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    checkedTokens: input.bindings.map((binding) => binding.token),
  };
}

/**
 * 断言边界成立，失败即抛 `PersistenceBoundaryError`。
 * 调用点：应用启动阶段（`services/api/src/db/persistence-boundary.service.ts`）。
 */
export function assertPersistenceBoundary(
  input: PersistenceBoundaryInput,
): PersistenceBoundaryReport {
  const report = evaluatePersistenceBoundary(input);
  if (!report.ok) {
    throw new PersistenceBoundaryError(report.violations);
  }
  return report;
}
