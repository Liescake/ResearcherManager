import { z } from 'zod';
import {
  GRADE_VALUES,
  PROGRAMMING_LEVEL_VALUES,
  availableTimeSchema,
  phoneSchema,
  riskFreeText,
  studentNoSchema,
  tagListSchema,
  trimmedText,
} from '@rm/shared';
import type { StudentProfile } from './student-profile.port';

/**
 * 画像切片的**输入闭集**、**禁止字段清单**与**读取契约**。
 *
 * 输入闭集：写接口只接受 `PROFILE_INPUT_FIELDS` 里的字段。出现闭集之外的字段（`roles`、`scope`、
 * `groupId`、`userId`、`reviewStatus`…）一律 400，而不是「静默忽略」——客户端提交的权限/范围/归属
 * 不是「被忽略的输入」，而是明确不被接受的输入，必须留下可观测的拒绝记录。
 *
 * 读取契约：存储记录在离开进程前必须满足本结构（含枚举闭集与时间格式）。未知枚举
 * （例如数据库迁移先于代码上线、或数据被外部改写）属于服务端缺陷：由 service 判为 500，
 * 绝不允许把未知状态当作合法值返回给调用方。
 *
 * 对外视图：**不含** `userId`、`studentNo`、`phone`，也**不含** `privacyConsent`。归属与身份不随
 * 响应回传给客户端；高敏感字段（学号、联系方式）只写不读，隐私同意快照（政策版本与同意时间）
 * 是服务端处理记录、同样只写不读，因此客户端没有任何可回传的归属/身份/同意信息可用于伪造。
 */

/** 写接口声明的请求字段闭集：必须与共享 `studentProfileInputSchema` 的键集一致（有回归断言） */
export const PROFILE_INPUT_FIELDS = [
  'name',
  'studentNo',
  'college',
  'major',
  'grade',
  'phone',
  'skills',
  'programmingLevel',
  'researchExperience',
  'competitionExperience',
  'availableTime',
  'researchInterests',
  'strengths',
  'intendedFields',
  'privacyConsent',
] as const;

/**
 * 身份/权限字段（**禁止修改**）：即使它们不在共享 schema 内，也必须给出可区分的拒绝原因，
 * 避免「以为是业务字段但被静默剥离」。这些字段的取值只能来自服务端会话/存储。
 */
export const FORBIDDEN_PROFILE_FIELDS = [
  'id',
  'userId',
  'accountStatus',
  'wechatOpenId',
  'openId',
  'roles',
  'scope',
  'dataScope',
  'groupId',
  'groupIds',
  'permissions',
  'permissionPoints',
  'assignedResourceIds',
  'profileSubmittedAt',
  'profileLockedAt',
  'reviewStatus',
] as const;

