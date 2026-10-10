import { ApiErrorCode } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../api/client';
import {
  NOTIFICATION_READ_FAILED_MESSAGE,
  NOTIFICATION_READ_UNAVAILABLE_MESSAGE,
  NOTIFICATION_UNAVAILABLE_CODE,
} from '../api/errors';
import { DEMO_READ_ONLY_MESSAGE } from '../api/gateway';
import type { NotificationView } from '../api/types';
import {
  INITIAL_NOTIFICATION_FLOW,
  clearNotificationError,
  dismissNotificationNotice,
  markReadFailed,
  markReadSucceeded,
  startMarkRead,
} from './notification-flow';
import type { NotificationFlowState } from './notification-flow';

const UNREAD_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';

const UNREAD_TARGET = { id: UNREAD_ID, status: 'unread' };

const READ_VIEW: NotificationView = {
  id: UNREAD_ID,
  type: 'membership_review',
  title: '入组申请审核结果',
  body: '已通过审核。',
  status: 'read',
  createdAt: '2026-10-10T01:00:00.000Z',
  readAt: '2026-10-11T01:00:00.000Z',
  updatedAt: '2026-10-11T01:00:00.000Z',
};

function inFlight(): NotificationFlowState {
  const outcome = startMarkRead(INITIAL_NOTIFICATION_FLOW, UNREAD_TARGET);
  expect(outcome.notificationId).toBe(UNREAD_ID);
  return outcome.state;
}

describe('标记已读流程：可发起范围', () => {
  it('初始无提交中标记、无本地已读记录', () => {
    expect(INITIAL_NOTIFICATION_FLOW).toEqual({
      pendingId: null,
      read: {},
      error: null,
      notice: null,
    });
  });

  it('只有服务端返回 unread 才能发起；read 与未知取值都不产生请求', () => {
    expect(startMarkRead(INITIAL_NOTIFICATION_FLOW, UNREAD_TARGET).notificationId).toBe(UNREAD_ID);

    for (const status of ['read', 'archived', '']) {
      const outcome = startMarkRead(INITIAL_NOTIFICATION_FLOW, { id: 'x', status });
      expect(outcome.notificationId).toBeNull();
      expect(outcome.state).toBe(INITIAL_NOTIFICATION_FLOW);
    }
  });

  it('发起时清掉上一次的错误与提示（不带着旧结论做新动作）', () => {
    const dirty: NotificationFlowState = {
      ...INITIAL_NOTIFICATION_FLOW,
      error: { kind: 'server', code: 'HTTP_500', message: '旧错误' },
      notice: '旧提示',
    };
    const outcome = startMarkRead(dirty, UNREAD_TARGET);
    expect(outcome.state.error).toBeNull();
    expect(outcome.state.notice).toBeNull();
    expect(outcome.state.pendingId).toBe(UNREAD_ID);
  });
});

describe('标记已读流程：防重复提交', () => {
  it('同一通知重复点击只提交一次：第二次不再给出通知 ID', () => {
    const first = startMarkRead(INITIAL_NOTIFICATION_FLOW, UNREAD_TARGET);
    const second = startMarkRead(first.state, UNREAD_TARGET);
    expect(second.notificationId).toBeNull();
    expect(second.state).toBe(first.state);
  });

  it('提交中不接受任何新动作：点其它未读通知同样被忽略', () => {
    const state = inFlight();
    const other = { id: '00000000-0000-4000-8000-000000000003', status: 'unread' };
    const outcome = startMarkRead(state, other);
    expect(outcome.notificationId).toBeNull();
    expect(outcome.state).toBe(state);
  });
});

