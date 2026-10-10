import { ApiErrorCode } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import { ApiClientError, INVALID_BASE_URL_CODE, INVALID_RESPONSE_CODE } from './client';
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

  it('非 ApiClientError 的恶意原始 message 不会泄露到界面', () => {
    const rawMessage = 'provider=/srv/secrets/token path=/internal/db password=hunter2';
    const error = toUiError(new Error(rawMessage), 'GET /api/v1/profile');

    expect(error).toMatchObject({ kind: 'unknown', code: 'UNEXPECTED_ERROR' });
    expect(error.message).toBe('发生未预期错误，请稍后重试。');
    expect(error.message).not.toContain(rawMessage);
    expect(error.endpoint).toBe('GET /api/v1/profile');
  });

  /**
   * 503 与 500 的处置不同：503 是「暂时不可用、可稍后重试」，500 是服务端缺陷、需要排查。
   * 两者都揉进「服务端异常」会让使用者无法判断该不该直接重试。
   */
  it('503（含共享的 AI_UNAVAILABLE 码）归为「服务暂不可用」，500 仍是服务端异常', () => {
    expect(toUiError(new ApiClientError('HTTP_503', 'x', { status: 503 })).kind).toBe(
      'service-unavailable',
    );
    expect(
      toUiError(new ApiClientError(ApiErrorCode.AiUnavailable, 'x', { status: 503 })).kind,
    ).toBe('service-unavailable');
    expect(toUiError(new ApiClientError('HTTP_500', 'x', { status: 500 })).kind).toBe('server');
  });

  /**
   * 响应契约错误：HTTP 层「成功」但响应体不是信封时必须单列，否则只会显示「发生未预期错误」；
   * 而 HTTP 层确实失败时仍按状态归类，不能把 404/503/401 的真实语义掩盖掉。
   */
  it('非信封响应：2xx 归为契约违规，4xx/5xx 仍按状态归类', () => {
    expect(toUiError(new ApiClientError(INVALID_RESPONSE_CODE, 'x', { status: 200 })).kind).toBe(
      'contract',
    );
    expect(toUiError(new ApiClientError(INVALID_RESPONSE_CODE, 'x', { status: 404 })).kind).toBe(
      'not-found',
    );
    expect(toUiError(new ApiClientError(INVALID_RESPONSE_CODE, 'x', { status: 503 })).kind).toBe(
      'service-unavailable',
    );
    expect(toUiError(new ApiClientError(INVALID_RESPONSE_CODE, 'x')).kind).toBe('contract');
  });

  it('基地址非法是前端配置错误，不是「发生未预期错误」', () => {
    expect(toUiError(new ApiClientError(INVALID_BASE_URL_CODE, '基地址不合法')).kind).toBe(
      'configuration',
    );
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
