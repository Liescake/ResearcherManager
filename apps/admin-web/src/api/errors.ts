import { ApiErrorCode } from '@rm/shared';
import { ApiClientError, INVALID_BASE_URL_CODE, INVALID_RESPONSE_CODE } from './client';

/**
 * 界面错误模型：把「客户端异常 / 后端稳定错误码 / HTTP 状态」统一收敛成可编程分支的 `kind`。
 *
 * 为什么要有这一层：页面不应该散落 `error.code === 'FORBIDDEN'` 这类字符串判断，
 * 也不应该解析 message。`kind` 是界面唯一分支依据：
 * - `unauthorized` → 清空会话并跳登录（401 的**唯一**处理方式）；
 * - `forbidden` → 页面级「无权限」面板（不跳转、不登出）；
 * - `not-found` → 空态或「端点未实现」提示（由 API 边界描述符决定语义）；
 * - 其余 → 「错误 + 重试」面板。
 */
export type UiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'rate-limited'
  | 'validation'
  | 'network'
  | 'timeout'
  | 'server'
  /** 503：服务或其后端依赖暂时不可用（可稍后重试），与 500 的服务端缺陷区分开 */
  | 'service-unavailable'
  /** 响应不符合统一信封契约（HTTP 层可能还是 200）：不是「成功」，也不是普通故障 */
  | 'contract'
  /** 前端构建期配置错误（例：API 基地址非法），请求根本没有发出 */
  | 'configuration'
  | 'unknown';

export interface UiError {
  kind: UiErrorKind;
  /** 稳定错误码（后端 code，或客户端合成码 `NETWORK_ERROR` / `HTTP_404` 等） */
  code: string;
  /** 用户安全消息：不包含内部堆栈、不含资源存在性信息 */
  message: string;
  status?: number;
  requestId?: string;
  /** 触发该错误的 API 边界（`METHOD /path`），用于排障与「端点未实现」提示 */
  endpoint?: string;
}

/** 非 API 客户端异常的固定安全文案；不得把原始异常文本带入用户界面。 */
export const UNEXPECTED_ERROR_MESSAGE = '发生未预期错误，请稍后重试。';

const CODE_TO_KIND: Readonly<Record<string, UiErrorKind>> = {
  [ApiErrorCode.Unauthenticated]: 'unauthorized',
  [ApiErrorCode.Forbidden]: 'forbidden',
  [ApiErrorCode.NotFound]: 'not-found',
  [ApiErrorCode.Conflict]: 'conflict',
  [ApiErrorCode.IdempotencyConflict]: 'conflict',
  [ApiErrorCode.StateTransitionInvalid]: 'conflict',
  [ApiErrorCode.RateLimited]: 'rate-limited',
  [ApiErrorCode.ValidationFailed]: 'validation',
  [ApiErrorCode.InternalError]: 'server',
  // 共享错误码里 AI 不可用就是 503：与「服务暂不可用」同一处置（稍后重试），
  // 不再笼统报成「服务端异常」。
  [ApiErrorCode.AiUnavailable]: 'service-unavailable',
  [ApiErrorCode.AiOutputInvalid]: 'server',
  [INVALID_BASE_URL_CODE]: 'configuration',
  NETWORK_ERROR: 'network',
  TIMEOUT: 'timeout',
  EMPTY_RESPONSE: 'server',
  INVALID_PATH: 'unknown',
};

function kindFromStatus(status: number): UiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate-limited';
  // 503 单列：它表示「暂时不可用、可稍后重试」，而 500 表示服务端缺陷、需要排查。
  if (status === 503) return 'service-unavailable';
  if (status >= 400 && status < 500) return 'validation';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * 稳定错误码 → 界面分类。
 *
 * 契约违规（`INVALID_RESPONSE`）只有「HTTP 层看起来成功」时才归为 `contract`；
 * 4xx/5xx 仍按状态归类（404 可能是端点未实现、503 是依赖不可用、401 是会话失效），
 * 否则会把真实语义掩盖成一句「响应不符合契约」。
 */
