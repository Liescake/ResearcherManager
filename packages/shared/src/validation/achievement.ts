import { z } from 'zod';
import { REVIEW_DECISION_VALUES, ReviewDecision } from '../enums/decision';
import { ReviewStatus } from '../enums/status';
import { ACHIEVEMENT_TYPE_VALUES } from '../enums/taxonomy';
import { riskFreeText, trimmedText, uuidSchema } from './fields';

export const achievementInputSchema = z.object({
  type: z.enum(ACHIEVEMENT_TYPE_VALUES),
  title: trimmedText(1, 300, '成果标题'),
  awardLevel: trimmedText(0, 100, '获奖级别').optional(),
  description: riskFreeText(0, 2000, '成果说明').optional(),
  achievedAt: z.coerce.date().optional(),
  evidenceFileId: uuidSchema.optional(),
});

export type AchievementInput = z.infer<typeof achievementInputSchema>;

export const achievementUpdateSchema = achievementInputSchema
  .partial()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少需要提交一个变更字段' });
    }
  });

export type AchievementUpdateInput = z.infer<typeof achievementUpdateSchema>;

export const achievementReviewInputSchema = z
  .object({
    decision: z.enum(REVIEW_DECISION_VALUES),
    comment: trimmedText(0, 500, '审核意见').optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === ReviewDecision.Reject && !value.comment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['comment'],
        message: '驳回成果必须填写审核意见',
      });
    }
  });

export type AchievementReviewInput = z.infer<typeof achievementReviewInputSchema>;

/** 学生本人仍可编辑的成果状态：仅待审核或已驳回（驳回后可修改重提） */
export function canStudentEditAchievement(status: ReviewStatus): boolean {
  return status === ReviewStatus.Pending || status === ReviewStatus.Rejected;
}
