import { createValueGuard } from './guard';

/** 审核决定（入退组、成果、升学共用） */
export const ReviewDecision = {
  Approve: 'approve',
  Reject: 'reject',
} as const;
export type ReviewDecision = (typeof ReviewDecision)[keyof typeof ReviewDecision];
export const REVIEW_DECISION_VALUES = [ReviewDecision.Approve, ReviewDecision.Reject] as const;
export const isReviewDecision = createValueGuard(REVIEW_DECISION_VALUES);

export const REVIEW_DECISION_LABELS: Record<ReviewDecision, string> = {
  [ReviewDecision.Approve]: '通过',
  [ReviewDecision.Reject]: '驳回',
};

/** 申请类型，用于统一审核入口区分入组/退组 */
export const ApplicationKind = {
  Join: 'join',
  Leave: 'leave',
} as const;
export type ApplicationKind = (typeof ApplicationKind)[keyof typeof ApplicationKind];
export const APPLICATION_KIND_VALUES = [ApplicationKind.Join, ApplicationKind.Leave] as const;
export const isApplicationKind = createValueGuard(APPLICATION_KIND_VALUES);
