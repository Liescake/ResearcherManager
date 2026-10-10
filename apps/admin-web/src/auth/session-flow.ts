/**
 * 会话流程中**与 React 无关**的部分：票据登录探测与 401 会话失效处理。
 *
 * 为什么单独抽出（而不是留在 `AuthContext.tsx` 里）：`AuthProvider` 是 React 组件，
 * 组件测试用 `react-dom/server` 静态渲染、**不执行 effect 也不引入 jsdom**，
 * 因此下面两条关键不变量在组件内部无法可靠回归，只能抽到纯函数层用假 fetch 断言：
 * - **登录探测收到 401 永远不是登录成功**：唯一成功路径是服务端认这张票据
 *   （200 / 404 / 403），401 必须转化为失败结果，且**不触发**全局「会话过期」处理；
 * - **401 只有一个处理点**：`createApiClient` 的 `onUnauthorized` → `expireSession`，
 *   清空会话并给出提示；页面与登录流程都不各自处理 401。
 *
 * 本模块不依赖 React，可注入 `fetch` 与存储，因此是 node 环境下的可测试层。
 */
import { ApiClientError, createApiClient } from '../api/client';
import { ENDPOINTS } from '../api/endpoints';
import { toUiError, type UiError } from '../api/errors';
import type { HealthView } from '../api/types';
import {
  ANONYMOUS,
  writeSession,
  type SessionState,
  type SessionStorageLike,
} from '../api/session';

/** 401 后的会话层提示（由页面展示，展示后调用 `clearNotice`） */
export const SESSION_EXPIRED_NOTICE = '登录状态已失效，请重新登录。';
/** 主动退出后的会话层提示 */
export const LOGGED_OUT_NOTICE = '已退出登录。';

export interface SessionExpiry {
  /** 失效后的会话状态：**恒为匿名**——401 永远不会被当成登录成功 */
  readonly state: SessionState;
  readonly notice: string;
}

/**
 * 401 的唯一处理点：清空会话并返回提示。
 *
 * 刻意只做「清空 + 提示」，不做命令式跳转：跳转由路由守卫根据会话状态完成，
 * 避免出现「有的地方跳转、有的地方显示错误」的不一致。
 * 存储不可用（隐私模式 / SSR）时 `writeSession` 自行降级，这里不会抛错。
 */
export function expireSession(storage: SessionStorageLike | null): SessionExpiry {
  writeSession(storage, ANONYMOUS);
  return { state: ANONYMOUS, notice: SESSION_EXPIRED_NOTICE };
}

/** 票据探测结果：`ok` 只表示「服务端认这张票据」，与「票据里有什么数据」无关 */
export interface VerificationOutcome {
  ok: boolean;
  warning?: string;
  error?: UiError;
}

export interface TicketProbeOptions {
  /** 与主客户端同源的基地址（共用 fail-closed 校验） */
  baseUrl: string;
  ticket: string;
  /** 仅用于测试注入；生产环境走 `globalThis.fetch` */
  fetchImpl?: typeof fetch;
  /** 仅用于测试缩短超时；生产环境走客户端默认值 */
  timeoutMs?: number;
}

/**
 * 用真实请求确认票据：探测 `GET /me/profile`。
 *
 * 为什么选它：共享权限目录里**每个默认角色都含 `profile:self:read`**，因此它是最中性的
 * 「服务端是否认这张票据」探针。判定口径：
 * - 401 → 票据无效或已过期（**失败**，即便响应体里带着看似正常的数据也不豁免）；
 * - 200 / 404（尚未提交画像）/ 403（票据有效但角色缺该权限）→ 服务端**认这张票据**；
 *   403 附提示，因为后续管理端页面可能仍然因权限不足而显示 403 面板；
 * - 网络错误/超时 → 无法确认，按失败处理（fail-closed，不写入会话）。
 *
 * 探测用的是一次性客户端，**刻意不接 `onUnauthorized`**：登录失败不应该触发「会话过期」
 * 的全局处理，也绝不能因此把这次 401 记成登录成功。
 */
export async function verifyTicket(options: TicketProbeOptions): Promise<VerificationOutcome> {
  const probe = createApiClient({
    baseUrl: options.baseUrl,
    tokenProvider: () => options.ticket,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const endpoint = `${ENDPOINTS.profileRead.method} ${ENDPOINTS.profileRead.path}`;

  try {
    await probe.getJson(ENDPOINTS.profileRead.path);
    return { ok: true };
  } catch (caught) {
    if (caught instanceof ApiClientError) {
      // 401 是「票据不被承认」，必须显式失败；绝不能落到下面的成功分支
      if (caught.status === 401) {
        return { ok: false, error: toUiError(caught, endpoint) };
      }
      if (caught.status === 404 || caught.status === 403) {
        return {
          ok: true,
          ...(caught.status === 403
            ? { warning: '会话有效，但当前角色缺少 profile:self:read，部分管理端功能可能不可用。' }
            : {}),
        };
      }
    }
    return { ok: false, error: toUiError(caught, endpoint) };
  }
}

/** 联调连通性探测结果：只表达「能不能连上、后端是否健康」，不构成任何授权判断 */
export interface ApiProbeResult {
  ok: boolean;
  health?: HealthView;
  error?: UiError;
}

export interface ApiProbeOptions {
  /** 与主客户端同源的基地址（必须已被 `resolveApiBaseUrlResult` 判定为合法） */
  baseUrl: string;
  /** 仅用于测试注入；生产环境走 `globalThis.fetch` */
  fetchImpl?: typeof fetch;
  /** 仅用于测试缩短超时；生产环境走客户端默认值 */
  timeoutMs?: number;
}

/**
 * 联调连通性探测：**匿名**请求 `GET /health`。
 *
 * 三个刻意之处：
 * 1. **不带票据**：探测发生在登录之前，是「我先看看 API 通不通」的动作；如果它携带票据，
 *    「先探测再粘贴票据」就变成了把凭证发往尚未确认的目标。这里不传 `tokenProvider`，
 *    结构上不会有 Authorization 头。
 * 2. **不改会话**：不接 `onUnauthorized`，也不写存储。探测失败只是展示一条错误状态。
 * 3. **fail-closed**：基地址非法时 `createApiClient` 会抛错，本函数把它转成 `ok: false`，
 *    绝不放行到「看起来连通」的结论。
 */
export async function probeApiHealth(options: ApiProbeOptions): Promise<ApiProbeResult> {
  const endpoint = `${ENDPOINTS.health.method} ${ENDPOINTS.health.path}`;
  try {
    const probe = createApiClient({
      baseUrl: options.baseUrl,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const health = await probe.getJson<HealthView>(ENDPOINTS.health.path);
    return { ok: true, health };
  } catch (caught) {
    return { ok: false, error: toUiError(caught, endpoint) };
  }
}
