import { ApiErrorCode, MAX_PAGE_SIZE, ok } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import {
  ApiClientError,
  INVALID_BASE_URL_CODE,
  buildPageQuery,
  createApiClient,
  resolveApiBaseUrl,
} from './client';

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function fetchReturning(
  body: unknown,
  init: { status?: number; calls?: FetchArgs[] } = {},
): typeof fetch {
  const implementation = async (...args: FetchArgs): Promise<Response> => {
    init.calls?.push(args);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return implementation as unknown as typeof fetch;
}

describe('API 基地址解析与校验', () => {
  it('未配置时回落到同源 /api/v1', () => {
    expect(resolveApiBaseUrl({})).toBe('/api/v1');
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: '   ' })).toBe('/api/v1');
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: undefined })).toBe('/api/v1');
  });

  it('放行同源根相对路径（反向代理部署），并去掉末尾斜杠', () => {
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: '/api/v1' })).toBe('/api/v1');
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: '/gateway/api/v1///' })).toBe('/gateway/api/v1');
  });

  /**
   * 回归：根路径 `/` 剥末尾斜杠后曾是空串，`client.baseUrl` 随之退化为空，
   * 拼出的地址不再锚定到站点根。`/` 必须原样保留为 `/`。
   */
  it('根相对基地址 / 保留为 /，不退化成空串（回归）', async () => {
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: '/' })).toBe('/');

    const calls: FetchArgs[] = [];
    const client = createApiClient({
      baseUrl: '/',
      fetchImpl: fetchReturning(ok({ status: 'ok' }), { calls }),
    });

    await client.getJson('/health');

    expect(client.baseUrl).toBe('/');
    expect(String(calls[0]?.[0])).toBe('/health');
    // 不能拼成 `//health`（协议相对地址，会被解析成主机名 health，等于换源）
    expect(String(calls[0]?.[0]).startsWith('//')).toBe(false);
    // 必须是从站点根开始的同源绝对路径，而不是相对当前页面路径解析出的地址
    expect(
      new URL(String(calls[0]?.[0]), 'https://admin.example.com/console/applications').pathname,
    ).toBe('/health');
  });

  it('放行显式 http/https 绝对地址（独立 API 域），并归一化', () => {
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: 'http://127.0.0.1:3000/api/v1/' })).toBe(
      'http://127.0.0.1:3000/api/v1',
    );
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: 'https://api.example.com/api/v1' })).toBe(
      'https://api.example.com/api/v1',
    );
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: 'HTTPS://API.EXAMPLE.COM/api/v1' })).toBe(
      'https://api.example.com/api/v1',
    );
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: 'https://api.example.com' })).toBe(
      'https://api.example.com',
    );
  });

  /**
   * 拒绝项全表：每一条都会让 `createApiClient` 在发出任何请求之前就失败，
   * 因此会话票据不可能被送到这些目标（`INVALID_BASE_URL` 是稳定错误码，不是 message 判断）。
   */
  const REJECTED_BASE_URLS: ReadonlyArray<[reason: string, value: string]> = [
    ['协议相对地址（换源到第三方）', '//evil.example.com/api/v1'],
    ['三斜杠协议相对地址', '///evil.example.com/api/v1'],
    ['非 http(s) 协议 ftp', 'ftp://evil.example.com/api/v1'],
    ['非 http(s) 协议 file', 'file:///etc/passwd'],
    ['可执行协议 javascript', 'javascript:alert(document.cookie)'],
    ['数据协议 data', 'data:text/plain,collect'],
    ['带用户名与密码', 'https://user:pass@evil.example.com/api/v1'],
    ['仅带用户名', 'https://token@evil.example.com/api/v1'],
    ['空用户名但带 @', 'https://@evil.example.com/api/v1'],
    ['空 origin（http）', 'http://'],
    ['空 origin（https）', 'https://'],
    ['空 origin 后直接给路径', 'http:///api/v1'],
    ['单斜杠绝对地址（会被解析成别的主机）', 'http:/evil.example.com'],
    ['缺少 // 的绝对地址', 'http:evil.example.com'],
    ['开头的控制字符', '\u0000https://evil.example.com'],
    ['路径中的控制字符', 'https://evil.example.com/api\u0000/v1'],
    ['URL 里的换行（头部注入）', 'https://evil.example.com/api/v1\nX-Injected: 1'],
    ['反斜杠伪装协议相对地址', '\\evil.example.com/api/v1'],
    ['绝对地址里混入反斜杠与 @', 'https://evil.example.com\\@good.example.com'],
    ['裸相对值（会相对当前页面解析）', 'api/v1'],
    ['带查询串', 'https://api.example.com/api/v1?token=leak'],
    ['带片段', '/api/v1#frag'],
    ['非法主机', 'https://exa mple.com/api/v1'],
  ];

  it.each(REJECTED_BASE_URLS)('拒绝不安全基地址：%s', (_reason, value) => {
    expect(() => resolveApiBaseUrl({ VITE_API_BASE_URL: value })).toThrowError(ApiClientError);

    let code: string | undefined;
    try {
      resolveApiBaseUrl({ VITE_API_BASE_URL: value });
    } catch (error) {
      code = (error as ApiClientError).code;
    }
    expect(code).toBe(INVALID_BASE_URL_CODE);
  });

  it('非法基地址在构造客户端时就失败：不发请求、不读取票据', () => {
    const calls: FetchArgs[] = [];
    let tokenReads = 0;
    const options = {
      fetchImpl: fetchReturning(ok({}), { calls }),
      tokenProvider: () => {
        tokenReads += 1;
        return 'ticket-abcd1234';
      },
    };

    expect(() =>
      createApiClient({ ...options, baseUrl: '//evil.example.com/api/v1' }),
    ).toThrowError(ApiClientError);
    expect(() =>
      createApiClient({ ...options, baseUrl: 'https://user:pass@evil.example.com/api/v1' }),
    ).toThrowError(ApiClientError);

    expect(calls).toHaveLength(0);
    expect(tokenReads).toBe(0);
  });

  it('合法基地址照常发请求并带着票据（回归：校验不误伤正常部署）', async () => {
    const calls: FetchArgs[] = [];
    const client = createApiClient({
      baseUrl: 'https://api.example.com/api/v1/',
      fetchImpl: fetchReturning(ok({ status: 'ok' }), { calls }),
      tokenProvider: () => 'ticket-abcd1234',
    });

    await client.getJson('/health');

    expect(client.baseUrl).toBe('https://api.example.com/api/v1');
    expect(String(calls[0]?.[0])).toBe('https://api.example.com/api/v1/health');
    expect((calls[0]?.[1]?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer ticket-abcd1234',
    );
  });
});

