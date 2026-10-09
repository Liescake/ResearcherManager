/**
 * 运维出口脱敏门禁（`/runtime-info` 与 `/health*` 共用）。
 *
 * ## 为什么需要它
 * 两个端点的字段闭集只能约束**字段名**，挡不住「白名单字段里塞进敏感取值」：把连接串写进
 * `nodeEnv`、把主机:端口写进 `checks[].detail`、或未来新增字段时顺带带上证据引用 / SQL / 内部路径。
 * 本模块在响应离开进程前做一次只读的取值级扫描，命中即由调用方判缺陷（返回 500），
 * 与「出现白名单之外的字段即 500」保持同一种 fail-closed 姿态。
 *
 * ## 判定口径
 * - 连接串：任何 `scheme://`（`postgresql://`、`https://` 一律不进入运维响应）；
 * - 口令键值：`password=` / `token:` 这类 `键=值` 形态；
 * - SQL 语句：`select ... from` / `update ... set` 等最小可判定形态；
 * - 内部路径：Windows 盘符路径、UNC 路径、`/etc`、`/srv` 等系统路径前缀；
 * - 私钥块：`-----BEGIN ... PRIVATE KEY-----`；
 * - 证据/连接配置字段名：`evidenceId`、`readinessRef`、`verifiedAt`、`migration*`、
 *   `connectionString`、`sql*` 等 —— 这些属于内部证据，不允许出现在运维出口。
 *
 * 边界事实：只读扫描，不改写载荷、不建连接、不读磁盘；日志只写字段路径与命中类别，
 * 永不写命中取值（否则脱敏门禁自己变成泄漏点）。
 */

export type SensitiveOutputKind =
  | 'connection-string'
  | 'credential-pair'
  | 'sql-statement'
  | 'internal-path'
  | 'private-key'
  | 'evidence-field';

export interface SensitiveOutputFinding {
  /** 命中的载荷路径，例如 `data.checks[0].detail` */
  readonly path: string;
  readonly kind: SensitiveOutputKind;
}

/** 扫描深度上限：运维载荷是浅层结构，出现超深嵌套本身就是异常 */
const MAX_SCAN_DEPTH = 8;

/**
 * 字段名不允许指向内部证据 / 连接配置。
 * 注意只匹配**字段名**：`DATABASE_URL` 作为「未配置」文案出现在 detail 取值里是合法的。
 */
const EVIDENCE_FIELD_PATTERN =
  /(?:evidence|readiness|verifiedat|checkedat|migration|connectionstring|databaseurl|sql|password|passwd|secret|credential|privatekey|apikey|accesskey)/iu;

interface ValueRule {
  readonly kind: SensitiveOutputKind;
  readonly pattern: RegExp;
}

/** 取值级规则：顺序即优先级，命中的第一个类别决定报告类别 */
const VALUE_RULES: readonly ValueRule[] = [
  { kind: 'private-key', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----/u },
  { kind: 'connection-string', pattern: /[a-z][a-z0-9+.-]*:\/\//iu },
  {
    kind: 'credential-pair',
    pattern: /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\b\s*[:=]\s*\S/iu,
  },
  {
    kind: 'sql-statement',
    pattern:
      /\b(?:select|insert|update|delete|drop|alter|truncate|grant)\b[\s\S]{0,120}?\b(?:from|into|where|set|values|table)\b/iu,
  },
  {
    kind: 'internal-path',
    pattern:
      /(?:[a-z]:[\\/]|\\\\[a-z0-9._-]+\\|(?:^|[\s"'(])\/(?:etc|var|home|root|usr|opt|srv|proc|sys)\/)/iu,
  },
];

function matchValue(value: string): SensitiveOutputKind | undefined {
  const rule = VALUE_RULES.find((candidate) => candidate.pattern.test(value));
  return rule?.kind;
}

function collect(
  value: unknown,
  path: string,
  findings: SensitiveOutputFinding[],
  depth: number,
  seen: Set<object>,
): void {
  if (depth > MAX_SCAN_DEPTH) {
    findings.push({ path, kind: 'internal-path' });
    return;
  }
  if (typeof value === 'string') {
    const kind = matchValue(value);
    if (kind !== undefined) {
      findings.push({ path, kind });
    }
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, `${path}[${index}]`, findings, depth + 1, seen));
    return;
  }
  for (const key of Object.keys(value)) {
    if (EVIDENCE_FIELD_PATTERN.test(key)) {
      findings.push({ path: `${path}.${key}`, kind: 'evidence-field' });
    }
    collect((value as Record<string, unknown>)[key], `${path}.${key}`, findings, depth + 1, seen);
  }
}

/**
 * 扫描运维响应用载荷：返回全部命中项（空数组表示可以安全输出）。
 * 纯函数：不写日志、不抛错，由调用方决定 fail-closed 行为。
 */
export function findSensitiveOutput(
  payload: unknown,
  basePath = 'data',
): readonly SensitiveOutputFinding[] {
  const findings: SensitiveOutputFinding[] = [];
  collect(payload, basePath, findings, 0, new Set<object>());
  return findings;
}

/** 只写路径与类别的可日志摘要：**不含命中取值** */
export function describeSensitiveFindings(findings: readonly SensitiveOutputFinding[]): string {
  return findings.map((finding) => `${finding.path}(${finding.kind})`).join(', ');
}
