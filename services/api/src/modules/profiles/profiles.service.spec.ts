import 'reflect-metadata';
import {
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AvailablePeriod, Grade, ProgrammingLevel, Role } from '@rm/shared';
import type { AuthorizationRequest } from '@rm/shared';
import { ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTHORIZATION_FORBIDDEN_MESSAGE,
  AuthorizationGuard,
} from '../access-control/authorization-guard';
import { AuthorizationPolicy } from '../access-control/authorization-policy';
import { BaselineRuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.baseline';
import type { AuthorizationDecision, RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import type { ProfileRepository, StudentProfile } from './student-profile.port';
import { ProfilesService } from './profiles.service';

/**
 * 服务层回归（不启 HTTP）：把「判定入参来自服务端」「**授权先于取数**」「未知字段与身份/权限字段
 * fail-closed」「存储异常不当作正常输出」「输出不含高敏感字段与隐私同意快照」五条约束固定在
 * service 这一层，避免它们只靠 HTTP 用例间接覆盖。
 */

const policy = new AuthorizationPolicy();
const guard = new AuthorizationGuard(new BaselineRuoYiAuthzAdapter(policy));

/** 画像仓储替身：只实现端口语义，不引入第二套授权或校验规则 */
class StubProfileRepository implements ProfileRepository {
  readonly capabilities = {
    backend: 'stub',
    persistent: false,
    productionReady: false,
  } as const;

  readonly saved: StudentProfile[] = [];
  private readonly profiles = new Map<string, StudentProfile>();

  /**
   * 缺陷注入：模拟「仓储返回归属不符/归属缺失/已损坏的记录」。
   * 这是唯一能让 `/me/profile` 的 SELF 判定真正拒绝的路径（正常仓储只会返回本人记录）。
   */
  lookupOverride?: (userId: string) => StudentProfile | undefined;

  constructor(seed: readonly StudentProfile[] = []) {
    for (const profile of seed) this.profiles.set(profile.userId, profile);
  }

  findByUserId(userId: string): StudentProfile | undefined {
    const overridden = this.lookupOverride?.(userId);
    if (overridden) return overridden;
    return this.profiles.get(userId);
  }

  save(profile: StudentProfile): StudentProfile {
    this.saved.push(profile);
    this.profiles.set(profile.userId, profile);
    return profile;
  }
}

/** 仓储替身：写回时把记录改坏，用于验证「输出/写回前再校验一次」不依赖仓储的自觉 */
class TamperingProfileRepository extends StubProfileRepository {
  override save(profile: StudentProfile): StudentProfile {
    return { ...super.save(profile), grade: 'tampered' as Grade };
  }
}

const FIXTURE_NOW = '2026-01-01T00:00:00.000Z';
const STUDENT_NO_1 = '2023123456';
const PHONE_1 = '13800138000';

function profileFixture(overrides: Partial<StudentProfile> = {}): StudentProfile {
  return {
    userId: 'u-student-1',
    name: '张三',
    studentNo: STUDENT_NO_1,
    college: '计算机学院',
    major: '软件工程',
    grade: Grade.Junior,
    phone: PHONE_1,
    skills: ['TypeScript', 'SQL'],
    programmingLevel: ProgrammingLevel.Intermediate,
    researchExperience: '参与过校级科研项目',
    availableTime: { weeklyHours: 10, periods: [AvailablePeriod.Weekend] },
    researchInterests: ['机器学习'],
    strengths: '沟通与文档能力',
    intendedFields: ['人工智能'],
    privacyConsent: { policyVersion: 'v1.0', consentedAt: FIXTURE_NOW },
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

const student = { userId: 'u-student-1', roles: [Role.Student] } as const;

function serviceWith(repository: ProfileRepository): ProfilesService {
  return new ProfilesService(guard, repository);
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出异常，但没有抛出');
}

describe('ProfilesService：判定入参只来自服务端', () => {
  it('更新：只改提交字段，归属与创建时间 immutable，updatedAt 由服务端时间决定', () => {
    const repository = new StubProfileRepository([profileFixture()]);
    const service = serviceWith(repository);

    const view = service.updateMyProfile(student, { college: '数学学院', skills: ['Rust'] });

    expect(repository.saved).toHaveLength(1);
    const saved = repository.saved[0];
    expect(saved?.userId).toBe('u-student-1');
    expect(saved?.createdAt).toBe(FIXTURE_NOW);
    expect(saved?.updatedAt).not.toBe(FIXTURE_NOW);
    expect(saved?.college).toBe('数学学院');
    expect(saved?.skills).toEqual(['Rust']);
    // 未提交字段保持原值；高敏感字段沿用存储值
    expect(saved?.name).toBe('张三');
    expect(saved?.studentNo).toBe(STUDENT_NO_1);
    expect(saved?.phone).toBe(PHONE_1);
    expect(view.college).toBe('数学学院');
    expect(view.updatedAt).toBe(saved?.updatedAt);
  });

  it('取数与判定都走服务端：resourceUserId 取会话主体，存储归属不符即 403', () => {
    const repository = new StubProfileRepository([profileFixture()]);
    repository.lookupOverride = () => profileFixture({ userId: 'u-student-2', name: '李四' });
    const realAdapter = new BaselineRuoYiAuthzAdapter(policy);
    const requests: AuthorizationRequest[] = [];
    const recording: RuoYiAuthzAdapter = {
      capabilities: realAdapter.capabilities,
      checkAuthorization: (subject, request): AuthorizationDecision => {
        requests.push(request);
        return realAdapter.checkAuthorization(subject, request);
      },
      checkGrant: (): AuthorizationDecision => ({ allowed: false, reason: 'policy-denied' }),
    };
    const service = new ProfilesService(new AuthorizationGuard(recording), repository);

    for (const run of [
      () => service.getMyProfile(student),
      () => service.updateMyProfile(student, { college: '数学学院' }),
    ]) {
      const error = captureError(run);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getStatus()).toBe(403);
      // 归属不符与授权拒绝共用同一文案：调用方无法区分原因
      expect((error as ForbiddenException).message).toBe(AUTHORIZATION_FORBIDDEN_MESSAGE);
      // 拒绝原因不暴露给客户端
      expect(JSON.stringify((error as ForbiddenException).getResponse())).not.toMatch(
        /unknown-|policy-denied/u,
      );
    }
    // 授权入参只来自服务端：resourceUserId 是会话主体（不是存储归属，更不是请求体）
    expect(requests).toEqual([
      { permission: 'profile:self:read', scope: 'SELF', resourceUserId: 'u-student-1' },
      { permission: 'profile:self:update', scope: 'SELF', resourceUserId: 'u-student-1' },
    ]);
    expect(repository.saved).toHaveLength(0);
  });

  it('存储归属不可读（空归属）时按 403 处理，不退化成放行', () => {
    const repository = new StubProfileRepository();
    repository.lookupOverride = () => profileFixture({ userId: '' });
    const service = serviceWith(repository);

    expect(captureError(() => service.getMyProfile(student))).toBeInstanceOf(ForbiddenException);
  });

  it('经端口判定：端口拒绝时即使仓储有数据也 403，且不写入；拒绝发生在取数之前', () => {
    const denying: RuoYiAuthzAdapter = {
      capabilities: new BaselineRuoYiAuthzAdapter(policy).capabilities,
      checkAuthorization: (): AuthorizationDecision => ({
        allowed: false,
        reason: 'policy-denied',
      }),
      checkGrant: (): AuthorizationDecision => ({ allowed: false, reason: 'policy-denied' }),
    };
    const repository = new StubProfileRepository([profileFixture()]);
    const findByUserId = vi.spyOn(repository, 'findByUserId');
    const service = new ProfilesService(new AuthorizationGuard(denying), repository);

    expect(captureError(() => service.getMyProfile(student))).toBeInstanceOf(ForbiddenException);
    expect(
      captureError(() => service.updateMyProfile(student, { college: '数学学院' })),
    ).toBeInstanceOf(ForbiddenException);
    expect(repository.saved).toHaveLength(0);
    // 授权先行：拒绝时不得访问仓储（调用方连资源是否存在都观察不到）
    expect(findByUserId).not.toHaveBeenCalled();
  });

  it('未登记角色 / 空 userId 的主体一律 403（fail-closed），且排在 404 之前', () => {
    // 存储里没有任何画像：若先取数就会得到 404，这里必须是 403，证明授权先于取数
    const repository = new StubProfileRepository();
    const findByUserId = vi.spyOn(repository, 'findByUserId');
    const service = serviceWith(repository);

    expect(
      captureError(() => service.getMyProfile({ userId: 'u-x', roles: ['guest' as Role] })),
    ).toBeInstanceOf(ForbiddenException);
    expect(
      captureError(() =>
        service.getMyProfile({ userId: 'u-x', roles: [Role.Student, 'guest' as Role] }),
      ),
    ).toBeInstanceOf(ForbiddenException);
    expect(
      captureError(() => service.getMyProfile({ userId: '', roles: [Role.Student] })),
    ).toBeInstanceOf(ForbiddenException);
    expect(findByUserId).not.toHaveBeenCalled();
  });

  it('尚无画像 → 404（读取与更新一致），且不触发写入', () => {
    const repository = new StubProfileRepository();
    const service = serviceWith(repository);

    expect(captureError(() => service.getMyProfile(student))).toBeInstanceOf(NotFoundException);
    expect(
      captureError(() => service.updateMyProfile(student, { college: '数学学院' })),
    ).toBeInstanceOf(NotFoundException);
    expect(repository.saved).toHaveLength(0);
  });
});

describe('ProfilesService：输入闭集与字段校验（fail-closed）', () => {
  it('未声明字段（roles/scope/groupId/userId/reviewStatus）→ ZodError，且不写库', () => {
    const repository = new StubProfileRepository([profileFixture()]);
    const service = serviceWith(repository);

    const error = captureError(() =>
      service.updateMyProfile(student, {
        college: '数学学院',
        roles: [Role.SuperAdmin],
        scope: 'GLOBAL',
        groupId: 'g-1',
        userId: 'u-victim-1',
        reviewStatus: 'approved',
      }),
    );

    expect(error).toBeInstanceOf(ZodError);
    const issues = (error as ZodError).issues;
    const byPath = new Map(issues.map((issue) => [issue.path.join('.'), issue.message]));
    for (const key of ['roles', 'scope', 'groupId', 'userId', 'reviewStatus']) {
      expect(byPath.has(key)).toBe(true);
    }
    // 身份/权限字段有可区分的拒绝原因
    expect(byPath.get('userId')).toContain('身份/权限字段');
    expect(byPath.get('roles')).toContain('身份/权限字段');
    expect(byPath.get('reviewStatus')).toContain('身份/权限字段');
    expect(repository.saved).toHaveLength(0);
  });

  it('非法字段值：未知枚举、越界、未同意隐私政策、空对象、非对象请求体 → ZodError', () => {
    const repository = new StubProfileRepository([profileFixture()]);
    const service = serviceWith(repository);

    const cases: unknown[] = [
      { grade: 'unknown_grade' },
      { programmingLevel: 'expert' },
      { availableTime: { weeklyHours: 200, periods: ['weekend'] } },
      { availableTime: { weeklyHours: 10, periods: [] } },
      { privacyConsent: { policyVersion: 'v1.0', agreed: false } },
      { phone: '12345' },
      { studentNo: '!!' },
      { researchExperience: '身份证 11010119900307617X' },
      {},
      [],
      'not-an-object',
      null,
    ];

    for (const body of cases) {
      expect(captureError(() => service.updateMyProfile(student, body))).toBeInstanceOf(ZodError);
    }
    expect(repository.saved).toHaveLength(0);
  });

  it('授权先于字段校验：无权主体得到 403，而不是拿到校验结果', () => {
    const denying: RuoYiAuthzAdapter = {
      capabilities: new BaselineRuoYiAuthzAdapter(policy).capabilities,
      checkAuthorization: (): AuthorizationDecision => ({
        allowed: false,
        reason: 'unknown-permission',
      }),
      checkGrant: (): AuthorizationDecision => ({ allowed: false, reason: 'unknown-permission' }),
    };
    const repository = new StubProfileRepository([profileFixture()]);
    const service = new ProfilesService(new AuthorizationGuard(denying), repository);

    const error = captureError(() =>
      service.updateMyProfile(student, { grade: 'unknown_grade', roles: [Role.SuperAdmin] }),
    );

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(repository.saved).toHaveLength(0);
  });
});

describe('ProfilesService：存储异常与输出边界 fail-closed', () => {
  it('存储枚举未登记 → 500，且异常不携带原始取值，也不写回', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const repository = new StubProfileRepository([
      profileFixture({ grade: 'unknown_grade' as Grade, college: '受损记录学院' }),
    ]);
    const service = serviceWith(repository);

    const error = captureError(() => service.getMyProfile(student));

    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect((error as InternalServerErrorException).getStatus()).toBe(500);
    expect(JSON.stringify((error as InternalServerErrorException).getResponse())).not.toContain(
      'unknown_grade',
    );
    expect(JSON.stringify(error)).not.toContain('受损记录学院');
    expect(Logger.prototype.error).toHaveBeenCalled();

    expect(
      captureError(() => service.updateMyProfile(student, { college: '数学学院' })),
    ).toBeInstanceOf(InternalServerErrorException);
    expect(repository.saved).toHaveLength(0);
  });

  it('仓储写回时改坏记录 → 500（输出前再校验一次，不依赖仓储的自觉）', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const repository = new TamperingProfileRepository([profileFixture()]);
    const service = serviceWith(repository);

    expect(
      captureError(() => service.updateMyProfile(student, { college: '数学学院' })),
    ).toBeInstanceOf(InternalServerErrorException);
  });

  it('对外视图不含归属、高敏感字段与隐私同意快照：序列化结果里没有 userId/学号/联系方式/同意记录', () => {
    const repository = new StubProfileRepository([profileFixture()]);
    const service = serviceWith(repository);

    const view = service.getMyProfile(student);
    const serialized = JSON.stringify(view);

    expect(Object.keys(view).sort()).toEqual([
      'availableTime',
      'college',
      'createdAt',
      'grade',
      'intendedFields',
      'major',
      'name',
      'programmingLevel',
      'researchExperience',
      'researchInterests',
      'skills',
      'strengths',
      'updatedAt',
    ]);
    expect(serialized).not.toContain('u-student-1');
    expect(serialized).not.toContain(STUDENT_NO_1);
    expect(serialized).not.toContain(PHONE_1);
    // 隐私同意快照（政策版本 + 同意时间）只写不读：既不出现键，也不出现取值
    expect(Object.keys(view)).not.toContain('privacyConsent');
    expect(serialized).not.toContain('policyVersion');
    expect(serialized).not.toContain('consentedAt');
    expect(serialized).not.toContain('v1.0');
  });

  it('空串清空可选文本，隐私同意时间由服务端决定（只写入存储，不进入视图）', () => {
    const repository = new StubProfileRepository([profileFixture()]);
    const service = serviceWith(repository);

    const cleared = service.updateMyProfile(student, { researchExperience: '' });
    expect(cleared.researchExperience).toBeUndefined();
    expect(Object.keys(cleared)).not.toContain('researchExperience');
    expect(repository.findByUserId('u-student-1')?.researchExperience).toBeUndefined();

    const consented = service.updateMyProfile(student, {
      privacyConsent: { policyVersion: 'v1.2', agreed: true },
    });
    expect(Object.keys(consented)).not.toContain('privacyConsent');

    const stored = repository.findByUserId('u-student-1');
    expect(stored?.privacyConsent.policyVersion).toBe('v1.2');
    const consentedAt = stored?.privacyConsent.consentedAt ?? '';
    expect(new Date(consentedAt).toISOString()).toBe(consentedAt);
  });
});
