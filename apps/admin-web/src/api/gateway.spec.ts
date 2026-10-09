import { ApplicationStatus, ok } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from './client';
import type { ApiClient } from './client';
import { DEMO_PROFILE } from './demo-data';
import { DEMO_READ_ONLY_MESSAGE, createDemoGateway, createLiveGateway } from './gateway';
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
      throw new Error('未预期的 POST');
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
});
