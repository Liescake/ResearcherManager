import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';
import {
  DataScope,
  Grade,
  GroupStatus,
  PermissionPoint,
  Role,
  isGroupApplicable,
  researchGroupInputSchema,
} from '@rm/shared';
import { ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTHORIZATION_FORBIDDEN_MESSAGE,
  AuthorizationGuard,
} from '../access-control/authorization-guard';
import { AuthorizationPolicy } from '../access-control/authorization-policy';
import { BaselineRuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.baseline';
import type { AuthorizationDecision, RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import {
  GROUP_CREATE_INPUT_FIELDS,
  GROUP_INITIAL_STATUS,
  GROUP_INTEGRITY_MESSAGE,
  buildGroupReadCandidates,
  groupCreateInputSchema,
  parseStoredGroup,
  storedGroupSchema,
} from './groups.contract';
import type { GroupRepository, GroupVisibilityQuery, ResearchGroup } from './groups.port';
import { GroupsService } from './groups.service';

/**
 * 小组服务层回归（不启 HTTP）：把「判定入参来自服务端」「授权先于仓储访问」
 * 「可见范围由多候选并集决定」「未知枚举 fail-closed」「仓储越界返回不当作正常输出」
 * 几条约束固定在 service 这一层，避免它们只靠 HTTP 用例间接覆盖。
 */

const policy = new AuthorizationPolicy();
const guard = new AuthorizationGuard(new BaselineRuoYiAuthzAdapter(policy));

/** 仓储替身：只实现端口语义，不引入第二套授权或校验规则；记录调用次数以证明访问顺序 */
class StubGroupRepository implements GroupRepository {
  readonly capabilities = {
    backend: 'stub',
    persistent: false,
    productionReady: false,
  } as const;

  readonly created: ResearchGroup[] = [];
  createCalls = 0;
  listCalls = 0;
  lastQuery: GroupVisibilityQuery | undefined;
  /** 供用例模拟「仓储返回范围外/非开放记录」的越界返回 */
  listOverride: readonly ResearchGroup[] | undefined;
  /** 供用例模拟「仓储改写了服务端写入的负责人」 */
  createOverride: ResearchGroup | undefined;

  private readonly records = new Map<string, ResearchGroup>();

  constructor(seed: readonly ResearchGroup[] = []) {
    for (const record of seed) this.records.set(record.id, record);
  }

  create(group: ResearchGroup): ResearchGroup {
    this.createCalls += 1;
    this.created.push(group);
    this.records.set(group.id, group);
    return this.createOverride ?? group;
  }

  listVisibleGroups(query: GroupVisibilityQuery): readonly ResearchGroup[] {
    this.listCalls += 1;
    this.lastQuery = query;
    if (this.listOverride) return this.listOverride;
    return [...this.records.values()].filter(
      (record) =>
        isGroupApplicable(record.status) &&
        (query.includeAllOpenGroups || query.visibleGroupIds.includes(record.id)),
    );
  }
}

const LEADER_UUID = '2f6a1f2e-9c31-4d2b-8f0a-6a1b2c3d4e5f';
/** 小组 ID 必须是合法 UUID（读取契约沿用共享 uuidSchema），因此测试也不使用 'g-1' 这类假 ID */
const GROUP_OPEN_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const GROUP_CLOSED_ID = '4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const GROUP_ASSIGNED_ID = '5b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const GROUP_OTHER_ID = '6c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f';

const student = { userId: 'u-student-1', roles: [Role.Student] } as const;
const leader = {
  userId: LEADER_UUID,
  roles: [Role.GroupLeader],
  groupIds: [GROUP_OPEN_ID],
} as const;
const admin = { userId: 'u-admin-1', roles: [Role.Admin] } as const;
const superAdmin = { userId: LEADER_UUID, roles: [Role.SuperAdmin] } as const;

const validBody = {
  name: '智能机器人小组',
  description: '面向校内竞赛的机器人方向小组',
  researchDirections: ['机器人', '嵌入式'],
  recruitmentRequirements: {
    skills: ['C++'],
    grades: [Grade.Sophomore, Grade.Junior],
    minWeeklyHours: 6,
    headcount: 4,
    note: '需要能参与周末调试',
  },
};

function group(overrides: Partial<ResearchGroup> = {}): ResearchGroup {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: randomUUID(),
    name: '机器人小组',
    researchDirections: ['机器人'],
    recruitmentRequirements: { headcount: 3 },
    leaderUserId: LEADER_UUID,
    status: GroupStatus.Open,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function serviceWith(repository: GroupRepository): GroupsService {
  return new GroupsService(guard, repository);
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出异常，但没有抛出');
}

describe('GroupsService：主体与归属只来自服务端', () => {
  it('创建：负责人、状态、时间戳由服务端写入，视图不含 leaderUserId', () => {
    const repository = new StubGroupRepository();
    const service = serviceWith(repository);

    const view = service.createGroup(superAdmin, { ...validBody });

    expect(repository.created).toHaveLength(1);
    const stored = repository.created[0];
    expect(stored?.leaderUserId).toBe(LEADER_UUID);
    expect(stored?.status).toBe(GroupStatus.Open);
    expect(stored?.createdAt).toBe(stored?.updatedAt);
    // 招募要求逐字段沿用请求值（共享 schema 的枚举/范围约束已经生效）
    expect(stored?.recruitmentRequirements).toEqual(validBody.recruitmentRequirements);

    // 对外视图白名单：没有 leaderUserId，也没有任何内部处理字段
    expect(Object.keys(view).sort()).toEqual([
      'createdAt',
      'description',
      'id',
      'name',
      'recruitmentRequirements',
      'researchDirections',
      'status',
      'updatedAt',
    ]);
    expect(JSON.stringify(view)).not.toContain(LEADER_UUID);
  });

  it('初始状态来自服务端常量：即使请求体带有 status 也不能改写（由输入闭集拒绝）', () => {
    const repository = new StubGroupRepository();
    const service = serviceWith(repository);

    expect(GROUP_INITIAL_STATUS).toBe(GroupStatus.Open);
    expect(
      captureError(() => service.createGroup(superAdmin, { ...validBody, status: 'closed' })),
    ).toBeInstanceOf(ZodError);
    expect(repository.created).toHaveLength(0);
  });

  it('列表：可见范围由服务端主体决定（学生 SELF → 集合级；负责人 GROUP → 逐条资源级）', () => {
    const opened = group({ id: GROUP_OPEN_ID, name: '开放小组' });
    const closed = group({ id: GROUP_CLOSED_ID, name: '已停用小组', status: GroupStatus.Closed });
    const repository = new StubGroupRepository([opened, closed]);

    const studentView = serviceWith(repository).listGroups(student);
    expect(studentView.map((item) => item.id)).toEqual([GROUP_OPEN_ID]);

    const leaderRepository = new StubGroupRepository([opened, closed]);
    const leaderService = serviceWith(leaderRepository);
    const leaderView = leaderService.listGroups(leader);

    expect(leaderView.map((item) => item.id)).toEqual([GROUP_OPEN_ID]);
    expect(leaderRepository.lastQuery).toEqual({
      includeAllOpenGroups: false,
      visibleGroupIds: [GROUP_OPEN_ID],
    });
    expect(JSON.stringify(leaderView)).not.toContain('已停用小组');
  });

  it('列表：管理员按服务端分配的可见资源取数（ASSIGNED 逐条判定）', () => {
    const assigned = group({ id: GROUP_ASSIGNED_ID, name: '受派小组' });
    const other = group({ id: GROUP_OTHER_ID, name: '未受派小组' });
    const repository = new StubGroupRepository([assigned, other]);
    const service = serviceWith(repository);

    const scope = { ...admin, assignedResourceIds: [GROUP_ASSIGNED_ID] } as const;
    const items = service.listGroups(scope);

    expect(items.map((item) => item.id)).toEqual([GROUP_ASSIGNED_ID]);
    expect(repository.lastQuery).toEqual({
      includeAllOpenGroups: false,
      visibleGroupIds: [GROUP_ASSIGNED_ID],
    });
  });

  it('系统管理员/超级管理员：集合级可见（SYSTEM / GLOBAL 不需要资源标识）', () => {
    const repository = new StubGroupRepository([
      group({ id: GROUP_OPEN_ID }),
      group({ id: GROUP_OTHER_ID }),
    ]);

    const systemAdmin = { userId: 'u-sys-1', roles: [Role.SystemAdmin] } as const;
    expect(serviceWith(repository).listGroups(systemAdmin)).toHaveLength(2);
    expect(repository.lastQuery).toEqual({ includeAllOpenGroups: true, visibleGroupIds: [] });

    expect(serviceWith(repository).listGroups(superAdmin)).toHaveLength(2);
    expect(repository.lastQuery).toEqual({ includeAllOpenGroups: true, visibleGroupIds: [] });
  });

  it('没有任何可用候选范围时 403（不回答「是否存在你看不见的小组」）', () => {
    const repository = new StubGroupRepository([group({ id: 'g-1' })]);
    const service = serviceWith(repository);

    const cases = [
      // 负责人没有任何服务端解析的 groupIds
      { userId: 'u-leader-1', roles: [Role.GroupLeader] as const },
      // 管理员没有任何服务端分配的可见资源
      { userId: 'u-admin-1', roles: [Role.Admin] as const },
      // 未登记角色不产生候选
      { userId: 'u-x', roles: ['guest' as Role] },
      // 已登记角色 + 未登记角色：主体整体不可信
      { userId: 'u-x', roles: [Role.Student, 'guest' as Role] },
      // 空主体
      { userId: '', roles: [Role.Student] as const },
    ];

    for (const subject of cases) {
      const error = captureError(() => service.listGroups(subject));
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).message).toBe(AUTHORIZATION_FORBIDDEN_MESSAGE);
    }
    expect(repository.listCalls).toBe(0);
  });

  it('授权先于仓储访问：端口拒绝时仓储的读写方法一次都不被调用', () => {
    const denying: RuoYiAuthzAdapter = {
      capabilities: new BaselineRuoYiAuthzAdapter(policy).capabilities,
      checkAuthorization: (): AuthorizationDecision => ({
        allowed: false,
        reason: 'policy-denied',
      }),
      checkGrant: (): AuthorizationDecision => ({ allowed: false, reason: 'policy-denied' }),
    };
    const repository = new StubGroupRepository([group()]);
    const service = new GroupsService(new AuthorizationGuard(denying), repository);

    expect(captureError(() => service.listGroups(student))).toBeInstanceOf(ForbiddenException);
    expect(captureError(() => service.createGroup(superAdmin, validBody))).toBeInstanceOf(
      ForbiddenException,
    );

    expect(repository.listCalls).toBe(0);
    expect(repository.createCalls).toBe(0);
    expect(repository.created).toHaveLength(0);
  });
});

describe('GroupsService：输入闭集与字段校验（fail-closed）', () => {
  it('服务端独占字段（leaderUserId/status/groupId/userId/roles/scope/id…）→ ZodError，且不落库', () => {
    const repository = new StubGroupRepository();
    const service = serviceWith(repository);

    const injected = {
      ...validBody,
      leaderUserId: randomUUID(),
      status: GroupStatus.Paused,
      groupId: 'g-1',
      groupIds: ['g-1'],
      userId: 'u-victim-1',
      roles: [Role.SuperAdmin],
      scope: DataScope.Global,
      dataScope: DataScope.Global,
      id: randomUUID(),
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const error = captureError(() => service.createGroup(superAdmin, injected));

    expect(error).toBeInstanceOf(ZodError);
    const messages = (error as ZodError).issues.map((issue) => issue.message).join('|');
    for (const key of [
      'leaderUserId',
      'status',
      'groupId',
      'groupIds',
      'userId',
      'roles',
      'scope',
      'dataScope',
      'id',
      'createdAt',
    ]) {
      expect(messages).toContain(key);
    }
    expect(repository.created).toHaveLength(0);
    expect(repository.createCalls).toBe(0);
  });

  it('未知枚举/越界/控制字符/非法招募要求 → ZodError，且不落库', () => {
    const repository = new StubGroupRepository();
    const service = serviceWith(repository);

    const cases: unknown[] = [
      {},
      { ...validBody, name: '' },
      { ...validBody, name: 'x'.repeat(101) },
      { ...validBody, name: '小组\u0007名称' },
      { ...validBody, description: 'x'.repeat(5001) },
      { ...validBody, researchDirections: [] },
      { ...validBody, researchDirections: Array.from({ length: 11 }, (_, i) => `方向${i}`) },
      { ...validBody, researchDirections: ['方向\u0000'] },
      { ...validBody, recruitmentRequirements: { grades: ['unknown_grade'] } },
      { ...validBody, recruitmentRequirements: { headcount: 0 } },
      { ...validBody, recruitmentRequirements: { headcount: 201 } },
      { ...validBody, recruitmentRequirements: { minWeeklyHours: 81 } },
      { ...validBody, recruitmentRequirements: { skills: Array.from({ length: 21 }, (_, i) => `s${i}`) } },
      { ...validBody, recruitmentRequirements: { note: 'x'.repeat(501) } },
      { ...validBody, recruitmentRequirements: 'not-an-object' },
      ['not', 'an', 'object'],
      'not-an-object',
    ];

    for (const body of cases) {
      expect(captureError(() => service.createGroup(superAdmin, body))).toBeInstanceOf(ZodError);
    }
    expect(repository.created).toHaveLength(0);
    // 对照组：同一请求体在创建 schema 下合法（证明上面的拒绝来自具体字段，而不是整体不成立）
    expect(groupCreateInputSchema.safeParse(validBody).success).toBe(true);
  });

  it('授权先于字段校验：无 group:manage 的角色得到 403，而不是校验结果', () => {
    const repository = new StubGroupRepository();
    const service = serviceWith(repository);

    for (const subject of [student, leader, admin]) {
      expect(captureError(() => service.createGroup(subject, { name: 'x' }))).toBeInstanceOf(
        ForbiddenException,
      );
    }
    expect(repository.createCalls).toBe(0);
    expect(repository.created).toHaveLength(0);
  });

  it('创建接口字段闭集与共享 schema 去服务端字段后的键集一致（契约回归）', () => {
    expect([...GROUP_CREATE_INPUT_FIELDS].sort()).toEqual(
      Object.keys(groupCreateInputSchema.shape).sort(),
    );
    // 服务端独占字段确实已从共享 schema 派生结果中移除，且共享 schema 本身仍要求它们
    expect(Object.keys(groupCreateInputSchema.shape)).not.toContain('leaderUserId');
    expect(Object.keys(groupCreateInputSchema.shape)).not.toContain('status');
    expect(Object.keys(researchGroupInputSchema.shape)).toContain('leaderUserId');
    expect(Object.keys(researchGroupInputSchema.shape)).toContain('status');
  });

  it('读取契约不继承共享 schema 的默认值：缺少 status 的存储记录必须判违规', () => {
    const created = {
      id: randomUUID(),
      name: '小组',
      researchDirections: ['方向'],
      recruitmentRequirements: { headcount: 1 },
      leaderUserId: LEADER_UUID,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(researchGroupInputSchema.safeParse({ ...created, leaderUserId: LEADER_UUID }).success).toBe(
      true,
    );
    expect(parseStoredGroup(created).ok).toBe(false);
    expect(parseStoredGroup({ ...created, status: GroupStatus.Open }).ok).toBe(true);
    expect(storedGroupSchema.safeParse({ ...created, status: 'unknown_status' }).success).toBe(
      false,
    );
  });
});

describe('GroupsService：可见范围候选（buildGroupReadCandidates）', () => {
  it('学生 → 单个 SELF 集合级候选，入参取自服务端主体', () => {
    expect(buildGroupReadCandidates(student)).toEqual([
      {
        kind: 'collection',
        origin: 'SELF',
        request: {
          permission: PermissionPoint.GroupReadOpen,
          scope: DataScope.Self,
          resourceUserId: 'u-student-1',
        },
      },
    ]);
  });

  it('负责人 → 每个服务端解析的小组各一条 GROUP 候选（逐条带 groupId）', () => {
    const candidates = buildGroupReadCandidates({
      userId: LEADER_UUID,
      roles: [Role.GroupLeader],
      groupIds: ['g-1', 'g-2', 'g-1'],
    });

    expect(candidates).toEqual([
      {
        kind: 'resource',
        origin: 'GROUP',
        resourceId: 'g-1',
        request: { permission: PermissionPoint.GroupReadOpen, scope: DataScope.Group, groupId: 'g-1' },
      },
      {
        kind: 'resource',
        origin: 'GROUP',
        resourceId: 'g-2',
        request: { permission: PermissionPoint.GroupReadOpen, scope: DataScope.Group, groupId: 'g-2' },
      },
    ]);
  });

  it('管理员 → 逐个 assignedResourceIds 的 ASSIGNED 候选；未登记角色不产生候选', () => {
    const candidates = buildGroupReadCandidates({
      userId: 'u-admin-1',
      roles: [Role.Admin],
      assignedResourceIds: ['g-9'],
    });
    expect(candidates).toEqual([
      {
        kind: 'resource',
        origin: 'ASSIGNED',
        resourceId: 'g-9',
        request: {
          permission: PermissionPoint.GroupReadOpen,
          scope: DataScope.Assigned,
          resourceUserId: 'g-9',
        },
      },
    ]);

    expect(buildGroupReadCandidates({ userId: 'u-x', roles: ['guest' as Role] })).toEqual([]);
  });
});

describe('GroupsService：存储异常 fail-closed', () => {
  it('存储状态枚举未登记 → 500，且异常不携带原始取值', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const corrupted = group({ status: 'unknown_status' as GroupStatus, name: '受损小组名称' });
    // 用 listOverride 模拟「仓储把未登记状态的记录也返回」：真实仓储会先按开放状态过滤，
    // 因此这条服务端不变量必须由 service 自己复核，而不能依赖仓储。
    const repository = new StubGroupRepository();
    repository.listOverride = [corrupted];
    const service = serviceWith(repository);

    const error = captureError(() => service.listGroups(student));

    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect((error as InternalServerErrorException).getStatus()).toBe(500);
    expect((error as InternalServerErrorException).message).toBe(GROUP_INTEGRITY_MESSAGE);
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('unknown_status');
    expect(serialized).not.toContain('受损小组名称');
    expect(Logger.prototype.error).toHaveBeenCalled();
  });

  it('存储时间戳非法 → 500（读取契约包含时间格式）', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = serviceWith(
      new StubGroupRepository([group({ createdAt: '2026-01-01 00:00:00' })]),
    );

    expect(captureError(() => service.listGroups(student))).toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('仓储返回非开放小组或授权范围之外的小组 → 500，绝不当作正常输出', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const pausedRepository = new StubGroupRepository();
    pausedRepository.listOverride = [group({ status: GroupStatus.Paused, name: '暂停小组' })];
    const pausedError = captureError(() => serviceWith(pausedRepository).listGroups(student));
    expect(pausedError).toBeInstanceOf(InternalServerErrorException);
    expect((pausedError as InternalServerErrorException).message).toBe(GROUP_INTEGRITY_MESSAGE);
    expect(JSON.stringify(pausedError)).not.toContain('暂停小组');

    const outOfScopeRepository = new StubGroupRepository();
    outOfScopeRepository.listOverride = [group({ id: 'g-2', name: '越权小组' })];
    const outOfScopeError = captureError(() =>
      serviceWith(outOfScopeRepository).listGroups(leader),
    );
    expect(outOfScopeError).toBeInstanceOf(InternalServerErrorException);
    expect((outOfScopeError as InternalServerErrorException).message).toBe(GROUP_INTEGRITY_MESSAGE);
    expect(JSON.stringify(outOfScopeError)).not.toContain('越权小组');
  });

  it('创建：会话主体的 userId 不是合法负责人 UUID → 500，且**不落库**', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const repository = new StubGroupRepository();
    const service = serviceWith(repository);

    const error = captureError(() =>
      service.createGroup({ userId: 'u-super-1', roles: [Role.SuperAdmin] }, validBody),
    );

    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect((error as InternalServerErrorException).message).toBe(GROUP_INTEGRITY_MESSAGE);
    expect(repository.createCalls).toBe(0);
    expect(repository.created).toHaveLength(0);
  });

  it('创建：仓储改写负责人（返回他人记录）→ 500，不把他人小组当作创建结果返回', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const repository = new StubGroupRepository();
    repository.createOverride = group({ leaderUserId: randomUUID(), name: '他人小组' });
    const service = serviceWith(repository);

    const error = captureError(() => service.createGroup(superAdmin, validBody));

    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect((error as InternalServerErrorException).message).toBe(GROUP_INTEGRITY_MESSAGE);
    expect(JSON.stringify(error)).not.toContain('他人小组');
  });
});
