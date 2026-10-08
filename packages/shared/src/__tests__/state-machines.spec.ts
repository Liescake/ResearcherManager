import { describe, expect, it } from 'vitest';
import {
  ApplicationStatus,
  MATCHING_REQUEST_STATUS_VALUES,
  MatchingRequestStatus,
  MembershipStatus,
} from '../enums/status';
import { StateTransitionError } from '../errors';
import {
  APPLICATION_TERMINAL_STATUSES,
  assertApplicationTransition,
  canTransitionApplication,
  canWithdrawApplication,
  isApplicationReviewable,
  isApplicationTerminal,
} from '../states/application-state-machine';
import {
  MATCHING_REQUEST_ENTRY_STATUS,
  MATCHING_REQUEST_TERMINAL_STATUSES,
  assertMatchingRequestTransition,
  canTransitionMatchingRequest,
  isMatchingRequestProcessable,
  isMatchingRequestTerminal,
  nextMatchingRequestStatuses,
} from '../states/matching-state-machine';
import {
  assertMembershipActiveForLeave,
  canCreateMembership,
  canTransitionMembership,
} from '../states/membership-state-machine';

describe('申请状态机', () => {
  it('只允许白名单内的转移', () => {
    expect(canTransitionApplication(ApplicationStatus.Pending, ApplicationStatus.Approved)).toBe(
      true,
    );
    expect(canTransitionApplication(ApplicationStatus.Pending, ApplicationStatus.Withdrawn)).toBe(
      true,
    );
    // 未审核不能直接跳到已完成
    expect(canTransitionApplication(ApplicationStatus.Pending, ApplicationStatus.Completed)).toBe(
      false,
    );
    // 已驳回/已撤回是终态，不能再次通过
    expect(canTransitionApplication(ApplicationStatus.Rejected, ApplicationStatus.Approved)).toBe(
      false,
    );
    expect(canTransitionApplication(ApplicationStatus.Withdrawn, ApplicationStatus.Approved)).toBe(
      false,
    );
  });

  it('非法转移抛出 STATE_TRANSITION_INVALID', () => {
    expect(() =>
      assertApplicationTransition(ApplicationStatus.Rejected, ApplicationStatus.Completed),
    ).toThrowError(StateTransitionError);
    try {
      assertApplicationTransition(ApplicationStatus.Rejected, ApplicationStatus.Completed);
    } catch (error) {
      expect((error as StateTransitionError).code).toBe('STATE_TRANSITION_INVALID');
    }
  });

  it('只有待审核状态可审核，重复审核必须被拦截', () => {
    expect(isApplicationReviewable(ApplicationStatus.Pending)).toBe(true);
    for (const status of APPLICATION_TERMINAL_STATUSES) {
      expect(isApplicationReviewable(status)).toBe(false);
      expect(isApplicationTerminal(status)).toBe(true);
    }
    expect(isApplicationReviewable(ApplicationStatus.Approved)).toBe(false);
  });

  it('只有本人且待审核的申请可以撤回', () => {
    expect(canWithdrawApplication(ApplicationStatus.Pending, true)).toBe(true);
    expect(canWithdrawApplication(ApplicationStatus.Pending, false)).toBe(false);
    expect(canWithdrawApplication(ApplicationStatus.Approved, true)).toBe(false);
  });
});

describe('成员关系状态机', () => {
  it('active -> ended 是唯一合法转移', () => {
    expect(canTransitionMembership(MembershipStatus.Active, MembershipStatus.Ended)).toBe(true);
    expect(canTransitionMembership(MembershipStatus.Ended, MembershipStatus.Active)).toBe(false);
  });

  it('退组前置条件要求 active 关系', () => {
    expect(() => assertMembershipActiveForLeave(MembershipStatus.Active)).not.toThrow();
    expect(() => assertMembershipActiveForLeave(MembershipStatus.Ended)).toThrowError(
      /不是 active/u,
    );
  });

  it('同一学生-小组不允许重复建立未结束关系', () => {
    expect(canCreateMembership([])).toBe(true);
    expect(canCreateMembership([MembershipStatus.Ended])).toBe(true);
    expect(canCreateMembership([MembershipStatus.Ended, MembershipStatus.Active])).toBe(false);
  });
});

describe('匹配请求状态机', () => {
  it('入口状态是 pending，且只允许推进到三个终态', () => {
    expect(MATCHING_REQUEST_ENTRY_STATUS).toBe(MatchingRequestStatus.Pending);
    expect([...nextMatchingRequestStatuses(MatchingRequestStatus.Pending)].sort()).toEqual(
      [
        MatchingRequestStatus.Completed,
        MatchingRequestStatus.Failed,
        MatchingRequestStatus.NoCandidate,
      ].sort(),
    );
  });

  it('终态不可再转移（结果一旦落库就不再被覆盖）', () => {
    for (const terminal of MATCHING_REQUEST_TERMINAL_STATUSES) {
      expect(isMatchingRequestTerminal(terminal)).toBe(true);
      expect(isMatchingRequestProcessable(terminal)).toBe(false);
      expect(nextMatchingRequestStatuses(terminal)).toEqual([]);
      for (const target of MATCHING_REQUEST_STATUS_VALUES) {
        expect(canTransitionMatchingRequest(terminal, target)).toBe(false);
      }
    }
    // 只有 pending 可处理，也只有它能转入终态
    expect(isMatchingRequestProcessable(MatchingRequestStatus.Pending)).toBe(true);
    expect(
      canTransitionMatchingRequest(MatchingRequestStatus.Pending, MatchingRequestStatus.Pending),
    ).toBe(false);
  });

  it('非法转移抛出 STATE_TRANSITION_INVALID', () => {
    expect(() =>
      assertMatchingRequestTransition(
        MatchingRequestStatus.Completed,
        MatchingRequestStatus.Completed,
      ),
    ).toThrowError(StateTransitionError);
    try {
      assertMatchingRequestTransition(
        MatchingRequestStatus.Completed,
        MatchingRequestStatus.Completed,
      );
    } catch (error) {
      expect((error as StateTransitionError).code).toBe('STATE_TRANSITION_INVALID');
    }
    expect(() =>
      assertMatchingRequestTransition(
        MatchingRequestStatus.Pending,
        MatchingRequestStatus.Completed,
      ),
    ).not.toThrow();
  });

  it('三个终态互不包含：completed / no_candidate / failed 语义不重叠', () => {
    expect(new Set(MATCHING_REQUEST_TERMINAL_STATUSES).size).toBe(3);
    expect(MATCHING_REQUEST_STATUS_VALUES).toHaveLength(4);
  });
});
