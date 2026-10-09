import {
  MATCHING_MAX_RECOMMENDATIONS,
  MATCHING_MIN_RECOMMENDATIONS,
  MATCHING_REASON_MAX_LENGTH,
  MATCHING_SCORE_MAX,
  MATCHING_SCORE_MIN,
  MATCHING_SUGGESTION_MAX_LENGTH,
} from '@rm/shared';
import { z } from 'zod';
import type { MatchingModelOutput } from './types';

/**
 * 结构化匹配结果 schema（模型输出契约）。
 * 服务端必须先通过本 schema，再做候选白名单与理由可解释性校验。
 */

export const matchingRecommendationSchema = z.object({
  groupId: z.string().trim().min(1, 'groupId 不能为空').max(64, 'groupId 过长'),
  score: z
    .number()
    .min(MATCHING_SCORE_MIN, `匹配分必须在 ${MATCHING_SCORE_MIN}-${MATCHING_SCORE_MAX} 之间`)
    .max(MATCHING_SCORE_MAX, `匹配分必须在 ${MATCHING_SCORE_MIN}-${MATCHING_SCORE_MAX} 之间`),
  reason: z
    .string()
    .trim()
    .min(1, '推荐理由不能为空')
    .max(MATCHING_REASON_MAX_LENGTH, `推荐理由不能超过 ${MATCHING_REASON_MAX_LENGTH} 字`),
  advice: z
    .string()
    .trim()
    .min(1, '发展建议不能为空')
    .max(MATCHING_SUGGESTION_MAX_LENGTH, `发展建议不能超过 ${MATCHING_SUGGESTION_MAX_LENGTH} 字`),
});

export const matchingModelOutputSchema = z.object({
  recommendations: z
    .array(matchingRecommendationSchema)
    .min(MATCHING_MIN_RECOMMENDATIONS, '至少返回 1 个推荐小组')
    .max(MATCHING_MAX_RECOMMENDATIONS, `最多返回 ${MATCHING_MAX_RECOMMENDATIONS} 个推荐小组`),
});

export type MatchingModelOutputParsed = z.infer<typeof matchingModelOutputSchema>;

/**
 * 提供给模型的 JSON Schema 提示（仅结构约束，不含任何用户数据）。
 * 手写而非从 zod 自动生成，避免为骨架引入额外依赖。
 */
export const MATCHING_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['recommendations'],
  properties: {
    recommendations: {
      type: 'array',
      minItems: MATCHING_MIN_RECOMMENDATIONS,
      maxItems: MATCHING_MAX_RECOMMENDATIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['groupId', 'score', 'reason', 'advice'],
        properties: {
          groupId: { type: 'string', description: '必须来自候选列表中的 groupId' },
          score: {
            type: 'number',
            minimum: MATCHING_SCORE_MIN,
            maximum: MATCHING_SCORE_MAX,
            description: '匹配分，0—100',
          },
          reason: {
            type: 'string',
            maxLength: MATCHING_REASON_MAX_LENGTH,
            description: '必须引用学生与小组的真实字段',
          },
          advice: {
            type: 'string',
            maxLength: MATCHING_SUGGESTION_MAX_LENGTH,
          },
        },
      },
    },
  },
} as const;

export const MATCHING_OUTPUT_SCHEMA_HINT = JSON.stringify(MATCHING_OUTPUT_JSON_SCHEMA);

/** 编译期断言：schema 输出必须与领域类型保持兼容，schema 漂移会导致类型报错 */
type AssertAssignable<_From, To> = _From extends To ? true : never;
export type ModelOutputSchemaMatchesDomain = AssertAssignable<
  MatchingModelOutputParsed,
  MatchingModelOutput
>;
