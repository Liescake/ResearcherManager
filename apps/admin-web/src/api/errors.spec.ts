import { ApiErrorCode } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from './client';
import { looksLikePendingEndpoint, toUiError } from './errors';

describe('界面错误模型', () => {
  it('按稳定错误码映射，而不是解析 message', () => {
    expect(
      toUiError(new ApiClientError(ApiErrorCode.Unauthenticated, 'x', { status: 401 })).kind,
    ).toBe('unauthorized');
    expect(toUiError(new ApiClientError(ApiErrorCode.Forbidden, 'x', { status: 403 })).kind).toBe(
      'forbidden',
    );
    expect(toUiError(new ApiClientError(ApiErrorCode.NotFound, 'x', { status: 404 })).kind).toBe(
      'not-found',
    );
    expect(
      toUiError(new ApiClientError(ApiErrorCode.StateTransitionInvalid, 'x', { status: 409 })).kind,
    ).toBe('conflict');
    expect(toUiError(new ApiClientError(ApiErrorCode.RateLimited, 'x', { status: 429 })).kind).toBe(
      'rate-limited',
    );
    expect(
      toUiError(new ApiClientError(ApiErrorCode.ValidationFailed, 'x', { status: 400 })).kind,
    ).toBe('validation');
    expect(
      toUiError(new ApiClientError(ApiErrorCode.InternalError, 'x', { status: 500 })).kind,
    ).toBe('server');
  });

  it('未知错误码按 HTTP 状态兜底，而不是当作成功', () => {
    expect(toUiError(new ApiClientError('SOMETHING_NEW', 'x', { status: 404 })).kind).toBe(
      'not-found',
    );
    expect(toUiError(new ApiClientError('SOMETHING_NEW', 'x', { status: 500 })).kind).toBe(
      'server',
    );
    expect(toUiError(new ApiClientError('SOMETHING_NEW', 'x')).kind).toBe('unknown');
  });

  it('网络/超时/非 Error 异常都有确定的归类', () => {
    expect(toUiError(new ApiClientError('NETWORK_ERROR', '连接失败')).kind).toBe('network');
    expect(toUiError(new ApiClientError('TIMEOUT', '超时')).kind).toBe('timeout');
    expect(toUiError('炸了').kind).toBe('unknown');
    expect(toUiError(new Error('')).message).toContain('未预期');
  });

  it('保留 requestId 与 API 边界，便于用户描述问题', () => {
    const error = toUiError(
      new ApiClientError(ApiErrorCode.Forbidden, '无权限', { status: 403, requestId: 'req-1' }),
      'GET /admin/applications',
    );
    expect(error.requestId).toBe('req-1');
    expect(error.endpoint).toBe('GET /admin/applications');
    expect(error.status).toBe(403);
  });
});

describe('「端点尚未实现」判定', () => {
  it('只有登记为 pending 的边界 + 404/403/501 才算未实现', () => {
    const notFound = toUiError(new ApiClientError('HTTP_404', 'x', { status: 404 }));
    const forbidden = toUiError(new ApiClientError(ApiErrorCode.Forbidden, 'x', { status: 403 }));
    const serverError = toUiError(new ApiClientError('HTTP_500', 'x', { status: 500 }));

    expect(looksLikePendingEndpoint(notFound, 'pending')).toBe(true);
    expect(looksLikePendingEndpoint(forbidden, 'pending')).toBe(true);
    // stable 端点的 404 是「资源不存在」这一合法空态，不能报成「功能未上线」
    expect(looksLikePendingEndpoint(notFound, 'stable')).toBe(false);
    // 500 是故障，不能归入计划内缺口
    expect(looksLikePendingEndpoint(serverError, 'pending')).toBe(false);
  });
});
