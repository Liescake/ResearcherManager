import { MembershipStatus } from '../enums/status';
import { BusinessRuleError, StateTransitionError } from '../errors';

/** 成员关系状态机：active -> ended 为唯一合法转移，ended 为终态 */
export const MEMBERSHIP_STATUS_TRANSITIONS: Record<MembershipStatus, readonly MembershipStatus[]> =
  {
    [MembershipStatus.Active]: [MembershipStatus.Ended],
    [MembershipStatus.Ended]: [],
  };

export function canTransitionMembership(from: MembershipStatus, to: MembershipStatus): boolean {
  return MEMBERSHIP_STATUS_TRANSITIONS[from].includes(to);
}

export function assertMembershipTransition(from: MembershipStatus, to: MembershipStatus): void {
  if (!canTransitionMembership(from, to)) {
    throw new StateTransitionError('membership', from, to);
  }
}

/** 退组审核前置条件：必须存在 active 成员关系，否则拒绝而不是产生悬挂记录 */
export function assertMembershipActiveForLeave(status: MembershipStatus): void {
  if (status !== MembershipStatus.Active) {
    throw new BusinessRuleError('MEMBERSHIP_NOT_ACTIVE', '当前成员关系不是 active，无法提交退组', {
      status,
    });
  }
}

/** 同一学生-小组不允许存在多条未结束成员关系 */
export function canCreateMembership(existingStatuses: readonly MembershipStatus[]): boolean {
  return !existingStatuses.includes(MembershipStatus.Active);
}