describe('API 客户端', () => {
  it('解析成功信封并返回 data', async () => {
    const calls: FetchArgs[] = [];
    const client = createApiClient({
      baseUrl: 'http://127.0.0.1:3000/api/v1',
      fetchImpl: fetchReturning(ok({ status: 'ok', service: 'api' }), { calls }),
    });

    const data = await client.getJson<{ status: string; service: string }>('/health');

    expect(data.service).toBe('api');
    expect(String(calls[0]?.[0])).toBe('http://127.0.0.1:3000/api/v1/health');
    expect(calls[0]?.[1]?.method).toBe('GET');
  });

  it('错误信封转换为带 code 与 requestId 的异常', async () => {
    const client = createApiClient({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning(
        {
          data: null,
          meta: { requestId: 'req-9' },
          error: {
            code: ApiErrorCode.Forbidden,
            message: '没有执行该操作的权限',
            requestId: 'req-9',
          },
        },
        { status: 403 },
      ),
    });

    await expect(client.getJson('/admin/exports')).rejects.toThrowError(ApiClientError);
    try {
      await client.getJson('/admin/exports');
    } catch (error) {
      const clientError = error as ApiClientError;
      expect(clientError.code).toBe('FORBIDDEN');
      expect(clientError.status).toBe(403);
      expect(clientError.requestId).toBe('req-9');
    }
  });

  it('非信封响应一律视为错误，不误判为成功', async () => {
    const client = createApiClient({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning({ status: 'ok' }),
    });

    await expect(client.getJson('/health')).rejects.toMatchObject({ code: 'HTTP_200' });
  });

  it('网络异常与超时分别映射为 NETWORK_ERROR 与 TIMEOUT', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const networkClient = createApiClient({ baseUrl: '/api/v1', fetchImpl: failing });
    await expect(networkClient.getJson('/health')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      })) as unknown as typeof fetch;
    const timeoutClient = createApiClient({
      baseUrl: '/api/v1',
      fetchImpl: hanging,
      timeoutMs: 10,
    });
    await expect(timeoutClient.getJson('/health')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('拒绝绝对地址与协议相对路径，避免把请求发往第三方', async () => {
    const calls: FetchArgs[] = [];
    const client = createApiClient({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning(ok({}), { calls }),
    });

    await expect(client.getJson('https://evil.example.com/collect')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(client.getJson('//evil.example.com/collect')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    expect(calls).toHaveLength(0);
  });

  it('data 为 null 时视为空响应错误', async () => {
    const client = createApiClient({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning({ data: null, meta: {}, error: null }),
    });
    await expect(client.getJson('/health')).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' });
  });
});

describe('API 客户端 · 会话与写操作', () => {
  it('有票据时注入 Bearer 头；匿名时不带 Authorization 头', async () => {
    const withTicket: FetchArgs[] = [];
    const authorized = createApiClient({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning(ok({ name: 'x' }), { calls: withTicket }),
      tokenProvider: () => 'ticket-abcd1234',
    });
    await authorized.getJson('/me/profile');
    const authorizedHeaders = withTicket[0]?.[1]?.headers as Record<string, string>;
    expect(authorizedHeaders['authorization']).toBe('Bearer ticket-abcd1234');

    const anonymousCalls: FetchArgs[] = [];
    const anonymous = createApiClient({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning(ok({ status: 'ok' }), { calls: anonymousCalls }),
      tokenProvider: () => null,
    });
    await anonymous.getJson('/health');
    const anonymousHeaders = anonymousCalls[0]?.[1]?.headers as Record<string, string>;
    expect(anonymousHeaders['authorization']).toBeUndefined();
  });

  it('401 统一回调会话层，页面无需各自处理', async () => {
    const unauthorizedCodes: string[] = [];
    const client = createApiClient({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning(
        {
          data: null,
          meta: {},
          error: { code: ApiErrorCode.Unauthenticated, message: '会话无效' },
        },
        { status: 401 },
      ),
      onUnauthorized: (error) => unauthorizedCodes.push(error.code),
    });

    await expect(client.getJson('/me/profile')).rejects.toMatchObject({ status: 401 });
    expect(unauthorizedCodes).toEqual([ApiErrorCode.Unauthenticated]);
  });

  it('403 不触发登出回调（权限问题不是会话问题）', async () => {
    const unauthorizedCodes: string[] = [];
    const client = createApiClient({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning(
        { data: null, meta: {}, error: { code: ApiErrorCode.Forbidden, message: '无权限' } },
        { status: 403 },
      ),
      onUnauthorized: (error) => unauthorizedCodes.push(error.code),
    });

    await expect(client.getJson('/admin/applications')).rejects.toMatchObject({ status: 403 });
    expect(unauthorizedCodes).toEqual([]);
  });

  it('PATCH 发送 JSON 请求体并声明 content-type；GET 不声明', async () => {
    const calls: FetchArgs[] = [];
    const client = createApiClient({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning(ok({ name: '新名字' }), { calls }),
    });

    const updated = await client.patchJson<{ name: string }>('/me/profile', { name: '新名字' });
    expect(updated.name).toBe('新名字');
    expect(calls[0]?.[1]?.method).toBe('PATCH');
    expect(calls[0]?.[1]?.body).toBe(JSON.stringify({ name: '新名字' }));
    expect((calls[0]?.[1]?.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
  });

  it('getEnvelope 保留 meta（分页信息由服务端给出，不在前端推导）', async () => {
    const client = createApiClient({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning(
        ok([{ id: 'a' }], { page: 2, pageSize: 20, total: 41, totalPages: 3 }),
      ),
    });

    const envelope = await client.getEnvelope<{ id: string }[]>('/admin/applications');
    expect(envelope.meta['total']).toBe(41);
    expect(envelope.data).toHaveLength(1);
  });
});

describe('分页查询串构造', () => {
  it('pageSize 由共享上限封顶，且不把空值写进查询串', () => {
    expect(buildPageQuery({ page: 1, pageSize: 20 })).toBe('?page=1&pageSize=20');
    expect(buildPageQuery({ page: 0, pageSize: 9999 })).toBe(`?page=1&pageSize=${MAX_PAGE_SIZE}`);
    expect(buildPageQuery({ page: 1, pageSize: 20, status: 'pending', keyword: '' })).toBe(
      '?page=1&pageSize=20&status=pending',
    );
  });

  it('关键词被正确编码，不会破坏查询串结构', () => {
    const query = buildPageQuery({ page: 1, pageSize: 20, keyword: 'a&b=c' });
    expect(query).toContain('keyword=a%26b%3Dc');
    expect(new URLSearchParams(query.slice(1)).get('keyword')).toBe('a&b=c');
  });
});