function kindForError(caught: ApiClientError): UiErrorKind {
  const byCode = CODE_TO_KIND[caught.code];
  if (byCode !== undefined) return byCode;
  if (
    caught.code === INVALID_RESPONSE_CODE &&
    (caught.status === undefined || caught.status < 400)
  ) {
    return 'contract';
  }
  return caught.status === undefined ? 'unknown' : kindFromStatus(caught.status);
}

/** 把任意异常转成界面错误。识别不了的一律 `unknown`，绝不当作成功。 */
export function toUiError(caught: unknown, endpoint?: string): UiError {
  const withEndpoint = (error: UiError): UiError =>
    endpoint === undefined ? error : { ...error, endpoint };

  if (caught instanceof ApiClientError) {
    const kind = kindForError(caught);
    return withEndpoint({
      kind,
      code: caught.code,
      message: caught.message,
      ...(caught.status === undefined ? {} : { status: caught.status }),
      ...(caught.requestId === undefined ? {} : { requestId: caught.requestId }),
    });
  }

  if (caught instanceof Error) {
    return withEndpoint({
      kind: 'unknown',
      code: 'UNEXPECTED_ERROR',
      message: UNEXPECTED_ERROR_MESSAGE,
    });
  }

  return withEndpoint({
    kind: 'unknown',
    code: 'UNEXPECTED_ERROR',
    message: UNEXPECTED_ERROR_MESSAGE,
  });
}

export function isUnauthorized(error: UiError): boolean {
  return error.kind === 'unauthorized';
}
export function isForbidden(error: UiError): boolean {
  return error.kind === 'forbidden';
}

export function isNotFound(error: UiError): boolean {
  return error.kind === 'not-found';
}

/**
 * 撤销导出的**统一安全拒绝**在界面侧的稳定错误码。
 *
 * 为什么需要一个前端码：服务端刻意把「不存在 / 跨主体 / `failed` 结论 / 已过期 / 非法路径参数」
 * 收敛到**同一个 404 + 同一条文案**（`EXPORT_REVOCATION_UNAVAILABLE_MESSAGE`），目的就是让调用方
 * 无法据此区分「有没有这条导出、它是什么结论」。如果界面把服务端的裸 404 当成普通「未找到数据」，
 * 就等于丢掉了「这是一次统一拒绝」的语义；如果界面去做更细的区分，就等于在自己这边重新泄露原因。
 * 因此这里统一成一个码：**界面只表达「当前不可撤销」，不解释为什么**。
 */
export const EXPORT_UNAVAILABLE_CODE = 'EXPORT_UNAVAILABLE';

/** 与码配套的用户安全文案：不区分原因、不泄露存在性、不含任何内部字段 */
export const EXPORT_REVOKE_UNAVAILABLE_MESSAGE =
  '该导出请求当前不可撤销（服务端不区分原因，界面也不推断原因）。列表随后重新加载即可看到最新状态。';

/** 演示模式下写操作被本地拒绝的稳定码（与 `gateway.ts` 的 `DEMO_READ_ONLY` 一致） */
export const DEMO_READ_ONLY_CODE = 'DEMO_READ_ONLY';

/**
 * 撤销调用的错误收敛（**唯一入口**）。规则刻意很少，但每一条都有理由：
 * 1. **401 / 403 / 503 等一切其它失败沿用既有映射**（`toUiError`）：会话失效、权限不足、
 *    服务暂不可用各有各的处置，不在这里被压成一句笼统文案；
 * 2. `not-found`（服务端的统一安全拒绝）→ 换成 `EXPORT_UNAVAILABLE` + 统一文案，
 *    保留 `status` / `requestId` / `endpoint` 以便排障；
 * 3. 演示模式的本地拒绝（`DEMO_READ_ONLY`）归类为 `forbidden`（「本模式不允许写操作」），
 *    而不是「发生未预期错误」——它是明确的产品策略，不是故障。
 */
