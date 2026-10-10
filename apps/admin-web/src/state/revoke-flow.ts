import { ENDPOINTS, endpointRef } from '../api/endpoints';
import { toExportRevokeUiError, type UiError } from '../api/errors';
import { isExportRevocableStatus, type ExportRequestView } from '../api/types';
import { formatShortId } from '../lib/format';

/**
 * 撤销导出的**交互状态机**（纯函数、无 React / 无网络依赖，因此可在 node 环境直接单测）。
 *
 * 为什么把它从组件里拿出来：撤销是**写操作**，它最容易出错的地方不是渲染，而是时序——
 * 双击提交两次、提交中还能再点别的行、取消后仍然发请求、确认弹窗关不掉。
 * 把这些时序收敛成一组「输入 → 新状态 + 是否真的应该发请求」的纯函数后，
 * 每一个并发边界都可以在单测里被固定，组件只负责渲染与调用。
 *
 * 状态形状（互斥且穷尽）：
 * - `confirmingId`：正在等待**用户确认**的那条导出（用户已点击撤销，但请求尚未发出）；
 * - `pendingId`：**正在提交**的那条导出（请求已发出）。它与 `confirmingId` 指向同一条时，
 *   确认弹窗保持打开并显示「正在撤销…」，因此使用者看得到「它还在飞」；
 * - `revoked`：本次会话内**已被服务端确认撤销**的记录（按 id 索引，值以服务端返回视图为准）；
 * - `error` / `notice`：最近一次撤销的结果展示（二者互斥：新动作开始时都清空）。
 *
 * 安全不变量（被单测固定）：
 * 1. **只有可撤销状态才能打开确认**：`failed` / `expired` / `revoked` / 未知取值一律无动作；
 * 2. **没有确认就不发请求**：`confirmRevoke` 只在 `confirmingId !== null` 时给出导出 ID；
 * 3. **防重复提交**：`pendingId !== null` 时，`requestRevoke` / `cancelRevoke` / `confirmRevoke`
 *    都不改变状态，且 `confirmRevoke` 恒返回 `exportId: null`（不产生第二次请求）；
 * 4. **失败不改变本地视图**：只有服务端确认（`revokeSucceeded`）才把记录写成已撤销。
 */
export interface RevokeFlowState {
  readonly confirmingId: string | null;
  readonly pendingId: string | null;
  readonly revoked: Readonly<Record<string, ExportRequestView>>;
  readonly error: UiError | null;
  readonly notice: string | null;
}

export const INITIAL_REVOKE_FLOW: RevokeFlowState = {
  confirmingId: null,
  pendingId: null,
  revoked: {},
  error: null,
  notice: null,
};

/** 撤销成功的提示里只出现短 ID：完整 UUID 对使用者没有信息量，也会挤掉正文 */
function revokedNotice(view: ExportRequestView): string {
  return `导出 ${formatShortId(view.id)} 已撤销：下载入口立即失效，记录本身不会被删除。`;
}

/**
 * 用户点击某条导出的「撤销」。
 * 不可撤销的状态、或已有请求在飞时**原样返回**（不解引用、不排队、不改任何字段），
 * 因此界面不可能因为一次误点而打开一个最终必然被服务端拒绝的确认框。
 */
export function requestRevoke(
  state: RevokeFlowState,
  target: { readonly id: string; readonly status: string },
): RevokeFlowState {
  if (state.pendingId !== null) return state;
  if (!isExportRevocableStatus(target.status)) return state;
  return { ...state, confirmingId: target.id, error: null, notice: null };
}

/** 取消确认：只关弹窗；请求在飞时不允许取消（那会让界面与服务端事实脱节） */
export function cancelRevoke(state: RevokeFlowState): RevokeFlowState {
  if (state.pendingId !== null) return state;
  return { ...state, confirmingId: null };
}

export interface ConfirmRevokeOutcome {
  readonly state: RevokeFlowState;
  /** 非 null 时调用方**必须**只提交一次；null 表示「不该发请求」（未确认 / 已在提交中） */
  readonly exportId: string | null;
}

/**
 * 用户在确认弹窗里点击「确认撤销」。
 * 弹窗**保持打开**（`confirmingId` 不变）以便展示提交中状态；`pendingId` 置为该导出 ID，
 * 于是所有撤销入口（含本行的两个按钮）在下一步渲染时都被禁用。
 */
export function confirmRevoke(state: RevokeFlowState): ConfirmRevokeOutcome {
  if (state.pendingId !== null) {
    return { state, exportId: null };
  }
  const exportId = state.confirmingId;
  if (exportId === null) {
    return { state, exportId: null };
  }
  return {
    state: { ...state, pendingId: exportId, error: null, notice: null },
    exportId,
  };
}

/** 服务端确认撤销：**以服务端返回的视图**更新本地视图，并关闭弹窗、清空提交中标记 */
export function revokeSucceeded(state: RevokeFlowState, view: ExportRequestView): RevokeFlowState {
  return {
    confirmingId: null,
    pendingId: null,
    revoked: { ...state.revoked, [view.id]: view },
    error: null,
    notice: revokedNotice(view),
  };
}

/** 撤销失败：如实展示（统一错误收敛），本地视图**不变**，弹窗关闭以便用户看到错误并重试 */
export function revokeFailed(state: RevokeFlowState, caught: unknown): RevokeFlowState {
  return {
    ...state,
    confirmingId: null,
    pendingId: null,
    error: toExportRevokeUiError(caught, endpointRef(ENDPOINTS.exportRevoke)),
    notice: null,
  };
}

/** 关闭成功提示（用户点「知道了」） */
export function dismissRevokeNotice(state: RevokeFlowState): RevokeFlowState {
  return state.notice === null ? state : { ...state, notice: null };
}

/** 关闭错误面板（用户开始新的尝试时） */
export function clearRevokeError(state: RevokeFlowState): RevokeFlowState {
  return state.error === null ? state : { ...state, error: null };
}
