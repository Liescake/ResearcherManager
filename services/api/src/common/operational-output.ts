import { ApiErrorCode, defaultMessageForErrorCode, fail } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import {
  HEALTH_ALLOWED_FIELDS,
  HEALTH_REQUIRED_FIELDS,
  checkHealthDataAgainstContract,
  checkReadinessDataAgainstContract,
  expectedReadinessStatus,
} from '../modules/ruoyi-adapter/contract/health-contract';
import type { HealthContractIssue } from '../modules/ruoyi-adapter/contract/health-contract';
import { RUNTIME_INFO_FIELDS } from '../modules/runtime-info/runtime-info.service';
import { findSensitiveOutput, type SensitiveOutputFinding } from './sensitive-output';

/**
 * **统一运维出口契约**（readiness output contract）。
 *
 * ## 为什么需要它
 * 运维出口已经有三处各自为政的校验：health 控制器里内联的契约适配器调用、runtime-info
 * 控制器里内联的字段闭集、以及各自单独的脱敏扫描；而启动日志与统一错误响应**完全没有**
 * 同类门禁 —— 同一套「闭集 + 脱敏」规则被抄了四遍，任何一处漂移都会留下不对称的缺口
 * （例如新增一个出口时忘了脱敏，或错误响应里带出了 SQL 片段）。
 *
 * 本模块把「运维出口只输出闭集脱敏字段」收敛成**唯一一份**可判定契约，五类出口共用：
 *
 * | 出口（profile） | 载荷 | 闭集来源 |
 * | --- | --- | --- |
 * | `health` | `GET /health` 的业务数据 | 契约适配器 `health-contract.ts` |
 * | `readiness` | `GET /health/ready` 的业务数据 | 同上（含 `ready ⇔ 全部 ok` 一致性） |
 * | `runtimeInfo` | `GET /runtime-info` 的业务数据 | `RUNTIME_INFO_FIELDS` |
 * | `apiError` | 统一错误信封 `{ data, meta, error }` | 本模块（错误体闭集） |
 * | `startupLog` | 启动配置摘要（`describeEnv`） | 本模块（与运维摘要同口径的子集） |
 *
 * ## 判定口径（四类结论，全部只描述规则、不含取值）
 * - `missing` / `unexpected`：闭集字段缺失或越界（结构缺陷）；
 * - `invalid`：契约适配器的字段级/取值级违规与跨字段一致性违规；
 * - `sensitive`：`common/sensitive-output.ts` 的取值级脱敏命中（连接串、口令、SQL、证据 ID、
 *   内部路径、owner/user ID、provider 名称、原始异常）。
 *
 * ## 边界事实
 * - 纯判定 / 纯渲染：不读环境变量、不建连接、不读磁盘、不写日志；
 * - 不改写**业务**响应：只有运维出口与错误信封经过本模块；
 * - 违规信息只含字段路径与类别，**永不包含命中取值**（否则门禁自己成为泄漏点）。
 */

export type OperationalOutputProfile =
  'health' | 'readiness' | 'runtimeInfo' | 'apiError' | 'startupLog';

export type OperationalOutputIssueKind = 'missing' | 'unexpected' | 'invalid' | 'sensitive';

export interface OperationalOutputIssue {
  readonly kind: OperationalOutputIssueKind;
  /** 命中的载荷路径，例如 `data.checks[1].detail` / `error.message` */
  readonly path: string;
  /** 规则描述（**绝不包含取值**） */
  readonly detail: string;
}

/**
 * 闭集 schema：某一层允许/必需出现的字段名。
 * `children` 只描述**契约关心的嵌套层**（数组按元素套用同一 schema），
 * 未登记的子键（例如 `error.details`）不做结构性递归，但仍会被取值级脱敏扫描覆盖。
 */
export interface OperationalOutputSchema {
  readonly required: readonly string[];
  readonly allowed: readonly string[];
  readonly children?: Readonly<Record<string, OperationalOutputSchema>>;
}

/** 启动配置摘要允许输出的字段（与 `/runtime-info` 同口径，去掉只有 HTTP 出口才需要的档位） */
export const STARTUP_LOG_FIELDS = [
  'nodeEnv',
  'apiPort',
  'apiPrefix',
  'databaseConfigured',
  'aiProvider',
  'aiMatchingEnabled',
] as const;

