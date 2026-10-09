import {
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  ApplicationKind,
  ApplicationStatus,
  DataScope,
  Role,
  StateTransitionError,
  isAuthorized,
} from '@rm/shared';
import type { AuthorizationRequest, AuthorizationSubject } from '@rm/shared';
import {
  ApplicationReviewConflictError,
  type ApplicationReviewRepository,
  type ApplicationReviewScope,
} from './application-reviews.port';
import { ApplicationReviewsService } from './application-reviews.service';
import type { Application } from './applications.port';
import {
  AUTHORIZATION_FORBIDDEN_MESSAGE,
  AuthorizationGuard,
} from '../access-control/authorization-guard';

/**
 * 审核端切片的**授权与顺序**回归。
 *
 * 本文件只验证一件事：审核端读/写了什么，完全由**服务端主体**决定 ——
 * 客户端提交的 `userId` / `roles` / `scope` / `groupId` / `status` / `reviewStatus`
 * 既不能推进判定，也不能落库。因此断言分三类：
 * 1. **范围来源**：传给仓储的 `scope` 必须逐字等于「从服务端主体解析出来的范围」；
 * 2. **顺序**：未授权时既不能碰仓储，也不能得到字段级校验反馈（403 而非 400）；
 * 3. **写入形状**：`reviewedByUserId` 恒为会话主体，归属/小组/创建时间逐字段沿用存储值。
 *
 * 授权判定复用 `@rm/shared` 的 canonical 谓词 `isAuthorized`（与
 * `BaselineRuoYiAuthzAdapter` 委托的同一份语义），因此这里的允许/拒绝是**真实策略**给出的，
 * 不是测试自己编的对照表。
 */
class PolicyBackedGuard extends AuthorizationGuard {
  constructor() {
    // 父类要求注入端口；这里用 canonical 谓词直接实现同一份语义
    super({
      checkAuthorization: (subject: AuthorizationSubject, request: AuthorizationRequest) => ({
        allowed: isAuthorized(subject, request),
      }),
      checkGrant: () => ({ allowed: false }),
    } as never);
  }
}

const GROUP_A = '11111111-1111-4111-8111-111111111111';
const GROUP_B = '22222222-2222-4222-8222-222222222222';
const GROUP_OUTSIDE = '33333333-3333-4333-8333-333333333333';
const APPLICANT = '44444444-4444-4444-8444-444444444444';
const REVIEWER = '55555555-5555-4555-8555-555555555555';
const APPLICATION_ID = '66666666-6666-4666-8666-666666666666';

const SUPER_ADMIN: AuthorizationSubject = { userId: REVIEWER, roles: [Role.SuperAdmin] };
const LEADER_OF_A: AuthorizationSubject = {
  userId: REVIEWER,
  roles: [Role.GroupLeader],
  groupIds: [GROUP_A],
};
const LEADER_OF_BOTH: AuthorizationSubject = {
  userId: REVIEWER,
  roles: [Role.GroupLeader],
  groupIds: [GROUP_A, GROUP_B],
};
const STUDENT: AuthorizationSubject = { userId: APPLICANT, roles: [Role.Student] };

