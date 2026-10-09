import { ApiErrorCode } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../api/client';
import { IDLE, failed, isEmptyList, loading, ready, toFailure } from './async';

describe('取数状态机', () => {
  it('四个状态互斥且穷尽', () => {
    expect(IDLE.status).toBe('idle');
    expect(loading().status).toBe('loading');
    expect(ready([1, 2]).status).toBe('ready');
    expect(failed({ kind: 'network', code: 'NETWORK_ERROR', message: 'x' }).status).toBe('error');
  });

  it('异常收敛为 error 状态并携带 API 边界', () => {
    const state = toFailure(
      new ApiClientError(ApiErrorCode.Forbidden, '无权限', { status: 403 }),
      'GET /admin/applications',
    );
    expect(state.status).toBe('error');
    if (state.status === 'error') {
      expect(state.error.kind).toBe('forbidden');
      expect(state.error.status).toBe(403);
      expect(state.error.endpoint).toBe('GET /admin/applications');
    }
  });

  it('空集判定只认同步数组，null/undefined 不是「空列表」而是需要单独处理的情况', () => {
    expect(isEmptyList([])).toBe(true);
    expect(isEmptyList([1])).toBe(false);
    expect(isEmptyList(null)).toBe(false);
    expect(isEmptyList({ items: [] })).toBe(false);
  });
});
