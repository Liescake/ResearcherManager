import type { ReactNode } from 'react';
import type { UiError } from '../api/errors';
import { ErrorPanel } from '../components/StatePanel';

/**
 * 前端配置错误页：API 基地址非法时**替代整个应用外壳**渲染。
 *
 * 为什么必须存在：基地址决定 `Authorization: Bearer <会话票据>` 的去向，因此
 * `resolveApiBaseUrlResult` 对非法值 fail-closed。但「解析失败」如果是渲染期抛异常，
 * 使用者只会看到一个白屏：既不知道哪里错了，也不知道「一个请求都没发出去」。
 * 本页把同一条 fail-closed 结论变成可读的状态，并在结构上保证不会加载任何业务页面、
 * 不会构造 API 客户端——票据因此不可能被送往非预期目标。
 *
 * 本页不接受任何输入、不提供「仍然继续」的入口：绕过基地址校验等于绕过票据保护。
 */
export function ConfigErrorPage({ error }: { error: UiError }): ReactNode {
  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1>前端配置错误</h1>
          <p className="muted">
            应用未加载任何业务页面：API 基地址不合法时客户端拒绝发出一切请求，避免把会话票据
            送往非预期目标。
          </p>
        </div>
      </header>

      <ErrorPanel error={error} />

      <section className="card" aria-labelledby="config-fix-title">
        <h2 id="config-fix-title">如何修正</h2>
        <ul className="muted">
          <li>
            检查构建期变量 <code>VITE_API_BASE_URL</code>（仓库根目录 <code>.env</code>）
            ：只允许同源根相对路径（未配置时默认 <code>/api/v1</code>）或显式{' '}
            <code>http(s)://host[:port]/path</code>。
          </li>
          <li>
            会被拒绝的写法：协议相对 <code>//host</code>、含用户名/密码、含控制字符、含查询串或
            片段、不以 <code>/</code> 开头的裸相对值。
          </li>
          <li>修正后重新构建或重启开发服务器；运行时不会尝试绕过该校验。</li>
        </ul>
      </section>
    </div>
  );
}
