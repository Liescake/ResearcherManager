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
      ['health', 'profileRead', 'profileUpdate', 'selfStatistics'].sort(),
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
  });

  it('展示用标签包含统一前缀，便于与后端日志对齐', () => {
    expect(endpointLabel(ENDPOINTS.adminApplications)).toBe(`GET ${API_PREFIX}/admin/applications`);
    expect(endpointRef(ENDPOINTS.adminApplications)).toBe('GET /admin/applications');
  });
});
