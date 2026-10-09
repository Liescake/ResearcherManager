import { useState, type FormEvent, type ReactNode } from 'react';
import type { UiError } from '../api/errors';
import { ENDPOINTS } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { useHashLocation } from '../router/hash-router';
import { ErrorPanel, NoticeBar, PendingEndpointPanel } from '../components/StatePanel';

/**
 * 登录页。
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
 * 刻意不做的事：本地伪造登录成功、把账号密码当占位符提交却假装成功。
 */
export function LoginPage(): ReactNode {
  const { notice, clearNotice, loginWithTicket, enterDemoMode } = useAuth();
  const location = useHashLocation();
  const redirect = location.query['redirect'];
  const [ticket, setTicket] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

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

      <section className="card" aria-labelledby="ticket-title">
        <h2 id="ticket-title">会话票据登录（真实校验）</h2>
        <p className="muted">
          当前后端尚未提供管理端登录端点：票据由服务端种子写入后交给你。提交后前端会向
          <code>GET /me/profile</code>
          发起一次真实请求来确认票据；服务端不认可就不会进入系统。
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
