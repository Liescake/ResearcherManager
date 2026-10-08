import { describe, expect, it } from 'vitest';
import { DataScope, PermissionPoint, Role } from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import { AuthorizationPolicy } from '../access-control/authorization-policy';
import { BaselineRuoYiAuthzAdapter } from './ruoyi-adapter.baseline';
import type { AuthorizationObservation } from './ruoyi-adapter.port';
import { AUTHZ_CONTRACT_ID, AUTHZ_CONTRACT_VERSION } from './contract/authz-fixtures';

/**
 * 适配器不变量：能力声明、默认拒绝、与基线谓词一致、观察者只收脱敏元数据。
 * 迁移到 RuoYi 实现时，这套不变量应当原样复用（把被断言对象换成 RuoYi 实现即可）。
 */

const policy = new AuthorizationPolicy();
const student: AuthorizationSubject = { userId: 'u-student-1', roles: [Role.Student] };
const groupLeader: AuthorizationSubject = {
  userId: 'u-leader-1',
  roles: [Role.GroupLeader],
  groupIds: ['g-1'],
};

describe('BaselineRuoYiAuthzAdapter 能力声明', () => {
  const adapter = new BaselineRuoYiAuthzAdapter(policy);

  it('声明自己是可回退的 NestJS 基线，且未接入 RuoYi 后端', () => {
    expect(adapter.capabilities.backend).toBe('nestjs-baseline');
    expect(adapter.capabilities.delegatesToCanonicalPredicate).toBe(true);
    expect(adapter.capabilities.menuRbacBackend).toBe(false);
    expect(adapter.capabilities.ruoyiDataScopeBackend).toBe(false);
  });

  it('边界事实：不含 RuoYi 源码、不引入 Maven 依赖', () => {
    expect(adapter.capabilities.ruoyiSourceIncluded).toBe(false);
    expect(adapter.capabilities.mavenDependencyIntroduced).toBe(false);
  });

  it('声明镜像的契约标识与版本', () => {
    expect(adapter.capabilities.contract).toEqual({
      id: AUTHZ_CONTRACT_ID,
      version: AUTHZ_CONTRACT_VERSION,
    });
    expect(BaselineRuoYiAuthzAdapter.describeContractSource()).toEqual({
      relativePath: 'services/ruoyi-api/contracts/authz-fixtures.json',
      contractId: AUTHZ_CONTRACT_ID,
    });
  });
});

