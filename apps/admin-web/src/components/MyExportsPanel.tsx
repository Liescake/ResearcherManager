import type { ReactNode } from 'react';
import { ENDPOINTS, endpointRef } from '../api/endpoints';
import { mergeRevokedViews } from '../api/export-view';
import { exportStatusLabel, isExportRevocableStatus } from '../api/types';
import type { ExportRequestView, MyExportPage } from '../api/types';
import type { Loadable } from '../state/async';
import type { RevokeFlowState } from '../state/revoke-flow';
import { formatDateTime, formatShortId } from '../lib/format';
import { AsyncStateView } from './AsyncStateView';
import { ErrorPanel, NoticeBar } from './StatePanel';

/**
 * 本人导出记录区（概览页内的一块，**不新增路由**）。
 *
 * 它只做三件真实的事，且每一件都有明确的边界：
 * 1. **展示状态**：逐条渲染服务端视图（资源、字段数、状态、时间），状态是服务端给的原文，
 *    界面不做任何本地推断；未知状态显示为「未知状态（原值）」而不是猜成某个已知结论；
 * 2. **本人撤销**：`pending` / `completed` 提供撤销入口（其余一律没有入口），
 *    点击后必须经过**确认弹窗**；确认弹窗里只有「确认 / 取消」两个动作，
 *    没有任何可填字段——归属、产物、路径都不是客户端可以提交的东西；
 * 3. **如实呈现结果**：撤销成功以**服务端返回的视图**更新本地视图并提示下载立即失效；
 *    失败走统一错误面板（401/403/503 沿用既有分类，服务端的统一安全拒绝收敛为
 *    `EXPORT_UNAVAILABLE`），提交中所有入口禁用（防重复提交）。
 *
 * 刻意**不做**的事：不提供下载入口（下载端点不在本轮范围，撤销的规则是「撤销后即使有下载也失效」），
 * 不在演示模式提供可点击的撤销入口（写操作在演示模式被拒绝，见 `gateway.ts`）。
 *
 * 组件本身是**受控的纯展示**：状态与回调全部来自 `props`，因此它可以被静态渲染测试覆盖
 * （本项目不引入 jsdom，交互时序由 `state/revoke-flow.ts` 的纯函数单测固定）。
 */
export interface MyExportsPanelProps {
  state: Loadable<MyExportPage>;
  /** `demo` 时撤销入口禁用并标注演示数据（不发出任何请求） */
  mode: 'live' | 'demo';
  flow: RevokeFlowState;
  onRequestRevoke: (target: { id: string; status: string }) => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: () => void;
  onDismissNotice: () => void;
  onRetry: () => void;
}

export const EXPORT_REVOKE_CONFIRM_TITLE = '确认撤销这条导出？';
export const EXPORT_REVOKE_DEMO_NOTE =
  '演示模式：导出记录来自前端受控夹具；撤销属于写操作，本模式一律拒绝，入口保持禁用且不会发出任何请求。';

/**
 * 下载端点**只作为文字说明**出现：它已由后端实现（`GET /me/exports/{exportId}/download`），
 * 但不属于本轮前端范围，因此刻意不登记进 `endpoints.ts`、也不出现任何可点击的下载入口。
 * 撤销的规则正是「撤销后即使存在产物也立即失效」，所以「没有下载入口」在这里不是缺失而是结论。
 */
export const EXPORT_DOWNLOAD_ENDPOINT_REF = 'GET /me/exports/{exportId}/download';

/** 确认弹窗里的说明：只陈述服务端事实，不暗示客户端可以指定归属或产物 */
const CONFIRM_DESCRIPTION =
  '撤销后该导出的下载立即失效，记录本身不会被删除。请求只包含导出 ID，归属由服务端按会话主体判定，' +
  '不接受任何客户端提交的用户 / 产物 / 路径字段。';