export function toExportRevokeUiError(caught: unknown, endpoint?: string): UiError {
  const error = toUiError(caught, endpoint);

  if (error.code === DEMO_READ_ONLY_CODE) {
    return { ...error, kind: 'forbidden' };
  }
  if (error.kind === 'not-found') {
    return {
      ...error,
      code: EXPORT_UNAVAILABLE_CODE,
      message: EXPORT_REVOKE_UNAVAILABLE_MESSAGE,
    };
  }
  return error;
}

/**
 * 标记通知已读的**统一安全拒绝**在界面侧的稳定错误码。
 *
 * 为什么需要一个前端码：服务端刻意把「不存在 / 非本人所有 / 归属不可读」收敛到**同一个 404 +
 * 同一文案**（`NOTIFICATION_NOT_VISIBLE_MESSAGE`），目的就是让调用方无法据此构造存在性探测。
 * 如果界面把裸 404 当成普通「未找到数据」，就丢掉了「这是一次统一拒绝」的语义；如果界面去做更细的
 * 区分，就等于在自己这边重新泄露原因。因此这里统一成一个码：**界面只表达「当前不可标记已读」，
 * 不解释为什么**。
 */
export const NOTIFICATION_UNAVAILABLE_CODE = 'NOTIFICATION_UNAVAILABLE';

/** 与码配套的用户安全文案：不区分原因、不泄露存在性、不含任何内部字段 */
export const NOTIFICATION_READ_UNAVAILABLE_MESSAGE =
  '该通知当前不可标记已读（服务端不区分原因，界面也不推断原因）。列表随后重新加载即可看到最新状态。';

/**
 * 本地未预期失败（非 `ApiClientError`：序列化异常、路径构造异常等）的统一安全文案。
 * 绝不把 `caught.message` 之类的**原始异常文本**带进界面——它可能含有内部标识或堆栈信息。
 */
export const NOTIFICATION_READ_FAILED_MESSAGE = '标记已读未完成，请稍后重试。';

/**
 * 标记通知已读调用的错误收敛（**唯一入口**）。规则很少，但每一条都有理由：
 * 1. **401 / 403 / 503 等一切其它失败沿用既有映射**（`toUiError`）：会话失效、权限不足、
 *    服务暂不可用各有各的处置，不在这里被压成一句笼统文案；
 * 2. `not-found`（服务端的统一安全拒绝）→ 换成 `NOTIFICATION_UNAVAILABLE_CODE` + 统一文案，
 *    保留 `status` / `requestId` / `endpoint` 以便排障；
 * 3. 演示模式的本地拒绝（`DEMO_READ_ONLY`）归类为 `forbidden`（「本模式不允许写操作」），
 *    而不是「发生未预期错误」——它是明确的产品策略，不是故障；
 * 4. 归类不明（`unknown`，含非 `ApiClientError` 的原始异常）→ 换成固定安全文案，
 *    原始异常文本既不展示也不外传。
 */
export function toNotificationReadUiError(caught: unknown, endpoint?: string): UiError {
  const error = toUiError(caught, endpoint);

  if (error.code === DEMO_READ_ONLY_CODE) {
    return { ...error, kind: 'forbidden' };
  }
  if (error.kind === 'not-found') {
    return {
      ...error,
      code: NOTIFICATION_UNAVAILABLE_CODE,
      message: NOTIFICATION_READ_UNAVAILABLE_MESSAGE,
    };
  }
  if (error.kind === 'unknown') {
    return { ...error, message: NOTIFICATION_READ_FAILED_MESSAGE };
  }
  return error;
}

/**
 * 「端点尚未实现」判定：只对**已按契约基线声明为待实现**的边界生效。
 * 必须同时满足两条，避免把「资源不存在」（合法空态）误报成「功能未上线」：
 * 1. 该边界在 `endpoints.ts` 里被标记为 `pending`；
 * 2. 观测到 404 / 501（未注册路由）或 403（网关级权限尚未放行）。
 */
export function looksLikePendingEndpoint(
  error: UiError,
  endpointStatus: 'stable' | 'pending',
): boolean {
  if (endpointStatus !== 'pending') return false;
  return error.kind === 'not-found' || error.kind === 'forbidden' || error.status === 501;
}
