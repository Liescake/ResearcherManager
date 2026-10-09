import { describe, expect, it } from 'vitest';
import { AiAdapterError, AiErrorCode } from '../errors';
import {
  createHttpJsonProvider,
  extractJsonPayload,
  parseJsonText,
} from '../provider/http-json-provider';
import type { AiCompletionRequest } from '../provider/provider-port';

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