const READINESS_CHECK_SCHEMA: OperationalOutputSchema = {
  required: HEALTH_REQUIRED_FIELDS.ReadinessCheck ?? [],
  allowed: HEALTH_ALLOWED_FIELDS.ReadinessCheck ?? [],
};

/**
 * 错误信封闭集：顶层恰好 `{ data, meta, error }`（`data` 必须为 null），
 * `meta` 恰好 `{ requestId }`，`error` 至少含 `code`/`message`，最多再带 `requestId`/`details`。
 * `details` 不做结构闭集（它的形状由错误码决定），但一定经过取值级脱敏扫描。
 */
const API_ERROR_SCHEMA: OperationalOutputSchema = {
  required: ['data', 'meta', 'error'],
  allowed: ['data', 'meta', 'error'],
  children: {
    meta: { required: ['requestId'], allowed: ['requestId'] },
    error: {
      required: ['code', 'message'],
      allowed: ['code', 'message', 'requestId', 'details'],
    },
  },
};

export const OPERATIONAL_OUTPUT_SCHEMAS: Readonly<
  Record<OperationalOutputProfile, OperationalOutputSchema>
> = {
  health: {
    required: HEALTH_REQUIRED_FIELDS.HealthData ?? [],
    allowed: HEALTH_ALLOWED_FIELDS.HealthData ?? [],
  },
  readiness: {
    required: HEALTH_REQUIRED_FIELDS.ReadinessData ?? [],
    allowed: HEALTH_ALLOWED_FIELDS.ReadinessData ?? [],
    children: { checks: READINESS_CHECK_SCHEMA },
  },
  runtimeInfo: { required: RUNTIME_INFO_FIELDS, allowed: RUNTIME_INFO_FIELDS },
  apiError: API_ERROR_SCHEMA,
  startupLog: { required: STARTUP_LOG_FIELDS, allowed: STARTUP_LOG_FIELDS },
};

export class OperationalOutputViolationError extends Error {
  readonly profile: OperationalOutputProfile;
  readonly issues: readonly OperationalOutputIssue[];

  constructor(profile: OperationalOutputProfile, issues: readonly OperationalOutputIssue[]) {
    super(`运维出口契约拒绝（${profile}，${issues.length} 项）`);
    this.name = 'OperationalOutputViolationError';
    this.profile = profile;
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 闭集判定：必需字段缺失、以及闭集之外的字段（越界）都算问题 */
function collectClosureIssues(
  value: unknown,
  schema: OperationalOutputSchema,
  base: string,
  issues: OperationalOutputIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ kind: 'invalid', path: base, detail: '必须是对象（闭集字段无法判定）' });
    return;
  }
  const keys = Object.keys(value);
  for (const field of schema.required) {
    if (!keys.includes(field)) {
      issues.push({ kind: 'missing', path: `${base}.${field}`, detail: '缺少闭集字段' });
    }
  }
  for (const key of keys) {
    if (!schema.allowed.includes(key)) {
      issues.push({ kind: 'unexpected', path: `${base}.${key}`, detail: '闭集之外的字段' });
    }
  }
  for (const [key, child] of Object.entries(schema.children ?? {})) {
    if (!keys.includes(key)) {
      continue; // 缺失已由 required 判定（未列为 required 的嵌套层不强制存在）
    }
    const nested = value[key];
    if (Array.isArray(nested)) {
      nested.forEach((item, index) =>
        collectClosureIssues(item, child, `${base}.${key}[${index}]`, issues),
      );
      continue;
    }
    collectClosureIssues(nested, child, `${base}.${key}`, issues);
  }
}

/** 契约适配器的字段级违规 → 统一违规形状（路径与规则描述，不含取值） */
function fromContractIssues(issues: readonly HealthContractIssue[]): OperationalOutputIssue[] {
  return issues.map((issue) => ({
    kind: 'invalid',
    path: issue.path,
    detail: issue.message,
  }));
}

function fromSensitiveFindings(
  findings: readonly SensitiveOutputFinding[],
): OperationalOutputIssue[] {
  return findings.map((finding) => ({
    kind: 'sensitive',
    path: finding.path,
    detail: `脱敏规则命中（${finding.kind}）`,
  }));
}

