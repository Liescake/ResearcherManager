import { MAX_PAGE_SIZE, isApiEnvelope } from '@rm/shared';
import type { ApiEnvelope, ApiErrorBody } from '@rm/shared';

/**
 * 最小 API 客户端（管理端专用）。
 *
 * 边界与不变量：
 * - 强制解析 `{ data, meta, error }` 信封，非信封响应一律视为错误（后端换了形状不会被当成成功）；
 * - 禁止请求绝对地址，避免把会话票据发往第三方；
 * - 基地址 fail-closed 校验：只放行同源根相对路径与显式 http(s) 绝对地址，协议相对、带用户名/密码、
 *   含控制字符等一律抛 `INVALID_BASE_URL`；校验在任何请求之前完成，票据不会被发出去；
 * - 统一超时并转换为稳定的前端错误码；
 * - 会话票据只经 `tokenProvider` 注入 `Authorization: Bearer`，**不落任何日志**；
 * - 401 不是「页面错误」而是「会话失效」：统一回调 `onUnauthorized`，由会话层清空并跳登录，
 *   页面不各自处理 401，避免出现「有的页面跳转、有的页面显示错误」的不一致；
 * - 403 不触发登出、不跳转：那是权限问题，由页面渲染「无权限」面板。
 *
 * 本客户端不引入 axios 等运行时依赖：`fetch` + `AbortController` 足够，且便于单测注入。
 */

export const DEFAULT_API_BASE_URL = '/api/v1';
export const REQUEST_TIMEOUT_MS = 8000;

export class ApiClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;

  constructor(
    code: string,
    message: string,
    options: { status?: number; requestId?: string } = {},
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

/** 基地址非法时的稳定错误码：fail-closed，请求根本不会发出，票据也就不可能被送出 */
export const INVALID_BASE_URL_CODE = 'INVALID_BASE_URL';

/**
 * 响应体不是统一信封（`{ data, meta, error }`）时的稳定错误码。
 *
 * 为什么单独给一个码：非信封响应在 HTTP 上完全可能是 200（代理返回 HTML、后端换了形状、
 * 网关插入了错误页）。只按状态码兜底会落到 `unknown`（「发生未预期错误」），排障时无法区分
 * 「后端契约漂移」与「偶发故障」。状态码仍然保留在 `status` 上，界面据此判断
 * 401 / 403 / 404 / 503 等语义，不因为多了这个码而丢失。
 */
export const INVALID_RESPONSE_CODE = 'INVALID_RESPONSE';

/** 契约漂移时的用户安全文案：说清「不是成功」，但不暴露后端内部结构 */
export const INVALID_RESPONSE_MESSAGE =
  '服务端响应不符合统一信封契约（data / meta / error），已按失败处理';

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

/** 控制字符（C0 与 DEL）检测：可用于 URL/头部注入，一律拒绝（按码点判断，避免正则控制字符） */
function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function invalidBaseUrl(reason: string): ApiClientError {
  return new ApiClientError(
    INVALID_BASE_URL_CODE,
    `API 基地址不合法（${reason}），已拒绝，避免把会话票据发往非预期目标`,
  );
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, '');
}

/**
 * 校验并归一化 API 基地址（唯一入口，必须 fail-closed）。
 *
 * 为什么必须校验：基地址决定 `Authorization: Bearer <会话票据>` 的去向，一个误配
 * （协议相对 `//evil.com`、环境变量里混入的控制字符等）就等于把票据发给第三方。
 * 因此只放行两类目标，其余一律抛 `INVALID_BASE_URL`：
 * - 同源根相对路径（默认 `/api/v1`）：部署在反向代理后面时使用；
 * - 显式 `http(s)://host[:port][/path]` 绝对地址：独立 API 域时使用。
 *
 * 明确拒绝：控制字符、反斜杠（浏览器把 `\` 当 `/`，`\evil.com` 会变成换源地址）、
 * 协议相对 `//host`、非 http(s) 协议、空 origin、带用户名/密码、带查询串或片段，
 * 以及不以 `/` 开头的裸相对值（会相对当前页面路径解析，落点不可预期）。
 */
