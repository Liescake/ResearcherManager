import { AiAdapterError, AiErrorCode } from '../errors';
import { resolveAiEndpoint } from './endpoint';
import type { AiEndpointPolicy } from './endpoint';
import type { AiCompletionRequest, AiProvider } from './provider-port';

/**
 * HTTP JSON Provider：兼容 OpenAI Chat Completions 形态的服务（自建网关或第三方）。
 * 安全要求：
 * - 密钥只放在请求头，绝不写入日志、错误消息或审计明细；
 * - 端点必须通过 `resolveAiEndpoint` 的字面量安全校验（协议 / 结构 / 危险主机 / 端口）；
 * - **不跟随重定向**（`redirect: 'error'`）：重定向按安全 ProviderError 处理，走既有降级；
 * - 请求体与响应体都按硬上限做**绝对字节**约束：请求体超限在 fetch **之前**拒绝（不出网），
 *   响应体超限立即取消读取并抛安全 ProviderError；
 * - 上限配置本身也 fail-closed：非法或超过绝对最大值的配置直接拒绝创建 Provider；
 * - `extraHeaders` 不得覆盖 Authorization / Content-Type 等敏感与协议保留头；
 * - 错误只暴露 HTTP 状态码与错误名，不回显请求体/响应体原文、密钥或完整 URL。
 */

/** 响应体默认硬上限：1 MiB（可通过 maxResponseBytes / AI_MAX_RESPONSE_BYTES 调整） */
export const DEFAULT_AI_MAX_RESPONSE_BYTES = 1_048_576;

/**
 * 响应体硬上限的**绝对最大值**：16 MiB。
 * 超过该值的配置一律 fail-closed（拒绝创建 Provider），避免「配置成无限大」退化成无约束读取。
 * 与 `AI_MAX_RESPONSE_BYTES` 环境变量的上界保持一致。
 */
export const MAX_AI_MAX_RESPONSE_BYTES = 16_777_216;

/**
 * 请求体默认硬上限：1 MiB。
 * 入站提示词来自脱敏后的特征包，真实体积远小于该值；超限说明调用方拼装异常或遭遇提示词放大。
 */
export const DEFAULT_AI_MAX_REQUEST_BYTES = 1_048_576;

/** 请求体硬上限的绝对最大值：8 MiB（超过即 fail-closed） */
export const MAX_AI_MAX_REQUEST_BYTES = 8_388_608;

/**
 * 禁止由 `extraHeaders` 覆盖的请求头：
 * - 凭据类（authorization / proxy-authorization）：密钥通道必须唯一，防止替换或注入；
 * - 载荷协商与长度类（content-type / content-length / transfer-encoding）：
 *   与协议实现绑定，覆盖会破坏解析或绕过体积约束；
 * - 连接与路由类（host / connection / te / trailer / upgrade / expect / keep-alive /
 *   proxy-connection）：可改变实际出站目标或连接语义；
 * - 会话类（cookie / set-cookie）：浏览器/网关会话凭据不应经模型出站通道携带。
 */
const RESERVED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'content-type',
  'content-length',
  'transfer-encoding',
  'host',
  'connection',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'keep-alive',
  'proxy-connection',
  'cookie',
  'set-cookie',
]);

/** RFC 7230 token：请求头名称只允许该字符集（同时排除 CR/LF 注入） */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

export interface HttpJsonProviderOptions {
  id?: string;
  /** 形如 https://api.example.com/v1（必须通过端点安全校验） */
  baseUrl: string;
  apiKey?: string;
  /** 默认模型名；请求未指定时使用 */
  model: string;
  temperature?: number;
  /**
   * 附加请求头（非敏感、非协议保留）。命中保留头（Authorization / Content-Type / Host 等）
   * 或名称非法时**拒绝创建 Provider**（fail-closed），不会静默覆盖。
   */
  extraHeaders?: Record<string, string>;
  /** 响应体硬上限（字节）；超过即拒绝读取并按安全 ProviderError 降级 */
  maxResponseBytes?: number;
  /** 请求体硬上限（字节）；序列化后超限即拒绝发送（不发生网络请求） */
  maxRequestBytes?: number;
  /** 显式受信主机 allowlist（逗号分隔字符串或数组），用于自建网关等受控场景 */
  trustedHosts?: AiEndpointPolicy['trustedHosts'];
  /** 注入点：测试与自定义运行时使用 */
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 去掉 ```json 代码块围栏后解析 JSON */
export function parseJsonText(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?/iu, '')
    .replace(/```$/u, '')
    .trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new AiAdapterError(AiErrorCode.OutputInvalid, '模型响应不是合法 JSON');
  }
}

