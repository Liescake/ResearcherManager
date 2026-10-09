import type { ReactNode } from 'react';
import type { UiError, UiErrorKind } from '../api/errors';
import type { EndpointDescriptor } from '../api/endpoints';
import { endpointLabel } from '../api/endpoints';

/**
 * 状态面板集合：**视觉是临时的**（纯 CSS、无组件库），但语义与文案是定型的——
 * 页面必须让用户区分清楚「正在加载 / 真的没有数据 / 权限不够 / 会话失效 / 功能未上线 / 出错可重试」。
 * 把这六种情况用同一套面板表达，是后续替换视觉设计时不丢语义的前提。
 */

/** 每种错误对应的用户安全标题（不泄露资源是否存在） */
const ERROR_TITLES: Readonly<Record<UiErrorKind, string>> = {
  unauthorized: '登录状态已失效',
  forbidden: '没有访问权限',
  'not-found': '未找到数据',
  conflict: '数据状态冲突',
  'rate-limited': '请求过于频繁',
  validation: '请求内容不合法',
  network: '无法连接服务端',
  timeout: '请求超时',
  server: '服务端异常',
  unknown: '发生未预期错误',
};

export function errorTitle(error: UiError): string {
  return ERROR_TITLES[error.kind];
}

export function LoadingPanel({ label = '数据' }: { label?: string }): ReactNode {
  return (
    <p className="state state--loading" role="status" aria-live="polite">
      正在加载{label}…
    </p>
  );
}

export function EmptyPanel({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="state state--empty" role="status">
      <p className="state__title">{title}</p>
      {description !== undefined && <p className="muted">{description}</p>}
      {action}
    </div>
  );
}

/** 错误详情：稳定错误码 + requestId + API 边界，便于用户描述问题、也便于排障 */
function ErrorDetails({ error }: { error: UiError }): ReactNode {
  return (
    <dl className="kv kv--compact">
      <dt>错误码</dt>
      <dd>
        <code>{error.code}</code>
      </dd>
      {error.status !== undefined && (
        <>
          <dt>HTTP</dt>
          <dd>{error.status}</dd>
        </>
      )}
      {error.endpoint !== undefined && (
        <>
          <dt>接口</dt>
          <dd>
            <code>{error.endpoint}</code>
          </dd>
        </>
      )}
      {error.requestId !== undefined && (
        <>
          <dt>请求 ID</dt>
          <dd>
            <code>{error.requestId}</code>
          </dd>
        </>
      )}
    </dl>
  );
}

export function ErrorPanel({
  error,
  onRetry,
  extra,
}: {
  error: UiError;
  onRetry?: () => void;
  extra?: ReactNode;
}): ReactNode {
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{errorTitle(error)}</p>
      <p>{error.message}</p>
      {extra}
      <ErrorDetails error={error} />
      {onRetry !== undefined && (
        <button type="button" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

export function UnauthorizedPanel({ error }: { error: UiError }): ReactNode {
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{errorTitle(error)}</p>
      <p>
        会话票据无效、已过期或已被登出。正在返回登录页；本次请求未被服务端接受，页面不会保留任何
        半成品数据。
      </p>
      <ErrorDetails error={error} />
    </div>
  );
}

/**
 * 403 面板：权限不足与「端点未实现」在 HTTP 上都可能表现为 403，因此文案必须两说，
 * 而不是替用户下结论。真正的判定由 API 边界描述符（`pending`）+ `looksLikePendingEndpoint` 完成。
 */
export function ForbiddenPanel({
  error,
  descriptor,
}: {
  error: UiError;
  descriptor?: EndpointDescriptor;
}): ReactNode {
  return (
    <div className="state state--forbidden" role="alert">
      <p className="state__title">{errorTitle(error)}</p>
      <p>
        当前会话的角色或数据范围不满足该操作的权限要求（403）。请确认账号角色；前端按钮状态不构成
        任何授权，服务端始终是唯一判定点。
      </p>
      {descriptor !== undefined && (
        <p className="muted">
          所需权限：
          {descriptor.permissions.length === 0 ? '（未声明）' : descriptor.permissions.join(' 或 ')}
        </p>
      )}
      <ErrorDetails error={error} />
    </div>
  );
}

/** 「端点尚未实现」面板：明确区分计划内缺口与故障，并给出可替换的边界信息 */
export function PendingEndpointPanel({
  descriptor,
  error,
}: {
  descriptor: EndpointDescriptor;
  error?: UiError;
}): ReactNode {
  return (
    <div className="state state--pending" role="status">
      <p className="state__title">后端端点尚未实现</p>
      <p>
        <code>{endpointLabel(descriptor)}</code> 已按契约基线登记，但后端切片尚未上线。
        界面不会用演示数据冒充真实结果；联调模式下这里只会显示空态或错误态。
      </p>
      {descriptor.note !== undefined && <p className="muted">{descriptor.note}</p>}
      <p className="muted">
        所需权限：
        {descriptor.permissions.length === 0 ? '（未声明）' : descriptor.permissions.join(' 或 ')}
      </p>
      {error !== undefined && <ErrorDetails error={error} />}
    </div>
  );
}

/** 演示模式下的统一提示条：任何展示夹具数据的区域都必须带上它 */
export function DemoNotice({ text, version }: { text: string; version?: string }): ReactNode {
  return (
    <p className="notice notice--demo" role="note">
      {text}
      {version !== undefined && <span className="muted">（夹具版本：{version}）</span>}
    </p>
  );
}

/** 会话层提示（过期、已退出、已进入演示模式）：可关闭，不阻塞操作 */
export function NoticeBar({
  text,
  onDismiss,
}: {
  text: string;
  onDismiss?: () => void;
}): ReactNode {
  return (
    <p className="notice" role="status">
      {text}
      {onDismiss !== undefined && (
        <button type="button" className="link" onClick={onDismiss}>
          知道了
        </button>
      )}
    </p>
  );
}
