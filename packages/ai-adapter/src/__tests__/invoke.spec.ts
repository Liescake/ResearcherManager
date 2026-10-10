import { describe, expect, it, vi } from 'vitest';
import { AiAdapterError, AiErrorCode } from '../errors';
import { invokeMatchingWithFallback } from '../matching/invoke';
import type { MatchFeatureBundle } from '../matching/types';
import { createMockProvider } from '../provider/mock-provider';
import type { AiProvider } from '../provider/provider-port';
import { groundedRecommendation, ML_GROUP_ID, validBundle } from './fixtures';

const CANDIDATE_ID = '22222222-2222-4222-8222-222222222222';

describe('匹配主流程与安全降级', () => {
  it('模型输出合法时返回 ai 结果并记录审计摘要', async () => {
    const provider = createMockProvider({
      result: { recommendations: [groundedRecommendation(ML_GROUP_ID)] },
    });
    const outcome = await invokeMatchingWithFallback({
      provider,
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
    });

    expect(outcome.status).toBe('ai');
    expect(outcome.degraded).toBe(false);
    expect(outcome.result.fallbackUsed).toBe(false);
    expect(outcome.result.recommendations).toHaveLength(1);
    expect(outcome.result.modelVersion).toBe('mock-model-v1');
    expect(outcome.result.promptVersion).toBe('matching-v1');
    // 只保存摘要，不保存原文
    expect(outcome.result.inputSnapshotHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(outcome.attempts).toBe(1);
  });

  it('Provider 报错时降级为规则推荐，并给出错误码', async () => {
    const outcome = await invokeMatchingWithFallback({
      provider: createMockProvider({ failWith: 'error' }),
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
      maxRetries: 0,
    });

    expect(outcome.status).toBe('fallback');
    expect(outcome.degraded).toBe(true);
    expect(outcome.errorCode).toBe(AiErrorCode.ProviderError);
    expect(outcome.result.fallbackUsed).toBe(true);
    expect(outcome.result.recommendations.length).toBeGreaterThan(0);
    expect(outcome.message).toContain('按规则');
  });

  it('按 maxRetries 重试后仍失败才降级', async () => {
    const outcome = await invokeMatchingWithFallback({
      provider: createMockProvider({ failWith: 'error' }),
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
      maxRetries: 2,
      retryBackoffMs: 0,
    });
    expect(outcome.attempts).toBe(3);
    expect(outcome.status).toBe('fallback');
  });

  it('超时降级并保留 AI_TIMEOUT 错误码', async () => {
    const outcome = await invokeMatchingWithFallback({
      provider: createMockProvider({ failWith: 'timeout' }),
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
      timeoutMs: 20,
      maxRetries: 0,
    });
    expect(outcome.errorCode).toBe(AiErrorCode.Timeout);
    expect(outcome.status).toBe('fallback');
  });

  it('输出结构非法时降级，且不重试', async () => {
    const outcome = await invokeMatchingWithFallback({
      provider: createMockProvider({ result: { recommendations: [] } }),
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
      maxRetries: 2,
      retryBackoffMs: 0,
    });
    expect(outcome.errorCode).toBe(AiErrorCode.OutputInvalid);
    expect(outcome.attempts).toBe(1);
  });

  it('非法小组 ID 触发 AI_ILLEGAL_GROUP_ID 并记录安全细节', async () => {
    const onDegrade = vi.fn();
    const outcome = await invokeMatchingWithFallback({
      provider: createMockProvider({
        result: {
          recommendations: [
            groundedRecommendation('unknown-group-id', '你的机器学习兴趣与方向一致'),
          ],
        },
      }),
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
      onDegrade,
    });

    expect(outcome.errorCode).toBe(AiErrorCode.IllegalGroupId);
    expect(onDegrade).toHaveBeenCalledWith(
      expect.objectContaining({
        code: AiErrorCode.IllegalGroupId,
        safeDetails: expect.objectContaining({ hasIllegalGroupId: true }),
      }),
    );
  });

  it('可解释性不达标时降级为规则推荐', async () => {
    const outcome = await invokeMatchingWithFallback({
      provider: createMockProvider({
        result: {
          recommendations: [groundedRecommendation(CANDIDATE_ID, '这段文字没有任何可对应内容')],
        },
      }),
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
    });
    expect(outcome.errorCode).toBe(AiErrorCode.UngroundedReason);
    expect(outcome.status).toBe('fallback');
  });

  it('功能开关关闭时不调用模型，直接返回规则结果', async () => {
    const completeJson = vi.fn(async () => {
      throw new Error('不应该被调用');
    });
    const outcome = await invokeMatchingWithFallback({
      provider: { id: 'spy', completeJson },
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
      matchingEnabled: false,
    });

    expect(completeJson).not.toHaveBeenCalled();
    expect(outcome.status).toBe('disabled');
    expect(outcome.errorCode).toBe(AiErrorCode.Disabled);
    expect(outcome.attempts).toBe(0);
  });

  it('输入含未脱敏字段时阻断模型调用并降级', async () => {
    const completeJson = vi.fn(async () => ({ recommendations: [] }));
    const dirtyBundle = {
      ...validBundle(),
      student: { ...validBundle().student, name: '张三', phone: '13800138000' },
    } as unknown as MatchFeatureBundle;

    const outcome = await invokeMatchingWithFallback({
      provider: { id: 'spy', completeJson },
      bundle: dirtyBundle,
      modelVersion: 'mock-model-v1',
    });

    expect(completeJson).not.toHaveBeenCalled();
    expect(outcome.errorCode).toBe(AiErrorCode.InputPiiDetected);
    expect(outcome.result.fallbackUsed).toBe(true);
  });

  it('无候选小组时返回 no_candidate 而不是空成功', async () => {
    const outcome = await invokeMatchingWithFallback({
      provider: createMockProvider({ failWith: 'error' }),
      bundle: { student: validBundle().student, candidates: [] },
      modelVersion: 'mock-model-v1',
      maxRetries: 0,
    });
    expect(outcome.status).toBe('no_candidate');
    expect(outcome.errorCode).toBe(AiErrorCode.NoCandidate);
    expect(outcome.result.recommendations).toEqual([]);
  });

  it('耗时按注入时钟计算，便于监控', async () => {
    let clock = 1000;
    const outcome = await invokeMatchingWithFallback({
      provider: createMockProvider({
        result: { recommendations: [groundedRecommendation(ML_GROUP_ID)] },
      }),
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
      now: () => {
        clock += 25;
        return clock;
      },
    });
    expect(outcome.durationMs).toBeGreaterThan(0);
  });
});

/** 永不返回、但遵守取消信号的 provider（模拟挂起的上游连接） */
function hangingProvider(): { provider: AiProvider; calls: () => number } {
  let calls = 0;
  const provider: AiProvider = {
    id: 'hanging',
    completeJson: (request) => {
      calls += 1;
      return new Promise<never>((_resolve, reject) => {
        const abort = (): void => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (request.signal?.aborted) {
          abort();
          return;
        }
        request.signal?.addEventListener('abort', abort, { once: true });
      });
    },
  };
  return { provider, calls: () => calls };
}

describe('匹配重试与退避的总预算（共享 deadline）', () => {
  it('重试不会成倍放大总耗时：多次尝试共享同一份业务 timeout', async () => {
    const { provider, calls } = hangingProvider();
    const startedAt = Date.now();

    const outcome = await invokeMatchingWithFallback({
      provider,
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
      timeoutMs: 200,
      maxRetries: 5,
      retryBackoffMs: 0,
    });

    const elapsed = Date.now() - startedAt;
    expect(outcome.status).toBe('fallback');
    expect(outcome.errorCode).toBe(AiErrorCode.Timeout);
    // 旧行为：每次尝试各给 200ms → 总耗时 6×200ms；现在只允许一次
    expect(calls()).toBe(1);
    expect(elapsed).toBeLessThan(1000);
    expect(outcome.durationMs).toBeLessThan(1000);
  });

  it('退避等待被总预算截断，不会把总耗时推过 timeoutMs', async () => {
    let calls = 0;
    const provider: AiProvider = {
      id: 'failing',
      completeJson: async () => {
        calls += 1;
        throw new AiAdapterError(AiErrorCode.ProviderError, 'boom');
      },
    };
    const startedAt = Date.now();

    const outcome = await invokeMatchingWithFallback({
      provider,
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
      timeoutMs: 120,
      maxRetries: 10,
      // 远超预算的退避：必须被截断到剩余预算
      retryBackoffMs: 5000,
    });

    const elapsed = Date.now() - startedAt;
    expect(outcome.errorCode).toBe(AiErrorCode.Timeout);
    expect(calls).toBe(1);
    expect(elapsed).toBeLessThan(1000);
    expect(outcome.durationMs).toBeLessThan(1000);
  });

  it('预算耗尽后不再发起新尝试（attempts 与实际调用次数一致）', async () => {
    const { provider, calls } = hangingProvider();
    const outcome = await invokeMatchingWithFallback({
      provider,
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
      timeoutMs: 150,
      maxRetries: 3,
      retryBackoffMs: 1000,
    });
    expect(calls()).toBe(1);
    expect(outcome.attempts).toBe(1);
    expect(outcome.errorCode).toBe(AiErrorCode.Timeout);
  });

  it('外部 signal 取消退避等待，不再重试', async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider: AiProvider = {
      id: 'failing',
      completeJson: async () => {
        calls += 1;
        throw new AiAdapterError(AiErrorCode.ProviderError, 'boom');
      },
    };
    setTimeout(() => controller.abort(), 30);
    const startedAt = Date.now();

    const outcome = await invokeMatchingWithFallback({
      provider,
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
      timeoutMs: 5000,
      maxRetries: 5,
      retryBackoffMs: 2000,
      signal: controller.signal,
    });

    const elapsed = Date.now() - startedAt;
    expect(calls).toBe(1);
    expect(outcome.errorCode).toBe(AiErrorCode.Timeout);
    // 若退避不可取消，这里至少会等满 2000ms
    expect(elapsed).toBeLessThan(1500);
  });

  it('外部 signal 中止进行中的尝试，并保留降级语义', async () => {
    const controller = new AbortController();
    const { provider, calls } = hangingProvider();
    setTimeout(() => controller.abort(), 30);
    const startedAt = Date.now();

    const outcome = await invokeMatchingWithFallback({
      provider,
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
      timeoutMs: 5000,
      maxRetries: 2,
      retryBackoffMs: 0,
      signal: controller.signal,
    });

    expect(calls()).toBe(1);
    expect(outcome.status).toBe('fallback');
    expect(outcome.degraded).toBe(true);
    expect(outcome.errorCode).toBe(AiErrorCode.Timeout);
    expect(outcome.result.fallbackUsed).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('已中止的 signal 立即失败，不调用模型', async () => {
    const controller = new AbortController();
    controller.abort();
    const completeJson = vi.fn(async () => ({ recommendations: [] }));

    const outcome = await invokeMatchingWithFallback({
      provider: { id: 'spy', completeJson },
      bundle: validBundle(),
      modelVersion: 'mock-model-v1',
      timeoutMs: 5000,
      signal: controller.signal,
    });

    expect(completeJson).not.toHaveBeenCalled();
    expect(outcome.errorCode).toBe(AiErrorCode.Timeout);
  });
});
