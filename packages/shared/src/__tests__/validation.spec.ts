import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { MAX_PAGE_SIZE } from '../constants';
import { ApiErrorCode } from '../api/error-codes';
import { fail, isApiEnvelope, ok, okPaginated, statusForErrorCode } from '../api/envelope';
import {
  detectHighRiskContent,
  maskIdentifier,
  maskName,
  maskPhone,
  maskStudentNo,
  studentProfileUpdateSchema as exportedStudentProfileUpdateSchema,
} from '../index';
import {
  DEFAULT_ROLE_DATA_SCOPE,
  DataScope,
  PermissionPoint,
  Role,
  canDelegatePermission,
  isPermissionPoint,
} from '../enums/permission';
import { canGrantPermissions, isAuthorized, isAtomicPermission } from '../enums/authorization';
import { Grade } from '../enums/taxonomy';
import { paginationSchema } from '../validation/query';
import { applicationReviewInputSchema } from '../validation/application';
import { educationRecordInputSchema } from '../validation/education-record';
import {
  adminProfileCorrectionSchema,
  studentProfileInputSchema,
  studentProfileUpdateSchema,
} from '../validation/student-profile';

function validProfile(): z.input<typeof studentProfileInputSchema> {
  return {
    name: '张三',
    studentNo: '2023123456',
    college: '计算机学院',
    major: '软件工程',
    grade: Grade.Junior,
    phone: '13800138000',
    skills: ['TypeScript', 'TypeScript', 'SQL'],
    programmingLevel: 'intermediate',
    researchExperience: '参与过校级科研项目',
    competitionExperience: '蓝桥杯省赛二等奖',
    availableTime: { weeklyHours: 10, periods: ['weekend'] },
    researchInterests: ['机器学习'],
    strengths: '沟通与文档能力',
    intendedFields: ['人工智能'],
    privacyConsent: { policyVersion: 'v1.0', agreed: true },
  };
}

