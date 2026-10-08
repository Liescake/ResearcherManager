/**
 * 健康探针契约适配器（services/ruoyi-api → services/api 边界）。
 *
 * 单一事实来源：`services/ruoyi-api/contracts/health.openapi.yaml`（`x-boundary.slice = health`）。
 *
 * 本文件**不解析 YAML**，也不复制契约里的任何文案或示例；它只声明「运行时响应必须满足的
 * 字段与取值约束」，供契约测试断言 NestJS 实际响应。契约仍是唯一事实来源，校验也不需要
 * 为仓库引入 YAML 依赖（services/api 的运行期依赖保持为零新增）。
 *
 * 边界约束：本文件是只读适配器——它不修改 services/api 的运行时行为，也不改动
 * services/ruoyi-api/contracts 的任何契约文件。
 */

/** 契约版本：必须等于 health.openapi.yaml 的 info.version 与 x-boundary.contractsVersion */
export const HEALTH_CONTRACT_VERSION = '0.1.0';

/** 契约声明的边界标识 */
export const HEALTH_CONTRACT_MODULE = 'ruoyi-api';
export const HEALTH_CONTRACT_SLICE = 'health';

/** 相对仓库根；仓库根按「同时存在 package.json 与 pnpm-workspace.yaml」判定 */
export const HEALTH_CONTRACT_RELATIVE_PATH = 'services/ruoyi-api/contracts/health.openapi.yaml';

/**
 * schema 名 → 允许出现的属性名（对应契约的 additionalProperties: false）。
 * 这是**结构契约**，不是文案副本：契约新增字段时本表必须同步，否则契约测试失败。
 */
export const HEALTH_ALLOWED_FIELDS: Record<string, readonly string[]> = {
  HealthData: ['status', 'service', 'version', 'uptimeSeconds', 'timestamp', 'prefix'],
  ReadinessData: ['status', 'checks'],
  ReadinessCheck: ['name', 'status', 'detail'],
};

/**
 * schema 名 → 契约 `required` 声明的字段。
 * 与上面分开是必要的：`detail` 允许出现但不是必需（契约 required 只列 name/status），
 * 把可选字段当必需会让合法的 ready 响应被误判为不合规。
 */
export const HEALTH_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  HealthData: ['status', 'service', 'version', 'uptimeSeconds', 'timestamp', 'prefix'],
  ReadinessData: ['status', 'checks'],
  ReadinessCheck: ['name', 'status'],
};

export const HEALTH_STATUS_VALUES = ['ok'] as const;
export const HEALTH_PREFIX_PATTERN = /^\//u;
export const HEALTH_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
export const HEALTH_READINESS_STATUS_VALUES = ['ready', 'degraded'] as const;

/**
 * 就绪检查项名称是**闭集**：契约对 ReadinessCheck.name 使用 enum，
 * 因此新增巡检项必须先改契约，再改实现。
 */
export const HEALTH_READINESS_CHECK_NAMES = ['database', 'sessionSecret', 'aiMatching'] as const;
export const HEALTH_READINESS_CHECK_STATUS_VALUES = ['ok', 'not_configured', 'degraded'] as const;

export type HealthReadinessCheckName = (typeof HEALTH_READINESS_CHECK_NAMES)[number];
export type HealthReadinessCheckStatus = (typeof HEALTH_READINESS_CHECK_STATUS_VALUES)[number];

export type HealthContractIssueKind = 'missing' | 'unexpected' | 'invalid';

export interface HealthContractIssue {
  kind: HealthContractIssueKind;
  path: string;
  message: string;
}

export interface ReadinessContractCheck {
  name: unknown;
  status: unknown;
  detail?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/**
 * 字段是否存在于响应中。
 *
 * 缺失判定（`missing`）与取值校验（`invalid`）必须共用同一个谓词：两者一旦不一致，
 * 同一个字段要么被记成两条互相矛盾的结论（既 missing 又 invalid），要么在存在性上
 * 各判一半而两边都跳过，让不合规响应静默通过（fail-open）。所以判定收敛到唯一入口。
 */
function hasField(data: Record<string, unknown>, field: string): boolean {
  return field in data;
}

function collectShapeIssues(
  data: Record<string, unknown>,
  base: string,
  required: readonly string[],
  allowed: readonly string[],
  issues: HealthContractIssue[],
): void {
  for (const field of required) {
    if (!hasField(data, field)) {
      issues.push({ kind: 'missing', path: `${base}.${field}`, message: '缺少必需字段' });
    }
  }
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) {
      issues.push({ kind: 'unexpected', path: `${base}.${key}`, message: '契约未声明该字段' });
    }
  }
}

/** 取 schema 的允许/必需字段表；缺失时按空表处理（契约测试会先暴露表未同步） */
function fieldsFor(schema: string): { required: readonly string[]; allowed: readonly string[] } {
  return {
    required: HEALTH_REQUIRED_FIELDS[schema] ?? [],
    allowed: HEALTH_ALLOWED_FIELDS[schema] ?? [],
  };
}

/**
 * 校验 `/health` 的业务数据。
 * 只检查契约声明的约束；不检查 service 的具体取值，避免把实现细节（服务名）固化为契约。
 */