/** `apiError` 的结构与一致性判定：错误信封必须自洽，而不是「恰好长得像信封」 */
function collectApiErrorIssues(
  payload: unknown,
  base: string,
  issues: OperationalOutputIssue[],
): void {
  if (!isRecord(payload)) {
    return;
  }
  if (payload['data'] !== null) {
    issues.push({ kind: 'invalid', path: `${base}.data`, detail: '错误响应的 data 必须是 null' });
  }
  const error = payload['error'];
  if (!isRecord(error)) {
    return;
  }
  if (typeof error['code'] !== 'string' || error['code'] === '') {
    issues.push({
      kind: 'invalid',
      path: `${base}.error.code`,
      detail: '错误码必须是非空字符串',
    });
  }
  if (typeof error['message'] !== 'string' || error['message'].trim() === '') {
    issues.push({
      kind: 'invalid',
      path: `${base}.error.message`,
      detail: 'message 必须是非空字符串',
    });
  }
  const meta = payload['meta'];
  const metaRequestId = isRecord(meta) ? meta['requestId'] : undefined;
  const errorRequestId = error['requestId'];
  if (errorRequestId !== undefined && errorRequestId !== metaRequestId) {
    issues.push({
      kind: 'invalid',
      path: `${base}.error.requestId`,
      detail: 'error.requestId 必须与 meta.requestId 一致',
    });
  }
}

/**
 * 判定某个运维出口是否满足统一契约：返回全部违规项（空数组表示可以安全输出）。
 * 纯函数：不写日志、不抛错，由调用方决定 fail-closed 行为。
 */
export function checkOperationalOutput(
  profile: OperationalOutputProfile,
  payload: unknown,
  // 运维数据出口以 `data` 为根（与响应信封一致）；错误信封装载的是信封本身
  basePath: string = profile === 'apiError' ? 'envelope' : 'data',
): readonly OperationalOutputIssue[] {
  const issues: OperationalOutputIssue[] = [];
  collectClosureIssues(payload, OPERATIONAL_OUTPUT_SCHEMAS[profile], basePath, issues);

  if (profile === 'health') {
    issues.push(...fromContractIssues(checkHealthDataAgainstContract(payload)));
  }
  if (profile === 'readiness') {
    const contractIssues = checkReadinessDataAgainstContract(payload);
    issues.push(...fromContractIssues(contractIssues));
    // `ready ⇔ 全部检查项为 ok`：字段级校验发现不了 status 与 checks 不一致，
    // 而这种数据同样会让调用方做出错误决策，因此只在结构合法时补一条一致性判定。
    if (contractIssues.length === 0 && isRecord(payload)) {
      const checks = payload['checks'];
      if (Array.isArray(checks) && payload['status'] !== expectedReadinessStatus(checks)) {
        issues.push({
          kind: 'invalid',
          path: 'data.status',
          detail: 'status 必须与 checks 一致（ready ⇔ 全部检查项为 ok）',
        });
      }
    }
  }
  if (profile === 'apiError') {
    collectApiErrorIssues(payload, basePath, issues);
  }

  issues.push(...fromSensitiveFindings(findSensitiveOutput(payload, basePath)));
  return issues;
}

/** 校验通过则原样返回（同一对象引用，字段与路径不变），否则抛错（fail-closed） */
export function assertOperationalOutput<T>(profile: OperationalOutputProfile, payload: T): T {
  const issues = checkOperationalOutput(profile, payload);
  if (issues.length > 0) {
    throw new OperationalOutputViolationError(profile, issues);
  }
  return payload;
}

/** 只写路径与类别的可日志摘要：**不含命中取值** */
export function describeOperationalIssues(issues: readonly OperationalOutputIssue[]): string {
  return issues.map((issue) => `${issue.path}(${issue.kind})`).join(', ');
}

/** 文本是否可安全输出（无脱敏命中）。用于单字段判定（错误文案、稳定错误码、启动失败日志兜底） */
export function isSafeOperationalText(value: unknown, basePath = 'text'): boolean {
  return findSensitiveOutput(value, basePath).length === 0;
}

