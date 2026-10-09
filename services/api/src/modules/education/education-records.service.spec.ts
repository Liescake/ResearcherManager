import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataScope, EducationStatus, EducationType, ReviewStatus, Role } from '@rm/shared';
import { ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import { AuthorizationPolicy } from '../access-control/authorization-policy';
import { BaselineRuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.baseline';
import type { AuthorizationDecision, RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import type { EducationRecord, EducationRecordRepository } from './education-records.port';
import { EducationRecordsService } from './education-records.service';

/**
 * 服务层回归（不启 HTTP）：把「判定入参来自服务端」「未知枚举 fail-closed」
 * 「存储异常不当作正常输出」「归属下推到取数」四条约束固定在 service 这一层，
 * 避免它们只靠 HTTP 用例间接覆盖。
 *
 * 端口是异步的（内存基线与 PostgreSQL 实现同一契约），因此这里的替身也按 Promise 语义实现，
 * 并且与真实实现一致地做**归属命中**（`findById(recordId, ownerUserId)`）。
 */

const policy = new AuthorizationPolicy();
const guard = new AuthorizationGuard(new BaselineRuoYiAuthzAdapter(policy));

/** 记录仓储替身：只实现端口语义，不引入第二套授权或校验规则 */
class StubEducationRecordRepository implements EducationRecordRepository {
  readonly capabilities = {
    backend: 'stub',
    persistent: false,
    productionReady: false,
  } as const;

  readonly created: EducationRecord[] = [];
  protected readonly records = new Map<string, EducationRecord>();

  constructor(seed: readonly EducationRecord[] = []) {
    for (const record of seed) this.records.set(record.id, record);
  }

  create(record: EducationRecord): Promise<EducationRecord> {
    this.created.push(record);
    this.records.set(record.id, record);
    return Promise.resolve(record);
  }

  /** 与端口契约一致：只返回「资源 ID 与归属同时命中」的记录 */
  findById(recordId: string, ownerUserId: string): Promise<EducationRecord | undefined> {
    const found = this.records.get(recordId);
    return Promise.resolve(found && found.userId === ownerUserId ? found : undefined);
  }

  listByUserId(userId: string): Promise<readonly EducationRecord[]> {
    return Promise.resolve([...this.records.values()].filter((record) => record.userId === userId));
  }
}

/**
 * **异常仓储**：无视传入的主体，把命中的记录原样返回。
 *
 * 用来验证 service 的**归属二次授权**（纵深防御）：即使仓储没按主体过滤，
 * 他人记录也不会被当成正常输出返回。
 */
class OwnerLeakingEducationRecordRepository extends StubEducationRecordRepository {
  override findById(recordId: string, _ownerUserId: string): Promise<EducationRecord | undefined> {
    return Promise.resolve(this.records.get(recordId));
  }

  override listByUserId(userId: string): Promise<readonly EducationRecord[]> {
    // 连列表也“泄露”：不过滤归属
    void userId;
    return Promise.resolve([...this.records.values()]);
  }
}

const student = { userId: 'u-student-1', roles: [Role.Student] } as const;

const validBody = {
  year: 2026,
  type: EducationType.Postgraduate,
  status: EducationStatus.Admitted,
  institutionOrDestination: '示例大学',
};

function record(overrides: Partial<EducationRecord> = {}): EducationRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: randomUUID(),
    userId: 'u-student-1',
    year: 2026,
    type: EducationType.Postgraduate,
    status: EducationStatus.Admitted,
    institutionOrDestination: '示例大学',
    reviewStatus: ReviewStatus.Approved,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function serviceWith(repository: EducationRecordRepository): EducationRecordsService {
  return new EducationRecordsService(guard, repository);
}

/** 捕获异步抛出的异常（端口是异步的，判定失败表现为 rejected Promise） */
async function captureAsyncError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出异常，但没有抛出');
}

describe('EducationRecordsService：判定入参只来自服务端', () => {
  it('创建：归属与审核态由服务端补齐，权限点/范围是服务端常量', async () => {
    const repository = new StubEducationRecordRepository();
    const service = serviceWith(repository);

    const view = await service.createMyRecord(student, { ...validBody });

    expect(repository.created).toHaveLength(1);
    const stored = repository.created[0];
    expect(stored?.userId).toBe('u-student-1');
    expect(stored?.reviewStatus).toBe(ReviewStatus.Pending);
    expect(stored?.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(stored?.createdAt).toBe(stored?.updatedAt);
    expect(view.institutionOrDestination).toBe('示例大学');
    // 对外视图不含归属字段
    expect(Object.keys(view).sort()).toEqual([
      'createdAt',
      'id',
      'institutionOrDestination',
      'reviewStatus',
      'status',
      'type',
      'updatedAt',
      'year',
    ]);
  });

  it('单条读取：归属下推到取数（入参取服务端主体），他人记录不可见 → 404 且不泄露内容', async () => {
    const others = record({ userId: 'u-student-2', institutionOrDestination: '他人大学' });
    const repository = new StubEducationRecordRepository([others]);
    const service = serviceWith(repository);

    const error = await captureAsyncError(() => service.getMyRecord(student, others.id));

    // 「不存在」与「存在但不属于该主体」不可区分：统一 404，因此他人资源的存在性不可探测
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getStatus()).toBe(404);
    expect(JSON.stringify((error as NotFoundException).getResponse())).not.toContain('他人大学');
  });

  it('单条读取：仓储未按主体过滤（返回他人记录）→ 归属二次授权 403（纵深防御）', async () => {
    const others = record({ userId: 'u-student-2', institutionOrDestination: '他人大学' });
    const service = serviceWith(new OwnerLeakingEducationRecordRepository([others]));

    const error = await captureAsyncError(() => service.getMyRecord(student, others.id));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getStatus()).toBe(403);
    // 拒绝原因不暴露给客户端，也不携带他人记录的任何字段
    expect(JSON.stringify((error as ForbiddenException).getResponse())).not.toMatch(
      /unknown-|policy-denied/u,
    );
    expect(JSON.stringify(error)).not.toContain('他人大学');
  });

  it('列表：只按服务端主体取数，绝不返回他人记录', async () => {
    const repository = new StubEducationRecordRepository([
      record({ userId: 'u-student-1' }),
      record({ userId: 'u-student-2', institutionOrDestination: '他人大学' }),
    ]);
    const service = serviceWith(repository);

    const items = await service.listMyRecords(student);

    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain('他人大学');
  });

  it('列表：异常仓储混入他人记录 → 500（不当作正常输出，也不静默丢弃）', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = serviceWith(
      new OwnerLeakingEducationRecordRepository([
        record({ userId: 'u-student-1' }),
        record({ userId: 'u-student-2', institutionOrDestination: '他人大学' }),
      ]),
    );

    const error = await captureAsyncError(() => service.listMyRecords(student));

    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect(JSON.stringify(error)).not.toContain('他人大学');
  });

  it('经端口判定：端口拒绝时即使仓储有数据也 403', async () => {
    const denying: RuoYiAuthzAdapter = {
      capabilities: new BaselineRuoYiAuthzAdapter(policy).capabilities,
      checkAuthorization: (): AuthorizationDecision => ({
        allowed: false,
        reason: 'policy-denied',
      }),
      checkGrant: (): AuthorizationDecision => ({ allowed: false, reason: 'policy-denied' }),
    };
    const repository = new StubEducationRecordRepository([record()]);
    const service = new EducationRecordsService(new AuthorizationGuard(denying), repository);

    expect(await captureAsyncError(() => service.listMyRecords(student))).toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('EducationRecordsService：输入闭集与字段校验（fail-closed）', () => {
  it('未声明字段（roles/scope/groupId/userId）→ ZodError，且不落库、不执行授权后逻辑', async () => {
    const repository = new StubEducationRecordRepository();
    const service = serviceWith(repository);

    const error = await captureAsyncError(() =>
      service.createMyRecord(student, {
        ...validBody,
        roles: [Role.SuperAdmin],
        scope: DataScope.Global,
        groupId: 'g-1',
        userId: 'u-victim-1',
      }),
    );

    expect(error).toBeInstanceOf(ZodError);
    const messages = (error as ZodError).issues.map((issue) => issue.message).join('|');
    for (const key of ['roles', 'scope', 'groupId', 'userId']) {
      expect(messages).toContain(key);
    }
    expect(repository.created).toHaveLength(0);
  });

  it('未知枚举/越界/已录取缺院校 → ZodError（共享 zod schema 拒绝）', async () => {
    const repository = new StubEducationRecordRepository();
    const service = serviceWith(repository);

    const cases: unknown[] = [
      { ...validBody, status: 'unknown_status' },
      { ...validBody, type: 'unknown_type' },
      { ...validBody, year: 1999 },
      { year: 2026, type: EducationType.Postgraduate, status: EducationStatus.Admitted },
    ];

    for (const body of cases) {
      expect(await captureAsyncError(() => service.createMyRecord(student, body))).toBeInstanceOf(
        ZodError,
      );
    }
    expect(repository.created).toHaveLength(0);
  });

  it('授权先于字段校验：无权限角色得到 403，而不是拿到校验结果', async () => {
    const repository = new StubEducationRecordRepository();
    const service = serviceWith(repository);
    const admin = { userId: 'u-admin-1', roles: [Role.Admin] } as const;

    const error = await captureAsyncError(() =>
      service.createMyRecord(admin, { status: 'unknown_status' }),
    );

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(repository.created).toHaveLength(0);
  });

  it('未登记角色的主体一律 403（fail-closed，不因“认识部分角色”而放行）', async () => {
    const repository = new StubEducationRecordRepository();
    const service = serviceWith(repository);

    expect(
      await captureAsyncError(() =>
        service.listMyRecords({ userId: 'u-x', roles: ['guest' as Role] }),
      ),
    ).toBeInstanceOf(ForbiddenException);
    expect(
      await captureAsyncError(() =>
        service.listMyRecords({ userId: 'u-x', roles: [Role.Student, 'guest' as Role] }),
      ),
    ).toBeInstanceOf(ForbiddenException);
    expect(
      await captureAsyncError(() => service.listMyRecords({ userId: '', roles: [Role.Student] })),
    ).toBeInstanceOf(ForbiddenException);
  });

  it('非法记录 ID → ZodError（不进仓储、不做归属判定）', async () => {
    const repository = new StubEducationRecordRepository();
    const service = serviceWith(repository);

    expect(
      await captureAsyncError(() => service.getMyRecord(student, 'not-a-uuid')),
    ).toBeInstanceOf(ZodError);
  });
});

describe('EducationRecordsService：存储异常 fail-closed', () => {
  it('存储枚举未登记 → 500，且异常不携带原始取值', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const corrupted = record({
      status: 'unknown_status' as EducationStatus,
      institutionOrDestination: '受损记录大学',
    });
    const service = serviceWith(new StubEducationRecordRepository([corrupted]));

    const error = await captureAsyncError(() => service.getMyRecord(student, corrupted.id));

    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect((error as InternalServerErrorException).getStatus()).toBe(500);
    expect(JSON.stringify((error as InternalServerErrorException).getResponse())).not.toContain(
      'unknown_status',
    );
    expect(JSON.stringify(error)).not.toContain('受损记录大学');
    expect(Logger.prototype.error).toHaveBeenCalled();
  });

  it('列表中出现损坏记录同样 500，不静默跳过（避免“少一条也不知道”）', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = serviceWith(
      new StubEducationRecordRepository([
        record({ userId: 'u-student-1' }),
        record({ userId: 'u-student-1', reviewStatus: 'unknown_review' as ReviewStatus }),
      ]),
    );

    const error = await captureAsyncError(() => service.listMyRecords(student));
    expect(error).toBeInstanceOf(InternalServerErrorException);
  });

  it('响应视图不包含归属字段；归属不可读 / 不匹配的记录对主体不可见（404，不放行）', async () => {
    const orphan = record({ userId: '' as string });
    const service = serviceWith(new StubEducationRecordRepository([orphan]));

    const error = await captureAsyncError(() => service.getMyRecord(student, orphan.id));

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getStatus()).toBe(404);
  });

  it('仓储把归属改写成空串（归属不可读）→ 归属二次授权拒绝 403，不退化成放行', async () => {
    const orphan = record({ userId: '' as string });
    const service = serviceWith(new OwnerLeakingEducationRecordRepository([orphan]));

    expect(await captureAsyncError(() => service.getMyRecord(student, orphan.id))).toBeInstanceOf(
      ForbiddenException,
    );
  });
});
