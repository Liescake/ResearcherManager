import { describe, expect, it } from 'vitest';
import { AiAdapterError, AiErrorCode } from '../errors';
import { invokeMatchingWithFallback } from '../matching/invoke';
import {
  DEFAULT_AI_MAX_RESPONSE_BYTES,
  createHttpJsonProvider,
  extractJsonPayload,
  parseJsonText,
} from '../provider/http-json-provider';
import type { AiCompletionRequest } from '../provider/provider-port';
import { validBundle } from './fixtures';

const request: AiCompletionRequest = {
  modelVersion: 'test-model',
  promptVersion: 'matching-v1',
  systemPrompt: 'system',
  userPrompt: 'user',
  schemaHint: '{}',
  signal: new AbortController().signal,
};

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function fakeFetchRecorder(calls: FetchArgs[], response: () => Response): typeof fetch {
  const implementation = async (...args: FetchArgs): Promise<Response> => {
    calls.push(args);
    return response();
  };
  return implementation as unknown as typeof fetch;
}

/** 注入一个总是抛错的 fetch（模拟网络层失败） */
function rejectingFetch(error: unknown): typeof fetch {
  const implementation = async (): Promise<Response> => {
    throw error;
  };
  return implementation as unknown as typeof fetch;
}

describe('模型响应解析', () => {
  it('支持代码块围栏的 JSON 文本', () => {
    expect(parseJsonText('```json\n{"recommendations":[]}\n```')).toEqual({ recommendations: [] });
  });

  it('兼容 OpenAI 形态与直接 JSON', () => {
    expect(extractJsonPayload({ choices: [{ message: { content: '{"a":1}' } }] })).toEqual({
      a: 1,
    });
    expect(extractJsonPayload({ choices: [{ text: '{"b":2}' }] })).toEqual({ b: 2 });
    expect(extractJsonPayload({ recommendations: [] })).toEqual({ recommendations: [] });
  });

  it('非法 JSON 抛出 AI_OUTPUT_INVALID', () => {
    expect(() => parseJsonText('not-json')).toThrowError(AiAdapterError);
    try {
      parseJsonText('not-json');
    } catch (error) {
      expect((error as AiAdapterError).code).toBe(AiErrorCode.OutputInvalid);
    }
  });
});

describe('HTTP JSON Provider', () => {
  it('按约定拼接端点、携带鉴权头并解析模型输出', async () => {
    const calls: FetchArgs[] = [];
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'test-key',
      model: 'default-model',
      fetchImpl: fakeFetchRecorder(
        calls,
        () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: '{"recommendations":[]}' } }] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    });

    const result = await provider.completeJson(request);
    expect(result).toEqual({ recommendations: [] });
    expect(String(calls[0]?.[0])).toBe('https://api.example.com/v1/chat/completions');
    const init = calls[0]?.[1];
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
    expect(String(init?.body)).toContain('test-model');
    // 密钥只在 Authorization 头里，绝不进请求体
    expect(String(init?.body)).not.toContain('test-key');
  });

  it('非 2xx 只暴露状态码，不回显响应体', async () => {
    const calls: FetchArgs[] = [];
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'default-model',
      fetchImpl: fakeFetchRecorder(calls, () => new Response('内部敏感信息', { status: 500 })),
    });

    await expect(provider.completeJson(request)).rejects.toThrowError(AiAdapterError);
    try {
      await provider.completeJson(request);
    } catch (error) {
      const adapterError = error as AiAdapterError;
      expect(adapterError.code).toBe(AiErrorCode.ProviderError);
      expect(adapterError.message).toContain('500');
      expect(adapterError.message).not.toContain('内部敏感信息');
    }
  });
});

describe('HTTP JSON Provider 端点安全策略', () => {
  it('拒绝本机 / 私网 baseUrl，且错误不回显原始地址', () => {
    let caught: unknown;
    try {
      createHttpJsonProvider({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AiAdapterError);
    const adapterError = caught as AiAdapterError;
    expect(adapterError.code).toBe(AiErrorCode.ProviderError);
    expect(adapterError.message).not.toContain('127.0.0.1');
    expect(adapterError.safeDetails?.endpointCode).toBe('AI_ENDPOINT_HOST_NOT_ALLOWED');
  });

  it('显式受信主机放行本机网关，并显式禁止跟随重定向', async () => {
    const calls: FetchArgs[] = [];
    const provider = createHttpJsonProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'sk-local-gateway',
      model: 'm',
      trustedHosts: '127.0.0.1',
      fetchImpl: fakeFetchRecorder(calls, () => new Response('{"ok":true}', { status: 200 })),
    });

    const result = await provider.completeJson(request);
    expect(result).toEqual({ ok: true });
    expect(String(calls[0]?.[0])).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(calls[0]?.[1]?.redirect).toBe('error');
    expect(String(calls[0]?.[1]?.body)).not.toContain('sk-local-gateway');
  });

  it('fetch 因重定向失败时转为安全 ProviderError（不泄露目标 URL）', async () => {
    const cause = new Error('unexpected redirect to https://evil.example.com/');
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      fetchImpl: rejectingFetch(Object.assign(new TypeError('fetch failed'), { cause })),
    });

    try {
      await provider.completeJson(request);
      expect.unreachable('应当抛出安全 ProviderError');
    } catch (error) {
      const adapterError = error as AiAdapterError;
      expect(adapterError.code).toBe(AiErrorCode.ProviderError);
      expect(adapterError.safeDetails?.reason).toBe('redirect');
      expect(adapterError.message).not.toContain('evil.example.com');
      expect(adapterError.message).not.toContain('api.example.com');
    }
  });

  it('3xx 响应同样按安全 ProviderError 处理，不跟随跳转', async () => {
    const calls: FetchArgs[] = [];
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      fetchImpl: fakeFetchRecorder(
        calls,
        () =>
          new Response('', {
            status: 302,
            headers: { location: 'https://evil.example.com/' },
          }),
      ),
    });

    try {
      await provider.completeJson(request);
      expect.unreachable('应当抛出安全 ProviderError');
    } catch (error) {
      const adapterError = error as AiAdapterError;
      expect(adapterError.code).toBe(AiErrorCode.ProviderError);
      expect(adapterError.safeDetails?.reason).toBe('redirect');
      expect(adapterError.message).not.toContain('evil.example.com');
    }
  });

  it('默认响应体上限是 1 MiB（可配置）', () => {
    expect(DEFAULT_AI_MAX_RESPONSE_BYTES).toBe(1_048_576);
    expect(() =>
      createHttpJsonProvider({
        baseUrl: 'https://api.example.com/v1',
        model: 'm',
        maxResponseBytes: 0,
      }),
    ).toThrowError(AiAdapterError);
  });
});

