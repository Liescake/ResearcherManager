import { ForbiddenException, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { DataScope, PermissionPoint, Role } from '@rm/shared';
import type { AuthorizationRequest, AuthorizationSubject, PermissionGrant } from '@rm/shared';
import { BaselineRuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.baseline';
import {
  RUOYI_AUTHZ_ADAPTER,
  type AuthorizationDecision,
  type RuoYiAdapterCapabilities,
  type RuoYiAuthzAdapter,
} from '../ruoyi-adapter/ruoyi-adapter.port';
import { AuthorizationGuard } from './authorization-guard';
import { AuthorizationPolicy } from './authorization-policy';

/**
 * 授权边界回归：guard **必须**经由适配器端口（`RUOYI_AUTHZ_ADAPTER`）判定，
 * 不再直接注入 `AuthorizationPolicy`；同时保持原有 403 行为与 canonical 基线结果。
 */

const policy = new AuthorizationPolicy();
const baselineAdapter = new BaselineRuoYiAuthzAdapter(policy);
const guard = new AuthorizationGuard(baselineAdapter);

const student: AuthorizationSubject = { userId: 'u-student-1', roles: [Role.Student] };
const groupLeader: AuthorizationSubject = {
  userId: 'u-leader-1',
  roles: [Role.GroupLeader],
  groupIds: ['g-1'],
};
const ordinaryAdmin: AuthorizationSubject = { userId: 'u-admin-1', roles: [Role.Admin] };
const systemAdmin: AuthorizationSubject = { userId: 'u-sys-1', roles: [Role.SystemAdmin] };

/** 捕获 403，非 ForbiddenException 直接抛出，避免把其他异常误判为授权拒绝。 */
function captureForbidden(run: () => void): ForbiddenException {
  try {
    run();
  } catch (error) {
    if (error instanceof ForbiddenException) {
      return error;
    }
    throw error;
  }
  throw new Error('预期抛出 ForbiddenException，但没有抛出');
}

function allows(run: () => void): boolean {
  try {
    run();
    return true;
  } catch (error) {
    if (error instanceof ForbiddenException) {
      return false;
    }
    throw error;
  }
}

const selfReadOfSelf: AuthorizationRequest = {
  permission: PermissionPoint.ProfileSelfRead,
  scope: DataScope.Self,
  resourceUserId: 'u-student-1',
};

describe('AuthorizationGuard（经适配器端口判定）', () => {
  it('permits only a server-validated group binding', () => {
    expect(() =>
      guard.assertAuthorized(groupLeader, {
        permission: PermissionPoint.MembershipReviewGroup,
        scope: DataScope.Group,
        groupId: 'g-1',
      }),
    ).not.toThrow();
    expect(() =>
      guard.assertAuthorized(groupLeader, {
        permission: PermissionPoint.MembershipReviewGroup,
        scope: DataScope.Group,
        groupId: 'g-2',
      }),
    ).toThrow(ForbiddenException);
  });

  it('rejects client-supplied self resource mismatches', () => {
    expect(() =>
      guard.assertAuthorized(student, {
        permission: PermissionPoint.ProfileSelfRead,
        scope: DataScope.Self,
        resourceUserId: 'other',
      }),
    ).toThrow(ForbiddenException);
  });

  it('放行本人在 SELF 范围内的画像读取', () => {
    expect(() => guard.assertAuthorized(student, selfReadOfSelf)).not.toThrow();
  });

  it('拒绝跨组资源、未分配 ASSIGNED 资源与越权范围', () => {
    expect(() =>
      guard.assertAuthorized(student, {
        permission: PermissionPoint.ProfileAdminRead,
        scope: DataScope.Assigned,
        resourceUserId: 'u-student-1',
      }),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.assertAuthorized(ordinaryAdmin, {
        permission: PermissionPoint.ProfileAdminRead,
        scope: DataScope.Assigned,
        resourceUserId: 'u-other-1',
      }),
    ).toThrow(ForbiddenException);
  });

  it('未登记权限/范围/角色/主体一律 fail-closed，且不把适配器原因泄露给客户端', () => {
    const cases: Array<[AuthorizationSubject, AuthorizationRequest]> = [
      [student, { permission: 'profile:*' as PermissionPoint, scope: DataScope.Self }],
      [student, { permission: PermissionPoint.ProfileSelfRead, scope: 'OWN' as DataScope }],
      [
        { userId: 'u-x', roles: ['guest' as Role] },
        {
          permission: PermissionPoint.ProfileSelfRead,
          scope: DataScope.Self,
          resourceUserId: 'u-x',
        },
      ],
      [
        { userId: '', roles: [Role.Student] },
        { permission: PermissionPoint.ProfileSelfRead, scope: DataScope.Self },
      ],
    ];

    for (const [subject, request] of cases) {
      const error = captureForbidden(() => guard.assertAuthorized(subject, request));
      expect(error.getStatus()).toBe(403);
      expect(error.message).toBe('无权执行该操作');
      const serialized = JSON.stringify({ message: error.message, response: error.getResponse() });
      expect(serialized).not.toMatch(/unknown-|policy-denied/);
    }
  });

  it('权限配置：系统管理员可授予 ASSIGNED 读取权限，普通管理员一律拒绝', () => {
    const grant: PermissionGrant = {
      targetUserId: 'u-admin-1',
      permission: PermissionPoint.ProfileAdminRead,
      scope: DataScope.Assigned,
    };
    expect(() => guard.assertCanConfigure(systemAdmin, [grant])).not.toThrow();

    const error = captureForbidden(() => guard.assertCanConfigure(ordinaryAdmin, [grant]));
    expect(error.getStatus()).toBe(403);
    expect(error.message).toBe('无权配置权限');
  });

  it('未登记权限/范围的配置请求同样 fail-closed', () => {
    expect(() =>
      guard.assertCanConfigure(systemAdmin, [
        {
          targetUserId: 'u-admin-1',
          permission: 'export:*' as PermissionPoint,
          scope: DataScope.Assigned,
        },
      ]),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.assertCanConfigure(systemAdmin, [
        {
          targetUserId: 'u-admin-1',
          permission: PermissionPoint.ProfileAdminRead,
          scope: 'OWN' as DataScope,
        },
      ]),
    ).toThrow(ForbiddenException);
  });

  it('经端口的判定与 canonical 谓词逐条一致（基线结果保持不变）', () => {
    const cases: Array<[AuthorizationSubject, AuthorizationRequest]> = [
      [student, selfReadOfSelf],
      [student, { ...selfReadOfSelf, resourceUserId: 'u-other-1' }],
      [
        groupLeader,
        {
          permission: PermissionPoint.MembershipReviewGroup,
          scope: DataScope.Group,
          groupId: 'g-1',
        },
      ],
      [
        groupLeader,
        {
          permission: PermissionPoint.MembershipReviewGroup,
          scope: DataScope.Group,
          groupId: 'g-2',
        },
      ],
      [ordinaryAdmin, { permission: PermissionPoint.ProfileAdminRead, scope: DataScope.Assigned }],
      [systemAdmin, { permission: PermissionPoint.AuditRead, scope: DataScope.System }],
      [student, { permission: PermissionPoint.ProfileSelfRead, scope: 'OWN' as DataScope }],
    ];

    for (const [subject, request] of cases) {
      expect(allows(() => guard.assertAuthorized(subject, request))).toBe(
        policy.authorize(subject, request),
      );
    }
  });

  it('构造器声明的注入令牌是适配器端口，而不是 AuthorizationPolicy', () => {
    const declared = (Reflect.getMetadata('self:paramtypes', AuthorizationGuard) ?? []) as Array<{
      index: number;
      param: unknown;
    }>;
    expect(declared).toHaveLength(1);
    expect(declared[0]?.param).toBe(RUOYI_AUTHZ_ADAPTER);
    expect(declared[0]?.param).not.toBe(AuthorizationPolicy);
  });
});

/** 模拟将来 RuoYi 侧 provider 适配器：判定结果与基线相反，用于证明 guard 只认端口。 */
const providerCapabilities: RuoYiAdapterCapabilities = {
  backend: 'ruoyi',
  delegatesToCanonicalPredicate: true,
  menuRbacBackend: true,
  ruoyiDataScopeBackend: true,
  contract: { id: 'ruoyi-authz-provider', version: '1.0.0' },
  ruoyiSourceIncluded: false,
  mavenDependencyIntroduced: false,
};

const providerCalls: string[] = [];
const providerAdapter: RuoYiAuthzAdapter = {
  capabilities: providerCapabilities,
  checkAuthorization: (): AuthorizationDecision => {
    providerCalls.push('checkAuthorization');
    return { allowed: false, reason: 'policy-denied' };
  },
  checkGrant: (): AuthorizationDecision => {
    providerCalls.push('checkGrant');
    return { allowed: true, reason: 'allowed' };
  },
};

@Module({
  providers: [{ provide: RUOYI_AUTHZ_ADAPTER, useValue: providerAdapter }, AuthorizationGuard],
})
class ProviderAdapterProbeModule {}

describe('AuthorizationGuard 消费 provider adapter（DI 令牌替换）', () => {
  beforeEach(() => {
    providerCalls.length = 0;
  });

  it('端口判拒绝时，即使 canonical 谓词会放行也抛 403', () => {
    const providerGuard = new AuthorizationGuard(providerAdapter);
    expect(() => providerGuard.assertAuthorized(student, selfReadOfSelf)).toThrow(
      ForbiddenException,
    );
    expect(providerCalls).toEqual(['checkAuthorization']);
  });

  it('端口判放行时，即使 canonical 谓词会拒绝也不抛错', () => {
    const providerGuard = new AuthorizationGuard(providerAdapter);
    const grant: PermissionGrant = {
      targetUserId: 'u-admin-1',
      permission: PermissionPoint.ProfileAdminRead,
      scope: DataScope.Assigned,
    };
    expect(policy.canConfigure(ordinaryAdmin, [grant])).toBe(false);
    expect(() => providerGuard.assertCanConfigure(ordinaryAdmin, [grant])).not.toThrow();
    expect(providerCalls).toEqual(['checkGrant']);
  });

  it('Nest 上下文把端口令牌绑定到 provider adapter 后，guard 采用该端口的判定', async () => {
    const app = await NestFactory.createApplicationContext(ProviderAdapterProbeModule, {
      logger: false,
    });
    try {
      const resolvedAdapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
      expect(resolvedAdapter).toBe(providerAdapter);
      const providerGuard = app.get(AuthorizationGuard);
      expect(() => providerGuard.assertAuthorized(student, selfReadOfSelf)).toThrow(
        ForbiddenException,
      );
      expect(providerCalls).toEqual(['checkAuthorization']);
    } finally {
      await app.close();
    }
  });
});
