import type { ReactNode } from 'react';
import { ENDPOINTS, endpointRef } from '../api/endpoints';
import { mergeReadNotifications } from '../api/notification-view';
import { isNotificationUnread, notificationStatusLabel, notificationTypeLabel } from '../api/types';
import type { NotificationView } from '../api/types';
import type { Loadable } from '../state/async';
import type { NotificationFlowState } from '../state/notification-flow';
import { formatDateTime, formatShortId } from '../lib/format';
import { AsyncStateView } from './AsyncStateView';
import { ErrorPanel, NoticeBar } from './StatePanel';

/**
 * 我的通知区（概览页内的一块，**不新增路由**）。
 *
 * 它只做三件真实的事，且每一件都有明确的边界：
 * 1. **展示服务端白名单字段**：类型、标题、正文、阅读状态、创建 / 已读时间。
 *    阅读状态是服务端给的原文，界面不做任何本地推断；未知类型 / 未知状态按「原值」呈现，
 *    绝不猜成某个已知结论。归属（`userId`）、会话票据、深链路径、投递渠道 / provider、
 *    原始异常一律不进入这一区（读取器已把它们挡在数据之外，这里也没有渲染它们的分支）；
 * 2. **标记本人已读**：只有服务端原文为 `unread` 的通知提供入口，点击即
 *    `PATCH /api/v1/me/notifications/{notificationId}/read`——**无请求体、无查询串**，
 *    唯一输入是路径里的通知 ID，归属由服务端按会话主体判定；
 * 3. **如实呈现结果**：成功以**服务端返回的视图**更新本地视图（含服务端给出的已读时间）；
 *    失败走统一错误面板（401/403/503 沿用既有分类，服务端的统一安全拒绝收敛为
 *    `NOTIFICATION_UNAVAILABLE`），提交中该条入口禁用并显示「正在标记…」（防重复提交）。
 *
 * 刻意**不做**的事：不显示未读数（服务端当前没有这个口径，客户端不自行造一个统计值）、
 * 不提供「全部标为已读」与删除（端点不在本轮范围）、不在演示模式提供可提交的入口
 * （写操作在演示模式被拒绝，见 `gateway.ts` 的 `DEMO_READ_ONLY`）。
 *
 * 组件本身是**受控的纯展示**：状态与回调全部来自 `props`，因此它可以被静态渲染测试覆盖
 * （本项目不引入 jsdom，交互时序由 `state/notification-flow.ts` 的纯函数单测固定）。
 * 无障碍：可执行动作是原生 `<button>`（键盘可达、有禁用态与 `aria-busy`），列表是 `<ul>/<li>`
 * 语义结构，状态文案与错误面板复用既有 `StatePanel` / `AsyncStateView`。
 */
export interface MyNotificationsPanelProps {
  state: Loadable<NotificationView[]>;
  /** `demo` 时标记入口禁用并标注演示数据（不发出任何请求） */
  mode: 'live' | 'demo';
  flow: NotificationFlowState;
  onRequestMarkRead: (target: { id: string; status: string }) => void;
  onDismissNotice: () => void;
  onRetry: () => void;
}

export const NOTIFICATION_DEMO_NOTE =
  '演示模式：通知来自前端受控夹具；标记已读属于写操作，本模式一律拒绝，入口保持禁用且不会发出任何请求。';

export function MyNotificationsPanel({
  state,
  mode,
  flow,
  onRequestMarkRead,
  onDismissNotice,
  onRetry,
}: MyNotificationsPanelProps): ReactNode {
  const busy = flow.pendingId !== null;

  return (
    <section className="card" aria-labelledby="my-notifications-title">
      <h2 id="my-notifications-title">我的通知</h2>
      <p className="muted">
        <code>{endpointRef(ENDPOINTS.myNotifications)}</code> 读取本人通知；
        <code>{endpointRef(ENDPOINTS.notificationRead)}</code>{' '}
        标记已读（幂等：已读是终态，重复请求不会产生第二次状态变化）。标记请求不带请求体、不带查询串，
        唯一输入是路径里的通知
        ID；归属只由服务端的会话主体判定，界面不读取、不保存、不展示会话票据，
        也不渲染归属、路径或投递渠道之类的内部字段。
      </p>

      {mode === 'demo' && (
        <p className="muted" id="notifications-demo-note">
          {NOTIFICATION_DEMO_NOTE}
        </p>
      )}

      {flow.notice !== null && <NoticeBar text={flow.notice} onDismiss={onDismissNotice} />}
      {flow.error !== null && <ErrorPanel error={flow.error} />}

      <AsyncStateView
        state={state}
        descriptor={ENDPOINTS.myNotifications}
        label="通知"
        onRetry={onRetry}
        isEmpty={(data) => data.length === 0}
        emptyTitle="当前没有通知"
        emptyDescription="服务端在授权范围内返回了 0 条通知，这是合法的空集，不是错误。"
      >
        {(data) => (
          <ul className="notifications">
            {mergeReadNotifications(data, flow.read).map((item) => (
              <NotificationRow
                key={item.id}
                item={item}
                mode={mode}
                busy={busy}
                pending={flow.pendingId === item.id}
                onRequestMarkRead={onRequestMarkRead}
              />
            ))}
          </ul>
        )}
      </AsyncStateView>
    </section>
  );
}

interface NotificationRowProps {
  item: NotificationView;
  mode: 'live' | 'demo';
  /** 全局是否有请求在飞：任何一条提交中，其余入口一并禁用 */
  busy: boolean;
  /** 本条是否正在提交 */
  pending: boolean;
  onRequestMarkRead: (target: { id: string; status: string }) => void;
}

function NotificationRow({
  item,
  mode,
  busy,
  pending,
  onRequestMarkRead,
}: NotificationRowProps): ReactNode {
  const unread = isNotificationUnread(item.status);

  return (
    <li className={unread ? 'notification notification--unread' : 'notification'}>
      <div className="notification__head">
        <h3 className="notification__title">{item.title}</h3>
        <span className="tag">{notificationTypeLabel(item.type)}</span>
        <span className={unread ? 'tag tag--live' : 'tag'}>
          {notificationStatusLabel(item.status)}
        </span>
        {mode === 'demo' && <span className="tag tag--demo">演示</span>}
      </div>
      {item.body !== '' && <p className="notification__body">{item.body}</p>}
      <p className="notification__meta">
        <span>
          创建时间 <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
        </span>
        {item.readAt !== undefined && (
          <span>
            已读时间 <time dateTime={item.readAt}>{formatDateTime(item.readAt)}</time>
          </span>
        )}
        <span>
          通知 ID <code title={item.id}>{formatShortId(item.id)}</code>
        </span>
      </p>
      <div className="notification__actions">
        {unread ? (
          <button
            type="button"
            className="button--secondary"
            onClick={() => onRequestMarkRead({ id: item.id, status: item.status })}
            disabled={busy || mode === 'demo'}
            aria-busy={pending}
            aria-describedby={mode === 'demo' ? 'notifications-demo-note' : undefined}
            title={mode === 'demo' ? NOTIFICATION_DEMO_NOTE : undefined}
          >
            {pending ? '正在标记…' : '标记已读'}
          </button>
        ) : (
          <span className="muted">
            不可标记已读（{notificationStatusLabel(item.status)}）：本状态不提供入口
          </span>
        )}
      </div>
    </li>
  );
}
