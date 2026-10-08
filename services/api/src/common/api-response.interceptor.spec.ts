import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, lastValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { ApiResponseInterceptor } from './api-response.interceptor';
import type { ResponseLike } from './request-context';

function createContext(request: { headers: Record<string, unknown> }) {
  const headers: Record<string, string> = {};
  const response: ResponseLike = {
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
    },
    getHeader: (name) => headers[name.toLowerCase()],
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return { context, headers };
}

function handler<T>(value: T): CallHandler<T> {
  return { handle: () => of(value) };
}

describe('统一响应信封', () => {
  it('把控制器返回值包装为 { data, meta, error }', async () => {
    const { context } = createContext({ headers: {} });
    const interceptor = new ApiResponseInterceptor<{ status: string }>();

    const envelope = await lastValueFrom(interceptor.intercept(context, handler({ status: 'ok' })));

    expect(envelope.data).toEqual({ status: 'ok' });
    expect(envelope.error).toBeNull();
    expect(envelope.meta.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(typeof envelope.meta.generatedAt).toBe('string');
  });

  it('沿用传入的请求 ID，便于前后端串联排障', async () => {
    const { context, headers } = createContext({ headers: { 'x-request-id': 'trace-0001' } });
    const interceptor = new ApiResponseInterceptor<number>();

    const envelope = await lastValueFrom(interceptor.intercept(context, handler(1)));

    expect(envelope.meta.requestId).toBe('trace-0001');
    expect(headers['x-request-id']).toBe('trace-0001');
  });

  it('非法请求 ID 不进入响应头，改为重新生成', async () => {
    const { context, headers } = createContext({
      headers: { 'x-request-id': 'evil\r\nX-Injected: 1' },
    });
    const interceptor = new ApiResponseInterceptor<number>();

    const envelope = await lastValueFrom(interceptor.intercept(context, handler(1)));

    expect(String(envelope.meta.requestId)).not.toContain('evil');
    expect(headers['x-request-id']).toBe(envelope.meta.requestId);
  });
});
