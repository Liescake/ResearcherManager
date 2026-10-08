import { z } from 'zod';
import { REVIEW_DECISION_VALUES, ReviewDecision } from '../enums/decision';
import { trimmedText, uuidSchema } from './fields';

/** 入组申请：备注选填，重复申请由服务端幂等和唯一约束拦截 */
export const joinApplicationInputSchema = z.object({
  groupId: uuidSchema,
  note: trimmedText(0, 1000, '申请备注').optional(),
});

export type JoinApplicationInput = z.infer<typeof joinApplicationInputSchema>;

/** 退组申请：原因与工作交接均为必填（数据字典） */
export const leaveApplicationInputSchema = z.object({
  membershipId: uuidSchema,
  reason: trimmedText(1, 1000, '退组原因'),
  handover: trimmedText(1, 2000, '工作交接'),
});

export type LeaveApplicationInput = z.infer<typeof leaveApplicationInputSchema>;

/** 审核入参：驳回必须填写意见；幂等键由请求头提供（Idempotency-Key） */
export const applicationReviewInputSchema = z
  .object({
    decision: z.enum(REVIEW_DECISION_VALUES),
    comment: trimmedText(0, 500, '审核意见').optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === ReviewDecision.Reject && !value.comment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['comment'],
        message: '驳回申请必须填写审核意见',
      });
    }
  });

export type ApplicationReviewInput = z.infer<typeof applicationReviewInputSchema>;

/** 撤回入参：只需要申请 ID，权限与状态由服务端校验 */
export const withdrawApplicationInputSchema = z.object({
  applicationId: uuidSchema,
});

export type WithdrawApplicationInput = z.infer<typeof withdrawApplicationInputSchema>;