describe('学生画像校验', () => {
  it('合法画像通过并去重标签', () => {
    const parsed = studentProfileInputSchema.parse(validProfile());
    expect(parsed.skills).toEqual(['TypeScript', 'SQL']);
  });

  it('未同意隐私政策时拒绝提交', () => {
    const input = { ...validProfile(), privacyConsent: { policyVersion: 'v1.0', agreed: false } };
    expect(studentProfileInputSchema.safeParse(input).success).toBe(false);
  });

  it('长文本中出现身份证号时拒绝', () => {
    const input = { ...validProfile(), researchExperience: '身份证 11010119900307617X 请勿记录' };
    const result = studentProfileInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('联系方式格式非法时拒绝', () => {
    const input = { ...validProfile(), phone: '12345' };
    expect(studentProfileInputSchema.safeParse(input).success).toBe(false);
  });

  it('管理员代改必须填写理由且至少修改一个字段', () => {
    expect(adminProfileCorrectionSchema.safeParse({ reason: '学生申请更正学院信息' }).success).toBe(
      false,
    );
    expect(
      adminProfileCorrectionSchema.safeParse({ major: '计算机科学与技术', reason: '理由太短' })
        .success,
    ).toBe(false);
    expect(
      adminProfileCorrectionSchema.safeParse({
        major: '计算机科学与技术',
        reason: '学生提交申请，管理员核实后更正专业名称',
      }).success,
    ).toBe(true);
  });
});

describe('学生画像更新（PATCH /me/profile 的部分输入）', () => {
  it('接受部分字段，并复用创建 schema 的字段级规则（含标签去重）', () => {
    const parsed = studentProfileUpdateSchema.parse({
      college: '数学学院',
      skills: ['SQL', 'SQL'],
    });
    expect(parsed).toEqual({ college: '数学学院', skills: ['SQL'] });
  });

  it('空对象（没有任何变更字段）被拒绝', () => {
    expect(studentProfileUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('经公共出口导出，且字段集与创建 schema 完全相同（不另起第二套字段/枚举）', () => {
    // 回归：API 层只从包出口引用该 schema，出口漏导出会让 services/api 的 typecheck 直接失败
    expect(exportedStudentProfileUpdateSchema).toBe(studentProfileUpdateSchema);
    const parsed = exportedStudentProfileUpdateSchema.parse(validProfile());
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(studentProfileInputSchema.shape).sort());
  });

  it('字段级规则不放宽：未登记枚举、非法联系方式、未同意隐私政策仍被拒绝', () => {
    expect(studentProfileUpdateSchema.safeParse({ grade: 'unknown_grade' }).success).toBe(false);
    expect(studentProfileUpdateSchema.safeParse({ phone: '12345' }).success).toBe(false);
    expect(
      studentProfileUpdateSchema.safeParse({
        privacyConsent: { policyVersion: 'v1.0', agreed: false },
      }).success,
    ).toBe(false);
  });

  it('未知字段被静默剥离：因此「不得携带未声明字段」必须由 API 层闭集门禁拒绝', () => {
    const parsed = studentProfileUpdateSchema.parse({
      college: '数学学院',
      roles: ['super_admin'],
    });
    expect(parsed).toEqual({ college: '数学学院' });
    expect(Object.keys(parsed)).not.toContain('roles');
  });
});

describe('敏感内容检测与脱敏', () => {
  it('命中结果不回显原文', () => {
    const findings = detectHighRiskContent('card 6222020200112233445');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.maskedSample).not.toContain('6222020200112233445');
    expect(findings[0]?.maskedSample).toContain('***');
  });

  it('掩码函数不泄露明文', () => {
    expect(maskPhone('13800138000')).toBe('138****8000');
    expect(maskStudentNo('2023123456')).not.toContain('123456');
    expect(maskName('张三')).toBe('张*');
    expect(maskIdentifier('openid_abcdefghijklmn')).toContain('***');
  });
});

describe('分页与排序', () => {
  it('pageSize 超过上限时拒绝', () => {
    expect(paginationSchema.safeParse({ pageSize: MAX_PAGE_SIZE + 1 }).success).toBe(false);
  });

  it('缺省时使用默认值并做数值转换', () => {
    const parsed = paginationSchema.parse({});
    expect(parsed.page).toBe(1);
    expect(paginationSchema.parse({ page: '3', pageSize: '10' }).pageSize).toBe(10);
  });
});

describe('审核与升学校验', () => {
  it('驳回申请必须填写审核意见', () => {
    expect(applicationReviewInputSchema.safeParse({ decision: 'reject' }).success).toBe(false);
    expect(
      applicationReviewInputSchema.safeParse({ decision: 'reject', comment: '材料不完整' }).success,
    ).toBe(true);
  });

  it('已录取必须填写院校或去向', () => {
    const base = { year: 2026, type: 'postgraduate', status: 'admitted' };
    expect(educationRecordInputSchema.safeParse(base).success).toBe(false);
    expect(
      educationRecordInputSchema.safeParse({ ...base, institutionOrDestination: '某大学' }).success,
    ).toBe(true);
    expect(
      educationRecordInputSchema.safeParse({
        year: 2026,
        type: 'postgraduate',
        status: 'preparing',
      }).success,
    ).toBe(true);
  });
});

describe('响应信封', () => {
  it('成功与失败信封结构稳定', () => {
    const success = ok({ id: 'x' }, { requestId: 'req-1' });
    expect(success.error).toBeNull();
    expect(success.data).toEqual({ id: 'x' });
    expect(isApiEnvelope(success)).toBe(true);

    const failure = fail(ApiErrorCode.Forbidden, { requestId: 'req-2' });
    expect(failure.data).toBeNull();
    expect(failure.error?.code).toBe('FORBIDDEN');
    expect(failure.error?.requestId).toBe('req-2');
  });

  it('未知错误码按 500 处理，不误判为成功', () => {
    expect(statusForErrorCode(ApiErrorCode.Forbidden)).toBe(403);
    expect(statusForErrorCode('SOMETHING_NEW')).toBe(500);
    expect(isApiEnvelope({ data: 1 })).toBe(false);
  });

  it('分页信封包含服务端计算的 totalPages', () => {
    const envelope = okPaginated(['a', 'b'], 5, { page: 1, pageSize: 2 });
    expect(envelope.meta.totalPages).toBe(3);
    expect(envelope.meta.total).toBe(5);
  });
});

describe('权限点受控', () => {
  it('禁止权限不可由普通管理员配置界面授予', () => {
    expect(isPermissionPoint('audit:delete')).toBe(false);
    expect(canDelegatePermission(PermissionPoint.RoleAssign)).toBe(false);
    expect(canDelegatePermission(PermissionPoint.AuditRead)).toBe(true);
  });

  it('默认数据范围与角色一一对应', () => {
    expect(DEFAULT_ROLE_DATA_SCOPE[Role.Student]).toBe(DataScope.Self);
    expect(DEFAULT_ROLE_DATA_SCOPE[Role.GroupLeader]).toBe(DataScope.Group);
    expect(DEFAULT_ROLE_DATA_SCOPE[Role.SuperAdmin]).toBe(DataScope.Global);
  });

  it('服务端按角色和已验证组关系授权', () => {
    const leader = { userId: 'u1', roles: [Role.GroupLeader] as const, groupIds: ['g1'] };
    expect(
      isAuthorized(leader, {
        permission: PermissionPoint.MembershipReviewGroup,
        scope: DataScope.Group,
        groupId: 'g1',
      }),
    ).toBe(true);
    expect(
      isAuthorized(leader, {
        permission: PermissionPoint.MembershipReviewGroup,
        scope: DataScope.Group,
        groupId: 'g2',
      }),
    ).toBe(false);
    expect(
      isAuthorized(leader, {
        permission: PermissionPoint.MembershipReviewGroup,
        scope: DataScope.Global,
      }),
    ).toBe(false);
    const student = { userId: 'u1', roles: [Role.Student] as const };
    expect(
      isAuthorized(student, {
        permission: PermissionPoint.ProfileSelfRead,
        scope: DataScope.Self,
        resourceUserId: 'u1',
      }),
    ).toBe(true);
    expect(
      isAuthorized(student, {
        permission: PermissionPoint.ProfileSelfRead,
        scope: DataScope.Self,
        resourceUserId: 'u2',
      }),
    ).toBe(false);
    const assignedAdmin = {
      userId: 'admin',
      roles: [Role.Admin] as const,
      assignedResourceIds: ['u2'],
    };
    expect(
      isAuthorized(assignedAdmin, {
        permission: PermissionPoint.ProfileAdminRead,
        scope: DataScope.Assigned,
        resourceUserId: 'u2',
      }),
    ).toBe(true);
    expect(
      isAuthorized(assignedAdmin, {
        permission: PermissionPoint.ProfileAdminRead,
        scope: DataScope.Assigned,
        resourceUserId: 'u3',
      }),
    ).toBe(false);
  });

  it('禁止普通管理员自授予配置、角色分配或 GLOBAL', () => {
    const admin = { userId: 'u1', roles: [Role.Admin] as const };
    expect(
      canGrantPermissions(admin, [
        {
          targetUserId: 'u1',
          permission: PermissionPoint.PermissionConfigure,
          scope: DataScope.Assigned,
        },
      ]),
    ).toBe(false);
    expect(
      canGrantPermissions(admin, [
        {
          targetUserId: 'u2',
          permission: PermissionPoint.ProfileAdminRead,
          scope: DataScope.Global,
        },
      ]),
    ).toBe(false);
    expect(
      canGrantPermissions({ userId: 's', roles: [Role.SuperAdmin] as const }, [
        {
          targetUserId: 'u2',
          permission: PermissionPoint.ProfileAdminRead,
          scope: DataScope.Assigned,
        },
      ]),
    ).toBe(true);
    expect(
      canGrantPermissions({ userId: 'sys', roles: [Role.SystemAdmin] as const }, [
        {
          targetUserId: 'u2',
          permission: PermissionPoint.PermissionConfigure,
          scope: DataScope.System,
        },
      ]),
    ).toBe(false);
  });

  it('导出和审计只接受目录中的原子权限', () => {
    expect(isAtomicPermission(PermissionPoint.ExportProfileCreate)).toBe(true);
    expect(isAtomicPermission('export:*')).toBe(false);
    expect(isAtomicPermission('audit:delete')).toBe(false);
  });
});
