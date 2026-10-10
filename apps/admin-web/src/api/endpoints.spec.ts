import { API_PREFIX } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import { ENDPOINTS, endpointLabel, endpointPath, endpointRef, getEndpoint } from './endpoints';
import type { EndpointId } from './endpoints';

describe('API 边界登记表', () => {
  const all = Object.values(ENDPOINTS);

  it('每条边界都有方法、以 / 开头的相对路径与说明', () => {
    for (const descriptor of all) {
      expect(['GET', 'POST', 'PATCH', 'PUT']).toContain(descriptor.method);
      expect(descriptor.path.startsWith('/')).toBe(true);
      expect(descriptor.path.startsWith('//')).toBe(false);
      expect(descriptor.summary.length).toBeGreaterThan(0);
    }
  });

  it('getEndpoint 按 id 取到同一条边界', () => {
    const id: EndpointId = 'profileRead';
    expect(getEndpoint(id)).toBe(ENDPOINTS.profileRead);
  });

  /**
   * 回归门禁：状态一旦被改动就必须显式修改本断言。
   * 目的：不允许把「后端还没实现」的端点悄悄标成 stable —— 那样界面就会把 404 说成空数据。
   */
  it('stable / pending 的划分与后端现状一致', () => {
    const stable = all.filter((item) => item.status === 'stable').map((item) => item.id);
    const pending = all.filter((item) => item.status === 'pending').map((item) => item.id);

    expect(stable.sort()).toEqual(
      [
        'health',
        'profileRead',
        'profileUpdate',
        'selfStatistics',
        // HEAD 已实现本人导出列表与撤销（后端契约稳定），因此这两条是 stable
        'myExports',
        'exportRevoke',
        // HEAD 已实现本人通知列表与标记已读（后端契约稳定），因此这两条也是 stable
        'myNotifications',
        'notificationRead',
      ].sort(),
    );
    expect(pending.sort()).toEqual(
      [
        'adminApplications',
        'adminApplicationReview',
        'adminStatisticsAchievements',
        'adminStatisticsEducation',
        'adminStatisticsFlow',
        'sessionLogin',
      ].sort(),
    );
  });

  it('pending 边界必须写明原因（否则界面无法解释「为什么没有数据」）', () => {
    for (const descriptor of all) {
      if (descriptor.status === 'pending') {
        expect(descriptor.note).toBeDefined();
        expect((descriptor.note ?? '').length).toBeGreaterThan(10);
      }
    }
  });

  it('管理端边界声明了契约基线要求的权限点', () => {
    expect(ENDPOINTS.profileRead.permissions).toContain('profile:self:read');
    expect(ENDPOINTS.adminApplications.permissions).toContain('membership:review:global');
    expect(ENDPOINTS.adminStatisticsEducation.permissions).toContain('statistics:education:read');
  });

  /**
   * 导出切片的边界登记：撤销的入参**只有路径参数**（没有请求体、没有查询串），
   * 归属取服务端会话主体，因此登记表里也不存在任何「可提交归属/产物」的入口。
   */
  it('本人导出边界：列表是 GET、撤销是 POST 且只带 exportId 路径参数', () => {
    expect(ENDPOINTS.myExports.method).toBe('GET');
    expect(ENDPOINTS.myExports.path).toBe('/me/exports');
    expect(ENDPOINTS.myExports.permissions).toEqual(['profile:self:read']);

    expect(ENDPOINTS.exportRevoke.method).toBe('POST');
    expect(ENDPOINTS.exportRevoke.path).toBe('/me/exports/{exportId}/revoke');
    expect(ENDPOINTS.exportRevoke.permissions).toEqual(['profile:self:read']);
    expect(endpointPath(ENDPOINTS.exportRevoke, { exportId: 'a-1' })).toBe(
      '/me/exports/a-1/revoke',
    );
  });

  /**
   * 通知切片的边界登记：列表是 GET 且**没有查询参数**，标记已读是 PATCH 且只带 notificationId
   * 路径参数（没有请求体入口），权限点复用闭集目录里的 self 点。
   */
  it('本人通知边界：列表是 GET、标记已读是 PATCH 且只带 notificationId 路径参数', () => {
    expect(ENDPOINTS.myNotifications.method).toBe('GET');
    expect(ENDPOINTS.myNotifications.path).toBe('/me/notifications');
    expect(ENDPOINTS.myNotifications.permissions).toEqual(['profile:self:read']);

    expect(ENDPOINTS.notificationRead.method).toBe('PATCH');
    expect(ENDPOINTS.notificationRead.path).toBe('/me/notifications/{notificationId}/read');
    expect(ENDPOINTS.notificationRead.permissions).toEqual(['profile:self:update']);
    expect(endpointPath(ENDPOINTS.notificationRead, { notificationId: 'a-1' })).toBe(
      '/me/notifications/a-1/read',
    );
  });
});

describe('路径构造', () => {
  it('替换路径参数并转义取值', () => {
    expect(endpointPath(ENDPOINTS.adminApplicationReview, { applicationId: 'abc-123' })).toBe(
      '/admin/applications/abc-123/review',
    );
    expect(endpointPath(ENDPOINTS.adminApplicationReview, { applicationId: 'a/b c' })).toBe(
      '/admin/applications/a%2Fb%20c/review',
    );
  });

  it('缺少参数、空参数或多余参数时 fail fast，不发出半截路径的请求', () => {
    expect(() => endpointPath(ENDPOINTS.adminApplicationReview)).toThrowError(/缺少路径参数/);
    expect(() =>
      endpointPath(ENDPOINTS.adminApplicationReview, { applicationId: '' }),
    ).toThrowError(/取值非法/);
    expect(() => endpointPath(ENDPOINTS.profileRead, { unexpected: 'x' })).toThrowError(
      /路径参数未被使用/,
    );
    // 导出 ID 是**单段**参数：路径穿越尝试被百分号编码，永远落在一个路径段里
    // （服务端再以 UUID 形态门禁统一拒绝，前端不据此判断存在性）
    expect(endpointPath(ENDPOINTS.exportRevoke, { exportId: '../../etc/passwd' })).toBe(
      '/me/exports/..%2F..%2Fetc%2Fpasswd/revoke',
    );
    expect(() => endpointPath(ENDPOINTS.exportRevoke, {})).toThrowError(/缺少路径参数/);
  });

  it('展示用标签包含统一前缀，便于与后端日志对齐', () => {
    expect(endpointLabel(ENDPOINTS.adminApplications)).toBe(`GET ${API_PREFIX}/admin/applications`);
    expect(endpointRef(ENDPOINTS.adminApplications)).toBe('GET /admin/applications');
  });
});
