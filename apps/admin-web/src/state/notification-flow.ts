import { ENDPOINTS, endpointRef } from '../api/endpoints';
import { toNotificationReadUiError, type UiError } from '../api/errors';
import { isNotificationUnread, type NotificationView } from '../api/types';
import { formatShortId } from '../lib/format';

/**
 * 「标记通知已读」的**交互状态机**（纯函数、无 React / 无网络依赖，因此可在 node 环境直接单测）。
 *
 * 为什么把它从组件里拿出来：标记已读是**写操作**，最容易出错的地方不是渲染，而是时序——
 * 双击提交两次、提交中还能点别的通知、失败后在界面上「看起来已经读了」。
 * 把这些时序收敛成一组「输入 → 新状态 + 是否真的应该发请求」的纯函数后，
 * 每一个并发边界都可以在单测里被固定，组件只负责渲染与调用。
 *
 * 状态形状（互斥且穷尽）：
 * - `pendingId`：**正在提交**的那条通知（请求已发出）；非 null 时所有标记入口禁用；
 * - `read`：本次会话内**已被服务端确认已读**的通知（按 id 索引，值以服务端返回视图为准）；
 * - `error` / `notice`：最近一次标记的结果展示（二者互斥：新动作开始时都清空）。
 *
 * 安全不变量（被单测固定）：
 * 1. **只有服务端返回 `unread` 的通知才能发起**：`read`（终态）与任何未知取值都没有入口；
 * 2. **防重复提交**：`pendingId !== null` 时 `startMarkRead` 不改变状态且恒返回
 *    `notificationId: null`（不产生第二次请求）；
 * 3. **失败不改变本地视图**：只有服务端确认（`markReadSucceeded`）才把记录写成已读；
 *    因此一次失败绝不会在界面上留下「已读」的假象。
 */
export interface NotificationFlowState {
  readonly pendingId: string | null;
  readonly read: Readonly<Record<string, NotificationView>>;
  readonly error: UiError | null;
  readonly notice: string | null;
}

export const INITIAL_NOTIFICATION_FLOW: NotificationFlowState = {
  pendingId: null,
  read: {},
  error: null,
  notice: null,
};

/** 成功提示里只出现短 ID：完整 UUID 对使用者没有信息量，也会挤掉正文 */
function readNotice(view: NotificationView): string {
  return `通知 ${formatShortId(view.id)} 已标记为已读（以服务端返回的状态为准）。`;
}

export interface StartMarkReadOutcome {
  readonly state: NotificationFlowState;
  /** 非 null 时调用方**必须**只提交一次；null 表示「不该发请求」（不可标记 / 已在提交中） */
  readonly notificationId: string | null;
}

/**
 * 用户点击某条通知的「标记已读」。
 * 不可标记的状态、或已有请求在飞时**原样返回**（不解引用、不排队、不改任何字段），
 * 因此界面不可能因为一次误点而发出一个最终必然被服务端拒绝、或重复的请求。
 */
export function startMarkRead(
  state: NotificationFlowState,
  target: { readonly id: string; readonly status: string },
): StartMarkReadOutcome {
  if (state.pendingId !== null) {
    return { state, notificationId: null };
  }
  if (!isNotificationUnread(target.status)) {
    return { state, notificationId: null };
  }
  return {
    state: { ...state, pendingId: target.id, error: null, notice: null },
    notificationId: target.id,
  };
}

/**
 * 服务端确认已读：**以服务端返回的视图**更新本地视图（含服务端给出的 `readAt`），
 * 并清空提交中标记 —— 状态永远以服务端为准，不由客户端推断。
 */
export function markReadSucceeded(
  state: NotificationFlowState,
  view: NotificationView,
): NotificationFlowState {
  return {
    pendingId: null,
    read: { ...state.read, [view.id]: view },
    error: null,
    notice: readNotice(view),
  };
}

/** 标记失败：如实展示（统一错误收敛），本地视图**不变**（不伪造已读） */
export function markReadFailed(
  state: NotificationFlowState,
  caught: unknown,
): NotificationFlowState {
  return {
    ...state,
    pendingId: null,
    error: toNotificationReadUiError(caught, endpointRef(ENDPOINTS.notificationRead)),
    notice: null,
  };
}

/** 关闭成功提示（用户点「知道了」） */
export function dismissNotificationNotice(state: NotificationFlowState): NotificationFlowState {
  return state.notice === null ? state : { ...state, notice: null };
}

/** 关闭错误面板（用户开始新的尝试时） */
export function clearNotificationError(state: NotificationFlowState): NotificationFlowState {
  return state.error === null ? state : { ...state, error: null };
}
