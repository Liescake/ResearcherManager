/**
 * 会话模型与浏览器存储（纯逻辑 + 可注入存储，便于在 node 环境单测）。
 *
 * 两种会话**在结构上可区分**，避免「演示会话」被误当成真实登录：
 * - `real`：持有服务端会话票据（Bearer）。票据由服务端种子写入，前端只负责携带；
 *   票据形状受白名单约束（`[A-Za-z0-9._:-]{8,128}`），从结构上排除换行/控制字符
 *   —— 否则一个被污染的存储值可以直接造成 HTTP 头注入；
 * - `demo`：**没有票据**。它只是「按受控夹具渲染界面」的开关，绝不会被注入到请求头，
 *   也绝不会被当成登录成功。所有演示数据在界面上全程标注。
 *
 * 存储位置：`sessionStorage`（关闭标签页即失效），而不是 `localStorage`：
 * 管理端票据的有效期更长也没有意义，缩短暴露窗口更划算。
 */
export type SessionMode = 'real' | 'demo';

export interface RealSession {
  readonly mode: 'real';
  readonly ticket: string;
  readonly label: string;
  readonly signedInAt: string;
}

export interface DemoSession {
  readonly mode: 'demo';
  readonly label: string;
  readonly signedInAt: string;
}

export type Session = RealSession | DemoSession;

export type SessionState =
  | { readonly status: 'anonymous' }
  | { readonly status: 'authenticated'; readonly session: Session };

export const SESSION_STORAGE_KEY = 'rm.admin.session.v1';
export const DEMO_SESSION_LABEL = '演示管理员';
export const ANONYMOUS: SessionState = { status: 'anonymous' };

/** 与服务端 `session-subject.baseline.ts` 的 Bearer 白名单同口径 */
export const SESSION_TICKET_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function isSessionTicketShape(value: unknown): value is string {
  return typeof value === 'string' && SESSION_TICKET_PATTERN.test(value);
}

/** 解析存储值。任何不认识/被篡改/缺字段的内容都判为匿名（默认拒绝，绝不半信半疑）。 */
export function parseSession(raw: string | null | undefined): SessionState {
  if (typeof raw !== 'string' || raw === '') return ANONYMOUS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return ANONYMOUS;
  }
  if (typeof parsed !== 'object' || parsed === null) return ANONYMOUS;
  const candidate = parsed as Record<string, unknown>;

  const label = typeof candidate['label'] === 'string' ? candidate['label'] : '';
  const signedInAt = typeof candidate['signedInAt'] === 'string' ? candidate['signedInAt'] : '';

  if (candidate['mode'] === 'real') {
    const ticket = candidate['ticket'];
    if (!isSessionTicketShape(ticket)) return ANONYMOUS;
    return {
      status: 'authenticated',
      session: { mode: 'real', ticket, label: label === '' ? '会话票据登录' : label, signedInAt },
    };
  }

  if (candidate['mode'] === 'demo') {
    return {
      status: 'authenticated',
      session: {
        mode: 'demo',
        label: label === '' ? DEMO_SESSION_LABEL : label,
        signedInAt,
      },
    };
  }

  return ANONYMOUS;
}

/** 序列化：匿名返回 null（调用方据此删除键，而不是写入一个「空会话」） */
export function serializeSession(state: SessionState): string | null {
  if (state.status === 'anonymous') return null;
  const { session } = state;
  if (session.mode === 'demo') {
    return JSON.stringify({ mode: 'demo', label: session.label, signedInAt: session.signedInAt });
  }
  return JSON.stringify({
    mode: 'real',
    ticket: session.ticket,
    label: session.label,
    signedInAt: session.signedInAt,
  });
}

export function createSession(ticket: string, label: string, now: Date = new Date()): RealSession {
  return { mode: 'real', ticket, label, signedInAt: now.toISOString() };
}

export function createDemoSession(
  label: string = DEMO_SESSION_LABEL,
  now: Date = new Date(),
): DemoSession {
  return { mode: 'demo', label, signedInAt: now.toISOString() };
}

export function readSession(storage: SessionStorageLike | null): SessionState {
  if (storage === null) return ANONYMOUS;
  try {
    return parseSession(storage.getItem(SESSION_STORAGE_KEY));
  } catch {
    return ANONYMOUS;
  }
}

export function writeSession(storage: SessionStorageLike | null, state: SessionState): void {
  if (storage === null) return;
  try {
    const serialized = serializeSession(state);
    if (serialized === null) {
      storage.removeItem(SESSION_STORAGE_KEY);
      return;
    }
    storage.setItem(SESSION_STORAGE_KEY, serialized);
  } catch {
    // 隐私模式/存储被禁用：不写入即可，界面仍可在当前标签页内使用（会话降级为内存态）
  }
}

/** 浏览器存储适配：SSR / 测试 / 隐私模式下返回 null，调用方必须容忍 */
export function createBrowserSessionStorage(
  scope: Pick<Window, 'sessionStorage'> | undefined = typeof window === 'undefined'
    ? undefined
    : window,
): SessionStorageLike | null {
  if (scope === undefined) return null;
  try {
    const storage = scope.sessionStorage;
    // 触碰一次以触发 Safari 隐私模式的异常
    void storage.length;
    return storage;
  } catch {
    return null;
  }
}
