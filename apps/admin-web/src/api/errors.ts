import { ApiErrorCode } from '@rm/shared';
import { ApiClientError } from './client';

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
  [ApiErrorCode.AiUnavailable]: 'server',
  [ApiErrorCode.AiOutputInvalid]: 'server',
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
  if (status >= 400 && status < 500) return 'validation';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** 把任意异常转成界面错误。识别不了的一律 `unknown`，绝不当作成功。 */
export function toUiError(caught: unknown, endpoint?: string): UiError {
  const withEndpoint = (error: UiError): UiError =>
    endpoint === undefined ? error : { ...error, endpoint };

  if (caught instanceof ApiClientError) {
    const byCode = CODE_TO_KIND[caught.code];
    const kind =
      byCode ?? (caught.status === undefined ? 'unknown' : kindFromStatus(caught.status));
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
      message: caught.message === '' ? '发生未预期错误，请查看浏览器控制台' : caught.message,
    });
  }

  return withEndpoint({
    kind: 'unknown',
    code: 'UNEXPECTED_ERROR',
    message: '发生未预期错误，请查看浏览器控制台',
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
