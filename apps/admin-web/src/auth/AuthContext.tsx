import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createApiClient, resolveApiBaseUrlResult } from '../api/client';
import { ENDPOINTS } from '../api/endpoints';
import { toUiError, type UiError } from '../api/errors';
import {
  createDemoGateway,
  createLiveGateway,
  createMisconfiguredGateway,
  type AdminGateway,
} from '../api/gateway';
import {
  ANONYMOUS,
  createBrowserSessionStorage,
  createDemoSession,
  createSession,
  isSessionTicketShape,
  readSession,
  writeSession,
  type SessionState,
  type SessionStorageLike,
} from '../api/session';
import { HOME_PATH, LOGIN_PATH } from '../router/routes';
import { buildHash, navigate } from '../router/hash-router';
import {
  LOGGED_OUT_NOTICE,
  SESSION_EXPIRED_NOTICE,
  expireSession,
  probeApiHealth,
  verifyTicket,
  type ApiProbeResult,
} from './session-flow';

/**
 * 会话层提示里与 401 相关的两条由无 React 依赖的 `session-flow` 提供，
 * 在这里转出以保持既有引用路径不变。
 */
export { LOGGED_OUT_NOTICE, SESSION_EXPIRED_NOTICE };

/**
 * 会话与取数上下文。
 *
 * 职责边界：
 * - **登录是真实的**：会话票据登录会用一次真实请求向服务端确认（见 `verifyTicket`），
 *   确认通过才写入会话；确认失败就把服务端的错误如实展示，绝不本地伪造成功；
 * - **演示是显式的**：演示模式只有用户主动点击才进入，且没有票据、走 `createDemoGateway`，
 *   在代码层面无法发出请求或写入数据；
 * - **401 只有一个处理点**：`client.onUnauthorized` → 清空会话 + 记录提示；页面不再各自处理 401。
 */
export interface LoginInput {
  ticket: string;
  /** 登录成功后的回跳目标（站内哈希）；不合法时回首页 */
  redirect?: string;
}

export type LoginResult = { ok: true; warning?: string } | { ok: false; error: UiError };

