import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { NAV_ROUTES, type RouteId } from '../router/routes';
import { buildHash } from '../router/hash-router';
import { DemoNotice, NoticeBar } from './StatePanel';

/**
 * 基础布局：顶栏（应用名 + 导航 + 当前会话 + 退出）+ 内容区 + 页脚。
 *
 * 视觉是临时的（无组件库、无主题系统），但结构承担的语义是定型的：
 * 1. 演示模式提示条**常驻**在内容之上，任何页面都不可能「忘记标注演示数据」；
 * 2. 会话提示（过期/退出）在布局层统一呈现，页面不重复实现；
 * 3. 导航只列出已登记的路由，未实现的页面也在导航里显式标注「预留」，
 *    避免出现「点进去才发现没有」的错觉。
 */
export interface AppLayoutProps {
  currentRouteId: RouteId;
  children: ReactNode;
}

export function AppLayout({ currentRouteId, children }: AppLayoutProps): ReactNode {
  const { session, gateway, notice, clearNotice, logout } = useAuth();
  const authenticated = session.status === 'authenticated';
  const mode = authenticated ? session.session.mode : null;
  const sessionLabel = authenticated ? session.session.label : '未登录';

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <span className="app__title">科研团队管理系统 · 管理端</span>
          <span className={`badge badge--${mode ?? 'anonymous'}`}>
            {mode === 'demo' ? '演示模式' : mode === 'real' ? '联调模式' : '未登录'}
          </span>
        </div>

        <nav className="app__nav" aria-label="主导航">
          {NAV_ROUTES.map((route) => (
            <a
              key={route.id}
              href={buildHash(route.path)}
              className={route.id === currentRouteId ? 'navlink navlink--active' : 'navlink'}
              aria-current={route.id === currentRouteId ? 'page' : undefined}
            >
              {route.title}
            </a>
          ))}
        </nav>

        <div className="app__session">
          <span className="muted">{sessionLabel}</span>
          {authenticated && (
            <button type="button" className="button--ghost" onClick={logout}>
              退出
            </button>
          )}
        </div>
      </header>

      <div className="app__notices">
        {gateway.notice !== null && (
          <DemoNotice text={gateway.notice} version={gateway.fixtureVersion} />
        )}
        {notice !== null && <NoticeBar text={notice} onDismiss={clearNotice} />}
      </div>

      <main className="app__main">{children}</main>

      <footer className="app__footer muted">
        管理端 MVP ·
        后端审核/统计切片并行开发中：未实现的端点会显式提示，界面不会用演示数据冒充真实结果。
      </footer>
    </div>
  );
}
