import { z } from 'zod';
import {
  MATCHING_MAX_RECOMMENDATIONS,
  MATCHING_REASON_MAX_LENGTH,
  MATCHING_SCORE_MAX,
  MATCHING_SCORE_MIN,
  MATCHING_SUGGESTION_MAX_LENGTH,
} from '../constants';
import { riskFreeText, uuidSchema } from './fields';

/**
 * AI 匹配（`/me/matching-requests`）的共享契约：**输入 schema** 与 **推荐条目契约**。
 *
 * 这里只回答两个问题，且两个问题都不涉及「谁可以做」：
 * 1. 客户端到底被允许提交哪些字段（`matchingRequestInputSchema`）：只有可选的画像版本，
 *    **没有** `userId` / `roles` / `scope` / `groupId` 之类可以被用来伪造主体、权限或范围的字段；
 *    zod `object` 默认静默剥离未知键，因此「请求体不得携带未声明字段」必须由 API 层闭集门禁
 *    fail-closed 拒绝（`services/api/src/modules/matching/matching.contract.ts`），而不是依赖本 schema。
 * 2. 一条推荐结果长什么样（`matchingRecommendationItemSchema`）：小组标识、0—100 整数分、
 *    非空且限长的理由与建议，且理由/建议走 `riskFreeText`（身份证号、长数字标识、密钥一律拒绝），
 *    因此模型或规则产出的文本不可能把这类敏感内容带进响应。
 *
 * 授权与数据范围完全由 `AuthorizationGuard`（权限点 + 服务端解析范围）决定，
 * 与本文档中的任何字段无关。
 */

/**
 * 匹配请求输入：只接收「客户端当前持有的画像版本」这一条可选的追溯信息
 * （docs/P2-API契约基线.md「POST /matching/recommendations：请求只接收当前用户画像版本
 * 或明确的最小特征」）。
 *
 * 特征最小化与召回在服务端完成：学生画像与候选小组都不由请求体提供。
 */
export const matchingRequestInputSchema = z.object({
  profileVersion: z
    .number()
    .int('画像版本必须是整数')
    .min(1, '画像版本必须为正整数')
    .max(1_000_000, '画像版本超出范围')
    .optional(),
});

export type MatchingRequestInput = z.infer<typeof matchingRequestInputSchema>;

/**
 * 单条推荐结果契约（模型输出、规则降级输出与存储记录共用同一形状）。
 * `groupId` 是项目内资源主键，因此必须是 UUID：非 UUID 视为非法输出而不是「宽松接受」。
 */
export const matchingRecommendationItemSchema = z.object({
  groupId: uuidSchema,
  score: z
    .number()
    .int('匹配分必须是整数')
    .min(MATCHING_SCORE_MIN, `匹配分必须在 ${MATCHING_SCORE_MIN}-${MATCHING_SCORE_MAX} 之间`)
    .max(MATCHING_SCORE_MAX, `匹配分必须在 ${MATCHING_SCORE_MIN}-${MATCHING_SCORE_MAX} 之间`),
  reason: riskFreeText(1, MATCHING_REASON_MAX_LENGTH, '推荐理由'),
  advice: riskFreeText(1, MATCHING_SUGGESTION_MAX_LENGTH, '发展建议'),
});

export type MatchingRecommendationItem = z.infer<typeof matchingRecommendationItemSchema>;

/**
 * 推荐列表：上限固定为 `MATCHING_MAX_RECOMMENDATIONS`（3）。
 *
 * 这里刻意**不**设置下限：`no_candidate`（没有可推荐的小组）与 `failed`（处理失败）
 * 都是合法的空列表终态，只有 `completed` 才必须携带 `MATCHING_MIN_RECOMMENDATIONS`（1）以上。
 * 「状态与条数是否自洽」属于读取契约的一部分，由 API 层读取契约一次性校验。
 */
export const matchingRecommendationListSchema = z
  .array(matchingRecommendationItemSchema)
  .max(MATCHING_MAX_RECOMMENDATIONS, `最多返回 ${MATCHING_MAX_RECOMMENDATIONS} 条推荐`);

export type MatchingRecommendationList = z.infer<typeof matchingRecommendationListSchema>;