/** 规范化单行日志文本：去掉换行/控制字符（防日志注入）并截断 */
export function normalizeLogText(value: string, maxLength = 300): string {
  const single = value.replace(/[\r\n\t\0]+/gu, ' ').trim();
  return single.length > maxLength ? `${single.slice(0, maxLength - 1)}…` : single;
}

/**
 * 错误响应：把任意输入**投影**成闭集脱敏错误信封。
 *
 * 语义边界（与 `api-exception.filter.ts` 的既有约定一致）：
 * - **状态码与错误码不变**：客户端按 `code` 分支，本函数从不改码；
 * - 文案安全则原样保留；命中脱敏规则则替换为该错误码的稳定默认文案（**不回显原文**）；
 * - `details` 命中脱敏规则则整体丢弃（部分保留会留下可拼接的线索）；
 * - `meta` 收敛为 `{ requestId }`，`error.requestId` 与之一致。
 */
export function projectApiErrorBody(body: ApiEnvelope<never>): ApiEnvelope<never> {
  const meta: Record<string, unknown> = isRecord(body.meta) ? body.meta : {};
  const error: Record<string, unknown> = isRecord(body.error) ? body.error : {};
  const requestId =
    typeof meta['requestId'] === 'string'
      ? meta['requestId']
      : typeof error['requestId'] === 'string'
        ? error['requestId']
        : undefined;
  const code =
    typeof error['code'] === 'string' && error['code'] !== ''
      ? error['code']
      : ApiErrorCode.InternalError;

  const fallback = fail(code, requestId === undefined ? {} : { requestId });
  const defaultMessage =
    fallback.error?.message ?? defaultMessageForErrorCode(ApiErrorCode.InternalError);

  const rawMessage = typeof error['message'] === 'string' ? error['message'] : '';
  const message =
    rawMessage !== '' && isSafeOperationalText(rawMessage, 'error.message')
      ? normalizeLogText(rawMessage, 200)
      : defaultMessage;

  const details =
    error['details'] !== undefined && isSafeOperationalText(error['details'], 'error.details')
      ? (error['details'] as Record<string, unknown>)
      : undefined;

  return {
    data: null,
    meta: requestId === undefined ? {} : { requestId },
    error: {
      code,
      message,
      ...(requestId === undefined ? {} : { requestId }),
      ...(details === undefined ? {} : { details }),
    },
  };
}

/**
 * 5xx 的**稳定**脱敏错误体：只有 `{ code: INTERNAL_ERROR, message: 默认文案, requestId }`，
 * 不带自定义 message、不带 details、不带任何内部细节。任何 5xx 出口都必须走这里。
 */
export function stableInternalErrorBody(requestId?: string): ApiEnvelope<never> {
  return projectApiErrorBody(
    fail(ApiErrorCode.InternalError, requestId === undefined ? {} : { requestId }),
  );
}

export interface OperationalLogValue {
  /** 可安全写入日志的文本（违规时是占位符，**不含**任何取值） */
  readonly text: string;
  readonly clean: boolean;
  readonly issues: readonly OperationalOutputIssue[];
}

/**
 * 渲染运维日志载荷（启动配置摘要等）：满足契约时输出 JSON，否则输出占位符。
 *
 * 为什么日志违规时**不**抛错：与 HTTP 出口不同，日志没有「返回 500」这条退路，
 * 而「因为一条日志不合规就让生产起不来」也不是本契约的目标。这里保证的是
 * **违规取值永不落盘**：调用方拿到的文本只有占位符，命中类别另行单独输出
 * （`describeOperationalIssues`，同样不含取值）。
 */
export function renderOperationalLogValue(
  profile: OperationalOutputProfile,
  payload: unknown,
): OperationalLogValue {
  const issues = checkOperationalOutput(profile, payload);
  if (issues.length === 0) {
    return { text: JSON.stringify(payload), clean: true, issues };
  }
  return { text: '<已按运维出口契约脱敏>', clean: false, issues };
}

export interface StartupBannerEnv {
  readonly API_HOST: string;
  readonly API_PORT: number;
  readonly API_PREFIX: string;
}

/**
 * 启动横幅里**被拒绝字段**的固定占位符。
 *
 * 闭集字面量：不含任何取值、不随输入变化。即使 `API_HOST` / `API_PREFIX` 被塞进连接串、
 * 凭据、内部路径或主体 ID，落盘的也只有这一个常量。
 */
