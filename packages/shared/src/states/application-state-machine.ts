import { ApplicationStatus } from '../enums/status';
import { StateTransitionError } from '../errors';

/**
 * 申请状态机（入组/退组共用）。
 * 后端白名单校验，前端按钮状态不构成控制。
 */
export const APPLICATION_STATUS_TRANSITIONS: Record<
  ApplicationStatus,
  readonly ApplicationStatus[]
> = {
  [ApplicationStatus.Pending]: [
    ApplicationStatus.Approved,
    ApplicationStatus.Rejected,
    ApplicationStatus.Withdrawn,
  ],
  // 审核通过后由事务写入成员关系，成功落库才推进到「已完成」
  [ApplicationStatus.Approved]: [ApplicationStatus.Completed],
  [ApplicationStatus.Rejected]: [],
  [ApplicationStatus.Withdrawn]: [],
  [ApplicationStatus.Completed]: [],
};

/** 终态集合：到达后不允许再变化 */
export const APPLICATION_TERMINAL_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.Rejected,
  ApplicationStatus.Withdrawn,
  ApplicationStatus.Completed,
];

export function canTransitionApplication(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return APPLICATION_STATUS_TRANSITIONS[from].includes(to);
}

export function nextApplicationStatuses(from: ApplicationStatus): readonly ApplicationStatus[] {
  return APPLICATION_STATUS_TRANSITIONS[from];
}

/** 非法转移抛出业务错误，由 API 层映射为 STATE_TRANSITION_INVALID */
export function assertApplicationTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!canTransitionApplication(from, to)) {
    throw new StateTransitionError('application', from, to);
  }
}

export function isApplicationTerminal(status: ApplicationStatus): boolean {
  return APPLICATION_TERMINAL_STATUSES.includes(status);
}

/** 只有待审核状态可以进入审核事务，重复审核必须被幂等键和状态双重拦截 */
export function isApplicationReviewable(status: ApplicationStatus): boolean {
  return status === ApplicationStatus.Pending;
}

/** 学生仅可撤回自己处于待审核的申请 */
export function canWithdrawApplication(status: ApplicationStatus, isOwner: boolean): boolean {
  return isOwner && status === ApplicationStatus.Pending;
}
