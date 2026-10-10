import { useRef, useState, type ReactNode } from 'react';
import { ENDPOINTS, endpointRef } from '../api/endpoints';
import type { NotificationView } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { MyNotificationsPanel } from '../components/MyNotificationsPanel';
import { PageHeader } from '../components/PageHeader';
import { useLoader } from '../state/useLoader';
import {
  INITIAL_NOTIFICATION_FLOW,
  markReadFailed,
  markReadSucceeded,
  dismissNotificationNotice,
  startMarkRead,
  type NotificationFlowState,
} from '../state/notification-flow';

export function NotificationsPage(): ReactNode {
  const { gateway } = useAuth();
  const notifications = useLoader(() => gateway.loadMyNotifications(), [gateway], {
    endpoint: endpointRef(ENDPOINTS.myNotifications),
  });
  const [flow, setFlow] = useState<NotificationFlowState>(INITIAL_NOTIFICATION_FLOW);
  const inFlight = useRef(false);
  const submit = async (id: string): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setFlow((current) => current);
      const view = await gateway.markNotificationRead(id);
      setFlow((current) => markReadSucceeded(current, view));
    } catch (caught) {
      setFlow((current) => markReadFailed(current, caught));
    } finally {
      inFlight.current = false;
    }
  };
  const handleMarkRead = (target: { id: string; status: string }): void => {
    const outcome = startMarkRead(flow, target);
    if (outcome.notificationId === null) return;
    setFlow(outcome.state);
    void submit(outcome.notificationId);
  };
  return (
    <div className="page">
      <PageHeader
        title="我的通知"
        description={
          <>
            本人站内通知来自 <code>{endpointRef(ENDPOINTS.myNotifications)}</code>
            ；阅读状态以服务端返回为准。
          </>
        }
        actions={
          <button
            type="button"
            className="button--secondary"
            onClick={notifications.reload}
            disabled={notifications.state.status === 'loading' || flow.pendingId !== null}
          >
            刷新列表
          </button>
        }
        meta={<span className="page__eyebrow">个人中心 · 只展示授权范围内的白名单字段</span>}
      />
      <MyNotificationsPanel
        state={notifications.state}
        mode={gateway.mode}
        flow={flow}
        onRequestMarkRead={handleMarkRead}
        onDismissNotice={() => setFlow((current) => dismissNotificationNotice(current))}
        onRetry={notifications.reload}
      />
    </div>
  );
}

export function notificationPreview(
  items: readonly NotificationView[],
  limit = 3,
): NotificationView[] {
  return items.slice(0, limit);
}
