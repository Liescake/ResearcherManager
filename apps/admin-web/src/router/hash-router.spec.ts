import { describe, expect, it } from 'vitest';
import { ANONYMOUS, createDemoSession, createSession } from '../api/session';
import type { SessionState } from '../api/session';
import {
  buildHash,
  isSafeInternalHash,
  matchRoute,
  navigate,
  normalizeHash,
  parseHash,
  resolveNavigation,
  useHashLocation,
} from './hash-router';
import { HOME_PATH, LOGIN_PATH } from './routes';

const authenticated: SessionState = {
  status: 'authenticated',
  session: createSession('ticket-abcd1234', '联调'),
};
const demo: SessionState = { status: 'authenticated', session: createDemoSession() };

describe('哈希解析', () => {
  it('归一化：空、#、#/、缺少前导斜杠都能得到以 / 开头的路径', () => {
    expect(normalizeHash('')).toBe('/');
    expect(normalizeHash('#')).toBe('/');
    expect(normalizeHash('#/')).toBe('/');
    expect(normalizeHash('#applications')).toBe('/applications');
    expect(normalizeHash('#/applications')).toBe('/applications');
  });

  it('解析查询串并去掉路径末尾斜杠', () => {
    const location = parseHash('#/login?redirect=%23%2Fapplications&from=guard');
    expect(location.path).toBe('/login');
    expect(location.query['redirect']).toBe('#/applications');
    expect(location.query['from']).toBe('guard');
    expect(parseHash('#/profile/').path).toBe('/profile');
  });

  it('构造：无查询串时不出现多余的 ?', () => {
    expect(buildHash('/overview')).toBe('#/overview');
    expect(buildHash('/login', { redirect: '#/overview' })).toBe('#/login?redirect=%23%2Foverview');
    expect(buildHash('/login', { redirect: '' })).toBe('#/login');
  });
});

describe('路由匹配', () => {
  it('根路径落到首页，而不是兜底 404', () => {
    expect(matchRoute(parseHash('')).route.id).toBe('overview');
  });

  it('已知路径匹配到对应路由', () => {
    expect(matchRoute(parseHash('#/applications')).route.id).toBe('applications');
    expect(matchRoute(parseHash('#/profile')).route.id).toBe('profile');
    expect(matchRoute(parseHash('#/reviews')).route.id).toBe('reviews');
  });

  it('预留的审核详情路由解析出 applicationId 参数并解码', () => {
    const match = matchRoute(parseHash('#/reviews/app%2F1'));
    expect(match.route.id).toBe('reviewDetail');
    expect(match.params['applicationId']).toBe('app/1');
  });

  it('未知路径落到 notFound（绝不静默渲染空页面）', () => {
    expect(matchRoute(parseHash('#/nope/deep')).route.id).toBe('notFound');
    expect(matchRoute(parseHash('#/overview/extra')).route.id).toBe('notFound');
  });
});

describe('回跳目标安全校验（防开放重定向）', () => {
  it('只接受站内哈希路径', () => {
    expect(isSafeInternalHash('#/applications')).toBe(true);
    expect(isSafeInternalHash('/applications')).toBe(true);
    expect(isSafeInternalHash('/reviews/abc?x=1')).toBe(true);

    expect(isSafeInternalHash('#//evil.example.com')).toBe(false);
    expect(isSafeInternalHash('//evil.example.com')).toBe(false);
    expect(isSafeInternalHash('https://evil.example.com')).toBe(false);
    expect(isSafeInternalHash('HTTP://evil.example.com')).toBe(false);
    expect(isSafeInternalHash('javascript:alert(1)')).toBe(false);
    expect(isSafeInternalHash('data:text/html,x')).toBe(false);
    expect(isSafeInternalHash('#/\\evil')).toBe(false);
    expect(isSafeInternalHash('/a\\b')).toBe(false);
    expect(isSafeInternalHash('')).toBe(false);
    expect(isSafeInternalHash(undefined)).toBe(false);
  });
});

describe('登录守卫', () => {
  it('匿名访问受保护页面 → 去登录并带回跳与原因', () => {
    const decision = resolveNavigation(matchRoute(parseHash('#/applications?page=2')), ANONYMOUS);
    expect(decision.kind).toBe('redirect');
    if (decision.kind === 'redirect') {
      expect(decision.reason).toBe('login-required');
      expect(decision.to.startsWith(`#${LOGIN_PATH}?`)).toBe(true);
      // 回跳目标是归一化后的站内路径（不含前导 #），经 URL 编码后作为查询串参数
      expect(decision.to).toContain(encodeURIComponent('/applications?page=2'));
      expect(decision.to).toContain('from=guard');
    }
  });

  it('匿名访问登录页 → 直接渲染（不会自跳转成死循环）', () => {
    expect(resolveNavigation(matchRoute(parseHash('#/login')), ANONYMOUS).kind).toBe('render');
  });

  it('已认证访问登录页 → 回到安全回跳目标或首页', () => {
    const withRedirect = resolveNavigation(
      matchRoute(parseHash(`#/login?redirect=${encodeURIComponent('#/profile')}`)),
      authenticated,
    );
    expect(withRedirect.kind).toBe('redirect');
    if (withRedirect.kind === 'redirect') {
      expect(withRedirect.to).toBe('#/profile');
      expect(withRedirect.reason).toBe('already-authenticated');
    }

    const unsafe = resolveNavigation(
      matchRoute(parseHash(`#/login?redirect=${encodeURIComponent('//evil.example.com')}`)),
      authenticated,
    );
    if (unsafe.kind === 'redirect') {
      expect(unsafe.to).toBe(`#${HOME_PATH}`);
    } else {
      throw new Error('应当重定向到首页');
    }
  });

  it('已认证访问受保护页面 → 渲染', () => {
    expect(resolveNavigation(matchRoute(parseHash('#/overview')), authenticated).kind).toBe(
      'render',
    );
    expect(resolveNavigation(matchRoute(parseHash('#/reviews')), demo).kind).toBe('render');
  });

  it('匿名访问未知路径 → 仍然先去登录（fail-closed）', () => {
    const decision = resolveNavigation(matchRoute(parseHash('#/unknown')), ANONYMOUS);
    expect(decision.kind).toBe('redirect');
  });
});

describe('命令式跳转与订阅 API', () => {
  it('navigate 在无 window 环境下不抛错（SSR 安全）', () => {
    expect(() => navigate('#/overview')).not.toThrow();
  });

  it('导出 useHashLocation 供组件订阅（SSR 快照为根路径）', () => {
    expect(typeof useHashLocation).toBe('function');
  });
});
