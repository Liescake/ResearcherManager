import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { NAV_GROUPS, navOwnerOf, ROUTES, type RouteId } from '../router/routes';
import { buildHash } from '../router/hash-router';
import { DemoNotice, NoticeBar } from './StatePanel';

export interface AppLayoutProps {
  currentRouteId: RouteId;
  children: ReactNode;
}

export function AppLayout({ currentRouteId, children }: AppLayoutProps): ReactNode {
  const { session, gateway, notice, clearNotice, logout, apiBaseUrl } = useAuth();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mainRef = useRef<HTMLElement | null>(null);
  const authenticated = session.status === 'authenticated';
  const mode = authenticated ? session.session.mode : null;
  const sessionLabel = authenticated ? session.session.label : '未登录';
  const owner = navOwnerOf(currentRouteId);
  const group = NAV_GROUPS.find((candidate) =>
    candidate.routes.some((route) => route.id === owner),
  );

  useEffect(() => {
    document.title = `${ROUTES[currentRouteId]?.title ?? '管理端'} · 科研团队管理系统`;
    setMobileNavOpen(false);
  }, [currentRouteId]);

  return (
    <div className="app">
      <button className="skip-link" type="button" onClick={() => mainRef.current?.focus()}>
        跳到主要内容
      </button>
      <aside className={mobileNavOpen ? 'app__sidebar app__sidebar--open' : 'app__sidebar'}>
        <div className="app__brand">
          <span className="app__mark" aria-hidden="true">
            研
          </span>
          <div>
            <strong className="app__title">科研团队</strong>
            <span className="app__subtitle">管理端工作台</span>
          </div>
        </div>
        <nav id="main-navigation" className="app__nav" aria-label="主导航">
          {NAV_GROUPS.map((navGroup) => (
            <div className="navgroup" key={navGroup.id}>
              <p className="navgroup__title">{navGroup.title}</p>
              <div className="navgroup__items">
                {navGroup.routes.map((route) => {
                  const active = route.id === owner;
                  return (
                    <a
                      key={route.id}
                      href={buildHash(route.path)}
                      className={active ? 'navlink navlink--active' : 'navlink'}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => setMobileNavOpen(false)}
                    >
                      <span>{route.title}</span>
                      {route.id === 'reviews' && <span className="navlink__hint">预留</span>}
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="app__sidebar-footer">
          <span className={`badge badge--${mode ?? 'anonymous'}`}>
            {mode === 'demo' ? '演示模式' : mode === 'real' ? '联调模式' : '未登录'}
          </span>
          <span className="app__session-label">{sessionLabel}</span>
          {authenticated && (
            <button type="button" className="button--ghost" onClick={logout}>
              退出
            </button>
          )}
        </div>
      </aside>
      {mobileNavOpen && (
        <button
          className="app__scrim"
          type="button"
          aria-label="关闭导航"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <div className="app__workspace">
        <header className="app__topbar">
          <button
            className="app__menu-button button--ghost"
            type="button"
            aria-expanded={mobileNavOpen}
            aria-controls="main-navigation"
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            菜单
          </button>
          <div className="app__breadcrumb" aria-label="当前位置">
            <span>{group?.title ?? '页面'}</span>
            <span aria-hidden="true">/</span>
            <strong>{ROUTES[currentRouteId]?.title}</strong>
          </div>
          <div className="app__topbar-meta">
            <span className={`badge badge--${mode ?? 'anonymous'}`}>
              {mode === 'demo' ? '演示模式' : mode === 'real' ? '联调模式' : '未登录'}
            </span>
          </div>
        </header>
        <div className="app__connection" role="status">
          {mode === 'real' ? (
            <>
              <span className="tag tag--live">真实请求</span>
              <span className="muted">
                联调模式：所有数据均来自 <code>{apiBaseUrl}</code>{' '}
                的真实响应，本页不使用任何演示夹具。
              </span>
            </>
          ) : mode === 'demo' ? (
            <>
              <span className="tag tag--demo">不发起请求</span>
              <span className="muted">
                演示模式：不连接后端、不发起任何请求，数据全部来自前端受控夹具。
              </span>
            </>
          ) : (
            <span className="muted">未登录：未携带会话票据，也未发起任何业务请求。</span>
          )}
        </div>
        <div className="app__notices">
          {gateway.notice !== null && (
            <DemoNotice text={gateway.notice} version={gateway.fixtureVersion} />
          )}
          {notice !== null && <NoticeBar text={notice} onDismiss={clearNotice} />}
        </div>
        <main className="app__main" id="main-content" tabIndex={-1} ref={mainRef}>
          {children}
        </main>
        <footer className="app__footer muted">
          管理端 MVP · 未实现的端点会显式提示，界面不会用演示数据冒充真实结果。
        </footer>
      </div>
    </div>
  );
}
