import { describe, expect, it } from 'vitest';
import { resolveRequestId, safeRequestPath } from './request-context';

function createResponse(headers: Record<string, string> = {}) {
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
  };
}

describe('请求 ID', () => {
  it('没有传入时生成 UUID 并写回响应头', () => {
    const response = createResponse();
    const requestId = resolveRequestId({ headers: {} }, response);

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.headers['x-request-id']).toBe(requestId);
  });

  it('沿用在长度与字符集范围内传入的请求 ID', () => {
    const requestId = resolveRequestId(
      { headers: { 'x-request-id': 'trace-1234_AB' } },
      createResponse(),
    );
    expect(requestId).toBe('trace-1234_AB');
  });

  it('拒绝可注入响应头的非法请求 ID（换行、空格、非法字符）', () => {
    const response = createResponse();
    const requestId = resolveRequestId(
      { headers: { 'x-request-id': 'bad value\r\nX-Injected: 1' } },
      response,
    );

    expect(requestId).not.toContain('X-Injected');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('超长请求 ID 被拒绝并重新生成', () => {
    const requestId = resolveRequestId({ headers: { 'x-request-id': 'a'.repeat(200) } });
    expect(requestId).not.toBe('a'.repeat(200));
  });

  it('数组型请求头取第一个值', () => {
    expect(resolveRequestId({ headers: { 'x-request-id': ['first-value', 'second'] } })).toBe(
      'first-value',
    );
  });
});

describe('日志路径脱敏', () => {
  it('去掉查询串，避免把敏感参数写进日志', () => {
    expect(safeRequestPath({ url: '/api/v1/groups?phone=13800138000' })).toBe('/api/v1/groups');
    expect(safeRequestPath({ originalUrl: '/api/v1/me/profile' })).toBe('/api/v1/me/profile');
    expect(safeRequestPath(undefined)).toBe('');
  });
});