/** 兼容 { choices: [{ message: { content } }] }、{ choices: [{ text }] } 与直接 JSON */
export function extractJsonPayload(payload: unknown): unknown {
  if (typeof payload === 'string') {
    return parseJsonText(payload);
  }
  if (isRecord(payload)) {
    const { choices } = payload;
    if (Array.isArray(choices) && choices.length > 0) {
      const first: unknown = choices[0];
      if (isRecord(first)) {
        const { message, text } = first;
        if (isRecord(message) && typeof message['content'] === 'string') {
          return parseJsonText(message['content']);
        }
        if (typeof text === 'string') {
          return parseJsonText(text);
        }
      }
    }
  }
  return payload;
}

/** 解析 HTTP 响应体 JSON：失败按安全 ProviderError 处理，不回显响应体原文 */
function parseJsonResponseText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AiAdapterError(AiErrorCode.ProviderError, '模型服务响应不是合法 JSON');
  }
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * 校验字节上限配置：必须是安全正整数且不超过绝对最大值，否则 fail-closed。
 * 错误里只回显配置项名与上限，不含任何凭据、地址或原文。
 */
function resolveByteLimit(
  optionName: string,
  value: number | undefined,
  fallback: number,
  absoluteMax: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > absoluteMax) {
    throw new AiAdapterError(
      AiErrorCode.ProviderError,
      `AI 配置项 ${optionName} 必须是 1..${absoluteMax} 之间的整数`,
      { reason: 'invalid_limit', option: optionName, absoluteMax },
    );
  }
  return resolved;
}

/**
 * 归一化并校验附加请求头（fail-closed）：
 * - 名称必须是合法 token（同时阻断 CR/LF 注入）；
 * - 命中敏感/协议保留头一律拒绝，**不静默覆盖**；
 * - 值必须是字符串且不含 CR/LF；
 * 错误里只回显**头名称**（配置项名，非机密），绝不回显头取值。
 */
function sanitizeExtraHeaders(
  extraHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  if (extraHeaders === undefined) {
    return sanitized;
  }
  if (!isRecord(extraHeaders)) {
    throw new AiAdapterError(
      AiErrorCode.ProviderError,
      'AI 附加请求头必须是键值对象，已拒绝创建 Provider',
      {
        reason: 'invalid_extra_header',
      },
    );
  }

  for (const [rawName, rawValue] of Object.entries(extraHeaders)) {
    const name = rawName.trim().toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new AiAdapterError(
        AiErrorCode.ProviderError,
        'AI 附加请求头名称非法，已拒绝创建 Provider',
        { reason: 'invalid_extra_header' },
      );
    }
    if (RESERVED_REQUEST_HEADERS.has(name)) {
      throw new AiAdapterError(
        AiErrorCode.ProviderError,
        `AI 附加请求头不得覆盖协议保留头（${name}），已拒绝创建 Provider`,
        { reason: 'reserved_extra_header', header: name },
      );
    }
    if (typeof rawValue !== 'string' || /[\r\n]/u.test(rawValue)) {
      throw new AiAdapterError(
        AiErrorCode.ProviderError,
        `AI 附加请求头取值非法（${name}），已拒绝创建 Provider`,
        { reason: 'invalid_extra_header', header: name },
      );
    }
    sanitized[name] = rawValue;
  }
  return sanitized;
}

/**
 * 判定错误链（含 `cause`）是否为「不允许跟随的重定向」失败。
 * 只做布尔判定：错误消息可能包含完整 URL，绝不透传出去。
 */
function isRedirectFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (/redirect/iu.test(current.message)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function oversizeError(maxBytes: number): AiAdapterError {
  return new AiAdapterError(
    AiErrorCode.ProviderError,
    '模型服务响应体超过大小上限，已按安全策略拒绝',
    { reason: 'oversize', maxBytes },
  );
}

function requestOversizeError(maxBytes: number, bytes: number): AiAdapterError {
  return new AiAdapterError(
    AiErrorCode.ProviderError,
    'AI 请求体超过大小上限，已按安全策略拒绝发送',
    { reason: 'request_oversize', maxBytes, bytes },
  );
}

/** 非法 Content-Length：不回显原始取值（可能是被污染的响应头） */
function invalidContentLengthError(): AiAdapterError {
  return new AiAdapterError(
    AiErrorCode.ProviderError,
    '模型服务响应体长度声明非法，已按安全策略拒绝',
    { reason: 'content_length_invalid' },
  );
}

/** 尽力释放响应体，避免早退时把连接挂着 */
function discardBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // 已结束或不可取消：忽略
  }
}

/**
 * 严格解析 `content-length`：必须是**非负的安全整数**十进制字面量。
 * 不用 `parseInt`：它会把 `12abc` / `-5` / `1e3` 静默吞成看似合法的数字。
 */
function parseContentLength(raw: string): number {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/u.test(trimmed)) {
    throw invalidContentLengthError();
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidContentLengthError();
  }
  return value;
}

