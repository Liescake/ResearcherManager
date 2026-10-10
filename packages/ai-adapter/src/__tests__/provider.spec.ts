import { describe, expect, it } from 'vitest';
import { AiAdapterError, AiErrorCode } from '../errors';
import { invokeMatchingWithFallback } from '../matching/invoke';
import {
  DEFAULT_AI_MAX_REQUEST_BYTES,
  DEFAULT_AI_MAX_RESPONSE_BYTES,
  MAX_AI_MAX_REQUEST_BYTES,
  MAX_AI_MAX_RESPONSE_BYTES,
  createHttpJsonProvider,
  extractJsonPayload,
  parseJsonText,
} from '../provider/http-json-provider';
import type { AiCompletionRequest } from '../provider/provider-port';
import type { HttpJsonProviderOptions } from '../provider/http-json-provider';
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

/** 构造完全受控的响应（含可观测的 reader.cancel），避免依赖 undici 的头部归一化 */
function fakeStreamingResponse(
  chunks: string[],
  headers: Record<string, string> = {},
): { response: Response; wasCancelled: () => boolean } {
  let cancelled = false;
  let index = 0;
  const encoder = new TextEncoder();
  const response = {
    status: 200,
    ok: true,
    headers: new Headers(headers),
    body: {
      getReader: () => ({
        read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }
          const value = encoder.encode(chunks[index] ?? '');
          index += 1;
          return { done: false, value };
        },
        cancel: async (): Promise<void> => {
          cancelled = true;
        },
      }),
      cancel: async (): Promise<void> => {
        cancelled = true;
      },
    },
  } as unknown as Response;
  return { response, wasCancelled: () => cancelled };
}

describe('HTTP JSON Provider 请求体硬上限', () => {
  it('序列化后超限时在 fetch 之前拒绝，不发送任何请求也不泄露内容', async () => {
    let fetchCalls = 0;
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-sup3rsecret',
      model: 'm',
      maxRequestBytes: 128,
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    const hugePrompt = `内部提示词-${'x'.repeat(4096)}`;
    try {
      await provider.completeJson({ ...request, userPrompt: hugePrompt });
      expect.unreachable('应当抛出 request_oversize 安全错误');
    } catch (error) {
      const adapterError = error as AiAdapterError;
      expect(adapterError.code).toBe(AiErrorCode.ProviderError);
      expect(adapterError.safeDetails?.reason).toBe('request_oversize');
      expect(adapterError.message).not.toContain('内部提示词');
      expect(adapterError.message).not.toContain('sk-sup3rsecret');
      expect(JSON.stringify(adapterError.safeDetails)).not.toContain('sk-sup3rsecret');
    }
    // 关键：超限在出网前拦下，fetch 一次都没被调用
    expect(fetchCalls).toBe(0);
  });

  it('按 UTF-8 字节数而非字符数计算上限', async () => {
    const calls: FetchArgs[] = [];
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      // 400 个 CJK 字符 = 1200 字节，字符数在限内、字节数超限
      maxRequestBytes: 512,
      fetchImpl: fakeFetchRecorder(calls, () => new Response('{}', { status: 200 })),
    });

    await expect(
      provider.completeJson({ ...request, userPrompt: '匹配'.repeat(200) }),
    ).rejects.toMatchObject({ code: AiErrorCode.ProviderError });
    expect(calls).toHaveLength(0);

    const okProvider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      maxRequestBytes: 4096,
      fetchImpl: fakeFetchRecorder(calls, () => new Response('{}', { status: 200 })),
    });
    await expect(
      okProvider.completeJson({ ...request, userPrompt: '匹配'.repeat(200) }),
    ).resolves.toEqual({});
    expect(calls).toHaveLength(1);
  });

  it('上限内的请求体照常发送（序列化结果与旧行为一致）', async () => {
    const calls: FetchArgs[] = [];
    const provider = createHttpJsonProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      fetchImpl: fakeFetchRecorder(calls, () => new Response('{"ok":true}', { status: 200 })),
    });

    await provider.completeJson(request);
    expect(String(calls[0]?.[1]?.body)).toContain('test-model');
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toMatchObject({
      model: 'test-model',
      response_format: { type: 'json_object' },
    });
  });

  it('请求体上限非法或超过绝对最大值时 fail-closed', () => {
    const base = { baseUrl: 'https://api.example.com/v1', model: 'm' };
    expect(() => createHttpJsonProvider({ ...base, maxRequestBytes: 0 })).toThrowError(
      AiAdapterError,
    );
    expect(() =>
      createHttpJsonProvider({ ...base, maxRequestBytes: MAX_AI_MAX_REQUEST_BYTES + 1 }),
    ).toThrowError(AiAdapterError);
    expect(() => createHttpJsonProvider({ ...base, maxRequestBytes: 1.5 })).toThrowError(
      AiAdapterError,
    );
    expect(() => createHttpJsonProvider({ ...base, maxRequestBytes: Number.NaN })).toThrowError(
      AiAdapterError,
    );
    // 默认值落在绝对上限之内
    expect(DEFAULT_AI_MAX_REQUEST_BYTES).toBeLessThanOrEqual(MAX_AI_MAX_REQUEST_BYTES);
  });
});