export function MyExportsPanel({
  state,
  mode,
  flow,
  onRequestRevoke,
  onCancelRevoke,
  onConfirmRevoke,
  onDismissNotice,
  onRetry,
}: MyExportsPanelProps): ReactNode {
  const busy = flow.pendingId !== null;

  return (
    <section className="card" aria-labelledby="my-exports-title">
      <h2 id="my-exports-title">我的导出记录</h2>
      <p className="muted">
        <code>{endpointRef(ENDPOINTS.myExports)}</code> 读取本人导出状态；
        <code>{endpointRef(ENDPOINTS.exportRevoke)}</code>{' '}
        为本人撤销（幂等：重复撤销同样返回已撤销）。请求不带请求体与查询串，票据只由 API 客户端注入{' '}
        <code>Authorization</code>，界面不读取、不保存、不展示会话票据。
      </p>

      {mode === 'demo' && (
        <p className="muted" id="exports-revoke-demo-note">
          {EXPORT_REVOKE_DEMO_NOTE}
        </p>
      )}

      {flow.notice !== null && <NoticeBar text={flow.notice} onDismiss={onDismissNotice} />}
      {flow.error !== null && <ErrorPanel error={flow.error} />}

      <AsyncStateView
        state={state}
        descriptor={ENDPOINTS.myExports}
        label="导出记录"
        onRetry={onRetry}
        isEmpty={(data) => data.items.length === 0}
        emptyTitle="当前没有导出记录"
        emptyDescription="服务端在授权范围内返回了 0 条导出请求，这是合法的空集，不是错误。"
      >
        {(data) => (
          <>
            <p className="muted">
              {data.limit === null ? '服务端未提供页大小' : `服务端页大小 ${data.limit}`}
              {data.hasNext
                ? '；服务端提示还有更多记录（游标分页），本区按最小 MVP 只展示第一页。'
                : ''}
            </p>
            <div className="table-wrap">
              <table>
                <caption className="muted">
                  本区只接入「状态 + 本人撤销」：下载端点{' '}
                  <code>{EXPORT_DOWNLOAD_ENDPOINT_REF}</code>
                  不在本轮范围，因此任何状态都不提供下载入口（撤销后即使存在产物也已失效）。
                </caption>
                <thead>
                  <tr>
                    <th scope="col">导出 ID</th>
                    <th scope="col">资源</th>
                    <th scope="col">字段</th>
                    <th scope="col">状态</th>
                    <th scope="col">创建时间</th>
                    <th scope="col">更新时间</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {mergeRevokedViews(data.items, flow.revoked).map((item) => (
                    <ExportRow
                      key={item.id}
                      item={item}
                      mode={mode}
                      flow={flow}
                      busy={busy}
                      onRequestRevoke={onRequestRevoke}
                      onCancelRevoke={onCancelRevoke}
                      onConfirmRevoke={onConfirmRevoke}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </AsyncStateView>
    </section>
  );
}

interface ExportRowProps {
  item: ExportRequestView;
  mode: 'live' | 'demo';
  flow: RevokeFlowState;
  busy: boolean;
  onRequestRevoke: (target: { id: string; status: string }) => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: () => void;
}

function ExportRow({
  item,
  mode,
  flow,
  busy,
  onRequestRevoke,
  onCancelRevoke,
  onConfirmRevoke,
}: ExportRowProps): ReactNode {
  const revocable = isExportRevocableStatus(item.status);
  const confirming = flow.confirmingId === item.id;
  const pending = flow.pendingId === item.id;

  return (
    <tr>
      <td>
        <code title={item.id}>{formatShortId(item.id)}</code>
      </td>
      <td>{item.resource}</td>
      <td>{item.fields.length} 项</td>
      <td>
        {exportStatusLabel(item.status)}
        {mode === 'demo' && <span className="tag tag--demo">演示</span>}
      </td>
      <td>{formatDateTime(item.createdAt)}</td>
      <td>{formatDateTime(item.updatedAt)}</td>
      <td>
        {item.status === 'revoked' ? (
          // 已撤销：只有一个事实，且明确说明没有下载入口
          <span className="muted">已撤销：下载入口已失效，无可执行操作（不提供下载）</span>
        ) : revocable ? (
          <div className="rowactions">
            <button
              type="button"
              className="button--secondary"
              onClick={() => onRequestRevoke({ id: item.id, status: item.status })}
              disabled={busy || mode === 'demo'}
              aria-describedby={mode === 'demo' ? 'exports-revoke-demo-note' : undefined}
              title={mode === 'demo' ? EXPORT_REVOKE_DEMO_NOTE : undefined}
            >
              撤销
            </button>
            {confirming && (
              <div
                className="confirm"
                role="alertdialog"
                aria-modal="false"
                aria-busy={pending}
                aria-labelledby={`revoke-title-${item.id}`}
                aria-describedby={`revoke-desc-${item.id}`}
                tabIndex={-1}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    onCancelRevoke();
                  }
                }}
              >
                <p className="state__title" id={`revoke-title-${item.id}`}>
                  {EXPORT_REVOKE_CONFIRM_TITLE}
                </p>
                <p className="muted" id={`revoke-desc-${item.id}`}>
                  {CONFIRM_DESCRIPTION}
                </p>
                <div className="confirm__actions">
                  <button
                    type="button"
                    onClick={onConfirmRevoke}
                    disabled={pending}
                    // 弹窗打开后焦点落在确认按钮上：键盘使用者不必先 Tab 寻找
                    autoFocus
                  >
                    {pending ? '正在撤销…' : '确认撤销'}
                  </button>
                  <button
                    type="button"
                    className="button--secondary"
                    onClick={onCancelRevoke}
                    disabled={pending}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <span className="muted">
            不可撤销（{exportStatusLabel(item.status)}）：本状态不提供撤销入口
          </span>
        )}
      </td>
    </tr>
  );
}
