import type {
  ApplicationKind,
  ApplicationStatus,
  AvailablePeriod,
  Grade,
  ProgrammingLevel,
  ReviewStatus,
} from '@rm/shared';
import type { UiError } from './errors';

/**
 * 管理端只读视图类型（前端侧声明）。
 *
 * 原则：**已稳定**的后端契约（本人画像、本人统计、健康检查、入组申请视图）在此逐字段镜像；
 * 尚未稳定的管理端契约（审核切片、管理端统计）只声明**已知字段**，其余一律标注为
 * 「待后端切片确认」，界面在字段缺失时显示占位符，绝不据此做任何授权或状态判定。
 * 这样做的好处是：后端契约一旦稳定，替换点集中在 `endpoints.ts` / `gateway.ts` 与类型别名，
 * 页面组件无需改动。
 */

/** `GET /health`（稳定） */
export interface HealthView {
  status: string;
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  prefix?: string;
}

/** `GET /me/profile`（稳定，镜像 services/api 的 `StudentProfileView`，不含学号/手机号） */
export interface StudentProfileView {
  name: string;
  college: string;
  major: string;
  grade: Grade;
  skills: string[];
  programmingLevel: ProgrammingLevel;
  researchExperience?: string;
  competitionExperience?: string;
  availableTime: {
    weeklyHours: number;
    periods: AvailablePeriod[];
    note?: string;
  };
  researchInterests: string[];
  strengths?: string;
  intendedFields: string[];
  createdAt: string;
  updatedAt: string;
}

/** `GET /me/statistics`（稳定）：四个计数的白名单闭集 */
export interface SelfStatisticsView {
  readonly educationRecords: number;
  readonly applications: number;
  readonly achievements: number;
  readonly matchingRequests: number;
}

/** 入组/退组申请视图（镜像 services/api 的 `ApplicationView`，稳定） */
export interface ApplicationView {
  id: string;
  groupId: string;
  kind: ApplicationKind;
  note?: string;
  status: ApplicationStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * 管理端申请列表条目：在 `ApplicationView` 之上附加**审核切片专属**的展示字段。
 *
 * 这些字段由并行的后端审核切片定义，尚未稳定，因此全部可选：
 * 缺失时界面显示「—」，不会把缺失当成「无申请人」之类的业务结论。
 */
export interface AdminApplicationListItem extends ApplicationView {
  /** 待审核切片确认：申请人展示名（服务端按范围与脱敏规则决定是否下发） */
  applicantName?: string;
  /** 待审核切片确认：小组展示名 */
  groupName?: string;
  /** 待审核切片确认：审核状态（与申请状态机解耦的独立维度） */
  reviewStatus?: ReviewStatus;
}

/** 管理端申请列表查询（契约基线定义分页、排序与过滤；服务端强制 pageSize 上限） */
export interface AdminApplicationQuery {
  page: number;
  pageSize: number;
  status?: ApplicationStatus;
  keyword?: string;
  sortBy?: 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

/**
 * 管理端申请分页结果。
 *
 * 刻意**不直接复用**共享的 `Paginated<T>`：它要求 `total`/`totalPages` 是确定的数字，而
 * 当前后端对普通数组响应的信封只填充 `{requestId, generatedAt}`（分页 meta 由列表端点自行
 * 用 `okPaginated` 构建）。若服务端未给出 `total`，把「当前页条数」当成总数就是伪造统计口径；
 * 因此这里显式允许 `null`，界面据此显示「总数未提供」，绝不用推算值冒充服务端口径。
 */
export interface AdminApplicationPage {
  items: AdminApplicationListItem[];
  page: number;
  pageSize: number;
  total: number | null;
  totalPages: number | null;
}

/**
 * 管理端统计来源（契约基线 `GET /admin/statistics/{flow|achievements|education}`）。
 * 后端切片未实现，因此**不对响应形状做任何假设**：只把「能否取到数据」与「取到几个可展示指标」
 * 作为事实，指标以 `label/value` 白名单形式携带，避免把未确认的字段名写进界面逻辑。
 */
export const ADMIN_STATISTICS_SOURCES = ['flow', 'achievements', 'education'] as const;
export type AdminStatisticsSource = (typeof ADMIN_STATISTICS_SOURCES)[number];

export interface DashboardMetric {
  key: string;
  label: string;
  value: number;
  hint?: string;
}

/**
 * 单来源统计结果。`pending` 表示「端点已按契约基线定义、但后端尚未实现」
 * （以 404/501 或未注册路由的形式观测到），与 `error`（其它失败）严格区分：
 * 前者是已知的计划内缺口，后者需要排查。
 */
export type StatisticsSourceResult =
  | { source: AdminStatisticsSource; status: 'ready'; metrics: DashboardMetric[] }
  | { source: AdminStatisticsSource; status: 'pending'; metrics: DashboardMetric[]; reason: string }
  | { source: AdminStatisticsSource; status: 'error'; metrics: DashboardMetric[]; error: UiError };
