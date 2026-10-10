import {
  NOTIFICATION_STATUS_LABELS,
  NOTIFICATION_TYPE_LABELS,
  isNotificationUnread,
  type NotificationView,
} from '../api/types';

/**
 * 「我的通知」面板的**视图模型**（纯函数，无 React / 无 DOM 依赖，可在 node 环境直接单测）。
 *
 * 这里只做展示层的派生：统计、筛选、焦点去向判定。它**不改变任何通知的状态**——
 * 阅读状态永远是服务端返回的原文（或服务端已确认的标记结果），这里只是按原文分组计数。
 */

/** 按阅读状态筛选：只是对**已加载列表**的本地视图切换，不发请求、不带查询串 */
export type NotificationFilter = 'all' | 'unread' | 'read';

export const NOTIFICATION_FILTERS: readonly NotificationFilter[] = ['all', 'unread', 'read'];

export const NOTIFICATION_FILTER_LABELS: Readonly<Record<NotificationFilter, string>> = {
  all: '全部',
  unread: '未读',
  read: '已读',
};

export interface NotificationSummary {
  readonly total: number;
  /** 服务端原文为 `unread` 的条数 */
  readonly unread: number;
  /** 服务端原文为 `read` 的条数 */
  readonly read: number;
  /** 状态不在已登记闭集内的条数（按原值展示、没有操作入口） */
  readonly unknownStatus: number;
  /** 类型或状态任一未登记的条数（用于「部分数据无法识别」提示） */
  readonly unrecognized: number;
}

function isKnownStatus(status: string): boolean {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_STATUS_LABELS, status);
}

function isKnownType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_TYPE_LABELS, type);
}

/**
 * 按服务端返回的状态原文计数。这不是服务端的「未读数」口径（服务端没有该端点），
 * 而是**本次已加载列表**里各状态的条数，界面文案必须写明这一点。
 */
export function summarizeNotifications(items: readonly NotificationView[]): NotificationSummary {
  let unread = 0;
  let read = 0;
  let unknownStatus = 0;
  let unrecognized = 0;
  for (const item of items) {
    if (isNotificationUnread(item.status)) unread += 1;
    else if (item.status === 'read') read += 1;
    else unknownStatus += 1;

    if (!isKnownStatus(item.status) || !isKnownType(item.type)) unrecognized += 1;
  }
  return { total: items.length, unread, read, unknownStatus, unrecognized };
}

/**
 * 本地筛选。规则：
 * - `all`：原样返回（含未知状态，它们只在「全部」里出现，不被猜进任何一类）；
 * - `read`：只要服务端原文为 `read` 的；
 * - `unread`：服务端原文为 `unread` 的，**外加本次会话里刚被服务端确认已读的条目**
 *   （`recentlyReadIds`）。保留它们是为了不让用户正在操作的那一条在点击成功后瞬间从眼前消失
 *   （键盘焦点也因此有一个稳定的落点）；这些条目显示的仍是服务端返回的「已读」状态，
 *   并带「刚刚标记」标识，不会被伪装成未读。重新加载列表后它们按服务端结果正常归类。
 */
export function filterNotifications(
  items: readonly NotificationView[],
  filter: NotificationFilter,
  recentlyReadIds: ReadonlySet<string> = new Set(),
): NotificationView[] {
  if (filter === 'all') return [...items];
  if (filter === 'read') return items.filter((item) => item.status === 'read');
  return items.filter((item) => isNotificationUnread(item.status) || recentlyReadIds.has(item.id));
}

/** 某个筛选下的条数（用于筛选按钮上的计数，与 `filterNotifications` 同口径） */
export function filterCount(summary: NotificationSummary, filter: NotificationFilter): number {
  if (filter === 'all') return summary.total;
  if (filter === 'read') return summary.read;
  return summary.unread;
}

/** 筛选后为空时的文案：与「服务端返回了 0 条」严格区分 */
export function filteredEmptyText(filter: NotificationFilter): string {
  if (filter === 'unread') return '当前列表里没有未读通知。';
  if (filter === 'read') return '当前列表里没有已读通知。';
  return '当前列表为空。';
}

/** 状态行文案（`aria-live` 播报用）：明确这是「已加载列表」的计数，而不是服务端未读数 */
export function summaryText(summary: NotificationSummary): string {
  const parts = [`已加载 ${String(summary.total)} 条`, `未读 ${String(summary.unread)} 条`];
  if (summary.unknownStatus > 0) {
    parts.push(`状态无法识别 ${String(summary.unknownStatus)} 条`);
  }
  return `${parts.join('，')}（按服务端返回的状态统计）`;
}

/** 焦点判定所需的最小 DOM 形状：便于在 node 环境用普通对象替身测试 */
export interface FocusContainer {
  contains(node: unknown): boolean;
}

/**
 * 标记成功后是否把键盘焦点移到该条通知的标题上。
 *
 * 背景：成功后该条的「标记已读」按钮会消失，浏览器随即把焦点丢回 `<body>`，键盘用户会被
 * 扔回页面开头。因此**只在焦点已经丢失时**（`activeElement` 为空或是 `<body>`）才接管，
 * 用户在这期间主动把焦点移到别处（包括本面板内的其它控件）时绝不抢焦点。
 */
export function shouldRestoreFocusAfterRead(
  activeElement: unknown,
  body: unknown,
  panel: FocusContainer | null,
): boolean {
  if (panel === null) return false;
  return activeElement === null || activeElement === undefined || activeElement === body;
}
