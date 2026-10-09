import { ApiClientError, buildPageQuery } from './client';
import type { ApiClient } from './client';
import {
  DEMO_ADMIN_STATISTICS,
  DEMO_APPLICATIONS,
  DEMO_DATA_NOTICE,
  DEMO_FIXTURE_VERSION,
  DEMO_PROFILE,
  DEMO_SELF_STATISTICS,
  buildDemoApplicationPage,
} from './demo-data';
import { ENDPOINTS, endpointRef } from './endpoints';
import { looksLikePendingEndpoint, toUiError } from './errors';
import { ADMIN_STATISTICS_SOURCES } from './types';
import type {
  AdminApplicationPage,
  AdminApplicationQuery,
  AdminApplicationListItem,
  HealthView,
  SelfStatisticsView,
  StatisticsSourceResult,
  StudentProfileView,
} from './types';

/**
 * 取数网关：**页面唯一的取数入口**。
 *
 * 为什么要有网关而不是让页面直接调 client：
 * 1. 后端切片与本 MVP 并行时，替换点在网关内部，页面零改动；
 * 2. 演示模式与联调模式在**结构上**分离：`createDemoGateway` 不持有 `ApiClient`，
 *    因此演示模式在代码层面就无法发出请求，更不可能写入数据；
 * 3. 越权边界清晰：演示模式对写操作直接抛错（`DEMO_READ_ONLY`），而不是本地改一改内存
 *    假装保存成功。
 */

/** 画像更新允许提交的字段子集（与共享 `studentProfileInputSchema` 的字段名一致） */
export type ProfilePatch = Partial<
  Pick<
    StudentProfileView,
    | 'name'
    | 'college'
    | 'major'
    | 'grade'
    | 'skills'
    | 'programmingLevel'
    | 'researchInterests'
    | 'intendedFields'
    | 'strengths'
  >
>;

export interface AdminGateway {
  readonly mode: 'live' | 'demo';
  /** 非空时界面必须全程展示「演示数据」标注 */
  readonly notice: string | null;
  readonly fixtureVersion?: string;
  /** 演示模式返回 null：不连接后端，也**不编造**一份健康状态 */
  loadHealth(): Promise<HealthView | null>;
  loadProfile(): Promise<StudentProfileView>;
  updateProfile(patch: ProfilePatch): Promise<StudentProfileView>;
  loadSelfStatistics(): Promise<SelfStatisticsView>;
  loadAdminStatistics(): Promise<StatisticsSourceResult[]>;
  loadApplications(query: AdminApplicationQuery): Promise<AdminApplicationPage>;
}

export const DEMO_READ_ONLY_MESSAGE =
  '演示模式为只读：本操作不会写入任何数据。请在联调模式下、由后端切片提供真实端点后重试。';

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toApplicationPage(
  query: AdminApplicationQuery,
  data: unknown,
  meta: Readonly<Record<string, unknown>>,
): AdminApplicationPage {
  const items = Array.isArray(data) ? (data as AdminApplicationListItem[]) : [];
  return {
    items,
    page: numberOrNull(meta['page']) ?? query.page,
    pageSize: numberOrNull(meta['pageSize']) ?? query.pageSize,
    // 服务端没给 total 时保留 null：绝不用「当前页条数」冒充总数
    total: numberOrNull(meta['total']),
    totalPages: numberOrNull(meta['totalPages']),
  };
}

