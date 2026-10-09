import type { ReactNode } from 'react';
import { buildHash } from '../router/hash-router';
import { HOME_PATH } from '../router/routes';

/** 404 页：显示被请求的哈希，便于对照路由表；并给出唯一的安全出口（首页） */
export function NotFoundPage({ raw }: { raw: string }): ReactNode {
  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1>页面不存在</h1>
          <p className="muted">
            没有匹配到路由：<code>#{raw}</code>
          </p>
        </div>
      </header>
      <section className="card">
        <p>
          请从顶部导航选择页面。若你期望这里是一个业务页面，说明该路由尚未登记到
          <code>src/router/routes.ts</code>。
        </p>
        <a href={buildHash(HOME_PATH)}>返回统计概览</a>
      </section>
    </div>
  );
}
