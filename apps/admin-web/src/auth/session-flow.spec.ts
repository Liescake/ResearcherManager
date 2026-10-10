import { ApiErrorCode, ok } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../api/client';
import {
  ANONYMOUS,
  SESSION_STORAGE_KEY,
  createSession,
  readSession,
  serializeSession,
  type SessionStorageLike,
} from '../api/session';
import {
  SESSION_EXPIRED_NOTICE,
  expireSession,
  probeApiHealth,
  verifyTicket,
} from './session-flow';

/**
 * 会话流程的回归测试（node 环境、无 React、无 jsdom）。
 *
 * 覆盖两条在 `AuthProvider` 内部无法可靠回归的不变量：
 * 1. **登录探测收到 401 永远不是登录成功**——即便 401 的响应信封里带着看似正常的数据；
 * 2. **401 的唯一处理点是 `client.onUnauthorized` → `expireSession`**——清空会话、给出提示，
 *    而 403 不触发登出。
 */
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

function memoryStorage(state?: Parameters<typeof serializeSession>[0]): SessionStorageLike & {
  readonly data: Map<string, string>;
} {
  const data = new Map<string, string>();
  const serialized = state === undefined ? null : serializeSession(state);
  if (serialized !== null) {
    data.set(SESSION_STORAGE_KEY, serialized);
  }
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const REAL_SESSION = {
  status: 'authenticated',
  session: createSession('ticket-abcd1234', '会话票据登录'),
} as const;

function probe(options: { fetchImpl: typeof fetch; timeoutMs?: number }) {
  return verifyTicket({
    baseUrl: '/api/v1',
    ticket: 'ticket-abcd1234',
    ...options,
  });
}

describe('票据登录探测（verifyTicket）', () => {
  it('200 → 服务端认这张票据，成功', async () => {
    const outcome = await probe({ fetchImpl: fetchReturning(ok({ status: 'ok' })) });

    expect(outcome.ok).toBe(true);
    expect(outcome.warning).toBeUndefined();
    expect(outcome.error).toBeUndefined();
  });

  /**
   * 回归：401 是「票据不被承认」，不是登录成功。判定必须只看 401 本身，
   * 不能被响应体里带的数据（甚至 data 非空）绕过——否则一个被伪造/复用的
   * 401 响应就会被记成已登录，前端进入受保护页面。
   */
  it('401 → 失败，即便响应信封里带着看似正常的数据（回归）', async () => {
    const outcome = await probe({
      fetchImpl: fetchReturning(
        {
          // 故意塞入一份「看起来像正常画像」的数据，诱导实现按 data 判成功
          data: { id: 'u-1', name: '张三', role: 'admin' },
          meta: { requestId: 'req-401' },
          error: { code: ApiErrorCode.Unauthenticated, message: '会话无效', requestId: 'req-401' },
        },
        { status: 401 },
      ),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatchObject({
      kind: 'unauthorized',
      status: 401,
      requestId: 'req-401',
    });
    // 失败结果里不允许出现「已认证」的任何痕迹
    expect(JSON.stringify(outcome)).not.toContain('admin');
  });

  it('401 的探测请求带着票据，失败结果里不携带任何会话状态', async () => {
    const calls: FetchArgs[] = [];
    const outcome = await probe({
      fetchImpl: fetchReturning(
        {
          data: null,
          meta: {},
          error: { code: ApiErrorCode.Unauthenticated, message: '会话无效' },
        },
        { status: 401, calls },
      ),
    });

    expect(outcome.ok).toBe(false);
    // 登录失败只回报一个界面错误（含 API 边界，便于用户描述问题）：
    // 结果里既没有票据，也没有可直接写入会话的字段
    expect(outcome.error?.endpoint).toBe('GET /me/profile');
    expect('session' in outcome).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain('ticket-abcd1234');
    expect((calls[0]?.[1]?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer ticket-abcd1234',
    );
  });

  it('403 → 票据有效但角色缺权限：认票据并给出提示', async () => {
    const outcome = await probe({
      fetchImpl: fetchReturning(
        { data: null, meta: {}, error: { code: ApiErrorCode.Forbidden, message: '无权限' } },
        { status: 403 },
      ),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.warning).toContain('profile:self:read');
    expect(outcome.error).toBeUndefined();
  });

  it('404（尚未提交画像）→ 认票据，不当成失败', async () => {
    const outcome = await probe({
      fetchImpl: fetchReturning(
        { data: null, meta: {}, error: { code: ApiErrorCode.NotFound, message: '不存在' } },
        { status: 404 },
      ),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.warning).toBeUndefined();
  });

  it('网络错误 / 超时 → fail-closed，返回失败而不是放行', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const network = await probe({ fetchImpl: failing });
    expect(network.ok).toBe(false);
    expect(network.error?.kind).toBe('network');

    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      })) as unknown as typeof fetch;
    const timeout = await probe({ fetchImpl: hanging, timeoutMs: 10 });
    expect(timeout.ok).toBe(false);
    expect(timeout.error?.kind).toBe('timeout');
  });
});

/**
 * 联调连通性探测（登录页的「联调入口」用它回答「地址通不通」）。
 *
 * 关键不变量：探测是**匿名**的——它发生在登录之前，绝不能把任何票据发往尚未确认的目标。
 */
describe('联调连通性探测（probeApiHealth）', () => {
  it('200 → 可达，并原样带出健康信息', async () => {
    const result = await probeApiHealth({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning(
        ok({ status: 'ok', service: 'api', version: '0.1.0', uptimeSeconds: 1, timestamp: 'x' }),
      ),
    });

    expect(result.ok).toBe(true);
    expect(result.health?.service).toBe('api');
    expect(result.error).toBeUndefined();
  });

  it('匿名：探测请求不带 Authorization 头（票据不会在登录前被发往任何目标）', async () => {
    const calls: FetchArgs[] = [];
    await probeApiHealth({
      baseUrl: 'http://127.0.0.1:3000/api/v1',
      fetchImpl: fetchReturning(ok({ status: 'ok' }), { calls }),
    });

    expect(String(calls[0]?.[0])).toBe('http://127.0.0.1:3000/api/v1/health');
    expect((calls[0]?.[1]?.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('API 不可达 → 明确的网络错误，而不是「连通」', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const result = await probeApiHealth({ baseUrl: '/api/v1', fetchImpl: failing });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('network');
    expect(result.health).toBeUndefined();
  });

  it('503 → 归为「服务暂不可用」，与 500 区分', async () => {
    const result = await probeApiHealth({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning(
        {
          data: null,
          meta: {},
          error: { code: ApiErrorCode.AiUnavailable, message: '依赖不可用' },
        },
        { status: 503 },
      ),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ kind: 'service-unavailable', status: 503 });
  });

  it('响应不符合信封契约 → 归为契约违规，绝不当成连通', async () => {
    const result = await probeApiHealth({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning('<html>proxy error</html>'),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('contract');
  });

  it('基地址非法 → fail-closed：不发起任何请求', async () => {
    const calls: FetchArgs[] = [];
    const result = await probeApiHealth({
      baseUrl: '//evil.example.com/api/v1',
      fetchImpl: fetchReturning(ok({}), { calls }),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('configuration');
    expect(calls).toHaveLength(0);
  });
});

describe('401 会话失效处理（expireSession）', () => {
  it('清空已登录会话并给出过期提示：结果恒为匿名', () => {
    const storage = memoryStorage(REAL_SESSION);
    expect(readSession(storage).status).toBe('authenticated');

    const expiry = expireSession(storage);

    expect(expiry.state).toEqual(ANONYMOUS);
    expect(expiry.state.status).toBe('anonymous');
    expect(expiry.notice).toBe(SESSION_EXPIRED_NOTICE);
    // 存储里的键被删除，而不是写入一个「空会话」；票据不留存
    expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(false);
    expect(readSession(storage)).toEqual(ANONYMOUS);
    expect(JSON.stringify([...storage.data.values()])).not.toContain('ticket-abcd1234');
  });

  it('存储不可用（null / 抛异常）时不抛错，仍返回匿名状态', () => {
    expect(expireSession(null).state).toEqual(ANONYMOUS);

    const hostile: SessionStorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => expireSession(hostile)).not.toThrow();
    expect(expireSession(hostile).notice).toBe(SESSION_EXPIRED_NOTICE);
  });

  /**
   * 端到端（无 React）：把客户端的 401 回调接到会话层，验证
   * 「401 客户端响应 → 会话被清空」，且不会被写成任何形式的已登录状态。
   */
  it('客户端 401 → 回调清空会话；403 不触发登出（回归）', async () => {
    const storage = memoryStorage(REAL_SESSION);
    const notices: string[] = [];
    const codes: string[] = [];
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
      tokenProvider: () => 'ticket-abcd1234',
      onUnauthorized: (error) => {
        codes.push(error.code);
        notices.push(expireSession(storage).notice);
      },
    });

    await expect(client.getJson('/me/profile')).rejects.toMatchObject({ status: 401 });
    expect(codes).toEqual([ApiErrorCode.Unauthenticated]);
    expect(notices).toEqual([SESSION_EXPIRED_NOTICE]);
    expect(readSession(storage)).toEqual(ANONYMOUS);

    const forbiddenStorage = memoryStorage(REAL_SESSION);
    let forbiddenCallbacks = 0;
    const forbiddenClient = createApiClient({
      baseUrl: '/api/v1',
      fetchImpl: fetchReturning(
        { data: null, meta: {}, error: { code: ApiErrorCode.Forbidden, message: '无权限' } },
        { status: 403 },
      ),
      onUnauthorized: () => {
        forbiddenCallbacks += 1;
        expireSession(forbiddenStorage);
      },
    });

    await expect(forbiddenClient.getJson('/admin/applications')).rejects.toMatchObject({
      status: 403,
    });
    expect(forbiddenCallbacks).toBe(0);
    expect(readSession(forbiddenStorage).status).toBe('authenticated');
  });
});