/** 存储记录读取契约：字段 + 枚举闭集 + ISO 时间戳（隐私同意时间由服务端写入） */
export const storedStudentProfileSchema = z.object({
  userId: trimmedText(1, 64, '归属主体'),
  name: trimmedText(1, 50, '姓名'),
  studentNo: studentNoSchema,
  college: trimmedText(1, 100, '学院'),
  major: trimmedText(1, 100, '专业'),
  grade: z.enum(GRADE_VALUES),
  phone: phoneSchema,
  skills: tagListSchema(1, 20, '擅长技能'),
  programmingLevel: z.enum(PROGRAMMING_LEVEL_VALUES),
  researchExperience: riskFreeText(0, 2000, '科研经历').optional(),
  competitionExperience: riskFreeText(0, 2000, '竞赛经历').optional(),
  availableTime: availableTimeSchema,
  researchInterests: tagListSchema(1, 20, '兴趣研究方向'),
  strengths: riskFreeText(0, 1000, '个人特长与优势').optional(),
  intendedFields: tagListSchema(1, 20, '意向科研领域'),
  privacyConsent: z.object({
    policyVersion: trimmedText(1, 40, '隐私政策版本'),
    consentedAt: z.string().datetime(),
  }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type StoredStudentProfile = z.infer<typeof storedStudentProfileSchema>;

/**
 * 对外视图：**不含** `userId` / `studentNo` / `phone` 等归属与高敏感字段，
 * 也**不含** `privacyConsent`（政策版本与同意时间是服务端处理记录，不外传）。
 * 客户端据此无法回传任何可用于伪造归属、权限或同意状态的字段。
 */
export interface StudentProfileView {
  name: string;
  college: string;
  major: string;
  grade: StoredStudentProfile['grade'];
  skills: string[];
  programmingLevel: StoredStudentProfile['programmingLevel'];
  researchExperience?: string;
  competitionExperience?: string;
  availableTime: {
    weeklyHours: number;
    periods: StoredStudentProfile['availableTime']['periods'];
    note?: string;
  };
  researchInterests: string[];
  strengths?: string;
  intendedFields: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StudentProfileContractIssue {
  readonly kind: 'invalid' | 'unexpected';
  readonly path: string;
}

export type StoredStudentProfileParse =
  | { readonly ok: true; readonly value: StoredStudentProfile }
  | { readonly ok: false; readonly issues: readonly StudentProfileContractIssue[] };

/**
 * 校验并规范化一条存储记录（一次解析，避免「先断言后使用」的重复解析）。
 * 失败时只返回字段路径与违规类型，不返回字段取值。
 */
export function parseStoredStudentProfile(record: unknown): StoredStudentProfileParse {
  const parsed = storedStudentProfileSchema.safeParse(record);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      kind: issue.code === 'unrecognized_keys' ? ('unexpected' as const) : ('invalid' as const),
      path: issue.path.join('.') || '(root)',
    })),
  };
}

/**
 * 校验后的存储记录 → 对外视图（逐字段显式赋值，不使用对象展开）。
 * `privacyConsent`（政策版本/同意时间）与 `studentNo`/`phone`/`userId` 一样**刻意不投影**：
 * 只写不读，任何响应都不回传，避免调用方据此伪造同意状态或归属。
 */
export function toStudentProfileView(record: StoredStudentProfile): StudentProfileView {
  return {
    name: record.name,
    college: record.college,
    major: record.major,
    grade: record.grade,
    skills: [...record.skills],
    programmingLevel: record.programmingLevel,
    ...(record.researchExperience ? { researchExperience: record.researchExperience } : {}),
    ...(record.competitionExperience
      ? { competitionExperience: record.competitionExperience }
      : {}),
    availableTime: {
      weeklyHours: record.availableTime.weeklyHours,
      periods: [...record.availableTime.periods],
      ...(record.availableTime.note ? { note: record.availableTime.note } : {}),
    },
    researchInterests: [...record.researchInterests],
    ...(record.strengths ? { strengths: record.strengths } : {}),
    intendedFields: [...record.intendedFields],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * 字段闭集门禁：请求体出现未声明字段时抛 `ZodError`，由 `ApiExceptionFilter` 统一映射为
 * 400 `VALIDATION_FAILED` + `details.issues`。
 *
 * `path` 指向违规字段本身，`message` 区分「身份/权限字段」与「未声明字段」：
 * 前者是必须显式拒绝的越权尝试，后者是契约漂移，两者都要能被观测到。
 * 非对象请求体（缺体、`null`、数组、标量）不在这里拒绝，交给字段级 schema 判非法。
 */
export function assertDeclaredProfileInputFields(body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;

  const declared: readonly string[] = PROFILE_INPUT_FIELDS;
  const forbidden: readonly string[] = FORBIDDEN_PROFILE_FIELDS;
  const unexpected = Object.keys(body).filter((key) => !declared.includes(key));
  if (unexpected.length === 0) return;

  throw new z.ZodError(
    unexpected.map((key) => ({
      code: 'unrecognized_keys' as const,
      keys: [key],
      path: [key] as (string | number)[],
      message: forbidden.includes(key)
        ? `禁止修改身份/权限字段 ${key}`
        : `请求体包含未声明字段 ${key}`,
    })),
  );
}

/** 供测试与调用方复用：记录归属主体（不可读时返回空串，交由授权判定默认拒绝） */
export function readProfileOwnerId(record: StudentProfile): string {
  return typeof record.userId === 'string' ? record.userId : '';
}
