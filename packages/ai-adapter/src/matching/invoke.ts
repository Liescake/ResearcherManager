import { computeInputSnapshotHash } from '../audit/snapshot';
import { AI_ERROR_MESSAGES, AiAdapterError, AiErrorCode, isAiAdapterError } from '../errors';
import type { AiProvider } from '../provider/provider-port';
import { sleep, withTimeout } from '../provider/timeout';
import { findPiiKeys } from './deidentify';
import { buildFallbackRecommendations } from './fallback';
import type { FallbackOptions } from './fallback';
import { MATCHING_PROMPT_VERSION, buildMatchingPrompt } from './prompt';
import type {
  MatchFeatureBundle,
  MatchOutcome,
  MatchingRecommendation,
  MatchingResult,
} from './types';
import { validateMatchingOutput } from './validate';
import type { GroundingMode, MatchValidationCode } from './validate';

export const DEFAULT_MATCHING_TIMEOUT_MS = 8000;
export const DEFAULT_MATCHING_MAX_RETRIES = 1;
const DEFAULT_RETRY_BACKOFF_MS = 200;

export interface MatchingDegradeInfo {
  code: AiErrorCode;
  /** 只允许安全细节：错误码、字段路径、状态码；禁止原始输出与敏感字段 */
  safeDetails?: Record<string, unknown>;
}

export interface InvokeMatchingOptions {
  provider: AiProvider;
  bundle: MatchFeatureBundle;
  modelVersion: string;
  promptVersion?: string;
  /** 功能开关：关闭时直接走规则降级，不调用模型 */
  matchingEnabled?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  requireGroundedReasons?: boolean;
  groundingMode?: GroundingMode;
  fallback?: FallbackOptions;
  retryBackoffMs?: number;
  now?: () => number;
  onDegrade?: (info: MatchingDegradeInfo) => void;
}

function mapValidationCode(code: MatchValidationCode): AiErrorCode {
  switch (code) {
    case 'GROUP_ID_NOT_IN_CANDIDATES':
      return AiErrorCode.IllegalGroupId;
    case 'REASON_NOT_GROUNDED':
      return AiErrorCode.UngroundedReason;
    case 'SCHEMA_INVALID':
    case 'DUPLICATE_GROUP_ID':
      return AiErrorCode.OutputInvalid;
    default:
      return AiErrorCode.OutputInvalid;
  }
}

/** 只保留错误名与状态码，绝不透传可能含敏感内容的错误消息 */
function toAiAdapterError(error: unknown): AiAdapterError {
  if (isAiAdapterError(error)) {
    return error;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new AiAdapterError(AiErrorCode.Timeout, undefined, { errorName: 'AbortError' });
  }
  const errorName = error instanceof Error ? error.name : typeof error;
  return new AiAdapterError(AiErrorCode.ProviderError, undefined, { errorName });
}

/**
 * 匹配主流程：脱敏检查 → 模型调用（超时 + 有限重试）→ schema/白名单/可解释性校验
 * → 任何失败都降级为规则推荐，业务永远拿到可展示结果而不是异常。
 */
export async function invokeMatchingWithFallback(
  options: InvokeMatchingOptions,
): Promise<MatchOutcome> {
  const now = options.now ?? ((): number => Date.now());
  const startedAt = now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_MATCHING_TIMEOUT_MS;
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MATCHING_MAX_RETRIES);
  const promptVersion = options.promptVersion ?? MATCHING_PROMPT_VERSION;
  const matchingEnabled = options.matchingEnabled ?? true;
  const inputSnapshotHash = computeInputSnapshotHash(options.bundle);

  let attempts = 0;

  const buildResult = (
    recommendations: MatchingRecommendation[],
    fallbackUsed: boolean,
  ): MatchingResult => ({
    recommendations,
    modelVersion: options.modelVersion,
    promptVersion,
    fallbackUsed,
    inputSnapshotHash,
  });

  const buildDegradedOutcome = (
    code: AiErrorCode,
    requestedStatus: 'fallback' | 'disabled',
  ): MatchOutcome => {
    const recommendations = buildFallbackRecommendations(options.bundle, options.fallback);
    const status: MatchOutcome['status'] =
      requestedStatus === 'disabled'
        ? 'disabled'
        : recommendations.length === 0
          ? 'no_candidate'
          : 'fallback';
    const effectiveCode = status === 'no_candidate' ? AiErrorCode.NoCandidate : code;
    return {
      status,
      result: buildResult(recommendations, true),
      degraded: true,
      errorCode: effectiveCode,
      message: AI_ERROR_MESSAGES[effectiveCode],
      attempts,
      durationMs: now() - startedAt,
    };
  };

  if (!matchingEnabled) {
    options.onDegrade?.({ code: AiErrorCode.Disabled });
    return buildDegradedOutcome(AiErrorCode.Disabled, 'disabled');
  }

  const piiFindings = findPiiKeys(options.bundle);
  if (piiFindings.length > 0) {
    // 未脱敏输入是安全事件：阻断模型调用，但仍给用户可用的规则结果
    options.onDegrade?.({
      code: AiErrorCode.InputPiiDetected,
      safeDetails: { findings: piiFindings.map((finding) => `${finding.path}:${finding.reason}`) },
    });
    return buildDegradedOutcome(AiErrorCode.InputPiiDetected, 'fallback');
  }

  const prompt = buildMatchingPrompt(options.bundle);
  const maxAttempts = 1 + maxRetries;
  let lastError: AiAdapterError | undefined;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const raw = await withTimeout(
        (signal) =>
          options.provider.completeJson({
            modelVersion: options.modelVersion,
            promptVersion: prompt.promptVersion,
            systemPrompt: prompt.systemPrompt,
            userPrompt: prompt.userPrompt,
            schemaHint: prompt.schemaHint,
            signal,
          }),
        timeoutMs,
      );

      const validation = validateMatchingOutput(raw, options.bundle, {
        requireGroundedReasons: options.requireGroundedReasons,
        groundingMode: options.groundingMode,
      });

      if (validation.ok) {
        return {
          status: 'ai',
          result: buildResult(validation.recommendations, false),
          degraded: false,
          attempts,
          durationMs: now() - startedAt,
        };
      }

      lastError = new AiAdapterError(mapValidationCode(validation.primaryCode), undefined, {
        issues: validation.issues.slice(0, 5).map((issue) => `${issue.code}@${issue.path ?? ''}`),
        hasIllegalGroupId: validation.hasIllegalGroupId,
      });
      options.onDegrade?.({ code: lastError.code, safeDetails: lastError.safeDetails });
      // 输出格式问题重试成本高且收益低，直接降级（提示词/模型版本问题应通过评测修复）
      break;
    } catch (error) {
      lastError = toAiAdapterError(error);
      options.onDegrade?.({ code: lastError.code, safeDetails: lastError.safeDetails });
      if (attempts >= maxAttempts) {
        break;
      }
      const backoff = (options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS) * attempts;
      if (backoff > 0) {
        await sleep(backoff);
      }
    }
  }

  return buildDegradedOutcome(lastError?.code ?? AiErrorCode.ProviderError, 'fallback');
}
