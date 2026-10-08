import { createValueGuard } from './guard';

/** 账号状态（users.account_status） */
export const AccountStatus = {
  Active: 'active',
  Locked: 'locked',
  Deleted: 'deleted',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];
export const ACCOUNT_STATUS_VALUES = [
  AccountStatus.Active,
  AccountStatus.Locked,
  AccountStatus.Deleted,
] as const;
export const isAccountStatus = createValueGuard(ACCOUNT_STATUS_VALUES);

/** 入组/退组申请状态（join_applications.status / leave_applications.status） */
export const ApplicationStatus = {
  Pending: 'pending',
  Approved: 'approved',
  Rejected: 'rejected',
  Withdrawn: 'withdrawn',
  Completed: 'completed',
} as const;
export type ApplicationStatus = (typeof ApplicationStatus)[keyof typeof ApplicationStatus];
export const APPLICATION_STATUS_VALUES = [
  ApplicationStatus.Pending,
  ApplicationStatus.Approved,
  ApplicationStatus.Rejected,
  ApplicationStatus.Withdrawn,
  ApplicationStatus.Completed,
] as const;
export const isApplicationStatus = createValueGuard(APPLICATION_STATUS_VALUES);

/** 成员关系状态（group_memberships.status） */
export const MembershipStatus = {
  Active: 'active',
  Ended: 'ended',
} as const;
export type MembershipStatus = (typeof MembershipStatus)[keyof typeof MembershipStatus];
export const MEMBERSHIP_STATUS_VALUES = [MembershipStatus.Active, MembershipStatus.Ended] as const;
export const isMembershipStatus = createValueGuard(MEMBERSHIP_STATUS_VALUES);

/** 审核状态（成果、升学记录等） */
export const ReviewStatus = {
  Pending: 'pending',
  Approved: 'approved',
  Rejected: 'rejected',
} as const;
export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];
export const REVIEW_STATUS_VALUES = [
  ReviewStatus.Pending,
  ReviewStatus.Approved,
  ReviewStatus.Rejected,
] as const;
export const isReviewStatus = createValueGuard(REVIEW_STATUS_VALUES);

/** 小组状态（research_groups.status） */
export const GroupStatus = {
  Open: 'open',
  Paused: 'paused',
  Closed: 'closed',
} as const;
export type GroupStatus = (typeof GroupStatus)[keyof typeof GroupStatus];
export const GROUP_STATUS_VALUES = [
  GroupStatus.Open,
  GroupStatus.Paused,
  GroupStatus.Closed,
] as const;
export const isGroupStatus = createValueGuard(GROUP_STATUS_VALUES);
