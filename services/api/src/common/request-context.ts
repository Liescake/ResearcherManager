import { randomUUID } from 'node:crypto';
import { REQUEST_ID_HEADER } from '@rm/shared';

/**
 * 请求 ID：用于把日志、审计和响应信封串起来（计划表 P3 §6）。
 * 接受调用方传入的 ID 前必须做字符集与长度校验，避免响应头注入。
 */

export interface RequestLike {
  headers?: Record<string, unknown>;
  method?: string;
  url?: string;
  originalUrl?: string;
}

export interface ResponseLike {
  setHeader?: (name: string, value: string) => void;
  getHeader?: (name: string) => unknown;
  status?: (code: number) => ResponseLike;
  json?: (body: unknown) => unknown;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

function normalizeHeaderValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return normalizeHeaderValue(value[0]);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return SAFE_REQUEST_ID.test(trimmed) ? trimmed : undefined;
  }
  return undefined;
}

export function resolveRequestId(request?: RequestLike, response?: ResponseLike): string {
  const existing =
    normalizeHeaderValue(response?.getHeader?.(REQUEST_ID_HEADER)) ??
    normalizeHeaderValue(request?.headers?.[REQUEST_ID_HEADER]);
  const requestId = existing ?? randomUUID();
  response?.setHeader?.(REQUEST_ID_HEADER, requestId);
  return requestId;
}

/** 日志只记录路径，去掉可能携带敏感值的查询串 */
export function safeRequestPath(request?: RequestLike): string {
  const raw = request?.url ?? request?.originalUrl ?? '';
  return raw.split('?')[0] ?? '';
}
