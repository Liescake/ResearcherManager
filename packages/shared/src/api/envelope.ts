import type { Pagination } from '../validation/query';
import {
  ApiErrorCode,
  defaultMessageForErrorCode,
  httpStatusForErrorCode,
  isApiErrorCode,
} from './error-codes';

/**
 * 统一响应信封：{ data, meta, error }（docs/P2-API契约基线.md 通用约定）。
 * 成功时 error 为 null；失败时 data 为 null，且 code 稳定可编程分支。
 */

export interface ApiErrorBody {
  code: ApiErrorCode | string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

export interface ApiMeta {
  requestId?: string;
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  generatedAt?: string;
  [key: string]: unknown;
}

export interface ApiEnvelope<T> {
  data: T | null;
  meta: ApiMeta;
  error: ApiErrorBody | null;
}

export function ok<T>(data: T, meta: ApiMeta = {}): ApiEnvelope<T> {
  return { data, meta, error: null };
}

export function okPaginated<T>(
  items: readonly T[],
  total: number,
  pagination: Pagination,
  meta: ApiMeta = {},
): ApiEnvelope<T[]> {
  return ok([...items], {
    ...meta,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
    totalPages: pagination.pageSize > 0 ? Math.ceil(total / pagination.pageSize) : 0,
  });
}

export function fail(
  code: ApiErrorCode | string,
  options: { message?: string; requestId?: string; details?: Record<string, unknown> } = {},
): ApiEnvelope<never> {
  const { message, requestId, details } = options;
  return {
    data: null,
    meta: requestId ? { requestId } : {},
    error: {
      code,
      message: message ?? defaultMessageForErrorCode(code),
      ...(requestId ? { requestId } : {}),
      ...(details ? { details } : {}),
    },
  };
}

/** 供 HTTP 层把业务错误码映射为状态码 */
export function statusForErrorCode(code: string): number {
  return httpStatusForErrorCode(code);
}

export function isKnownErrorCode(code: string): code is ApiErrorCode {
  return isApiErrorCode(code);
}

/** 运行期结构校验：客户端解析响应前先确认信封格式 */
export function isApiEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return 'data' in candidate && 'meta' in candidate && 'error' in candidate;
}