export const STARTUP_BANNER_PLACEHOLDER = '<已按运维出口契约占位>';

/** 允许出现在启动横幅里的主机形态 1：IPv4 点分十进制 */
const SAFE_HOST_IPV4_PATTERN =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
/** 允许出现在启动横幅里的主机形态 2：IPv6（仅十六进制与冒号，因此不可能承载 `://`） */
const SAFE_HOST_IPV6_PATTERN = /^[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}$/u;
/** 允许出现在启动横幅里的主机形态 3：DNS 名（逐标签字母数字与连字符，闭集字符） */
const SAFE_HOST_NAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u;

/** 允许出现在启动横幅里的前缀形态：`/` 分隔的非空路径段，闭集字符表 */
const SAFE_PREFIX_PATTERN = /^(?:\/[A-Za-z0-9._~-]+)+$/u;

/**
 * 主机字段的闭集投影：只有「形态合法**且**脱敏扫描零命中」的取值才原样输出，否则占位。
 *
 * 两道判定缺一不可：
 * 1. 形态闭集挡住连接串 / 凭据 / 盘符路径 —— 含 `:`、`/`、`@`、`\`、空格的取值根本不满足形态；
 * 2. 脱敏扫描挡住「形态上像主机名、语义上是主体 ID / provider 品牌」的取值（`u-student-1`、`openai`）。
 *
 * 入参按不可信处理：类型不是字符串或超长一律占位，绝不回显取值。
 */
function projectStartupHost(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    return STARTUP_BANNER_PLACEHOLDER;
  }
  const shaped =
    SAFE_HOST_IPV4_PATTERN.test(value) ||
    SAFE_HOST_IPV6_PATTERN.test(value) ||
    SAFE_HOST_NAME_PATTERN.test(value);
  if (!shaped || findSensitiveOutput(value, 'API_HOST').length > 0) {
    return STARTUP_BANNER_PLACEHOLDER;
  }
  return value;
}

/** 端口字段的闭集投影：只接受 0..65535 的整数；NaN / Infinity / 越界 / 非数字一律占位 */
function projectStartupPort(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535
    ? String(value)
    : STARTUP_BANNER_PLACEHOLDER;
}

/** 前缀字段的闭集投影：闭集形态 + 无 `.` / `..` 段 + 脱敏零命中，任一不满足即占位 */
function projectStartupPrefix(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) {
    return STARTUP_BANNER_PLACEHOLDER;
  }
  const normalized = value === '' ? '/' : value;
  const segments = normalized.split('/').filter((segment) => segment !== '');
  if (normalized !== '/') {
    const traversal = segments.some((segment) => segment === '.' || segment === '..');
    if (!SAFE_PREFIX_PATTERN.test(normalized) || traversal) {
      return STARTUP_BANNER_PLACEHOLDER;
    }
  }
  // 整串扫描（内部路径 `/etc/…` 等）与逐段扫描（`/u-student-1` 这类主体 ID 段，
  // 其主体 ID 字面量的边界字符是 `/`，只有把段单独拿出来才落在规则起点上）都要做
  const sensitive =
    findSensitiveOutput(normalized, 'API_PREFIX').length > 0 ||
    segments.some((segment) => findSensitiveOutput(segment, 'API_PREFIX').length > 0);
  return sensitive ? STARTUP_BANNER_PLACEHOLDER : normalized;
}

/**
 * 启动横幅（监听与探针路径日志行）。
 *
 * 硬约束一：**不写 `scheme://`**。契约拒绝任何连接串形态（`postgresql://`、`https://`），
 * 而 `http://host:port` 与该形态在字面上无法区分 —— 监听地址因此只写 `host:port` 与路径，
 * 排障所需的信息（绑定地址、端口、前缀）一个不少。
 *
 * 硬约束二：**每个字段先过闭集投影再拼接**。`API_HOST` / `API_PREFIX` 的配置校验
 * （`config/env.ts`）只保证「非空」与「以 `/` 开头」，它们仍可能承载任意文本；本函数不信任
 * 入参，逐字段走 `projectStartupHost` / `projectStartupPort` / `projectStartupPrefix`，
 * 被拒绝的字段只输出固定占位符（**绝不回显取值**）。
 *
 * 最后对整行再做一次脱敏兜底扫描：只要有任何命中，横幅整体退化为固定安全行。
 */
