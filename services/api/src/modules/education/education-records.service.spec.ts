import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';
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
 * 「存储异常不当作正常输出」三条约束固定在 service 这一层，
 * 避免它们只靠 HTTP 用例间接覆盖。
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
  private readonly records = new Map<string, EducationRecord>();

  constructor(seed: readonly EducationRecord[] = []) {
    for (const record of seed) this.records.set(record.id, record);
  }

  create(record: EducationRecord): EducationRecord {
    this.created.push(record);
    this.records.set(record.id, record);
    return record;
  }

  findById(recordId: string): EducationRecord | undefined {
    return this.records.get(recordId);
  }

  listByUserId(userId: string): readonly EducationRecord[] {
    return [...this.records.values()].filter((record) => record.userId === userId);
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

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出异常，但没有抛出');
}

describe('EducationRecordsService：判定入参只来自服务端', () => {
  it('创建：归属与审核态由服务端补齐，权限点/范围是服务端常量', () => {
    const repository = new StubEducationRecordRepository();
    const service = serviceWith(repository);

    const view = service.createMyRecord(student, { ...validBody });

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

  it('单条读取：resourceUserId 取存储归属，范围固定为 SELF，跨用户即 403', () => {
    const others = record({ userId: 'u-student-2' });
    const repository = new StubEducationRecordRepository([others]);
    const service = serviceWith(repository);

    const error = captureError(() => service.getMyRecord(student, others.id));
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getStatus()).toBe(403);
    // 拒绝原因不暴露给客户端
    expect(JSON.stringify((error as ForbiddenException).getResponse())).not.toMatch(
      /unknown-|policy-denied/u,
    );
  });

  it('列表：只按服务端主体取数，绝不返回他人记录', () => {
    const repository = new StubEducationRecordRepository([
      record({ userId: 'u-student-1' }),
      record({ userId: 'u-student-2', institutionOrDestination: '他人大学' }),
    ]);
    const service = serviceWith(repository);

    const items = service.listMyRecords(student);

    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain('他人大学');
  });

  it('经端口判定：端口拒绝时即使仓储有数据也 403', () => {
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

    expect(captureError(() => service.listMyRecords(student))).toBeInstanceOf(ForbiddenException);
  });
});

describe('EducationRecordsService：输入闭集与字段校验（fail-closed）', () => {
  it('未声明字段（roles/scope/groupId/userId）→ ZodError，且不落库、不执行授权后逻辑', () => {
    const repository = new StubEducationRecordRepository();
    const service = serviceWith(repository);

    const error = captureError(() =>
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

  it('未知枚举/越界/已录取缺院校 → ZodError（共享 zod schema 拒绝）', () => {
    const repository = new StubEducationRecordRepository();
    const service = serviceWith(repository);

    const cases: unknown[] = [
      { ...validBody, status: 'unknown_status' },
      { ...validBody, type: 'unknown_type' },
      { ...validBody, year: 1999 },
      { year: 2026, type: EducationType.Postgraduate, status: EducationStatus.Admitted },
    ];

    for (const body of cases) {
      expect(captureError(() => service.createMyRecord(student, body))).toBeInstanceOf(ZodError);
    }
    expect(repository.created).toHaveLength(0);
  });

  it('授权先于字段校验：无权限角色得到 403，而不是拿到校验结果', () => {
    const repository = new StubEducationRecordRepository();
    const service = serviceWith(repository);
    const admin = { userId: 'u-admin-1', roles: [Role.Admin] } as const;

    const error = captureError(() => service.createMyRecord(admin, { status: 'unknown_status' }));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(repository.created).toHaveLength(0);
  });

  it('未登记角色的主体一律 403（fail-closed，不因“认识部分角色”而放行）', () => {
    const repository = new StubEducationRecordRepository();
    const service = serviceWith(repository);

    expect(
      captureError(() => service.listMyRecords({ userId: 'u-x', roles: ['guest' as Role] })),
    ).toBeInstanceOf(ForbiddenException);
    expect(
      captureError(() =>
        service.listMyRecords({ userId: 'u-x', roles: [Role.Student, 'guest' as Role] }),
      ),
    ).toBeInstanceOf(ForbiddenException);
    expect(
      captureError(() => service.listMyRecords({ userId: '', roles: [Role.Student] })),
    ).toBeInstanceOf(ForbiddenException);
  });

  it('非法记录 ID → ZodError（不进仓储、不做归属判定）', () => {
    const repository = new StubEducationRecordRepository();
    const service = serviceWith(repository);

    expect(captureError(() => service.getMyRecord(student, 'not-a-uuid'))).toBeInstanceOf(ZodError);
  });
});

describe('EducationRecordsService：存储异常 fail-closed', () => {
  it('存储枚举未登记 → 500，且异常不携带原始取值', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const corrupted = record({
      status: 'unknown_status' as EducationStatus,
      institutionOrDestination: '受损记录大学',
    });
    const service = serviceWith(new StubEducationRecordRepository([corrupted]));

    const error = captureError(() => service.getMyRecord(student, corrupted.id));

    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect((error as InternalServerErrorException).getStatus()).toBe(500);
    expect(JSON.stringify((error as InternalServerErrorException).getResponse())).not.toContain(
      'unknown_status',
    );
    expect(JSON.stringify(error)).not.toContain('受损记录大学');
    expect(Logger.prototype.error).toHaveBeenCalled();
  });

  it('列表中出现损坏记录同样 500，不静默跳过（避免“少一条也不知道”）', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = serviceWith(
      new StubEducationRecordRepository([
        record({ userId: 'u-student-1' }),
        record({ userId: 'u-student-1', reviewStatus: 'unknown_review' as ReviewStatus }),
      ]),
    );

    const error = captureError(() => service.listMyRecords(student));
    expect(error).toBeInstanceOf(InternalServerErrorException);
  });

  it('响应视图不包含归属字段，且未知归属按 403 处理（不会退化成放行）', () => {
    const orphan = record({ userId: '' as string });
    const service = serviceWith(new StubEducationRecordRepository([orphan]));

    expect(captureError(() => service.getMyRecord(student, orphan.id))).toBeInstanceOf(
      ForbiddenException,
    );
  });
});