export interface AuthContextValue {
  readonly session: SessionState;
  readonly gateway: AdminGateway;
  /** 实际生效的 API 基地址（与请求头里票据的去向完全一致）；配置非法时为空串 */
  readonly apiBaseUrl: string;
  /** 基地址配置错误：非 null 时界面只渲染配置错误，且不得发起任何请求 */
  readonly apiConfigError: UiError | null;
  /** 会话层提示（会话过期、已退出等），展示后由页面调用 `clearNotice` */
  readonly notice: string | null;
  clearNotice(): void;
  loginWithTicket(input: LoginInput): Promise<LoginResult>;
  enterDemoMode(): void;
  logout(): void;
  /** 联调连通性探测：匿名 GET /health，不携带票据、不改变会话 */
  checkApiConnection(): Promise<ApiProbeResult>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const DEMO_ENTERED_NOTICE =
  '已进入受控演示模式：所有数据来自前端夹具，写操作被拒绝，不会产生任何真实持久化结果。';

/** 票据形状不合法时的本地拒绝（不发请求，也不写入会话） */
export const INVALID_TICKET_NOTICE = '会话票据格式不符：应为 8–128 位字母、数字或 . _ : - 字符。';

export interface AuthProviderProps {
  children: ReactNode;
  /** 便于测试注入内存存储；不传则用 browser sessionStorage（不可用时降级为内存态） */
  storage?: SessionStorageLike | null;
  /** 便于测试注入基地址 */
  baseUrl?: string;
}

export function AuthProvider({ children, storage, baseUrl }: AuthProviderProps): ReactNode {
  const storageRef = useRef<SessionStorageLike | null>(
    storage === undefined ? createBrowserSessionStorage() : storage,
  );
  const [session, setSession] = useState<SessionState>(() => readSession(storageRef.current));
  const [notice, setNotice] = useState<string | null>(null);

  const applySession = useCallback((next: SessionState) => {
    writeSession(storageRef.current, next);
    setSession(next);
  }, []);

  const resolvedBaseUrl = useMemo(() => resolveApiBaseUrlResult(baseUrl), [baseUrl]);
  const apiBaseUrl = resolvedBaseUrl.ok ? resolvedBaseUrl.baseUrl : '';
  const demoSession = session.status === 'authenticated' && session.session.mode === 'demo';
  /**
   * 配置错误只在**真实模式**下成为阻断状态。
   *
   * 演示模式不构造客户端、不发任何请求，因此一个写错的 API 地址不该妨碍界面走查——
   * 把两种模式放进同一个阻断条件，等于让「后端配置有问题」连带禁掉了「不依赖后端的演示」。
   */
  const apiConfigError = useMemo(
    () => (demoSession || resolvedBaseUrl.ok ? null : toUiError(resolvedBaseUrl.error)),
    [demoSession, resolvedBaseUrl],
  );

  /**
   * 客户端与网关在**同一个 memo** 里构造，是为了让「基地址非法」「演示模式」这两条
   * 不变量在结构上成立：前者拿不到客户端（连构造都不会发生），后者只会拿到演示网关。
   */
  const { client, gateway } = useMemo((): {
    client: ReturnType<typeof createApiClient> | null;
    gateway: AdminGateway;
  } => {
    if (session.status === 'authenticated' && session.session.mode === 'demo') {
      // 演示模式：不构造任何 API 客户端，代码层面就无法发出请求、更无法写入
      return { client: null, gateway: createDemoGateway() };
    }
    if (!resolvedBaseUrl.ok) {
      // 基地址非法：fail-closed，既不构造客户端，也不给界面任何「空数据」的错觉
      return { client: null, gateway: createMisconfiguredGateway(resolvedBaseUrl.error) };
    }
    const liveClient = createApiClient({
      baseUrl: resolvedBaseUrl.baseUrl,
      tokenProvider: () =>
        session.status === 'authenticated' && session.session.mode === 'real'
          ? session.session.ticket
          : null,
      onUnauthorized: () => {
        // 会话语义上的失效：清空 + 提示；跳转由路由守卫完成（401 不在这里做命令式跳转）
        const expiry = expireSession(storageRef.current);
        setSession(expiry.state);
        setNotice(expiry.notice);
      },
    });
    return { client: liveClient, gateway: createLiveGateway(liveClient) };
  }, [resolvedBaseUrl, session]);

  const loginWithTicket = useCallback(
    async ({ ticket, redirect }: LoginInput): Promise<LoginResult> => {
      const trimmed = ticket.trim();
      if (!isSessionTicketShape(trimmed)) {
        return {
          ok: false,
          error: {
            kind: 'validation',
            code: 'INVALID_TICKET_SHAPE',
            message: INVALID_TICKET_NOTICE,
            endpoint: `${ENDPOINTS.sessionLogin.method} ${ENDPOINTS.sessionLogin.path}`,
          },
        };
      }
      if (client === null) {
        // 基地址非法时本地拒绝：票据不会离开浏览器，请求一个都不会发出
        return {
          ok: false,
          error: apiConfigError ?? toUiError(new Error('API 基地址配置不合法，已拒绝登录请求')),
        };
      }
      const outcome = await verifyTicket({ baseUrl: client.baseUrl, ticket: trimmed });
      if (!outcome.ok) {
        return {
          ok: false,
          error:
            outcome.error ?? toUiError(new Error('无法确认会话票据'), ENDPOINTS.sessionLogin.path),
        };
      }
      applySession({
        status: 'authenticated',
        session: createSession(trimmed, '会话票据登录'),
      });
      setNotice(null);
      navigate(redirect !== undefined && redirect !== '' ? redirect : buildHash(HOME_PATH));
      return outcome.warning === undefined ? { ok: true } : { ok: true, warning: outcome.warning };
    },
    [applySession, client, apiConfigError],
  );

  const checkApiConnection = useCallback(async (): Promise<ApiProbeResult> => {
    if (!resolvedBaseUrl.ok) {
      return { ok: false, error: toUiError(resolvedBaseUrl.error) };
    }
    return probeApiHealth({ baseUrl: resolvedBaseUrl.baseUrl });
  }, [resolvedBaseUrl]);

  const enterDemoMode = useCallback(() => {
    applySession({ status: 'authenticated', session: createDemoSession() });
    setNotice(DEMO_ENTERED_NOTICE);
    navigate(buildHash(HOME_PATH));
  }, [applySession]);

  const logout = useCallback(() => {
    applySession(ANONYMOUS);
    setNotice(LOGGED_OUT_NOTICE);
    navigate(buildHash(LOGIN_PATH));
  }, [applySession]);

  const clearNotice = useCallback(() => {
    setNotice(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      gateway,
      apiBaseUrl,
      apiConfigError,
      notice,
      clearNotice,
      loginWithTicket,
      enterDemoMode,
      logout,
      checkApiConnection,
    }),
    [
      session,
      gateway,
      apiBaseUrl,
      apiConfigError,
      notice,
      clearNotice,
      loginWithTicket,
      enterDemoMode,
      logout,
      checkApiConnection,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  }
  return value;
}