function normalizeBaseUrl(raw: string | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') {
    return DEFAULT_API_BASE_URL;
  }
  if (hasControlChars(value)) {
    throw invalidBaseUrl('含控制字符');
  }
  if (value.includes('\\')) {
    throw invalidBaseUrl('含反斜杠');
  }
  if (value.startsWith('//')) {
    throw invalidBaseUrl('不允许协议相对地址');
  }

  if (!HAS_SCHEME.test(value)) {
    if (!value.startsWith('/')) {
      throw invalidBaseUrl('相对基地址必须以 / 开头');
    }
    if (value.includes('?') || value.includes('#')) {
      throw invalidBaseUrl('不允许携带查询串或片段');
    }
    // 根路径 `/` 本身是合法的同源基地址：不能把末尾斜杠剥成空串——空基地址会让
    // `baseUrl` 退化，且基地址字段不再是可解析的目标，因此单独保留为 `/`。
    const stripped = stripTrailingSlashes(value);
    return stripped === '' ? '/' : stripped;
  }

  const colon = value.indexOf(':');
  const scheme = value.slice(0, colon).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw invalidBaseUrl(`不支持的协议 ${scheme}:`);
  }
  if (value.slice(colon + 1, colon + 3) !== '//') {
    throw invalidBaseUrl('绝对地址必须是 http(s)://host 形式');
  }

  const authorityStart = colon + 3;
  const authorityEnd = value.slice(authorityStart).search(/[/?#]/u);
  const authority =
    authorityEnd === -1
      ? value.slice(authorityStart)
      : value.slice(authorityStart, authorityStart + authorityEnd);
  if (authority === '') {
    throw invalidBaseUrl('缺少有效 origin');
  }
  if (authority.includes('@')) {
    throw invalidBaseUrl('不允许携带用户名/密码');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidBaseUrl('不是合法的 http(s) 地址');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw invalidBaseUrl('不允许携带查询串或片段');
  }
  return stripTrailingSlashes(parsed.href);
}

/** 显式 baseUrl 与 VITE_API_BASE_URL 共用一套校验：空值回落默认，非法值 fail-closed */
function resolveClientBaseUrl(baseUrl?: string): string {
  return baseUrl === undefined ? resolveApiBaseUrl() : normalizeBaseUrl(baseUrl);
}

/** 读取 VITE_API_BASE_URL；未配置时回落到同源 /api/v1（配合反向代理）；非法值抛 INVALID_BASE_URL */
export function resolveApiBaseUrl(env?: Record<string, unknown>): string {
  const source = env ?? (import.meta.env as unknown as Record<string, unknown>);
  const configured = source['VITE_API_BASE_URL'];
  return normalizeBaseUrl(typeof configured === 'string' ? configured : undefined);
}

/**
 * 基地址解析结果：非法值不抛异常，而是作为结果返回。
 *
 * 为什么需要它：`createApiClient` 在构造时抛错是 fail-closed 的正确行为，但如果界面在**渲染期**
 * 直接调用抛错版本（`resolveApiBaseUrl`），一个错误的环境变量就会让整个应用白屏——使用者既看不到
 * 「哪里错了」，也看不到「本该发出的请求一个都没发」。这里把失败变成可渲染的状态，同时保持
 * 同样的 fail-closed 语义：`ok: false` 时调用方不得构造任何客户端，也就不会发出任何请求。
 */
export type BaseUrlResolution =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly error: ApiClientError };

/** 与 `createApiClient` 同源的解析，但不抛异常：显式 baseUrl 与 VITE_API_BASE_URL 共用一套校验 */
export function resolveApiBaseUrlResult(explicit?: string): BaseUrlResolution {
  try {
    return { ok: true, baseUrl: resolveClientBaseUrl(explicit) };
  } catch (caught) {
    return {
      ok: false,
      error:
        caught instanceof ApiClientError
          ? caught
          : new ApiClientError(INVALID_BASE_URL_CODE, 'API 基地址不合法，已拒绝发起请求'),
    };
  }
}

function joinUrl(baseUrl: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(path) || path.startsWith('//')) {
    throw new ApiClientError('INVALID_PATH', '不允许请求绝对地址');
  }
  // 基地址允许保留为站点根 `/`：拼接前剥掉末尾斜杠，否则 `baseUrl + '/path'` 会拼出
  // `//path`——那是协议相对地址，会被浏览器解析成「另一个主机」，等于把票据换源发出去。
  const base = stripTrailingSlashes(baseUrl);
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 分页查询串：pageSize 由共享常量封顶，服务端仍会再校验一次 */
export function buildPageQuery(query: {
  page: number;
  pageSize: number;
  status?: string;
  keyword?: string;
  sortBy?: string;
  sortOrder?: string;
}): string {
  const page = Math.max(1, Math.trunc(query.page));
  const pageSize = Math.min(Math.max(1, Math.trunc(query.pageSize)), MAX_PAGE_SIZE);
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  for (const key of ['status', 'keyword', 'sortBy', 'sortOrder'] as const) {
    const value = query[key];
    if (value !== undefined && value !== '') {
      params.set(key, value);
    }
  }
  return `?${params.toString()}`;
}