function pendingApplication(overrides: Partial<Application> = {}): Application {
  return {
    id: APPLICATION_ID,
    userId: APPLICANT,
    groupId: GROUP_A,
    kind: ApplicationKind.Join,
    note: '希望加入',
    status: ApplicationStatus.Pending,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 记录型假仓储：只记录调用与参数，不实现任何策略（策略全在 service 与 guard 里） */
class RecordingRepository implements ApplicationReviewRepository {
  readonly capabilities = {
    backend: 'fake-recording',
    persistent: false,
    productionReady: false,
  } as const;

  readonly listScopes: ApplicationReviewScope[] = [];
  readonly findCalls: { applicationId: string; scope: ApplicationReviewScope }[] = [];
  readonly saveCalls: { record: Application; scope: ApplicationReviewScope }[] = [];

  listResult: Application[] = [];
  findResult: Application | undefined;
  saveError: Error | undefined;
  saveTransform: ((record: Application) => Application) | undefined;

  listForReview(scope: ApplicationReviewScope): Promise<readonly Application[]> {
    this.listScopes.push(scope);
    return Promise.resolve(this.listResult);
  }

  findForReview(
    applicationId: string,
    scope: ApplicationReviewScope,
  ): Promise<Application | undefined> {
    this.findCalls.push({ applicationId, scope });
    return Promise.resolve(this.findResult);
  }

  saveReviewed(application: Application, scope: ApplicationReviewScope): Promise<Application> {
    this.saveCalls.push({ record: application, scope });
    if (this.saveError) return Promise.reject(this.saveError);
    return Promise.resolve(this.saveTransform ? this.saveTransform(application) : application);
  }
}

function serviceWith(repository: RecordingRepository): ApplicationReviewsService {
  return new ApplicationReviewsService(new PolicyBackedGuard(), repository);
}

async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出异常，但没有');
}

/** 取唯一一次审核写入的入参（同时断言确实只写了一次） */
function onlySave(repository: RecordingRepository): {
  record: Application;
  scope: ApplicationReviewScope;
} {
  expect(repository.saveCalls).toHaveLength(1);
  return repository.saveCalls[0] as { record: Application; scope: ApplicationReviewScope };
}

describe('ApplicationReviewsService：范围只来自服务端主体', () => {
  it('全局审核者（super_admin）得到 global 范围', async () => {
    const repository = new RecordingRepository();
    await serviceWith(repository).listApplications(SUPER_ADMIN, {});

    expect(repository.listScopes).toEqual([{ kind: 'global' }]);
  });

  it('小组负责人只得到「服务端已验证且确实授权」的小组，而非客户端提交的小组', async () => {
    const repository = new RecordingRepository();
    await serviceWith(repository).listApplications(LEADER_OF_BOTH, {});

    expect(repository.listScopes).toEqual([{ kind: 'groups', groupIds: [GROUP_A, GROUP_B] }]);
  });

  it('无审核权限的主体（学生）：403，且**不触碰仓储**', async () => {
    const repository = new RecordingRepository();
    const error = await rejectionOf(() => serviceWith(repository).listApplications(STUDENT, {}));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toBe(AUTHORIZATION_FORBIDDEN_MESSAGE);
    expect(repository.listScopes).toEqual([]);
  });

  it('授权先于校验：未授权主体 + 非法查询参数 → 403（而不是 400）', async () => {
    const repository = new RecordingRepository();
    const error = await rejectionOf(() =>
      // 这个查询参数本身也会让已授权主体拿到 400；未授权时必须先是 403
      serviceWith(repository).listApplications(STUDENT, { groupId: 'not-a-uuid' }),
    );

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(repository.listScopes).toEqual([]);
  });

  it('授权先于校验：未授权主体 + 服务端字段注入请求体 → 403（而不是 400）', async () => {
    const repository = new RecordingRepository();
    const error = await rejectionOf(() =>
      serviceWith(repository).reviewApplication(STUDENT, APPLICATION_ID, {
        decision: 'approve',
        status: ApplicationStatus.Approved,
        roles: [Role.SuperAdmin],
        userId: REVIEWER,
        scope: DataScope.Global,
      }),
    );

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(repository.findCalls).toEqual([]);
    expect(repository.saveCalls).toEqual([]);
  });
});

describe('ApplicationReviewsService：查询参数闭集与范围收窄', () => {
  it('未声明的查询参数一律 400，且不触碰仓储', async () => {
    const repository = new RecordingRepository();
    const error = await rejectionOf(() =>
      serviceWith(repository).listApplications(LEADER_OF_A, { status: 'pending' }),
    );

    expect(error).toBeInstanceOf(ZodError);
    expect(repository.listScopes).toEqual([]);
  });

  it('客户端 groupId 收敛为单个小组（在服务端范围之内）', async () => {
    const repository = new RecordingRepository();
    await serviceWith(repository).listApplications(LEADER_OF_BOTH, { groupId: GROUP_B });

    expect(repository.listScopes).toEqual([{ kind: 'groups', groupIds: [GROUP_B] }]);
  });

  it('客户端 groupId 落在服务端范围之外 → 403，绝不放宽范围', async () => {
    const repository = new RecordingRepository();
    const error = await rejectionOf(() =>
      serviceWith(repository).listApplications(LEADER_OF_A, { groupId: GROUP_OUTSIDE }),
    );

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(repository.listScopes).toEqual([]);
  });

  it('全局审核者可以把自己收窄到某个小组（收窄不是扩张）', async () => {
    const repository = new RecordingRepository();
    await serviceWith(repository).listApplications(SUPER_ADMIN, { groupId: GROUP_OUTSIDE });

    expect(repository.listScopes).toEqual([{ kind: 'groups', groupIds: [GROUP_OUTSIDE] }]);
  });

  it('groupId 形状非法（即使已授权）→ 400，且不触碰仓储', async () => {
    const repository = new RecordingRepository();
    const error = await rejectionOf(() =>
      serviceWith(repository).listApplications(SUPER_ADMIN, { groupId: 'not-a-uuid' }),
    );

    expect(error).toBeInstanceOf(ZodError);
    expect(repository.listScopes).toEqual([]);
  });
});

describe('ApplicationReviewsService：审核动作的输入闭集', () => {
  const forbidden: Record<string, unknown> = {
    status: ApplicationStatus.Approved,
    reviewStatus: 'approved',
    userId: APPLICANT,
    applicantId: APPLICANT,
    roles: [Role.SuperAdmin],
    scope: DataScope.Global,
    groupId: GROUP_B,
    groupIds: [GROUP_B],
    permissions: ['*'],
    reviewedByUserId: APPLICANT,
    reviewedAt: '2026-05-02T00:00:00.000Z',
    kind: ApplicationKind.Leave,
  };

  for (const [field, value] of Object.entries(forbidden)) {
    it(`客户端提交 ${field} → 400，且授权与仓储都不受影响`, async () => {
      const repository = new RecordingRepository();
      const error = await rejectionOf(() =>
        serviceWith(repository).reviewApplication(LEADER_OF_A, APPLICATION_ID, {
          decision: 'approve',
          [field]: value,
        }),
      );

      expect(error).toBeInstanceOf(ZodError);
      expect(repository.findCalls).toEqual([]);
      expect(repository.saveCalls).toEqual([]);
    });
  }

  it('未声明的任意字段 → 400', async () => {
    const repository = new RecordingRepository();
    const error = await rejectionOf(() =>
      serviceWith(repository).reviewApplication(LEADER_OF_A, APPLICATION_ID, {
        decision: 'approve',
        whatever: 1,
      }),
    );

    expect(error).toBeInstanceOf(ZodError);
    expect(repository.saveCalls).toEqual([]);
  });
});

describe('ApplicationReviewsService：审核写入由服务端决定', () => {
  it('通过：状态 approved、审核人取会话主体、记录不变字段逐字段沿用存储值', async () => {
    const repository = new RecordingRepository();
    repository.findResult = pendingApplication();
    const reviewed = await serviceWith(repository).reviewApplication(LEADER_OF_A, APPLICATION_ID, {
      decision: 'approve',
    });

    expect(repository.saveCalls).toHaveLength(1);
    const { record, scope } = onlySave(repository);
    expect(scope).toEqual({ kind: 'groups', groupIds: [GROUP_A] });
    expect(record.status).toBe(ApplicationStatus.Approved);
    expect(record.reviewedByUserId).toBe(REVIEWER);
    expect(record.reviewComment).toBeUndefined();
    expect(record.id).toBe(APPLICATION_ID);
    expect(record.userId).toBe(APPLICANT);
    expect(record.groupId).toBe(GROUP_A);
    expect(record.kind).toBe(ApplicationKind.Join);
    expect(record.note).toBe('希望加入');
    expect(record.createdAt).toBe('2026-05-01T00:00:00.000Z');
    expect(reviewed.status).toBe(ApplicationStatus.Approved);
    expect(reviewed.applicantUserId).toBe(APPLICANT);
  });

  it('驳回：必须带审核意见；带上后写入 reviewComment', async () => {
    const repository = new RecordingRepository();
    repository.findResult = pendingApplication();

    const missing = await rejectionOf(() =>
      serviceWith(repository).reviewApplication(LEADER_OF_A, APPLICATION_ID, {
        decision: 'reject',
      }),
    );
    expect(missing).toBeInstanceOf(ZodError);
    expect(repository.saveCalls).toEqual([]);

    await serviceWith(repository).reviewApplication(LEADER_OF_A, APPLICATION_ID, {
      decision: 'reject',
      comment: '材料不完整',
    });
    const { record } = onlySave(repository);
    expect(record.status).toBe(ApplicationStatus.Rejected);
    expect(record.reviewComment).toBe('材料不完整');
  });

  it('客户端提交的审核人/意见不影响服务端写入的审核人', async () => {
    const repository = new RecordingRepository();
    repository.findResult = pendingApplication();

    // reviewerId 属于闭集之外的字段：这里只验证「即使被塞进 comment 也进不了 reviewedByUserId」
    await serviceWith(repository).reviewApplication(LEADER_OF_A, APPLICATION_ID, {
      decision: 'approve',
      comment: 'ok',
    });

    const { record } = onlySave(repository);
    expect(record.reviewedByUserId).toBe(REVIEWER);
    expect(record.reviewedByUserId).not.toBe(APPLICANT);
  });

  it('范围外的记录（仓储异常返回）→ 403 决定性命中，且不写入', async () => {
    const repository = new RecordingRepository();
    // 仓储无视范围谓词，返回了一条小组归属在范围外的记录
    repository.findResult = pendingApplication({ groupId: GROUP_OUTSIDE });

    const error = await rejectionOf(() =>
      serviceWith(repository).reviewApplication(LEADER_OF_A, APPLICATION_ID, {
        decision: 'approve',
      }),
    );

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toBe(AUTHORIZATION_FORBIDDEN_MESSAGE);
    expect(repository.saveCalls).toEqual([]);
  });

  it('范围外/不存在（仓储返回 undefined）→ 404，且不泄露存在性', async () => {
    const repository = new RecordingRepository();
    repository.findResult = undefined;

    const error = await rejectionOf(() =>
      serviceWith(repository).reviewApplication(LEADER_OF_A, APPLICATION_ID, {
        decision: 'approve',
      }),
    );

    expect(error).toBeInstanceOf(NotFoundException);
    expect(repository.saveCalls).toEqual([]);
  });

  it('非 pending 状态（已被审核）→ 409 状态转移无效', async () => {
    const repository = new RecordingRepository();
    repository.findResult = pendingApplication({ status: ApplicationStatus.Approved });

    const error = await rejectionOf(() =>
      serviceWith(repository).reviewApplication(LEADER_OF_A, APPLICATION_ID, {
        decision: 'approve',
      }),
    );

    expect(error).toBeInstanceOf(StateTransitionError);
    expect(repository.saveCalls).toEqual([]);
  });

  it('仓储并发冲突 → 409（而不是 500）', async () => {
    const repository = new RecordingRepository();
    repository.findResult = pendingApplication();
    repository.saveError = new ApplicationReviewConflictError('并发');

    const error = await rejectionOf(() =>
      serviceWith(repository).reviewApplication(LEADER_OF_A, APPLICATION_ID, {
        decision: 'approve',
      }),
    );

    expect(error).toBeInstanceOf(StateTransitionError);
  });

  it('存储记录违反读取契约 → 500（不把未知状态当合法值返回）', async () => {
    const repository = new RecordingRepository();
    repository.findResult = { ...pendingApplication(), status: 'unknown-status' } as never;

    const error = await rejectionOf(() =>
      serviceWith(repository).reviewApplication(LEADER_OF_A, APPLICATION_ID, {
        decision: 'approve',
      }),
    );

    expect(error).toBeInstanceOf(InternalServerErrorException);
  });

  it('全局审核者审任意小组的记录都通过（GLOBAL 能力）', async () => {
    const repository = new RecordingRepository();
    repository.findResult = pendingApplication({ groupId: GROUP_OUTSIDE });

    await serviceWith(repository).reviewApplication(SUPER_ADMIN, APPLICATION_ID, {
      decision: 'approve',
    });

    expect(repository.findCalls[0]?.scope).toEqual({ kind: 'global' });
    expect(repository.saveCalls).toHaveLength(1);
  });

  it('全局审核者的写入 scope 保持 global（不因记录小组而改写范围）', async () => {
    const repository = new RecordingRepository();
    repository.findResult = pendingApplication({ groupId: GROUP_OUTSIDE });

    await serviceWith(repository).reviewApplication(SUPER_ADMIN, APPLICATION_ID, {
      decision: 'approve',
    });

    expect(repository.saveCalls[0]?.scope).toEqual({ kind: 'global' });
  });

  it('路径参数非法 → 400，且不触碰仓储', async () => {
    const repository = new RecordingRepository();
    const error = await rejectionOf(() =>
      serviceWith(repository).reviewApplication(LEADER_OF_A, 'not-a-uuid', {
        decision: 'approve',
      }),
    );

    expect(error).toBeInstanceOf(ZodError);
    expect(repository.findCalls).toEqual([]);
  });
});
