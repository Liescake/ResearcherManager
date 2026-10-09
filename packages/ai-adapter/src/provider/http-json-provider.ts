import { AiAdapterError, AiErrorCode } from '../errors';
import type { AiCompletionRequest, AiProvider } from './provider-port';

/**
 * HTTP JSON Provider：兼容 OpenAI Chat Completions 形态的服务（自建网关或第三方）。
 * 安全要求：
 * - 密钥只放在请求头，绝不写入日志、错误消息或审计明细；
 * - 错误只暴露 HTTP 状态码，不回显响应体原文（可能包含敏感内容）。
 */

export interface HttpJsonProviderOptions {
  id?: string;
  /** 形如 https://api.example.com/v1 */
  baseUrl: string;
  apiKey?: string;
  /** 默认模型名；请求未指定时使用 */
  model: string;
  temperature?: number;
  extraHeaders?: Record<string, string>;
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

export function createHttpJsonProvider(options: HttpJsonProviderOptions): AiProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new AiAdapterError(
      AiErrorCode.ProviderError,
      '当前运行时不支持 fetch，无法使用 HTTP Provider',
    );
  }

  const endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    ...options.extraHeaders,
  };

  return {
    id: options.id ?? 'http-json',
    async completeJson(request: AiCompletionRequest): Promise<unknown> {
      const response = await fetchImpl(endpoint, {
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
      });

      if (!response.ok) {
        throw new AiAdapterError(AiErrorCode.ProviderError, `模型服务返回状态 ${response.status}`, {
          status: response.status,
        });
      }

      const payload: unknown = await response.json();
      return extractJsonPayload(payload);
    },
  };
}