describe('HTTP JSON Provider 响应体上限配置 fail-closed', () => {
  const base = { baseUrl: 'https://api.example.com/v1', model: 'm' };

  it('超过绝对最大值的 maxResponseBytes 被拒绝', () => {
    let caught: unknown;
    try {
      createHttpJsonProvider({ ...base, maxResponseBytes: MAX_AI_MAX_RESPONSE_BYTES + 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AiAdapterError);
    expect((caught as AiAdapterError).code).toBe(AiErrorCode.ProviderError);
    expect((caught as AiAdapterError).safeDetails?.reason).toBe('invalid_limit');
    expect((caught as AiAdapterError).safeDetails?.option).toBe('maxResponseBytes');
  });

  it('非整数 / NaN / Infinity / 负数一律拒绝', () => {
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      expect(() => createHttpJsonProvider({ ...base, maxResponseBytes: value })).toThrowError(
        AiAdapterError,
      );
    }
  });

  it('恰好等于绝对最大值是合法的', () => {
    expect(() =>
      createHttpJsonProvider({ ...base, maxResponseBytes: MAX_AI_MAX_RESPONSE_BYTES }),
    ).not.toThrow();
  });
});

describe('HTTP JSON Provider Content-Length 校验', () => {
  const base = { baseUrl: 'https://api.example.com/v1', model: 'm', maxResponseBytes: 1024 };

  async function expectRejected(response: Response, reason: string): Promise<AiAdapterError> {
    const provider = createHttpJsonProvider({
      ...base,
      fetchImpl: fakeFetchRecorder([], () => response),
    });
    try {
      await provider.completeJson(request);
      expect.unreachable('应当抛出安全 ProviderError');
    } catch (error) {
      const adapterError = error as AiAdapterError;
      expect(adapterError.code).toBe(AiErrorCode.ProviderError);
      expect(adapterError.safeDetails?.reason).toBe(reason);
      return adapterError;
    }
  }

  it('负数 Content-Length 被 fail-closed 拒绝，不回显取值', async () => {
    const { response } = fakeStreamingResponse(['{}'], { 'content-length': '-5' });
    const error = await expectRejected(response, 'content_length_invalid');
    expect(error.message).not.toContain('-5');
  });

  it('非数字 Content-Length 整体校验（不做 parseInt 截断）', async () => {
    const { response } = fakeStreamingResponse(['{}'], { 'content-length': '12abc' });
    await expectRejected(response, 'content_length_invalid');
    const { response: exponent } = fakeStreamingResponse(['{}'], { 'content-length': '1e3' });
    await expectRejected(exponent, 'content_length_invalid');
  });

  it('声明超过 cap 时拒绝，且不读取响应体', async () => {
    const { response, wasCancelled } = fakeStreamingResponse(['{}'], {
      'content-length': '10485760',
    });
    await expectRejected(response, 'oversize');
    expect(wasCancelled()).toBe(true);
  });

  it('非法 Content-Length 同样不读取响应体（连接被释放）', async () => {
    const { response, wasCancelled } = fakeStreamingResponse(['{}'], { 'content-length': 'abc' });
    await expectRejected(response, 'content_length_invalid');
    expect(wasCancelled()).toBe(true);
  });

  it('合法且不超限的 Content-Length 照常读取', async () => {
    const { response } = fakeStreamingResponse(['{"recommendations":[]}'], {
      'content-length': '22',
    });
    const provider = createHttpJsonProvider({
      ...base,
      fetchImpl: fakeFetchRecorder([], () => response),
    });
    await expect(provider.completeJson(request)).resolves.toEqual({ recommendations: [] });
  });

  it('流式分块累计超过 cap 时取消读取并拒绝', async () => {
    const { response, wasCancelled } = fakeStreamingResponse([
      'x'.repeat(700),
      'sup3rsecret'.repeat(100),
    ]);
    const provider = createHttpJsonProvider({
      ...base,
      fetchImpl: fakeFetchRecorder([], () => response),
    });

    try {
      await provider.completeJson(request);
      expect.unreachable('应当抛出 oversize 安全错误');
    } catch (error) {
      const adapterError = error as AiAdapterError;
      expect(adapterError.safeDetails?.reason).toBe('oversize');
      expect(adapterError.message).not.toContain('sup3rsecret');
    }
    expect(wasCancelled()).toBe(true);
  });
});

describe('HTTP JSON Provider extraHeaders 防护', () => {
  const base = { baseUrl: 'https://api.example.com/v1', model: 'm' };

  function capture(options: Record<string, unknown>): AiAdapterError {
    let caught: unknown;
    try {
      createHttpJsonProvider({ ...base, ...options } as unknown as HttpJsonProviderOptions);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AiAdapterError);
    return caught as AiAdapterError;
  }

  it('禁止覆盖 Authorization：fail-closed 且不泄露任何密钥', () => {
    const error = capture({
      apiKey: 'sk-sup3rsecret',
      extraHeaders: { Authorization: 'Bearer sk-attacker' },
    });
    expect(error.code).toBe(AiErrorCode.ProviderError);
    expect(error.safeDetails?.reason).toBe('reserved_extra_header');
    expect(error.safeDetails?.header).toBe('authorization');
    expect(error.message).not.toContain('sk-attacker');
    expect(error.message).not.toContain('sk-sup3rsecret');
    expect(JSON.stringify(error.safeDetails)).not.toContain('sk-attacker');
  });

  it('即使未配置 apiKey 也不允许注入 Authorization', () => {
    const error = capture({ extraHeaders: { authorization: 'Bearer sk-attacker' } });
    expect(error.safeDetails?.reason).toBe('reserved_extra_header');
  });

  it('禁止覆盖 Content-Type（大小写与空白不敏感）', () => {
    for (const name of ['Content-Type', 'content-type', ' CONTENT-TYPE ']) {
      const error = capture({ extraHeaders: { [name]: 'text/plain' } });
      expect(error.safeDetails?.reason).toBe('reserved_extra_header');
      expect(error.safeDetails?.header).toBe('content-type');
    }
  });

  it('禁止覆盖协议保留头（host / content-length / connection / cookie 等）', () => {
    for (const name of [
      'host',
      'content-length',
      'transfer-encoding',
      'connection',
      'proxy-authorization',
      'cookie',
      'upgrade',
    ]) {
      const error = capture({ extraHeaders: { [name]: 'x' } });
      expect(error.safeDetails?.reason).toBe('reserved_extra_header');
      expect(error.safeDetails?.header).toBe(name);
    }
  });

  it('拒绝 CR/LF 头注入与非法取值', () => {
    const injected = capture({ extraHeaders: { 'x-custom': 'a\r\nx-evil: 1' } });
    expect(injected.safeDetails?.reason).toBe('invalid_extra_header');
    const notString = capture({ extraHeaders: { 'x-custom': 123 } });
    expect(notString.safeDetails?.reason).toBe('invalid_extra_header');
    const badName = capture({ extraHeaders: { 'x bad name': 'v' } });
    expect(badName.safeDetails?.reason).toBe('invalid_extra_header');
  });

  it('允许安全自定义头，且 Authorization 仍是配置的密钥', async () => {
    const calls: FetchArgs[] = [];
    const provider = createHttpJsonProvider({
      ...base,
      apiKey: 'sk-sup3rsecret',
      extraHeaders: { 'X-Trace-Id': 'trace-1' },
      fetchImpl: fakeFetchRecorder(calls, () => new Response('{"ok":true}', { status: 200 })),
    });

    await provider.completeJson(request);
    const headers = calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-sup3rsecret');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-trace-id']).toBe('trace-1');
    // 保留头没有被任何附加头改写
    expect(headers.host).toBeUndefined();
    expect(headers['content-length']).toBeUndefined();
  });
});
