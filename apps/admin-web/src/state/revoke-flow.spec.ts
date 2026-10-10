import { ApiErrorCode } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../api/client';
import { EXPORT_UNAVAILABLE_CODE, EXPORT_REVOKE_UNAVAILABLE_MESSAGE } from '../api/errors';
import type { ExportRequestView } from '../api/types';
import {
  INITIAL_REVOKE_FLOW,
  cancelRevoke,
  clearRevokeError,
  confirmRevoke,
  dismissRevokeNotice,
  requestRevoke,
  revokeFailed,
  revokeSucceeded,
} from './revoke-flow';
import type { RevokeFlowState } from './revoke-flow';

const PENDING = { id: '00000000-0000-4000-8000-000000000001', status: 'pending' };
const COMPLETED = { id: '00000000-0000-4000-8000-000000000002', status: 'completed' };
const REVOKED_VIEW: ExportRequestView = {
  id: PENDING.id,
  resource: 'profile',
  fields: ['name'],
  status: 'revoked',
  createdAt: '2026-10-10T01:00:00.000Z',
  updatedAt: '2026-10-11T01:00:00.000Z',
};

/** 打开确认框（供后续用例复用） */
function confirming(target: { id: string; status: string }): RevokeFlowState {
  return requestRevoke(INITIAL_REVOKE_FLOW, target);
}

describe('撤销流程：确认与取消', () => {
  it('初始无弹窗、无提交中标记、无本地撤销记录', () => {
    expect(INITIAL_REVOKE_FLOW).toEqual({
      confirmingId: null,
      pendingId: null,
      revoked: {},
      error: null,
      notice: null,
    });
  });

  it('pending / completed 可以打开确认弹窗；failed / expired / revoked / 未知取值都不能', () => {
    expect(confirming(PENDING).confirmingId).toBe(PENDING.id);
    expect(confirming(COMPLETED).confirmingId).toBe(COMPLETED.id);

    for (const status of ['failed', 'expired', 'revoked', 'cancelled', '']) {
      const state = requestRevoke(INITIAL_REVOKE_FLOW, { id: 'x', status });
      expect(state.confirmingId).toBeNull();
      expect(state).toBe(INITIAL_REVOKE_FLOW);
    }
  });

  it('点击撤销会清掉上一次的错误与提示（不会带着旧结论做新动作）', () => {
    const dirty: RevokeFlowState = {
      ...INITIAL_REVOKE_FLOW,
      error: { kind: 'server', code: 'HTTP_500', message: '旧错误' },
      notice: '旧提示',
    };
    const state = requestRevoke(dirty, PENDING);
    expect(state.error).toBeNull();
    expect(state.notice).toBeNull();
    expect(state.confirmingId).toBe(PENDING.id);
  });

  it('取消只关闭弹窗：不发请求、不改本地视图', () => {
    const opened = confirming(PENDING);
    const cancelled = cancelRevoke(opened);
    expect(cancelled.confirmingId).toBeNull();
    expect(cancelled.pendingId).toBeNull();
    expect(cancelled.revoked).toEqual({});
    // 没有确认时「确认」也不会产生请求
    expect(confirmRevoke(cancelled).exportId).toBeNull();
  });
});

describe('撤销流程：确认即提交一次（防重复提交）', () => {
  it('确认后才给出导出 ID，且弹窗保持打开以展示提交中状态', () => {
    const opened = confirming(PENDING);
    const outcome = confirmRevoke(opened);
    expect(outcome.exportId).toBe(PENDING.id);
    expect(outcome.state.pendingId).toBe(PENDING.id);
    expect(outcome.state.confirmingId).toBe(PENDING.id);
  });

  it('同一状态重复确认只提交一次：第二次不再给出导出 ID', () => {
    const first = confirmRevoke(confirming(PENDING));
    const second = confirmRevoke(first.state);
    expect(second.exportId).toBeNull();
    expect(second.state).toBe(first.state);
  });

  it('提交中不接受新的动作：请求其它行、取消、确认都被忽略', () => {
    const inFlight = confirmRevoke(confirming(PENDING)).state;

    expect(requestRevoke(inFlight, COMPLETED)).toBe(inFlight);
    expect(cancelRevoke(inFlight)).toBe(inFlight);
    expect(confirmRevoke(inFlight).exportId).toBeNull();
    expect(confirmRevoke(inFlight).state).toBe(inFlight);
  });
});

describe('撤销流程：结果处理', () => {
  it('成功：以服务端返回视图更新本地视图、关闭弹窗、给出下载失效提示', () => {
    const inFlight = confirmRevoke(confirming(PENDING)).state;
    const done = revokeSucceeded(inFlight, REVOKED_VIEW);
    expect(done.pendingId).toBeNull();
    expect(done.confirmingId).toBeNull();
    expect(done.error).toBeNull();
    expect(done.revoked[REVOKED_VIEW.id]).toEqual(REVOKED_VIEW);
    expect(done.notice).toContain('已撤销');
    expect(done.notice).toContain('下载入口立即失效');
  });

  it('失败：如实展示统一错误、关闭弹窗、**本地视图不变**（不假装撤销成功）', () => {
    const inFlight = confirmRevoke(confirming(PENDING)).state;
    const failed = revokeFailed(
      inFlight,
      new ApiClientError(ApiErrorCode.NotFound, '导出请求不存在或不可撤销', { status: 404 }),
    );
    expect(failed.pendingId).toBeNull();
    expect(failed.confirmingId).toBeNull();
    expect(failed.revoked).toEqual({});
    expect(failed.error?.code).toBe(EXPORT_UNAVAILABLE_CODE);
    expect(failed.error?.message).toBe(EXPORT_REVOKE_UNAVAILABLE_MESSAGE);
    expect(failed.error?.endpoint).toBe('POST /me/exports/{exportId}/revoke');
  });

  it('提示与错误可分别关闭，且关闭是幂等的', () => {
    const withNotice = revokeSucceeded(confirmRevoke(confirming(PENDING)).state, REVOKED_VIEW);
    expect(dismissRevokeNotice(withNotice).notice).toBeNull();
    expect(dismissRevokeNotice(INITIAL_REVOKE_FLOW)).toBe(INITIAL_REVOKE_FLOW);

    const withError = revokeFailed(INITIAL_REVOKE_FLOW, new Error('boom'));
    expect(clearRevokeError(withError).error).toBeNull();
    expect(clearRevokeError(INITIAL_REVOKE_FLOW)).toBe(INITIAL_REVOKE_FLOW);
  });

  it('失败后可以重新发起：确认弹窗能再次打开（不会被上一次失败卡死）', () => {
    const failed = revokeFailed(confirmRevoke(confirming(PENDING)).state, new Error('boom'));
    const retried = requestRevoke(failed, PENDING);
    expect(retried.confirmingId).toBe(PENDING.id);
    expect(retried.error).toBeNull();
    expect(confirmRevoke(retried).exportId).toBe(PENDING.id);
  });
});