describe('标记已读流程：结果处理', () => {
  it('成功：以服务端返回视图更新本地视图（含服务端 readAt），并给出提示', () => {
    const done = markReadSucceeded(inFlight(), READ_VIEW);
    expect(done.pendingId).toBeNull();
    expect(done.error).toBeNull();
    expect(done.read[UNREAD_ID]).toEqual(READ_VIEW);
    expect(done.notice).toContain('已标记为已读');
  });

  it('失败：如实展示统一安全拒绝，**本地视图不变**（不伪造已读）', () => {
    const failed = markReadFailed(
      inFlight(),
      new ApiClientError(ApiErrorCode.NotFound, '目标通知不存在或不可见', { status: 404 }),
    );
    expect(failed.pendingId).toBeNull();
    expect(failed.read).toEqual({});
    expect(failed.error?.code).toBe(NOTIFICATION_UNAVAILABLE_CODE);
    expect(failed.error?.message).toBe(NOTIFICATION_READ_UNAVAILABLE_MESSAGE);
    expect(failed.error?.endpoint).toBe('PATCH /me/notifications/{notificationId}/read');
    // 服务端的原始文案不会被展示
    expect(failed.error?.message).not.toContain('目标通知不存在或不可见');
  });

  it('失败：503 沿用「服务暂时不可用」，401/403 沿用既有分类', () => {
    const unavailable = markReadFailed(
      INITIAL_NOTIFICATION_FLOW,
      new ApiClientError('HTTP_503', '服务暂不可用', { status: 503 }),
    );
    expect(unavailable.error?.kind).toBe('service-unavailable');

    const unauthorized = markReadFailed(
      INITIAL_NOTIFICATION_FLOW,
      new ApiClientError(ApiErrorCode.Unauthenticated, '会话失效', { status: 401 }),
    );
    expect(unauthorized.error?.kind).toBe('unauthorized');

    const forbidden = markReadFailed(
      INITIAL_NOTIFICATION_FLOW,
      new ApiClientError(ApiErrorCode.Forbidden, '没有权限', { status: 403 }),
    );
    expect(forbidden.error?.kind).toBe('forbidden');
  });

  it('演示模式的本地拒绝归类为「无权限」，而不是未预期错误', () => {
    const failed = markReadFailed(
      INITIAL_NOTIFICATION_FLOW,
      new ApiClientError('DEMO_READ_ONLY', DEMO_READ_ONLY_MESSAGE),
    );
    expect(failed.error?.kind).toBe('forbidden');
    expect(failed.error?.code).toBe('DEMO_READ_ONLY');
  });

  it('原始异常文本不会进入界面：未知失败换成固定安全文案', () => {
    const failed = markReadFailed(
      INITIAL_NOTIFICATION_FLOW,
      new Error('TypeError: cannot read properties of undefined (reading ownerUserId)'),
    );
    expect(failed.error?.message).toBe(NOTIFICATION_READ_FAILED_MESSAGE);
    expect(failed.error?.message).not.toContain('ownerUserId');
    expect(failed.error?.message).not.toContain('TypeError');
  });

  it('提示与错误可分别关闭，且关闭是幂等的', () => {
    const withNotice = markReadSucceeded(inFlight(), READ_VIEW);
    expect(dismissNotificationNotice(withNotice).notice).toBeNull();
    expect(dismissNotificationNotice(INITIAL_NOTIFICATION_FLOW)).toBe(INITIAL_NOTIFICATION_FLOW);

    const withError = markReadFailed(INITIAL_NOTIFICATION_FLOW, new Error('boom'));
    expect(clearNotificationError(withError).error).toBeNull();
    expect(clearNotificationError(INITIAL_NOTIFICATION_FLOW)).toBe(INITIAL_NOTIFICATION_FLOW);
  });

  it('失败后可以重试：同一条未读通知能再次发起（不会被上一次失败卡死）', () => {
    const failed = markReadFailed(inFlight(), new Error('boom'));
    const retried = startMarkRead(failed, UNREAD_TARGET);
    expect(retried.notificationId).toBe(UNREAD_ID);
    expect(retried.state.error).toBeNull();
  });

  it('已读通知不会再发起：本地合并后的状态不产生请求', () => {
    const done = markReadSucceeded(inFlight(), READ_VIEW);
    const again = startMarkRead(done, { id: READ_VIEW.id, status: READ_VIEW.status });
    expect(again.notificationId).toBeNull();
  });

  it('本地已读记录不影响其它通知的未读状态判定', () => {
    const done = markReadSucceeded(inFlight(), READ_VIEW);
    const other = { id: OTHER_ID, status: 'unread' };
    expect(startMarkRead(done, other).notificationId).toBe(OTHER_ID);
  });
});