export function createLiveGateway(client: ApiClient): AdminGateway {
  return {
    mode: 'live',
    notice: null,

    async loadHealth(): Promise<HealthView | null> {
      return client.getJson<HealthView>(ENDPOINTS.health.path);
    },

    async loadProfile(): Promise<StudentProfileView> {
      return client.getJson<StudentProfileView>(ENDPOINTS.profileRead.path);
    },

    async updateProfile(patch: ProfilePatch): Promise<StudentProfileView> {
      return client.patchJson<StudentProfileView>(ENDPOINTS.profileUpdate.path, patch);
    },

    async loadSelfStatistics(): Promise<SelfStatisticsView> {
      return client.getJson<SelfStatisticsView>(ENDPOINTS.selfStatistics.path);
    },

    async loadAdminStatistics(): Promise<StatisticsSourceResult[]> {
      const results: StatisticsSourceResult[] = [];
      for (const source of ADMIN_STATISTICS_SOURCES) {
        const descriptor =
          source === 'flow'
            ? ENDPOINTS.adminStatisticsFlow
            : source === 'achievements'
              ? ENDPOINTS.adminStatisticsAchievements
              : ENDPOINTS.adminStatisticsEducation;
        try {
          await client.getJson<unknown>(descriptor.path);
          // 只有「能取到」是事实：响应字段形状尚未确认，因此不解析、不展示任何具体指标，
          // 避免把未确认的字段名变成界面逻辑。
          results.push({ source, status: 'ready', metrics: [] });
        } catch (caught) {
          const error = toUiError(caught, endpointRef(descriptor));
          if (looksLikePendingEndpoint(error, descriptor.status)) {
            results.push({
              source,
              status: 'pending',
              metrics: [],
              reason: `${endpointRef(descriptor)} 尚未实现（后端切片未上线）`,
            });
          } else {
            results.push({ source, status: 'error', metrics: [], error });
          }
        }
      }
      return results;
    },

    async loadApplications(query: AdminApplicationQuery): Promise<AdminApplicationPage> {
      const envelope = await client.getEnvelope<AdminApplicationListItem[]>(
        `${ENDPOINTS.adminApplications.path}${buildPageQuery(query)}`,
      );
      return toApplicationPage(query, envelope.data, envelope.meta as Record<string, unknown>);
    },
  };
}

export interface DemoGatewayOptions {
  /** 注入延迟用于走查 loading 态；默认 0，测试保持确定性 */
  latencyMs?: number;
  fixtureVersion?: string;
}

export function createDemoGateway(options: DemoGatewayOptions = {}): AdminGateway {
  const latencyMs = options.latencyMs ?? 0;
  const wait = async (): Promise<void> => {
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }
  };

  return {
    mode: 'demo',
    notice: DEMO_DATA_NOTICE,
    fixtureVersion: options.fixtureVersion ?? DEMO_FIXTURE_VERSION,

    async loadHealth(): Promise<HealthView | null> {
      await wait();
      return null;
    },

    async loadProfile(): Promise<StudentProfileView> {
      await wait();
      return {
        ...DEMO_PROFILE,
        skills: [...DEMO_PROFILE.skills],
        researchInterests: [...DEMO_PROFILE.researchInterests],
        intendedFields: [...DEMO_PROFILE.intendedFields],
        availableTime: {
          ...DEMO_PROFILE.availableTime,
          periods: [...DEMO_PROFILE.availableTime.periods],
        },
      };
    },

    async updateProfile(): Promise<StudentProfileView> {
      await wait();
      throw new ApiClientError('DEMO_READ_ONLY', DEMO_READ_ONLY_MESSAGE);
    },

    async loadSelfStatistics(): Promise<SelfStatisticsView> {
      await wait();
      return { ...DEMO_SELF_STATISTICS };
    },

    async loadAdminStatistics(): Promise<StatisticsSourceResult[]> {
      await wait();
      return ADMIN_STATISTICS_SOURCES.map((source) => ({
        source,
        status: 'ready' as const,
        metrics: [...(DEMO_ADMIN_STATISTICS[source] ?? [])],
      }));
    },

    async loadApplications(query: AdminApplicationQuery): Promise<AdminApplicationPage> {
      await wait();
      const page = buildDemoApplicationPage(
        {
          page: query.page,
          pageSize: query.pageSize,
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.keyword === undefined ? {} : { keyword: query.keyword }),
        },
        DEMO_APPLICATIONS,
      );
      return {
        items: page.items,
        page: page.page,
        pageSize: page.pageSize,
        total: page.total,
        totalPages: page.totalPages,
      };
    },
  };
}
