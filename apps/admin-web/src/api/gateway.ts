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
  demoExportItems,
} from './demo-data';
import { ENDPOINTS, endpointPath, endpointRef } from './endpoints';
import {
  buildExportCursorQuery,
  contractError,
  readExportPage,
  readExportView,
} from './export-view';
import { looksLikePendingEndpoint, toUiError } from './errors';
import { ADMIN_STATISTICS_SOURCES } from './types';
import type {
  AdminApplicationPage,
  AdminApplicationQuery,
  AdminApplicationListItem,
  ExportRequestView,
  HealthView,
  MyExportPage,
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
  /**
   * 本人导出记录的一页（键集分页）。`cursor` 是服务端签发的不透明游标：
   * 前端只负责原样带回，**不解析、不构造、不缓存**。
   */
  loadMyExports(options?: MyExportsQuery): Promise<MyExportPage>;
  /**
   * **撤销本人的导出请求**（`POST /me/exports/:exportId/revoke`）。
   *
   * 入参只有路径参数 `exportId`：不发请求体、不带查询串，因此不存在「客户端提交归属 / 产物 /
   * 路径」的入口——归属由服务端的会话主体决定（Authorization 由 api client 统一注入）。
   * 幂等：重复撤销同样返回已撤销的视图。演示模式**拒绝**该写操作（`DEMO_READ_ONLY`），
   * 且演示网关不持有任何 `ApiClient`，因此结构上不可能发出请求。
   */
  revokeExport(exportId: string): Promise<ExportRequestView>;
}

export interface MyExportsQuery {
  /** 服务端上一页返回的 `nextCursor`；省略即取第一页 */
  readonly cursor?: string;
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

    /**
     * 本人导出列表：只带服务端声明的 `cursor`（服务端默认页大小），并**按白名单读取**响应。
     * 形状不符即抛契约违规错误：宁可让这一页显示为「响应不符合接口契约」，也不静默丢行。
     */
    async loadMyExports(options: MyExportsQuery = {}): Promise<MyExportPage> {
      const envelope = await client.getEnvelope<unknown>(
        `${ENDPOINTS.myExports.path}${buildExportCursorQuery(options)}`,
      );
      const page = readExportPage(envelope.data, envelope.meta as Record<string, unknown>);
      if (page === null) {
        throw contractError();
      }
      return page;
    },

    /**
     * 撤销本人导出：**没有请求体、没有查询串**。
     *
     * `client.postJson(path, undefined)` 刻意传 `undefined` 而不是 `{}`：客户端只在 body
     * 不是 `undefined` 时才发送请求体与 `content-type`，因此这条请求在线上就是一个裸 POST +
     * `Authorization`（票据由 `tokenProvider` 注入，前端代码从不读取或暂存它）。
     * 路径参数经 `endpointPath` 单点校验与转义（含 `/`、空串一律 fail fast）。
     */
    async revokeExport(exportId: string): Promise<ExportRequestView> {
      const data = await client.postJson<unknown>(
        endpointPath(ENDPOINTS.exportRevoke, { exportId }),
        undefined,
      );
      const view = readExportView(data);
      if (view === null) {
        throw contractError();
      }
      return view;
    },
  };
}

/**
 * 基地址非法时的**不可用网关**：所有取数一律以同一个配置错误失败。
 *
 * 为什么不返回空数据、也不返回演示数据：空集会被界面渲染成「没有记录」，演示数据会被渲染成
 * 业务事实——两者都把一次前端配置故障说成了数据结论。fail-closed 的失败面是唯一诚实的表达，
 * 而且它让错误沿着既有的「可重试错误」通路显示，不需要任何新的界面分支。
 */
export function createMisconfiguredGateway(error: ApiClientError): AdminGateway {
  const reject = async (): Promise<never> => {
    throw error;
  };
  return {
    // 仍然是 live：它没有、也不会用任何夹具数据，只是连基地址都不合法而已。
    mode: 'live',
    notice: null,
    loadHealth: () => reject(),
    loadProfile: () => reject(),
    updateProfile: () => reject(),
    loadSelfStatistics: () => reject(),
    loadAdminStatistics: () => reject(),
    loadApplications: () => reject(),
    loadMyExports: () => reject(),
    revokeExport: () => reject(),
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

    /**
     * 演示导出记录：一次性返回夹具（`hasNext: false`、`nextCursor: null`），
     * **不模拟游标分页**——伪造一个可续页的游标会让界面显示「还有下一页」却拿不到数据。
     * `cursor` 参数被忽略：演示网关不接受任何分页输入，因为它根本没有服务端。
     */
    async loadMyExports(): Promise<MyExportPage> {
      await wait();
      const items = demoExportItems();
      return { items, limit: items.length, hasNext: false, nextCursor: null };
    },

    /**
     * 演示模式**拒绝**撤销：这是写操作，演示网关既不持有 `ApiClient`（结构上发不出请求），
     * 也返回本地「假装撤销成功」的结果——那正是本项目禁止的（见 `DEMO_READ_ONLY_MESSAGE`）。
     */
    async revokeExport(): Promise<ExportRequestView> {
      await wait();
      throw new ApiClientError('DEMO_READ_ONLY', DEMO_READ_ONLY_MESSAGE);
    },
  };
}
