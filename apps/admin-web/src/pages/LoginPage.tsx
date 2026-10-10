import { useState, type FormEvent, type ReactNode } from 'react';
import type { UiError } from '../api/errors';
import { ENDPOINTS } from '../api/endpoints';
import { SESSION_STORAGE_KEY } from '../api/session';
import { useAuth } from '../auth/AuthContext';
import type { ApiProbeResult } from '../auth/session-flow';
import { useHashLocation } from '../router/hash-router';
import { ErrorPanel, NoticeBar, PendingEndpointPanel } from '../components/StatePanel';

/**
 * 登录页 = **本地联调入口**。
 *
 * 先要说清**当前后端的真实状态**：契约基线只定义了 `POST /auth/wechat/login`（小程序凭证换取）
 * 与 `POST /auth/refresh`，管理端网页登录端点尚未定义。因此本页提供两条**都不撒谎**的路径：
 *
 * 1. 会话票据联调登录（真实）：票据由服务端种子写入会话存储后交给使用者；
 *    前端用一次真实请求（`GET /me/profile`）确认服务端是否认这张票据，确认通过才写入会话。
 *    票据仅存于 `sessionStorage`，不写入 URL、不写日志。
 * 2. 受控演示模式（显式）：无票据、不发请求，用前端夹具走查界面；所有演示数据全程标注，
 *    写操作一律被拒绝。
 *
 * 本页刻意不做的事：
 * - **不内置任何票据**：没有默认票据、没有「用示例票据登录」按钮；
 * - **不提供认证旁路**：票据必须经服务端确认，确认失败就如实报错；
 * - **不接受外部传入的基地址**：请求地址只来自构建期配置（页面顶部的联调入口只做展示）。
 */
export function LoginPage(): ReactNode {
  const { notice, clearNotice, loginWithTicket, enterDemoMode, apiBaseUrl, checkApiConnection } =
    useAuth();
  const location = useHashLocation();
  const redirect = location.query['redirect'];
  const [ticket, setTicket] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [probe, setProbe] = useState<ApiProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  const runProbe = async (): Promise<void> => {
    setProbing(true);
    setProbe(await checkApiConnection());
    setProbing(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    setWarning(null);
    const result = await loginWithTicket({
      ticket,
      ...(redirect === undefined ? {} : { redirect }),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.warning !== undefined) {
      setWarning(result.warning);
    }
  };

  return (
    <div className="login">
      <header className="login__header">
        <h1>科研团队管理系统 · 管理端</h1>
        <p className="muted">
          管理端 MVP：登录、基础布局、统计概览、申请列表、个人资料；申请审核路由已预留。
        </p>
      </header>

      {notice !== null && <NoticeBar text={notice} onDismiss={clearNotice} />}

      <section className="card" aria-labelledby="connect-title">
        <h2 id="connect-title">联调入口（真实模式）</h2>
        <p className="muted">
          真实模式下，请求携带的会话票据**只会**发往下面的地址。本页不内置、不生成、不缓存任何
          票据，也不提供任何认证旁路：票据必须由服务端确认，确认失败就如实报错。
        </p>
        <dl className="kv">
          <dt>API 基地址</dt>
          <dd>
            <code>{apiBaseUrl}</code>
          </dd>
          <dt>地址来源</dt>
          <dd>
            构建期配置 <code>VITE_API_BASE_URL</code>（未配置时同源 <code>/api/v1</code>
            ）；页面无法修改它，也不接受经 URL 或存储传入的地址。
          </dd>
        </dl>
        <div className="pager">
          <button
            type="button"
            className="button--secondary"
            onClick={() => void runProbe()}
            disabled={probing}
          >
            {probing ? '正在探测…' : '检测 API 连通性（匿名 GET /health）'}
          </button>
        </div>
        <p className="muted">
          探测请求<strong>不带票据</strong>、不改变登录状态，只回答「地址通不通、后端是否健康」。
        </p>
        {probe !== null && probe.ok && probe.health !== undefined && (
          <dl className="kv">
            <dt>连通性</dt>
            <dd className="ok">可达</dd>
            <dt>服务</dt>
            <dd>
              {probe.health.service} v{probe.health.version}
            </dd>
            <dt>状态</dt>
            <dd>{probe.health.status}</dd>
          </dl>
        )}
        {probe !== null && !probe.ok && probe.error !== undefined && (
          <ErrorPanel error={probe.error} onRetry={() => void runProbe()} />
        )}

        <details>
          <summary>用受控会话状态进入真实模式（不经过本表单）</summary>
          <p className="muted">
            也可在浏览器控制台为当前标签页写入会话（键 <code>{SESSION_STORAGE_KEY}</code>
            ），刷新后即进入真实模式。它走**同一套**票据形状校验与
            <code>GET /me/profile</code> 探测路径，不会绕过认证：
          </p>
          <pre>
            <code>
              {
                '{"mode":"real","ticket":"<一次性会话票据>","label":"联调","signedInAt":"<ISO 时间>"}'
              }
            </code>
          </pre>
          <p className="muted">
            票据由服务端种子写入后交给你；本页没有任何默认值，也不读取 URL 中的票据。
          </p>
        </details>
      </section>

      <section className="card" aria-labelledby="ticket-title">
        <h2 id="ticket-title">会话票据登录（真实校验）</h2>
        <p className="muted">
          当前后端尚未提供管理端登录端点：票据由服务端种子写入后交给你。提交后前端会向
          <code>GET /me/profile</code>
          发起一次真实请求，确认服务端是否认可这张票据；服务端不认可就不会进入系统。
        </p>
        <form className="form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="ticket">会话票据（Bearer）</label>
          <input
            id="ticket"
            name="ticket"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={ticket}
            onChange={(event) => setTicket(event.target.value)}
            placeholder="例如：8–128 位字母、数字或 . _ : -"
          />
          <p className="muted">
            票据只保存在当前标签页的 <code>sessionStorage</code>，关闭标签页即失效；请求头之外不会
            出现在任何位置。
          </p>
          <button type="submit" disabled={pending || ticket.trim() === ''}>
            {pending ? '正在校验…' : '登录'}
          </button>
        </form>
        {error !== null && <ErrorPanel error={error} />}
        {warning !== null && <NoticeBar text={warning} onDismiss={() => setWarning(null)} />}
      </section>

      <section className="card" aria-labelledby="demo-title">
        <h2 id="demo-title">受控演示模式</h2>
        <p className="muted">
          后端审核/统计切片尚未上线时，用前端夹具走查界面结构、加载态、空态与错误态。
          <strong>演示模式不会连接后端、不会写入任何数据</strong>
          ，所有演示数据在界面上全程标注，写操作会被明确拒绝。
        </p>
        <button type="button" className="button--secondary" onClick={enterDemoMode}>
          进入演示模式（只读）
        </button>
      </section>

      <section className="card" aria-labelledby="boundary-title">
        <h2 id="boundary-title">接口边界现状</h2>
        <PendingEndpointPanel descriptor={ENDPOINTS.sessionLogin} />
        <ul className="muted">
          <li>
            已实现并可直接联调：<code>GET /me/profile</code>、<code>PATCH /me/profile</code>、
            <code>GET /me/statistics</code>、<code>GET /health</code>。
          </li>
          <li>
            待后端切片：<code>GET /admin/applications</code>、
            <code>
              POST /admin/applications/{'{'}applicationId{'}'}/review
            </code>
            、<code>GET /admin/statistics/*</code>。
          </li>
        </ul>
      </section>
    </div>
  );
}
