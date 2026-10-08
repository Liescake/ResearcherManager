import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DataScope, PermissionPoint, Role } from '@rm/shared';
import { AuthorizationGuard } from './authorization-guard';
import { AuthorizationPolicy } from './authorization-policy';

describe('AuthorizationGuard', () => {
  const guard = new AuthorizationGuard(new AuthorizationPolicy());

  it('permits only a server-validated group binding', () => {
    const subject = { userId: 'leader', roles: [Role.GroupLeader] as const, groupIds: ['g1'] };
    expect(() =>
      guard.assertAuthorized(subject, {
        permission: PermissionPoint.MembershipReviewGroup,
        scope: DataScope.Group,
        groupId: 'g1',
      }),
    ).not.toThrow();
    expect(() =>
      guard.assertAuthorized(subject, {
        permission: PermissionPoint.MembershipReviewGroup,
        scope: DataScope.Group,
        groupId: 'g2',
      }),
    ).toThrow(ForbiddenException);
  });

  it('rejects client-supplied self resource mismatches', () => {
    const subject = { userId: 'student', roles: [Role.Student] as const };
    expect(() =>
      guard.assertAuthorized(subject, {
        permission: PermissionPoint.ProfileSelfRead,
        scope: DataScope.Self,
        resourceUserId: 'other',
      }),
    ).toThrow(ForbiddenException);
  });
});
