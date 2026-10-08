import { describe, expect, it } from 'vitest';
import { DataScope, PermissionPoint, Role } from '@rm/shared';
import { AuthorizationPolicy } from './authorization-policy';

describe('AuthorizationPolicy', () => {
  const policy = new AuthorizationPolicy();

  it('delegates authorization to the default-deny shared predicate', () => {
    const subject = { userId: 'leader', roles: [Role.GroupLeader] as const, groupIds: ['g1'] };
    expect(
      policy.authorize(subject, {
        permission: PermissionPoint.MembershipReviewGroup,
        scope: DataScope.Group,
        groupId: 'g1',
      }),
    ).toBe(true);
    expect(
      policy.authorize(subject, {
        permission: PermissionPoint.MembershipReviewGroup,
        scope: DataScope.Group,
        groupId: 'g2',
      }),
    ).toBe(false);
  });

  it('does not allow an ordinary administrator to configure permissions', () => {
    const subject = { userId: 'admin', roles: [Role.Admin] as const };
    expect(
      policy.canConfigure(subject, [
        {
          targetUserId: 'admin',
          permission: PermissionPoint.PermissionConfigure,
          scope: DataScope.Assigned,
        },
      ]),
    ).toBe(false);
  });
});
