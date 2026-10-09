import { describe, expect, it, vi } from 'vitest';
import { AiErrorCode } from '../errors';
import { invokeMatchingWithFallback } from '../matching/invoke';
import type { MatchFeatureBundle } from '../matching/types';
import { createMockProvider } from '../provider/mock-provider';
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
