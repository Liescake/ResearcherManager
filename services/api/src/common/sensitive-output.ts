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
 *   `connectionString`、`sql*` 等 —— 这些属于内部证据，不允许出现在运维出口；
 * - owner / user 标识：`ownerId` / `userId` / `ownerUserId` 等**字段名**（camelCase 与
 *   snake_case），以及 `u-student-1` 这类主体 ID 字面量 —— 运维出口只回答「是否配置」，
 *   不回答「是谁」；
 * - provider 名称：真实第三方模型 / 云厂商品牌（OpenAI、Anthropic、Gemini、DeepSeek…）
 *   与模型族标识（`gpt-*`）一律不出现在运维出口；本项目自己的枚举取值（`mock` /
 *   `http-json` / `disabled`）属于脱敏事实，不在拒绝之列；
 * - 原始异常：堆栈帧、`node_modules` / `node:internal` 路径、`Error: …` 形态的异常文本，
 *   以及 `stack` / `stackTrace` / `exception` / `cause` 这类**字段名** —— 原始异常属于内部细节，
 *   出口只允许稳定错误码与安全文案。
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
  | 'evidence-field'
  | 'owner-id'
  | 'provider-name'
  | 'raw-exception';

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
 * 复合词允许 `_` / `-` 分隔（`DATABASE_URL`、`connectionString`、`api_key` 同族）。
 */
const EVIDENCE_FIELD_PATTERN =
  /(?:evidence|readiness|verified[_-]?at|checked[_-]?at|migration|connection[_-]?string|database[_-]?url|sql|password|passwd|secret|credential|private[_-]?key|api[_-]?key|access[_-]?key)/iu;

/**
 * owner / user 标识字段名（camelCase 与 snake_case）。
 *
 * 只匹配「以 id/ids 结尾且指代主体」的字段名，因此 `sessionSecret`、`memberRole`、
 * `roles` 这类字段不会被误判；`ownerUserId` / `reviewedByUserId` / `targetUserId` 等
 * 派生写法同样命中。
 */
const OWNER_ID_FIELD_PATTERN =
  /(?:^|[_-])(?:owner|actor|leader|reviewer|reviewed_?by|created_?by|updated_?by|deleted_?by|target|subject|member)?[_-]?user[_-]?ids?$|(?:^|[_-])owner[_-]?ids?$/iu;

/** 原始异常字段名：堆栈与异常对象本体绝不进入运维出口 */
const RAW_EXCEPTION_FIELD_PATTERN =
  /^(?:stack|stacktrace|stack_trace|exception|exceptiondetail|errordetail|cause)$/iu;

interface FieldRule {
  readonly kind: SensitiveOutputKind;
  readonly pattern: RegExp;
}

/** 字段名级规则：命中即标记该路径（并与取值级规则并行判定） */
const DENIED_FIELD_RULES: readonly FieldRule[] = [
  { kind: 'evidence-field', pattern: EVIDENCE_FIELD_PATTERN },
  { kind: 'owner-id', pattern: OWNER_ID_FIELD_PATTERN },
  { kind: 'raw-exception', pattern: RAW_EXCEPTION_FIELD_PATTERN },
];

/**
 * 原始异常的取值形态：堆栈帧、依赖目录路径，或 `TypeError: …` 这类异常文本。
 * `describeError()` 只写异常**类名**、不带冒号，因此不会被本规则误伤。
 */
const RAW_EXCEPTION_VALUE_PATTERN =
  /(?:^|\n)\s*at\s+\S|\bnode_modules[\\/]|\bnode:internal[\\/]|^[A-Za-z]*Error\s*:/mu;

/**
 * provider 名称：真实第三方模型 / 云厂商品牌与模型族标识。
 * 刻意**不**包含本项目自己的 provider 枚举（`mock` / `http-json` / `disabled`），
 * 它们是脱敏事实而不是供应商身份。
 */
const PROVIDER_NAME_PATTERN =
  /\b(?:openai|anthropic|claude|gemini|deepseek|cohere|mistral|mixtral|llama|bedrock|vertex|azure|ollama|groq|openrouter|perplexity|moonshot|kimi|zhipu|glm|ernie|doubao|volcengine|hunyuan|minimax|stepfun|siliconflow|sensenova|sparkdesk|baichuan|qwen|tongyi|gpt|chatglm)\b/iu;

/**
 * owner / user 标识字面量：会话主体基线形如 `u-student-1`。
 * 只在明确的边界字符之后判定，避免把普通英文词里的 `u-` 片段当成 ID。
 */
const OWNER_ID_VALUE_PATTERN =
  /(?:^|[\s"'(=:,[])(?:u|usr|actor|owner|leader|reviewer)-[a-z0-9][a-z0-9_-]{2,}/u;

interface ValueRule {
  readonly kind: SensitiveOutputKind;
  readonly pattern: RegExp;
}

/** 取值级规则：顺序即优先级，命中的第一个类别决定报告类别 */
const VALUE_RULES: readonly ValueRule[] = [
  { kind: 'private-key', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----/u },
  { kind: 'raw-exception', pattern: RAW_EXCEPTION_VALUE_PATTERN },
  { kind: 'connection-string', pattern: /[a-z][a-z0-9+.-]*:\/\//iu },
  {
    // 裸 host:port 也是内部拓扑信息；仅在主机名/IPv4 形态成立时命中，避免误伤 ISO 时间戳。
    kind: 'internal-path',
    pattern:
      /(?:\b(?:\d{1,3}\.){3}\d{1,3}|\blocalhost\b|\b[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::\d{1,5})\b/iu,
  },
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
  { kind: 'provider-name', pattern: PROVIDER_NAME_PATTERN },
  { kind: 'owner-id', pattern: OWNER_ID_VALUE_PATTERN },
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
    for (const rule of DENIED_FIELD_RULES) {
      if (rule.pattern.test(key)) {
        findings.push({ path: `${path}.${key}`, kind: rule.kind });
      }
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