describe('HTTP JSON Provider 响应体硬上限', () => {
  it('流式响应超过上限立即拒绝，且不解析 JSON', async () => {
    // 不设置 content-length：走流式分块计数路径
    const oversized = JSON.stringify({
      choices: [{ message: { content: `sup3rsecret-${'x'.repeat(2048)}` } }],
    });
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      maxResponseBytes: 64,
      fetchImpl: fakeFetchRecorder([], () => new Response(oversized, { status: 200 })),
    });

    try {
      await provider.completeJson(request);
      expect.unreachable('应当抛出 oversize 安全错误');
    } catch (error) {
      const adapterError = error as AiAdapterError;
      expect(adapterError.code).toBe(AiErrorCode.ProviderError);
      expect(adapterError.safeDetails?.reason).toBe('oversize');
      expect(adapterError.message).not.toContain('sup3rsecret');
    }
  });

  it('content-length 声明的超大响应直接拒绝，不进入读取', async () => {
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      maxResponseBytes: 1024,
      fetchImpl: fakeFetchRecorder(
        [],
        () =>
          new Response('{}', {
            status: 200,
            headers: { 'content-length': '10485760' },
          }),
      ),
    });

    try {
      await provider.completeJson(request);
      expect.unreachable('应当抛出 oversize 安全错误');
    } catch (error) {
      expect((error as AiAdapterError).safeDetails?.reason).toBe('oversize');
    }
  });

  it('上限内的正常响应照常解析', async () => {
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      maxResponseBytes: 4096,
      fetchImpl: fakeFetchRecorder(
        [],
        () => new Response('{"recommendations":[]}', { status: 200 }),
      ),
    });
    await expect(provider.completeJson(request)).resolves.toEqual({ recommendations: [] });
  });

  it('响应体不是合法 JSON 时按安全 ProviderError 处理，不回显原文', async () => {
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      fetchImpl: fakeFetchRecorder(
        [],
        () => new Response('内部敏感信息 not-json', { status: 200 }),
      ),
    });

    try {
      await provider.completeJson(request);
      expect.unreachable('应当抛出安全 ProviderError');
    } catch (error) {
      const adapterError = error as AiAdapterError;
      expect(adapterError.code).toBe(AiErrorCode.ProviderError);
      expect(adapterError.message).not.toContain('内部敏感信息');
    }
  });
});

describe('HTTP JSON Provider 错误不泄露', () => {
  it('网络层错误消息（含完整 URL 与密钥）不进入对外错误', async () => {
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      fetchImpl: rejectingFetch(
        new TypeError('request to https://api.example.com/v1?key=sk-sup3rsecret failed'),
      ),
    });

    try {
      await provider.completeJson(request);
      expect.unreachable('应当抛出安全 ProviderError');
    } catch (error) {
      const adapterError = error as AiAdapterError;
      expect(adapterError.code).toBe(AiErrorCode.ProviderError);
      expect(adapterError.message).not.toContain('sup3rsecret');
      expect(adapterError.message).not.toContain('api.example.com');
      expect(adapterError.safeDetails?.errorName).toBe('TypeError');
    }
  });

  it('中断（AbortError）保持中断语义，交由 withTimeout 映射为超时', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      fetchImpl: rejectingFetch(abortError),
    });

    await expect(provider.completeJson(request)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('重定向失败经 invokeMatchingWithFallback 走既有降级路径', async () => {
    const cause = new Error('unexpected redirect');
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      fetchImpl: rejectingFetch(Object.assign(new TypeError('fetch failed'), { cause })),
    });

    const outcome = await invokeMatchingWithFallback({
      provider,
      bundle: validBundle(),
      modelVersion: 'http-json-model',
      maxRetries: 0,
    });

    expect(outcome.status).toBe('fallback');
    expect(outcome.degraded).toBe(true);
    expect(outcome.errorCode).toBe(AiErrorCode.ProviderError);
    expect(outcome.result.fallbackUsed).toBe(true);
    expect(outcome.result.recommendations.length).toBeGreaterThan(0);
  });
});