export function describeStartupBanner(env: StartupBannerEnv): readonly string[] {
  const host = projectStartupHost(env.API_HOST);
  const port = projectStartupPort(env.API_PORT);
  const prefix = projectStartupPrefix(env.API_PREFIX);
  // IPv6 字面量带冒号，`::1:3000` 无法区分「地址 + 端口」，因此只在有歧义时加方括号
  const renderedHost = host.includes(':') ? `[${host}]` : host;
  // 空前缀归一为 `/`：探针路径不能拼成 `//health`（协议相对形态，看起来像连接串）
  const healthPath = prefix === '/' ? '/health' : `${prefix}/health`;
  const lines = [
    `服务已启动: 监听 ${renderedHost}:${port}，前缀 ${prefix}`,
    `健康检查路径: ${healthPath}`,
  ];
  // 不把已验证的 host + port 再拼回字符串交给裸 host:port 规则扫描：
  // 该规则必须继续拦截普通输出中的内部拓扑，但监听地址本身是本函数的安全投影。
  // 仍逐片扫描固定文案与投影字段，避免未来新增固定片段时绕过门禁。
  const bannerFragments = [
    '服务已启动: 监听 ',
    renderedHost,
    port,
    '，前缀 ',
    prefix,
    '健康检查路径: ',
    healthPath,
  ];
  if (
    bannerFragments.some((fragment) => findSensitiveOutput(fragment, 'startupBanner').length > 0)
  ) {
    return [`服务已启动: ${STARTUP_BANNER_PLACEHOLDER}`];
  }
  return lines;
}

/** 未登记异常类名的固定占位符（闭集字面量，绝不含原始 `error.name`） */
export const STARTUP_ERROR_NAME_PLACEHOLDER = '<未登记异常类名>';

/** 启动失败日志里原始异常文本的固定替代文案（闭集字面量，绝不含 `error.message`） */
export const STARTUP_FAILURE_TEXT_PLACEHOLDER = '<已按运维出口契约省略原始异常文本>';

/**
 * 启动失败日志允许原样输出的异常类名**闭集**（明确登记，唯一的放行来源）。
 *
 * 为什么是「登记闭集」而不是「形态规则」：`error.name` 是**可写**字段，任何构造点都能把它
 * 改成任意文本。形态规则（例如「ASCII 字母开头 + 字母数字」）只能挡住连接串、盘符路径这类
 * 带标点 / 空格的伪装名，挡不住**形态合法但从未登记**的名称 —— `EvilName`、`InjectedError`
 * 这类任意 ASCII 名称会原样落进日志。放行面必须收窄到一个可枚举、可评审的名单：
 * 只有本名单里的字面量才原样输出，其余（含空串、非字符串、getter 抛错）一律固定占位符。
 *
 * 新增异常类时必须在同一次改动里登记本名单，否则启动失败日志只会显示占位符 ——
 * 这是安全侧默认（少一条可读信息，而不是多一条未知取值）。
 *
 * 有意**不**登记 NestJS 内部异常名：它们随框架版本漂移，且不是本仓库可评审的契约面。
 */
export const REGISTERED_ERROR_NAMES = [
  // JavaScript 内置（启动期最常见的抛出者）
  'AggregateError',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  // 本仓库登记的结构化异常（构造函数里写入 name 的赋值点）
  'ApplicationReviewConflictError',
  'ApplicationReviewRejectedError',
  'DatabaseConfigError',
  'DatabaseUnavailableError',
  'DependencyReadinessError',
  'InMemoryMatchingRepositoryError',
  'MigrationBoundaryError',
  'MigrationDeploymentGuardError',
  'MigrationRunnerError',
  'OperationalOutputViolationError',
  'PersistenceBoundaryError',
  'PostgresAchievementRepositoryError',
  'PostgresAdapterBoundaryError',
  'PostgresApplicationRepositoryError',
  'PostgresAuditRepositoryError',
  'PostgresComplianceRepositoryError',
  'PostgresEducationRecordRepositoryError',
  'PostgresExecutorError',
  'PostgresExportRepositoryError',
  'PostgresGroupRepositoryError',
  'PostgresMatchingRepositoryError',
  'PostgresNotificationRepositoryError',
  'PostgresSessionStoreError',
  'PostgresStatisticsRepositoryError',
  'PostgresStudentProfileRepositoryError',
  'SchemaDraftError',
  'SqlExecutorVerificationError',
  'SqlParameterSlotError',
] as const;