export function checkHealthDataAgainstContract(data: unknown): HealthContractIssue[] {
  const issues: HealthContractIssue[] = [];
  if (!isRecord(data)) {
    return [{ kind: 'invalid', path: 'data', message: 'data 必须是对象' }];
  }

  const healthFields = fieldsFor('HealthData');
  collectShapeIssues(data, 'data', healthFields.required, healthFields.allowed, issues);

  // 每个必需字段只产出一条结论：缺失由 collectShapeIssues 记 missing，存在才校验取值。
  if (
    hasField(data, 'status') &&
    !(HEALTH_STATUS_VALUES as readonly unknown[]).includes(data.status)
  ) {
    issues.push({
      kind: 'invalid',
      path: 'data.status',
      message: `status 必须是 ${HEALTH_STATUS_VALUES.join('|')}`,
    });
  }
  if (
    hasField(data, 'service') &&
    (typeof data.service !== 'string' || data.service.length === 0)
  ) {
    issues.push({ kind: 'invalid', path: 'data.service', message: 'service 必须是非空字符串' });
  }
  if (
    hasField(data, 'version') &&
    (typeof data.version !== 'string' || !HEALTH_VERSION_PATTERN.test(data.version))
  ) {
    issues.push({ kind: 'invalid', path: 'data.version', message: 'version 必须是 semver' });
  }
  if (
    hasField(data, 'uptimeSeconds') &&
    (typeof data.uptimeSeconds !== 'number' ||
      !Number.isInteger(data.uptimeSeconds) ||
      data.uptimeSeconds < 0)
  ) {
    issues.push({
      kind: 'invalid',
      path: 'data.uptimeSeconds',
      message: 'uptimeSeconds 必须是非负整数',
    });
  }
  if (hasField(data, 'timestamp') && !isIsoTimestamp(data.timestamp)) {
    issues.push({
      kind: 'invalid',
      path: 'data.timestamp',
      message: 'timestamp 必须是 ISO date-time',
    });
  }
  if (
    hasField(data, 'prefix') &&
    (typeof data.prefix !== 'string' || !HEALTH_PREFIX_PATTERN.test(data.prefix))
  ) {
    issues.push({ kind: 'invalid', path: 'data.prefix', message: 'prefix 必须以 / 开头' });
  }

  return issues;
}

/**
 * 校验 `/health/ready` 的业务数据。
 * `degraded` 是业务事实而不是传输失败，因此只做字段级校验，不在这里决定 HTTP 状态码。
 */
export function checkReadinessDataAgainstContract(data: unknown): HealthContractIssue[] {
  const issues: HealthContractIssue[] = [];
  if (!isRecord(data)) {
    return [{ kind: 'invalid', path: 'data', message: 'data 必须是对象' }];
  }

  const readinessFields = fieldsFor('ReadinessData');
  collectShapeIssues(data, 'data', readinessFields.required, readinessFields.allowed, issues);

  if (
    hasField(data, 'status') &&
    !(HEALTH_READINESS_STATUS_VALUES as readonly unknown[]).includes(data.status)
  ) {
    issues.push({
      kind: 'invalid',
      path: 'data.status',
      message: `status 必须是 ${HEALTH_READINESS_STATUS_VALUES.join('|')}`,
    });
  }

  // checks 缺失时上面已记 missing，这里不再补一条 invalid：同一路径只留一条结论。
  if (!hasField(data, 'checks')) {
    return issues;
  }
  const checks = data.checks;
  if (!Array.isArray(checks) || checks.length === 0) {
    issues.push({ kind: 'invalid', path: 'data.checks', message: 'checks 必须是非空数组' });
    return issues;
  }

  const checkFields = fieldsFor('ReadinessCheck');
  const checkNames = new Set<string>(HEALTH_READINESS_CHECK_NAMES);
  checks.forEach((rawCheck: unknown, index: number) => {
    const base = `data.checks[${index}]`;
    if (!isRecord(rawCheck)) {
      issues.push({ kind: 'invalid', path: base, message: '检查项必须是对象' });
      return;
    }
    collectShapeIssues(rawCheck, base, checkFields.required, checkFields.allowed, issues);

    if (
      hasField(rawCheck, 'name') &&
      (typeof rawCheck.name !== 'string' || !checkNames.has(rawCheck.name))
    ) {
      issues.push({
        kind: 'invalid',
        path: `${base}.name`,
        message: `name 必须是 ${HEALTH_READINESS_CHECK_NAMES.join('|')} 之一`,
      });
    }
    if (
      hasField(rawCheck, 'status') &&
      !(HEALTH_READINESS_CHECK_STATUS_VALUES as readonly unknown[]).includes(rawCheck.status)
    ) {
      issues.push({
        kind: 'invalid',
        path: `${base}.status`,
        message: `status 必须是 ${HEALTH_READINESS_CHECK_STATUS_VALUES.join('|')}`,
      });
    }
    // detail 是可选字段：缺失不算问题，出现但类型不符才算。
    if (hasField(rawCheck, 'detail') && typeof rawCheck.detail !== 'string') {
      issues.push({ kind: 'invalid', path: `${base}.detail`, message: 'detail 必须是字符串' });
    }
  });

  return issues;
}

/**
 * 契约一致性规则：`ready` 当且仅当所有检查项都是 ok（见契约 §6：degraded 是业务事实）。
 * 返回期望的 status，供测试与服务实现比对。
 */
export function expectedReadinessStatus(
  checks: readonly ReadinessContractCheck[],
): 'ready' | 'degraded' {
  return checks.every((check) => check.status === 'ok') ? 'ready' : 'degraded';
}
