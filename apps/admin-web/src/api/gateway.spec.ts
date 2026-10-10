import { ApplicationStatus, ok } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import {
  ApiClientError,
  INVALID_BASE_URL_CODE,
  INVALID_RESPONSE_CODE,
  createApiClient,
} from './client';
import type { ApiClient } from './client';
import { DEMO_PROFILE } from './demo-data';
import {
  DEMO_READ_ONLY_MESSAGE,
  createDemoGateway,
  createLiveGateway,
  createMisconfiguredGateway,
} from './gateway';
import type { AdminApplicationListItem } from './types';

interface RecordedCall {
  method: 'GET' | 'PATCH' | 'POST';
  path: string;
  body?: unknown;
}

interface StubClient {
  client: ApiClient;
  calls: RecordedCall[];
}

function stubClient(
  handlers: {
    getJson?: (path: string) => Promise<unknown>;
    getEnvelope?: (path: string) => Promise<unknown>;
    patchJson?: (path: string, body: unknown) => Promise<unknown>;
    postJson?: (path: string, body: unknown) => Promise<unknown>;
  } = {},
): StubClient {
  const calls: RecordedCall[] = [];
  const client: ApiClient = {
    baseUrl: '/api/v1',
    async getJson<T>(path: string): Promise<T> {
      calls.push({ method: 'GET', path });
      return (await handlers.getJson?.(path)) as T;
    },
    async getEnvelope<T>(path: string): Promise<ApiEnvelope<T>> {
      calls.push({ method: 'GET', path });
      return (await handlers.getEnvelope?.(path)) as ApiEnvelope<T>;
    },
    async postJson<T>(path: string, body: unknown): Promise<T> {
      calls.push({ method: 'POST', path, body });
      if (handlers.postJson === undefined) {
        throw new Error('未预期的 POST');
      }
      return (await handlers.postJson(path, body)) as T;
    },
    async patchJson<T>(path: string, body: unknown): Promise<T> {
      calls.push({ method: 'PATCH', path, body });
      return (await handlers.patchJson?.(path, body)) as T;
    },
  };
  return { client, calls };
}

const ITEM: AdminApplicationListItem = {
  id: '00000000-0000-4000-8000-000000000001',
  groupId: '11111111-1111-4111-8111-000000000001',
  kind: 'join',
  status: ApplicationStatus.Pending,
  createdAt: '2026-10-01T01:00:00.000Z',
  updatedAt: '2026-10-01T01:00:00.000Z',
};

describe('联调网关', () => {
  it('申请列表：拼查询串并采信服务端 meta', async () => {
    const { client, calls } = stubClient({
      getEnvelope: async () => ok([ITEM], { page: 2, pageSize: 20, total: 41, totalPages: 3 }),
    });
    const gateway = createLiveGateway(client);

    const page = await gateway.loadApplications({
      page: 2,
      pageSize: 20,
      status: ApplicationStatus.Pending,
    });

    expect(calls[0]?.path).toBe('/admin/applications?page=2&pageSize=20&status=pending');
    expect(page.total).toBe(41);
    expect(page.totalPages).toBe(3);
    expect(page.items).toHaveLength(1);
  });

  it('申请列表：meta 缺失时 total 为 null，绝不用当前页条数冒充总数', async () => {
    const { client } = stubClient({ getEnvelope: async () => ok([ITEM, ITEM]) });
    const gateway = createLiveGateway(client);

    const page = await gateway.loadApplications({ page: 1, pageSize: 20 });
    expect(page.total).toBeNull();
    expect(page.totalPages).toBeNull();
    expect(page.page).toBe(1);
    expect(page.items).toHaveLength(2);
  });

  it('申请列表：data 为 null 时是空列表，不是崩溃', async () => {
    const { client } = stubClient({
      getEnvelope: async () => ({ data: null, meta: {}, error: null }),
    });
    const gateway = createLiveGateway(client);
    const page = await gateway.loadApplications({ page: 1, pageSize: 20 });
    expect(page.items).toEqual([]);
    expect(page.total).toBeNull();
  });

  it('管理端统计：未实现的端点归为 pending，而不是「暂无数据」或故障', async () => {
    const { client } = stubClient({
      getJson: async (path) => {
        throw new ApiClientError('HTTP_404', '找不到路由', { status: 404, requestId: path });
      },
    });
    const gateway = createLiveGateway(client);

    const results = await gateway.loadAdminStatistics();
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.status).toBe('pending');
      expect(result.metrics).toEqual([]);
      if (result.status === 'pending') {
        expect(result.reason).toContain('尚未实现');
      }
    }
  });

  it('管理端统计：端点响应后只记录「能取到」，不解析未确认字段', async () => {
    const { client } = stubClient({ getJson: async () => ({ total: 5, columns: ['x'] }) });
    const gateway = createLiveGateway(client);
    const results = await gateway.loadAdminStatistics();
    for (const result of results) {
      expect(result.status).toBe('ready');
      expect(result.metrics).toEqual([]);
    }
  });

  it('管理端统计：5xx 归为错误（需要排查），不与计划内缺口混为一谈', async () => {
    const { client } = stubClient({
      getJson: async () => {
        throw new ApiClientError('HTTP_500', '服务端异常', { status: 500 });
      },
    });
    const results = await createLiveGateway(client).loadAdminStatistics();
    for (const result of results) {
      expect(result.status).toBe('error');
    }
  });

  it('画像更新走真实 PATCH，并如实抛错', async () => {
    const { client, calls } = stubClient({
      patchJson: async () => {
        throw new ApiClientError('FORBIDDEN', '没有执行该操作的权限', { status: 403 });
      },
    });
    const gateway = createLiveGateway(client);
    await expect(gateway.updateProfile({ name: '新名字' })).rejects.toMatchObject({ status: 403 });
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.path).toBe('/me/profile');
    expect(calls[0]?.body).toEqual({ name: '新名字' });
  });

  it('联调模式不展示演示标注', () => {
    expect(createLiveGateway(stubClient().client).notice).toBeNull();
  });
});

