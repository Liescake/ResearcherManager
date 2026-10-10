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
 * - 响应体先按硬上限截断再解析 JSON，超限同样按安全 ProviderError 降级；
 * - 错误只暴露 HTTP 状态码与错误名，不回显响应体原文、密钥或完整 URL。
 */

/** 响应体默认硬上限：1 MiB（可通过 maxResponseBytes / AI_MAX_RESPONSE_BYTES 调整） */
export const DEFAULT_AI_MAX_RESPONSE_BYTES = 1_048_576;

export interface HttpJsonProviderOptions {
  id?: string;
  /** 形如 https://api.example.com/v1（必须通过端点安全校验） */
  baseUrl: string;
  apiKey?: string;
  /** 默认模型名；请求未指定时使用 */
  model: string;
  temperature?: number;
  extraHeaders?: Record<string, string>;
  /** 响应体硬上限（字节）；超过即拒绝读取并按安全 ProviderError 降级 */
  maxResponseBytes?: number;
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

/**
 * 按硬上限读取响应体（**不**一次性 `response.json()`，避免超大响应先把内存吃掉）。
 * - 先看 `content-length`（存在且超限即拒绝，不读流）；
 * - 再按流式分块累积字节数，超过上限立刻取消读取并抛安全 ProviderError。
 */
async function readResponseBodyWithinLimit(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const declared = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw oversizeError(maxBytes);
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

  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_AI_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new AiAdapterError(AiErrorCode.ProviderError, '响应体大小上限必须是正整数', {
      reason: 'invalid_limit',
    });
  }

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

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    ...options.extraHeaders,
  };

  return {
    id: options.id ?? 'http-json',
    async completeJson(request: AiCompletionRequest): Promise<unknown> {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: request.modelVersion || options.model,
            temperature: options.temperature ?? 0.2,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: request.systemPrompt },
              { role: 'user', content: request.userPrompt },
            ],
          }),
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
