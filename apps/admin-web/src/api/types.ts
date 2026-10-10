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
 * 本人导出请求的**对外视图状态**（镜像服务端 `EXPORT_VIEW_STATUS_VALUES`）。
 *
 * 为什么这五个取值必须显式列全，而不是「只处理我见过的两个」：
 * - `pending` / `completed` / `failed` 是服务端**存储三态**；
 * - `revoked` 是服务端按 `revokedAt` **派生**的第四态（撤销是服务端事实，客户端不参与判定）；
 * - `expired` 对应服务端「下载 / 撤销判定」里的过期语义。服务端当前不会把它当作列表状态下发，
 *   这里显式声明是为了让它在界面上有确定呈现（不可撤销、无下载），而不是落到「未知状态」分支上。
 *
 * 注意：**可撤销闭集**是独立的（见 `isExportRevocableStatus`）。界面永远不按枚举名猜动作，
 * 只按闭集放行——因此服务端将来新增任何状态，界面的默认行为都是「不提供撤销入口」。
 */
export const EXPORT_VIEW_STATUS_VALUES = [
  'pending',
  'completed',
  'failed',
  'expired',
  'revoked',
] as const;

export type ExportViewStatus = (typeof EXPORT_VIEW_STATUS_VALUES)[number];

/** 展示文案（仅展示，不构成任何授权或状态判定） */
export const EXPORT_STATUS_LABELS: Readonly<Record<ExportViewStatus, string>> = {
  pending: '处理中',
  completed: '已完成',
  failed: '生成失败',
  expired: '已过期',
  revoked: '已撤销',
};

/**
 * **可撤销状态闭集**（镜像服务端 `isExportRevocableStatus`）：只有 `pending` / `completed`。
 *
 * 这是白名单而不是黑名单：`failed`（结论不可撤销）、`expired`（已过期）以及任何**未知**取值
 * 都自动落在闭集之外。界面据此决定是否渲染撤销入口；真正的判定始终在服务端。
 */
export const EXPORT_REVOCABLE_STATUS_VALUES = ['pending', 'completed'] as const;

export function isExportRevocableStatus(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (EXPORT_REVOCABLE_STATUS_VALUES as readonly string[]).includes(value)
  );
}

/** 已知状态的展示文案；未知取值按「未知状态（原值）」呈现，绝不猜成某个已知结论 */
export function exportStatusLabel(status: string): string {
  const label = EXPORT_STATUS_LABELS[status as ExportViewStatus];
  return label ?? `未知状态（${status}）`;
}

/**
 * 导出请求对外视图（**逐字段镜像**服务端 `ExportRequestView` 白名单）。
 *
 * 刻意不含：归属（ownerUserId / requesterId）、产物句柄（artifactId）、有效期（expiresAt）、
 * 撤销时刻（revokedAt）、文件名/路径/下载地址——服务端本就不下发这些字段，前端也不去读它们。
 */
export interface ExportRequestView {
  id: string;
  resource: string;
  fields: string[];
  /** 服务端状态原文：前端不做本地推断，未知取值按「未知状态」展示且不可撤销 */
  status: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 本人导出列表的一页（**键集分页**，镜像服务端 `meta` = `{ limit, hasNext, nextCursor }`）。
 *
 * `limit` 在服务端未给出时为 `null`（绝不推算）；`hasNext` 与 `nextCursor` 的充要关系
 * 由服务端保证，前端只是如实携带——**不自洽就按契约违规处理**，不猜「还有没有下一页」。
 */
export interface MyExportPage {
  items: ExportRequestView[];
  limit: number | null;
  hasNext: boolean;
  nextCursor: string | null;
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
