import { createValueGuard } from '../enums/guard';

/**
 * 稳定错误码：客户端根据 code 分支，不解析 message。
 * message 必须是「用户安全消息」，不得泄露他组资源是否存在或敏感字段原文。
 */
export const ApiErrorCode = {
  ValidationFailed: 'VALIDATION_FAILED',
  Unauthenticated: 'UNAUTHENTICATED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  IdempotencyConflict: 'IDEMPOTENCY_CONFLICT',
  StateTransitionInvalid: 'STATE_TRANSITION_INVALID',
  RateLimited: 'RATE_LIMITED',
  AiUnavailable: 'AI_UNAVAILABLE',
  AiOutputInvalid: 'AI_OUTPUT_INVALID',
  InternalError: 'INTERNAL_ERROR',
} as const;
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
export const API_ERROR_CODE_VALUES = [
  ApiErrorCode.ValidationFailed,
  ApiErrorCode.Unauthenticated,
  ApiErrorCode.Forbidden,
  ApiErrorCode.NotFound,
  ApiErrorCode.Conflict,
  ApiErrorCode.IdempotencyConflict,
  ApiErrorCode.StateTransitionInvalid,
  ApiErrorCode.RateLimited,
  ApiErrorCode.AiUnavailable,
  ApiErrorCode.AiOutputInvalid,
  ApiErrorCode.InternalError,
] as const;
export const isApiErrorCode = createValueGuard(API_ERROR_CODE_VALUES);

export const ERROR_HTTP_STATUS: Record<ApiErrorCode, number> = {
  [ApiErrorCode.ValidationFailed]: 400,
  [ApiErrorCode.Unauthenticated]: 401,
  [ApiErrorCode.Forbidden]: 403,
  [ApiErrorCode.NotFound]: 404,
  [ApiErrorCode.Conflict]: 409,
  [ApiErrorCode.IdempotencyConflict]: 409,
  [ApiErrorCode.StateTransitionInvalid]: 409,
  [ApiErrorCode.RateLimited]: 429,
  [ApiErrorCode.AiUnavailable]: 503,
  [ApiErrorCode.AiOutputInvalid]: 502,
  [ApiErrorCode.InternalError]: 500,
};

export const DEFAULT_ERROR_MESSAGE: Record<ApiErrorCode, string> = {
  [ApiErrorCode.ValidationFailed]: '提交内容不合法，请检查后重试',
  [ApiErrorCode.Unauthenticated]: '登录状态无效或已过期，请重新登录',
  [ApiErrorCode.Forbidden]: '没有执行该操作的权限',
  [ApiErrorCode.NotFound]: '目标资源不存在或不可见',
  [ApiErrorCode.Conflict]: '当前数据状态与请求冲突，请刷新后重试',
  [ApiErrorCode.IdempotencyConflict]: '同一幂等键的请求内容不一致',
  [ApiErrorCode.StateTransitionInvalid]: '当前状态不允许该操作',
  [ApiErrorCode.RateLimited]: '请求过于频繁，请稍后重试',
  [ApiErrorCode.AiUnavailable]: '智能匹配暂时不可用，可先浏览小组或稍后重试',
  [ApiErrorCode.AiOutputInvalid]: '智能匹配结果异常，已降级处理',
  [ApiErrorCode.InternalError]: '服务器内部错误，请稍后重试',
};

/** 未知错误码一律按 500 处理，避免把内部错误暴露为成功 */
export function httpStatusForErrorCode(code: string): number {
  return isApiErrorCode(code) ? ERROR_HTTP_STATUS[code] : 500;
}

export function defaultMessageForErrorCode(code: string): string {
  return isApiErrorCode(code)
    ? DEFAULT_ERROR_MESSAGE[code]
    : DEFAULT_ERROR_MESSAGE[ApiErrorCode.InternalError];
}
