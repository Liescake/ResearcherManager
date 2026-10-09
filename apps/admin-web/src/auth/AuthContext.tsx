import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiClientError, createApiClient, resolveApiBaseUrl } from '../api/client';
import type { ApiClient } from '../api/client';
import { ENDPOINTS } from '../api/endpoints';
import { toUiError, type UiError } from '../api/errors';
import { createDemoGateway, createLiveGateway, type AdminGateway } from '../api/gateway';
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
  /** 会话层提示（会话过期、已退出等），展示后由页面调用 `clearNotice` */
  readonly notice: string | null;
  clearNotice(): void;
  loginWithTicket(input: LoginInput): Promise<LoginResult>;
  enterDemoMode(): void;
  logout(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const SESSION_EXPIRED_NOTICE = '登录状态已失效，请重新登录。';
export const LOGGED_OUT_NOTICE = '已退出登录。';
export const DEMO_ENTERED_NOTICE =
  '已进入受控演示模式：所有数据来自前端夹具，写操作被拒绝，不会产生任何真实持久化结果。';

/** 票据形状不合法时的本地拒绝（不发请求，也不写入会话） */
export const INVALID_TICKET_NOTICE = '会话票据格式不符：应为 8–128 位字母、数字或 . _ : - 字符。';

interface VerificationOutcome {
  ok: boolean;
  warning?: string;
  error?: UiError;
}

/**
 * 用真实请求确认票据：探测 `GET /me/profile`。
 *
 * 为什么选它：共享权限目录里**每个默认角色都含 `profile:self:read`**，因此它是最中性的
 * 「服务端是否认这张票据」探针。判定口径：
 * - 401 → 票据无效或已过期（失败）；
 * - 200 / 404（尚未提交画像）/ 403（票据有效但角色缺该权限）→ 服务端**认这张票据**；
 *   403 附提示，因为后续管理端页面可能仍然因权限不足而显示 403 面板；
 * - 网络错误/超时 → 无法确认，按失败处理（fail-closed，不写入会话）。
 */
async function verifyTicket(client: ApiClient, ticket: string): Promise<VerificationOutcome> {
  const probe = createApiClient({
    baseUrl: client.baseUrl,
    tokenProvider: () => ticket,
    // 刻意不接 onUnauthorized：登录失败不应该触发「会话过期」的全局处理
  });

  try {
    await probe.getJson(ENDPOINTS.profileRead.path);
    return { ok: true };
  } catch (caught) {
    if (caught instanceof ApiClientError) {
      if (caught.status === 401) {
        return {
          ok: false,
          error: toUiError(caught, `${ENDPOINTS.profileRead.method} ${ENDPOINTS.profileRead.path}`),
        };
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
    return {
      ok: false,
      error: toUiError(caught, `${ENDPOINTS.profileRead.method} ${ENDPOINTS.profileRead.path}`),
    };
  }
}

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

  const resolvedBaseUrl = useMemo(() => baseUrl ?? resolveApiBaseUrl(), [baseUrl]);

  const client = useMemo(
    () =>
      createApiClient({
        baseUrl: resolvedBaseUrl,
        tokenProvider: () =>
          session.status === 'authenticated' && session.session.mode === 'real'
            ? session.session.ticket
            : null,
        onUnauthorized: () => {
          // 会话语义上的失效：清空 + 提示；跳转由路由守卫完成（401 不在这里做命令式跳转）
          writeSession(storageRef.current, ANONYMOUS);
          setSession(ANONYMOUS);
          setNotice(SESSION_EXPIRED_NOTICE);
        },
      }),
    [resolvedBaseUrl, session],
  );

  const gateway = useMemo<AdminGateway>(
    () =>
      session.status === 'authenticated' && session.session.mode === 'demo'
        ? createDemoGateway()
        : createLiveGateway(client),
    [session, client],
  );

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
      const outcome = await verifyTicket(client, trimmed);
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
    [applySession, client],
  );

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
    () => ({ session, gateway, notice, clearNotice, loginWithTicket, enterDemoMode, logout }),
    [session, gateway, notice, clearNotice, loginWithTicket, enterDemoMode, logout],
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