const EXPORT_VIEW = {
  id: '00000000-0000-4000-8000-000000000001',
  resource: 'profile',
  fields: ['name', 'grade'],
  status: 'pending',
  createdAt: '2026-10-10T01:00:00.000Z',
  updatedAt: '2026-10-10T02:00:00.000Z',
};

describe('联调网关：本人导出', () => {
  it('列表只带服务端声明的 cursor；无游标时不带查询串', async () => {
    const { client, calls } = stubClient({
      getEnvelope: async () => ok([EXPORT_VIEW], { limit: 20, hasNext: false, nextCursor: null }),
    });
    const gateway = createLiveGateway(client);

    const page = await gateway.loadMyExports();
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('/me/exports');
    expect(page.items).toHaveLength(1);
    expect(page.limit).toBe(20);
    expect(page.hasNext).toBe(false);
  });

  it('续页只提交 cursor，不提交 limit / status / owner 之类未声明参数', async () => {
    const { client, calls } = stubClient({
      getEnvelope: async () => ok([EXPORT_VIEW], { hasNext: false, nextCursor: null }),
    });
    await createLiveGateway(client).loadMyExports({ cursor: 'a/b+c' });
    expect(calls[0]?.path).toBe('/me/exports?cursor=a%2Fb%2Bc');
  });

  it('撤销：POST 到契约路径，**不带请求体**（归属 / 产物 / 路径都没有客户端入口）', async () => {
    const { client, calls } = stubClient({
      postJson: async () => ({ ...EXPORT_VIEW, status: 'revoked' }),
    });
    const view = await createLiveGateway(client).revokeExport(EXPORT_VIEW.id);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe(`/me/exports/${EXPORT_VIEW.id}/revoke`);
    expect(calls[0]?.body).toBeUndefined();
    expect(JSON.stringify(calls[0])).not.toContain('owner');
    expect(view.status).toBe('revoked');
  });

  it('撤销：服务端响应只保留白名单字段（归属 / 产物 / 路径不外泄到界面）', async () => {
    const { client } = stubClient({
      postJson: async () => ({
        ...EXPORT_VIEW,
        status: 'revoked',
        ownerUserId: '99999999-0000-4000-8000-000000000001',
        artifactId: 'aaaaaaaa-0000-4000-8000-000000000001',
        path: '/var/x.zip',
      }),
    });
    const view = await createLiveGateway(client).revokeExport(EXPORT_VIEW.id);
    expect(Object.keys(view).sort()).toEqual([
      'createdAt',
      'fields',
      'id',
      'resource',
      'status',
      'updatedAt',
    ]);
  });

  it('撤销：401 / 403 / 503 原样抛出，状态码不被吞掉（由既有错误映射分类）', async () => {
    for (const status of [401, 403, 503]) {
      const { client } = stubClient({
        postJson: async () => {
          throw new ApiClientError(`HTTP_${String(status)}`, 'x', { status });
        },
      });
      await expect(createLiveGateway(client).revokeExport(EXPORT_VIEW.id)).rejects.toMatchObject({
        status,
      });
    }
  });

  it('撤销：空导出 ID fail fast，请求根本不会发出（不拼半截路径）', async () => {
    const { client, calls } = stubClient({ postJson: async () => EXPORT_VIEW });
    await expect(createLiveGateway(client).revokeExport('')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  /**
   * 导出 ID 由客户端原样给出、由服务端判定：带 `/` 的取值被百分号编码成**一个路径段**，
   * 因此它不可能指向别人的资源路径；服务端再以 UUID 形态门禁统一拒绝（同一个 404）。
   * 前端不在这里猜「这个 ID 存不存在」，也不改写成别的请求。
   */
  it('撤销：路径穿越形态的导出 ID 被编码为单段路径，不被前端改写', async () => {
    const { client, calls } = stubClient({ postJson: async () => EXPORT_VIEW });
    await createLiveGateway(client).revokeExport('../../etc/passwd');
    expect(calls[0]?.path).toBe('/me/exports/..%2F..%2Fetc%2Fpasswd/revoke');
  });

  it('列表形状违规 → 契约违规错误（不静默丢行、不当成空列表）', async () => {
    const { client } = stubClient({
      getEnvelope: async () => ok([EXPORT_VIEW, { ...EXPORT_VIEW, id: 7 }], {}),
    });
    await expect(createLiveGateway(client).loadMyExports()).rejects.toMatchObject({
      code: INVALID_RESPONSE_CODE,
    });
  });

  it('撤销响应形状违规 → 契约违规错误（不把未知形状当成撤销成功）', async () => {
    const { client } = stubClient({ postJson: async () => ({ status: 'revoked' }) });
    await expect(createLiveGateway(client).revokeExport(EXPORT_VIEW.id)).rejects.toMatchObject({
      code: INVALID_RESPONSE_CODE,
    });
  });
});

describe('基地址非法时的不可用网关', () => {
  const error = new ApiClientError(INVALID_BASE_URL_CODE, 'API 基地址不合法（含反斜杠）');

  it('一切取数都以配置错误失败：不返回空数据、不返回演示数据', async () => {
    const gateway = createMisconfiguredGateway(error);
    expect(gateway.mode).toBe('live');
    expect(gateway.notice).toBeNull();

    await expect(gateway.loadProfile()).rejects.toBe(error);
    await expect(gateway.loadHealth()).rejects.toMatchObject({
      code: INVALID_BASE_URL_CODE,
    });
    await expect(gateway.loadSelfStatistics()).rejects.toMatchObject({
      code: INVALID_BASE_URL_CODE,
    });
    await expect(gateway.loadAdminStatistics()).rejects.toMatchObject({
      code: INVALID_BASE_URL_CODE,
    });
    await expect(gateway.loadApplications({ page: 1, pageSize: 20 })).rejects.toMatchObject({
      code: INVALID_BASE_URL_CODE,
    });
    await expect(gateway.updateProfile({ name: 'x' })).rejects.toMatchObject({
      code: INVALID_BASE_URL_CODE,
    });
    await expect(gateway.loadMyExports()).rejects.toMatchObject({ code: INVALID_BASE_URL_CODE });
    await expect(gateway.revokeExport('x')).rejects.toMatchObject({ code: INVALID_BASE_URL_CODE });
  });
});

describe('演示网关', () => {
  it('不持有 ApiClient，因此无法发请求、无法写入', async () => {
    const gateway = createDemoGateway();
    expect(gateway.mode).toBe('demo');
    expect(gateway.notice).not.toBeNull();
    await expect(gateway.updateProfile({ name: 'x' })).rejects.toMatchObject({
      code: 'DEMO_READ_ONLY',
      message: DEMO_READ_ONLY_MESSAGE,
    });
  });

  it('健康检查返回 null：不编造后端健康状态', async () => {
    expect(await createDemoGateway().loadHealth()).toBeNull();
  });

  it('画像返回副本，修改展示对象不污染夹具', async () => {
    const gateway = createDemoGateway();
    const profile = await gateway.loadProfile();
    profile.name = '被就地修改';
    profile.skills.push('注入技能');
    expect(DEMO_PROFILE.name).not.toBe('被就地修改');
    expect(DEMO_PROFILE.skills).not.toContain('注入技能');
  });

  it('申请列表按状态过滤，分页语义与后端同构', async () => {
    const gateway = createDemoGateway();
    const page = await gateway.loadApplications({
      page: 1,
      pageSize: 20,
      status: ApplicationStatus.Pending,
    });
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.every((item) => item.status === ApplicationStatus.Pending)).toBe(true);
  });

  it('管理端统计返回三个来源的演示指标（标注由界面负责）', async () => {
    const results = await createDemoGateway().loadAdminStatistics();
    expect(results.map((result) => result.source)).toEqual(['flow', 'achievements', 'education']);
    for (const result of results) {
      expect(result.status).toBe('ready');
      expect(result.metrics.length).toBeGreaterThan(0);
    }
  });

  it('导出列表返回夹具（五种状态各一条），且不模拟游标分页', async () => {
    const page = await createDemoGateway().loadMyExports();
    expect(page.items.map((item) => item.status).sort()).toEqual([
      'completed',
      'expired',
      'failed',
      'pending',
      'revoked',
    ]);
    // 演示网关没有服务端：绝不签发一个「还有下一页」的游标
    expect(page.hasNext).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('导出夹具返回副本：就地修改不污染夹具', async () => {
    const page = await createDemoGateway().loadMyExports();
    const first = page.items[0];
    expect(first).toBeDefined();
    first?.fields.push('注入字段');
    const again = await createDemoGateway().loadMyExports();
    expect(again.items[0]?.fields).not.toContain('注入字段');
  });

  /**
   * 演示模式**不发任何请求**：演示网关不持有 ApiClient（结构上不可），且写操作一律被拒绝，
   * 绝不返回本地「假装撤销成功」的结果。
   */
  it('演示模式拒绝撤销：抛 DEMO_READ_ONLY，不返回任何撤销结果', async () => {
    const gateway = createDemoGateway();
    await expect(
      gateway.revokeExport('00000000-0000-4000-8000-000000000001'),
    ).rejects.toMatchObject({
      code: 'DEMO_READ_ONLY',
      message: DEMO_READ_ONLY_MESSAGE,
    });
  });
});

/**
 * 真实客户端 + 真实网关的联调回归：证明撤销**复用既有 API 客户端**（而不是另起一套请求），
 * 并且会话票据只出现在 `Authorization` 头上——前端代码不读取、不保存、不展示它。
 */
describe('真实 API 客户端下的撤销（Authorization 注入与票据不落地）', () => {
  const TICKET = 'ticket-abcd1234';

  interface RecordedRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }

  function recordingFetch(body: unknown): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
    const requests: RecordedRequest[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers,
        body: init?.body,
      });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, requests };
  }

  it('撤销请求带 Authorization、无请求体、无 content-type；界面拿到的视图不含票据', async () => {
    const { fetchImpl, requests } = recordingFetch(
      ok({ ...EXPORT_VIEW, status: 'revoked' }, { requestId: 'req-1' }),
    );
    const client = createApiClient({
      baseUrl: 'http://127.0.0.1:3000/api/v1',
      fetchImpl,
      tokenProvider: () => TICKET,
    });

    const view = await createLiveGateway(client).revokeExport(EXPORT_VIEW.id);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      `http://127.0.0.1:3000/api/v1/me/exports/${EXPORT_VIEW.id}/revoke`,
    );
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers['authorization']).toBe(`Bearer ${TICKET}`);
    // 撤销端点不接受任何请求体字段：既没有 body，也没有 content-type
    expect(requests[0]?.body).toBeUndefined();
    expect(requests[0]?.headers['content-type']).toBeUndefined();
    // 票据绝不进入业务视图（因此也不可能被渲染出来）
    expect(JSON.stringify(view)).not.toContain(TICKET);
  });

  it('列表请求同样只经 Authorization 注入票据，且 URL 里不出现归属或票据', async () => {
    const { fetchImpl, requests } = recordingFetch(
      ok([EXPORT_VIEW], { limit: 20, hasNext: false, nextCursor: null }),
    );
    const client = createApiClient({
      baseUrl: 'http://127.0.0.1:3000/api/v1',
      fetchImpl,
      tokenProvider: () => TICKET,
    });

    const page = await createLiveGateway(client).loadMyExports();
    const url = requests[0]?.url ?? '';
    expect(url).toBe('http://127.0.0.1:3000/api/v1/me/exports');
    expect(url).not.toContain(TICKET);
    expect(url).not.toContain('userId');
    expect(requests[0]?.headers['authorization']).toBe(`Bearer ${TICKET}`);
    expect(JSON.stringify(page)).not.toContain(TICKET);
  });

  it('匿名（无票据）时不带 Authorization 头：客户端不会伪造凭据', async () => {
    const { fetchImpl, requests } = recordingFetch(ok(EXPORT_VIEW));
    const client = createApiClient({
      baseUrl: 'http://127.0.0.1:3000/api/v1',
      fetchImpl,
      tokenProvider: () => null,
    });

    await createLiveGateway(client).revokeExport(EXPORT_VIEW.id);
    expect(requests[0]?.headers['authorization']).toBeUndefined();
  });
});
