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
 * 4. 违规信息只包含端口名/后端名/规则，绝不包含连接串或口令。
 */

export type PersistenceViolationRule =
  | 'MISSING_CAPABILITIES'
  | 'BACKEND_NOT_DECLARED'
  | 'IN_MEMORY_BACKEND_IN_PRODUCTION'
  | 'BACKEND_NOT_PRODUCTION_READY_IN_PRODUCTION'
  | 'DATABASE_NOT_CONFIGURED_IN_PRODUCTION';

export interface PersistenceViolation {
  readonly rule: PersistenceViolationRule;
  /** 违规端口（DI 令牌的可读名，例如 `GROUP_REPOSITORY`） */
  readonly token: string;
  /** 只包含后端名与布尔能力，不含任何机密 */
  readonly detail: string;
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
