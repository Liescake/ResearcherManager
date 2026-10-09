import { createValueGuard } from '@rm/shared';

/** AI 适配层错误码：与 docs/P2-API契约基线.md「AI 输出 JSON schema、降级错误码」对应 */
export const AiErrorCode = {
  Disabled: 'AI_DISABLED',
  Timeout: 'AI_TIMEOUT',
  ProviderError: 'AI_PROVIDER_ERROR',
  OutputInvalid: 'AI_OUTPUT_INVALID',
  IllegalGroupId: 'AI_ILLEGAL_GROUP_ID',
  UngroundedReason: 'AI_UNGROUNDED_REASON',
  InputPiiDetected: 'AI_INPUT_PII_DETECTED',
  NoCandidate: 'AI_NO_CANDIDATE',
} as const;
export type AiErrorCode = (typeof AiErrorCode)[keyof typeof AiErrorCode];
export const AI_ERROR_CODE_VALUES = [
  AiErrorCode.Disabled,
  AiErrorCode.Timeout,
  AiErrorCode.ProviderError,
  AiErrorCode.OutputInvalid,
  AiErrorCode.IllegalGroupId,
  AiErrorCode.UngroundedReason,
  AiErrorCode.InputPiiDetected,
  AiErrorCode.NoCandidate,
] as const;
export const isAiErrorCode = createValueGuard(AI_ERROR_CODE_VALUES);

/** 面向用户的安全提示，不含原始模型输出与敏感字段 */
export const AI_ERROR_MESSAGES: Record<AiErrorCode, string> = {
  [AiErrorCode.Disabled]: '智能匹配已关闭，已按规则为你推荐',
  [AiErrorCode.Timeout]: '智能匹配超时，已按规则为你推荐',
  [AiErrorCode.ProviderError]: '智能匹配服务暂时不可用，已按规则为你推荐',
  [AiErrorCode.OutputInvalid]: '智能匹配结果格式异常，已按规则为你推荐',
  [AiErrorCode.IllegalGroupId]: '智能匹配结果包含未召回的小组，已按规则为你推荐',
  [AiErrorCode.UngroundedReason]: '智能匹配理由无法对应真实字段，已按规则为你推荐',
  [AiErrorCode.InputPiiDetected]: '检测到未脱敏字段，已阻断模型调用并按规则推荐',
  [AiErrorCode.NoCandidate]: '当前没有符合条件的小组，可调整期望方向后再次查看',
};

export class AiAdapterError extends Error {
  public readonly code: AiErrorCode;
  /** 仅用于内部排查的安全细节，禁止写入原始提示词或敏感字段 */
  public readonly safeDetails?: Record<string, unknown>;

  constructor(code: AiErrorCode, message?: string, safeDetails?: Record<string, unknown>) {
    super(message ?? AI_ERROR_MESSAGES[code]);
    this.name = 'AiAdapterError';
    this.code = code;
    this.safeDetails = safeDetails;
  }
}

export function isAiAdapterError(error: unknown): error is AiAdapterError {
  return error instanceof AiAdapterError;
}