/**
 * 按硬上限读取响应体（**不**一次性 `response.json()`，避免超大响应先把内存吃掉）。
 * - 先看 `content-length`：非法（负数 / 非数字 / 溢出）直接拒绝，声明超限也直接拒绝，都不读流；
 * - 再按流式分块累积字节数，超过上限立刻取消读取并抛安全 ProviderError。
 */
async function readResponseBodyWithinLimit(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    try {
      const declared = parseContentLength(declaredLength);
      if (declared > maxBytes) {
        throw oversizeError(maxBytes);
      }
    } catch (error) {
      // 早退（非法声明或声明超限）前释放响应体，避免把连接挂着
      discardBody(response);
      throw error;
    }
  }

  const body = response.body;
  if (body === null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw oversizeError(maxBytes);
    }
    return text;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const chunk = result.value;
      if (chunk === undefined) {
        continue;
      }
      received += chunk.byteLength;
      if (received > maxBytes) {
        throw oversizeError(maxBytes);
      }
      text += decoder.decode(chunk, { stream: true });
    }
  } finally {
    // 超限提前中止或正常读完都释放读取器；cancel 对已结束的流是幂等空操作
    try {
      await reader.cancel();
    } catch {
      // 连接已被中断：忽略，真正的安全错误已在上面抛出
    }
  }
  text += decoder.decode();
  return text;
}

export function createHttpJsonProvider(options: HttpJsonProviderOptions): AiProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new AiAdapterError(
      AiErrorCode.ProviderError,
      '当前运行时不支持 fetch，无法使用 HTTP Provider',
    );
  }

  const maxResponseBytes = resolveByteLimit(
    'maxResponseBytes',
    options.maxResponseBytes,
    DEFAULT_AI_MAX_RESPONSE_BYTES,
    MAX_AI_MAX_RESPONSE_BYTES,
  );
  const maxRequestBytes = resolveByteLimit(
    'maxRequestBytes',
    options.maxRequestBytes,
    DEFAULT_AI_MAX_REQUEST_BYTES,
    MAX_AI_MAX_REQUEST_BYTES,
  );

  const resolution = resolveAiEndpoint(options.baseUrl, { trustedHosts: options.trustedHosts });
  if (!resolution.ok) {
    // 只带错误码，不带原始 baseUrl（可能含凭据或查询串）
    throw new AiAdapterError(
      AiErrorCode.ProviderError,
      'AI 服务地址未通过安全校验，已拒绝创建 Provider',
      { endpointCode: resolution.code },
    );
  }
  const endpoint = `${resolution.endpoint.url.replace(/\/+$/u, '')}/chat/completions`;

  // 附加头先做保留头/注入校验；通过后也只能追加，不可能覆盖协议头或 Authorization
  const extraHeaders = sanitizeExtraHeaders(options.extraHeaders);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    ...extraHeaders,
  };

  return {
    id: options.id ?? 'http-json',
    async completeJson(request: AiCompletionRequest): Promise<unknown> {
      // 先序列化再量字节：超限时**不发生任何网络请求**（凭据与内容都不出网）
      let body: string;
      try {
        body = JSON.stringify({
          model: request.modelVersion || options.model,
          temperature: options.temperature ?? 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
          ],
        });
      } catch {
        // 序列化失败原因可能带业务内容，只回显安全的 reason
        throw new AiAdapterError(
          AiErrorCode.ProviderError,
          'AI 请求体序列化失败，已按安全策略拒绝发送',
          { reason: 'request_serialize_failed' },
        );
      }

      const bodyBytes = new TextEncoder().encode(body).byteLength;
      if (bodyBytes > maxRequestBytes) {
        throw requestOversizeError(maxRequestBytes, bodyBytes);
      }

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: request.signal,
          // 显式禁止跟随跳转：重定向可能是把出站凭据带到非预期主机的通道
          redirect: 'error',
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          // 保持中断语义：由 withTimeout 统一映射为 AI_TIMEOUT
          throw error;
        }
        if (isRedirectFailure(error)) {
          throw new AiAdapterError(
            AiErrorCode.ProviderError,
            '模型服务返回重定向，已按安全策略拒绝跟随',
            { reason: 'redirect' },
          );
        }
        // fetch 失败消息通常带完整 URL，这里只保留错误名
        const errorName = error instanceof Error ? error.name : typeof error;
        throw new AiAdapterError(AiErrorCode.ProviderError, undefined, { errorName });
      }

      if (isRedirectStatus(response.status)) {
        throw new AiAdapterError(
          AiErrorCode.ProviderError,
          '模型服务返回重定向，已按安全策略拒绝跟随',
          { reason: 'redirect', status: response.status },
        );
      }

      if (!response.ok) {
        throw new AiAdapterError(AiErrorCode.ProviderError, `模型服务返回状态 ${response.status}`, {
          status: response.status,
        });
      }

      const text = await readResponseBodyWithinLimit(response, maxResponseBytes);
      return extractJsonPayload(parseJsonResponseText(text));
    },
  };
}