describe('BaselineRuoYiAuthzAdapter 判定与基线谓词一致', () => {
  const adapter = new BaselineRuoYiAuthzAdapter(policy);

  it('放行本人在 SELF 范围内的画像读取', () => {
    const decision = adapter.checkAuthorization(student, {
      permission: PermissionPoint.ProfileSelfRead,
      scope: DataScope.Self,
      resourceUserId: 'u-student-1',
    });
    expect(decision).toEqual({ allowed: true, reason: 'allowed' });
  });

  it('拒绝学生读取他人 SELF 资源', () => {
    const decision = adapter.checkAuthorization(student, {
      permission: PermissionPoint.ProfileSelfRead,
      scope: DataScope.Self,
      resourceUserId: 'u-student-2',
    });
    expect(decision).toEqual({ allowed: false, reason: 'policy-denied' });
  });

  it('拒绝负责人访问非所属小组', () => {
    const decision = adapter.checkAuthorization(groupLeader, {
      permission: PermissionPoint.MembershipReviewGroup,
      scope: DataScope.Group,
      groupId: 'g-2',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('policy-denied');
  });

  it('权限配置仍由基线谓词决定：普通管理员不得配置权限', () => {
    const admin: AuthorizationSubject = { userId: 'u-admin-1', roles: [Role.Admin] };
    expect(
      adapter.checkGrant(admin, [
        {
          targetUserId: 'u-admin-1',
          permission: PermissionPoint.PermissionConfigure,
          scope: DataScope.Assigned,
        },
      ]),
    ).toEqual({ allowed: false, reason: 'policy-denied' });
  });

  it('系统管理员可以为他人授予 ASSIGNED 读取权限', () => {
    const systemAdmin: AuthorizationSubject = { userId: 'u-sys-1', roles: [Role.SystemAdmin] };
    expect(
      adapter.checkGrant(systemAdmin, [
        {
          targetUserId: 'u-admin-1',
          permission: PermissionPoint.ProfileAdminRead,
          scope: DataScope.Assigned,
        },
      ]),
    ).toEqual({ allowed: true, reason: 'allowed' });
  });
});

describe('BaselineRuoYiAuthzAdapter 默认拒绝（进谓词前即拒绝）', () => {
  const adapter = new BaselineRuoYiAuthzAdapter(policy);

  it('未登记权限在适配器层被拒绝，并给出可审计的原因', () => {
    const decision = adapter.checkAuthorization(student, {
      permission: 'profile:*' as unknown as PermissionPoint,
      scope: DataScope.Self,
      resourceUserId: 'u-student-1',
    });
    expect(decision).toEqual({ allowed: false, reason: 'unknown-permission' });
  });

  it('未登记数据范围被拒绝', () => {
    const decision = adapter.checkAuthorization(student, {
      permission: PermissionPoint.ProfileSelfRead,
      scope: 'OWN' as unknown as DataScope,
      resourceUserId: 'u-student-1',
    });
    expect(decision).toEqual({ allowed: false, reason: 'unknown-scope' });
  });

  it('未登记角色被拒绝', () => {
    const decision = adapter.checkAuthorization(
      { userId: 'u-x', roles: ['guest' as Role] },
      {
        permission: PermissionPoint.ProfileSelfRead,
        scope: DataScope.Self,
        resourceUserId: 'u-x',
      },
    );
    expect(decision).toEqual({ allowed: false, reason: 'unknown-role' });
  });

  it('缺少服务端解析的用户标识时拒绝', () => {
    const decision = adapter.checkAuthorization(
      { userId: '', roles: [Role.Student] },
      { permission: PermissionPoint.ProfileSelfRead, scope: DataScope.Self, resourceUserId: '' },
    );
    expect(decision).toEqual({ allowed: false, reason: 'unknown-subject' });
  });

  it('拒绝时绝不返回 allowed: true', () => {
    const decisions = [
      adapter.checkAuthorization(student, {
        permission: 'unlisted:permission' as unknown as PermissionPoint,
        scope: DataScope.Self,
      }),
      adapter.checkAuthorization(
        { userId: '', roles: [] },
        {
          permission: PermissionPoint.ProfileSelfRead,
          scope: DataScope.Self,
        },
      ),
      adapter.checkGrant({ userId: 'u-admin-1', roles: [Role.Admin] }, []),
    ];
    expect(decisions.some((decision) => decision.allowed)).toBe(false);
  });
});

describe('BaselineRuoYiAuthzAdapter 观察者只接收脱敏元数据', () => {
  it('记录判定结果、原因、权限与范围，但不记录主体标识', () => {
    const events: AuthorizationObservation[] = [];
    const adapter = new BaselineRuoYiAuthzAdapter(policy, {
      observe: (event) => events.push(event),
    });

    adapter.checkAuthorization(student, {
      permission: PermissionPoint.ProfileSelfRead,
      scope: DataScope.Self,
      resourceUserId: 'u-student-1',
    });
    adapter.checkAuthorization(student, {
      permission: PermissionPoint.ProfileSelfRead,
      scope: DataScope.Self,
      resourceUserId: 'u-student-2',
    });

    expect(events).toEqual([
      {
        kind: 'authorize',
        allowed: true,
        reason: 'allowed',
        permission: 'profile:self:read',
        scope: 'SELF',
      },
      {
        kind: 'authorize',
        allowed: false,
        reason: 'policy-denied',
        permission: 'profile:self:read',
        scope: 'SELF',
      },
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('u-student-1');
    expect(serialized).not.toContain('u-student-2');
  });

  it('未注入观察者时仍可正常判定', () => {
    const adapter = new BaselineRuoYiAuthzAdapter(policy);
    expect(
      adapter.checkAuthorization(student, {
        permission: PermissionPoint.ProfileSelfRead,
        scope: DataScope.Self,
        resourceUserId: 'u-student-1',
      }).allowed,
    ).toBe(true);
  });
});
