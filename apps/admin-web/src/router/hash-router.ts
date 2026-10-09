import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { HOME_PATH, LOGIN_PATH, ROUTES, ROUTE_MATCH_ORDER, type RouteDefinition } from './routes';
import type { SessionState } from '../api/session';

/**
 * 极简哈希路由：解析、匹配、构造与登录守卫。
 *
 * 全部是纯函数（除 `useHashLocation`），因此「登录守卫」这种最容易出安全问题的逻辑
 * 可以在 node 环境逐条断言，而不需要浏览器或 DOM 测试环境。
 *
 * 为什么用哈希而不是 History API：
 * - 静态托管/反向代理不需要为每个子路径配置 fallback，刷新不会 404；
 * - 管理端 MVP 不需要 SSR 友好的 URL。
 */
export interface HashLocation {
  /** 归一化后的路径，以 `/` 开头（不含查询串） */
  path: string;
  query: Readonly<Record<string, string>>;
  /** 原始哈希（含查询串），用于登录后的回跳 */
  raw: string;
}

export interface RouteMatch {
  route: RouteDefinition;
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
  /** 原始哈希：登录回跳必须原样带回，且必须先经过安全校验 */
  raw: string;
}

export type NavigationDecision =
  | { readonly kind: 'render'; readonly match: RouteMatch }
  | {
      readonly kind: 'redirect';
      readonly to: string;
      readonly reason: 'login-required' | 'already-authenticated';
    };

/** `#/a/b?x=1` → `/a/b?x=1`；空/`#`/`#/` → `/` */
export function normalizeHash(hash: string): string {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const trimmed = withoutHash.trim();
  if (trimmed === '' || trimmed === '/') return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function parseHash(hash: string): HashLocation {
  const raw = normalizeHash(hash);
  const questionIndex = raw.indexOf('?');
  const path = questionIndex === -1 ? raw : raw.slice(0, questionIndex);
  const query: Record<string, string> = {};
  if (questionIndex !== -1) {
    for (const [key, value] of new URLSearchParams(raw.slice(questionIndex + 1))) {
      query[key] = value;
    }
  }
  return {
    path: path === '' ? '/' : stripTrailingSlash(path),
    query,
    raw,
  };
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/u, '') : path;
}

function splitSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  if (pattern === '*') return {};
  const patternSegments = splitSegments(pattern);
  const pathSegments = splitSegments(path);
  if (patternSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (const [index, patternSegment] of patternSegments.entries()) {
    const pathSegment = pathSegments[index];
    if (pathSegment === undefined) return null;
    if (patternSegment.startsWith(':')) {
      const name = patternSegment.slice(1);
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathSegment);
      } catch {
        return null;
      }
      if (decoded === '') return null;
      params[name] = decoded;
      continue;
    }
    if (patternSegment !== pathSegment) return null;
  }
  return params;
}

/** 未知路径 → 兜底的 `notFound` 路由（绝不放行到「无匹配即渲染空页面」） */
export function matchRoute(location: HashLocation): RouteMatch {
  // 根路径（空哈希 / `#/`）视为首页：首次打开时不会被兜底 404 捕获
  const path = location.path === '/' ? HOME_PATH : location.path;
  for (const route of ROUTE_MATCH_ORDER) {
    const params = matchPath(route.path, path);
    if (params !== null) {
      return { route, params, query: location.query, raw: location.raw };
    }
  }
  return { route: ROUTES.notFound, params: {}, query: location.query, raw: location.raw };
}

export function buildHash(path: string, query: Readonly<Record<string, string>> = {}): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== '') search.set(key, value);
  }
  const suffix = search.toString();
  return suffix === '' ? `#${normalized}` : `#${normalized}?${suffix}`;
}

/**
 * 回跳目标安全校验：只接受站内哈希路径。
 *
 * 必须在**归一化之前**先排除带 scheme 的取值，否则像 `https://evil.example.com` 会被
 * `normalizeHash` 补上前导 `/` 变成 `/https://evil.example.com` 而通过检查（实测由单测捕获）。
 * 同时拒绝 `#//host`、反斜杠与空串，避免开放重定向与「跳到一个空路径」。
 */
export function isSafeInternalHash(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  // 任何 scheme（javascript:、data:、https: …）一律拒绝
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return false;
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  if (value.includes('\\')) return false;

  const normalized = normalizeHash(value);
  if (!normalized.startsWith('/')) return false;
  if (normalized.startsWith('//') || normalized.startsWith('/\\')) return false;
  return true;
}

/**
 * 登录守卫：
 * - 需要认证但匿名 → 去登录，并带上原路径与原因（登录后回跳）；
 * - 已认证却访问登录页 → 回到 `redirect`（若安全）或首页。
 */
export function resolveNavigation(match: RouteMatch, session: SessionState): NavigationDecision {
  const authenticated = session.status === 'authenticated';

  if (match.route.requiresAuth && !authenticated) {
    return {
      kind: 'redirect',
      to: buildHash(LOGIN_PATH, { redirect: match.raw, from: 'guard' }),
      reason: 'login-required',
    };
  }

  if (match.route.id === 'login' && authenticated) {
    const redirect = match.query['redirect'];
    return {
      kind: 'redirect',
      to: isSafeInternalHash(redirect) ? `#${normalizeHash(redirect)}` : buildHash(HOME_PATH),
      reason: 'already-authenticated',
    };
  }

  return { kind: 'render', match };
}

function currentHash(): string {
  if (typeof window === 'undefined') return '';
  return normalizeHash(window.location.hash);
}

/**
 * 订阅地址栏哈希。用 `useSyncExternalStore` 而不是 `useEffect + useState`：
 * 渲染期读到的始终是同一个快照，避免「首次渲染读到旧哈希再闪一次」。
 */
export function useHashLocation(): HashLocation {
  const subscribe = useCallback((onStoreChange: () => void) => {
    window.addEventListener('hashchange', onStoreChange);
    return () => window.removeEventListener('hashchange', onStoreChange);
  }, []);
  const hash = useSyncExternalStore(subscribe, currentHash, () => '');
  return useMemo(() => parseHash(hash), [hash]);
}

/** 命令式跳转（仅用于登录成功、登出这类明确的用户动作） */
export function navigate(to: string): void {
  if (typeof window === 'undefined') return;
  window.location.hash = to.startsWith('#') ? to.slice(1) : to;
}