const REGISTERED_ERROR_NAME_SET: ReadonlySet<string> = new Set(REGISTERED_ERROR_NAMES);

/**
 * 异常类名投影：**绝不原样记录 `error.name`**。
 *
 * 判定只有一条：取值**逐字等于**登记闭集 `REGISTERED_ERROR_NAMES` 里的某个字面量才原样输出
 * （因为相等，输出等价于该登记字面量），否则输出固定占位符 `STARTUP_ERROR_NAME_PLACEHOLDER`。
 * 形态合法但未登记的 `EvilName` / `InjectedError` 同样占位 —— 放行面由名单决定，而不是由形状
 * 决定；敏感扫描因此在类名路径上不再是唯一防线。
 *
 * 非 `Error` 的抛出值不读取任何属性，只写 `typeof`（`typeof` 的结果本身是固定枚举，不含取值）；
 * 属性读取本身也按不可信处理（getter 抛错时同样占位，绝不让排障日志自己成为崩溃点或泄漏点）。
 */
function projectErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return error === undefined ? 'undefined' : typeof error;
  }
  try {
    const raw: unknown = error.name;
    return typeof raw === 'string' && REGISTERED_ERROR_NAME_SET.has(raw)
      ? raw
      : STARTUP_ERROR_NAME_PLACEHOLDER;
  } catch {
    return STARTUP_ERROR_NAME_PLACEHOLDER;
  }
}

/** 稳定错误码的形态闭集：大写字母开头 + 大写字母 / 数字 / 下划线（长度 ≤ 64） */
const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

/**
 * 从异常对象上读取稳定的机器可判 `code`（**形态闭集 + 脱敏扫描都通过**时才回传）。
 *
 * `code` 同样出自可写属性：若只做长度与脱敏判定，`{ code: 'internal-token-abcdef' }`
 * 这类「形状自由、恰好不含脱敏命中」的取值就能借 `code` 通道落进日志。因此这里要求它
 * 满足错误码的**形态闭集**（大写蛇形），把自由文本排除在外；不满足即视为无码。
 */
function readStableCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  try {
    const code = error['code'];
    if (typeof code !== 'string' || !STABLE_ERROR_CODE_PATTERN.test(code)) {
      return undefined;
    }
    return isSafeOperationalText(code, 'error.code') ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 启动失败日志：**拒绝原始异常**。
 *
 * 口径（两条都是「不看内容」的闭集判定，因此不存在「文本看着不敏感就放行」的窗口）：
 * 1. 异常类名先过 `projectErrorName` 的**登记闭集**投影 —— 未登记（含 `EvilName` 这类
 *    形态合法的任意 ASCII 名）一律固定占位符，绝不原样记录 `error.name`；
 * 2. `error.message` **永不输出**（连读取都不需要）：即使文本里没有任何脱敏命中，也只写固定
 *    安全文案 `STARTUP_FAILURE_TEXT_PLACEHOLDER`。原始异常文本是自由文本，脱敏规则只能做
 *    「已登记敏感形态」的黑名单，挡不住未知形态的口令、主体信息与业务数据。
 *
 * 保留的**稳定分类**只有两样：已登记的异常类名，以及满足形态闭集且脱敏零命中的 `error.code`；
 * 排障据此定位规则，而不是把异常原文抄进日志。最后对整行再做一次脱敏兜底：只要有任何命中，
 * 整行退化为固定安全占位。
 */
export function describeStartupFailure(error: unknown): string {
  const name = projectErrorName(error);
  const code = readStableCode(error);
  const label = code === undefined ? name : `${name}(${code})`;
  const rendered = `启动失败: ${label}: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`;

  return isSafeOperationalText(rendered, 'startupFailure')
    ? rendered
    : `启动失败: ${STARTUP_ERROR_NAME_PLACEHOLDER}`;
}