export interface ApiClientOptions {
  /** 基地址；与 `VITE_API_BASE_URL` 共用同一套校验，非法值抛 `INVALID_BASE_URL` */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 会话票据提供者：返回 `null`/空串表示匿名（匿名请求不带 Authorization 头） */
  tokenProvider?: () => string | null | undefined;
  /** 401 统一回调：由会话层清空会话；页面不应重复处理 401 */
  onUnauthorized?: (error: ApiClientError) => void;
}

export interface ApiClient {
  readonly baseUrl: string;
  getJson<T>(path: string): Promise<T>;
  /** 需要读取 `meta`（分页信息）时使用；`data` 允许为 null，由调用方决定语义 */
  getEnvelope<T>(path: string): Promise<ApiEnvelope<T>>;
  postJson<T>(path: string, body: unknown): Promise<T>;
  patchJson<T>(path: string, body: unknown): Promise<T>;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
}

function readRequestId(envelope: ApiEnvelope<unknown> | undefined): string | undefined {
  const fromError = envelope?.error?.requestId;
  if (typeof fromError === 'string' && fromError !== '') return fromError;
  const fromMeta = envelope?.meta?.requestId;
  return typeof fromMeta === 'string' && fromMeta !== '' ? fromMeta : undefined;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  // 基地址先于任何请求完成校验：非法配置直接抛 INVALID_BASE_URL，票据不会被送出去
  const baseUrl = resolveClientBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function request<T>(requestOptions: RequestOptions): Promise<ApiEnvelope<T>> {
    const url = joinUrl(baseUrl, requestOptions.path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const ticket = options.tokenProvider?.() ?? null;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (typeof ticket === 'string' && ticket !== '') {
      headers['authorization'] = `Bearer ${ticket}`;
    }
    /** 只有带请求体的方法才声明 content-type，避免 GET 触发预检 */
    const hasBody = requestOptions.body !== undefined;
    if (hasBody) {
      headers['content-type'] = 'application/json';
    }

    try {
      const response = await fetchImpl(url, {
        method: requestOptions.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(requestOptions.body) } : {}),
        signal: controller.signal,
      });

      const raw: unknown = await response.json().catch(() => undefined);
      const envelope = isApiEnvelope(raw) ? (raw as unknown as ApiEnvelope<T>) : undefined;

      if (!response.ok || envelope === undefined || envelope.error !== null) {
        const errorBody: ApiErrorBody | undefined = envelope?.error ?? undefined;
        const requestId = readRequestId(envelope);
        // 响应体不是信封属于**契约违规**：可能是反向代理返回的 HTML、后端换了形状或网关错误页。
        // 服务端给出的稳定 code 永远优先；只有「服务端没给 code 且响应不是信封」时才用
        // INVALID_RESPONSE，让界面能把它与普通 HTTP 失败区分开（HTTP 层可能还是 200）。
        const contractViolation = envelope === undefined;
        const error = new ApiClientError(
          errorBody?.code ??
            (contractViolation ? INVALID_RESPONSE_CODE : `HTTP_${response.status}`),
          errorBody?.message ??
            (contractViolation ? INVALID_RESPONSE_MESSAGE : '请求失败，请稍后重试'),
          {
            status: response.status,
            ...(requestId === undefined ? {} : { requestId }),
          },
        );
        // 401 是会话层事件，不是页面事件：统一交给会话层处理，页面只渲染结果状态
        if (response.status === 401) {
          options.onUnauthorized?.(error);
        }
        throw error;
      }

      return envelope;
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApiClientError('TIMEOUT', '请求超时，请稍后重试');
      }
      throw new ApiClientError('NETWORK_ERROR', '无法连接服务端，请确认 API 是否已启动');
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestData<T>(requestOptions: RequestOptions): Promise<T> {
    const envelope = await request<T>(requestOptions);
    if (envelope.data === null) {
      throw new ApiClientError('EMPTY_RESPONSE', '服务端未返回数据', {
        status: 200,
      });
    }
    return envelope.data;
  }

  return {
    baseUrl,
    getJson: <T>(path: string): Promise<T> => requestData<T>({ method: 'GET', path }),
    getEnvelope: <T>(path: string): Promise<ApiEnvelope<T>> => request<T>({ method: 'GET', path }),
    postJson: <T>(path: string, body: unknown): Promise<T> =>
      requestData<T>({ method: 'POST', path, body }),
    patchJson: <T>(path: string, body: unknown): Promise<T> =>
      requestData<T>({ method: 'PATCH', path, body }),
  };
}
