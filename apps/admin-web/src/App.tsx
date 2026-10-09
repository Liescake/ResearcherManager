import { useEffect, type ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import type { SessionStorageLike } from './api/session';
import { AppLayout } from './components/AppLayout';
import { NotFoundPage } from './pages/NotFoundPage';
import { ApplicationsPage } from './pages/ApplicationsPage';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { ProfilePage } from './pages/ProfilePage';
import { ReviewDetailPage, ReviewsPage } from './pages/ReviewsPage';
import { matchRoute, navigate, resolveNavigation, useHashLocation } from './router/hash-router';

/**
 * 应用外壳：路由解析 → 登录守卫 → 页面渲染。
 *
 * 安全要点：守卫在**渲染前**判定。需要认证而当前匿名时，本组件只渲染「正在跳转登录」占位，
 * 绝不先把受保护页面渲染出来再跳转（那会让页面内的取数在无会话状态下先跑一轮）。
 * 401 由 client → 会话层统一处理，本组件不需要额外分支。
 *
 * `storage` / `baseUrl` 可选注入：单测用它构造确定的会话与地址，不必依赖浏览器存储。
 */
export interface AppProps {
  storage?: SessionStorageLike | null;
  baseUrl?: string;
}

export function App({ storage, baseUrl }: AppProps = {}): ReactNode {
  return (
    <AuthProvider
      {...(storage === undefined ? {} : { storage })}
      {...(baseUrl === undefined ? {} : { baseUrl })}
    >
      <RouteView />
    </AuthProvider>
  );
}

function RouteView(): ReactNode {
  const { session } = useAuth();
  const location = useHashLocation();
  const match = matchRoute(location);
  const decision = resolveNavigation(match, session);
  const redirectTo = decision.kind === 'redirect' ? decision.to : null;

  useEffect(() => {
    if (redirectTo !== null) {
      navigate(redirectTo);
    }
  }, [redirectTo]);

  if (decision.kind === 'redirect') {
    return (
      <div className="page">
        <p className="state" role="status">
          正在跳转（{decision.reason === 'login-required' ? '需要登录' : '已登录'}）…
        </p>
      </div>
    );
  }

  const routeId = match.route.id;

  switch (routeId) {
    case 'login':
      return <LoginPage />;
    case 'overview':
      return (
        <AppLayout currentRouteId="overview">
          <OverviewPage />
        </AppLayout>
      );
    case 'applications':
      return (
        <AppLayout currentRouteId="applications">
          <ApplicationsPage />
        </AppLayout>
      );
    case 'reviews':
      return (
        <AppLayout currentRouteId="reviews">
          <ReviewsPage />
        </AppLayout>
      );
    case 'reviewDetail':
      return (
        <AppLayout currentRouteId="reviewDetail">
          <ReviewDetailPage applicationId={match.params['applicationId'] ?? ''} />
        </AppLayout>
      );
    case 'profile':
      return (
        <AppLayout currentRouteId="profile">
          <ProfilePage />
        </AppLayout>
      );
    case 'notFound':
    default:
      return (
        <AppLayout currentRouteId="notFound">
          <NotFoundPage raw={location.raw} />
        </AppLayout>
      );
  }
}
