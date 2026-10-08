import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataScope, PermissionPoint, studentProfileUpdateSchema } from '@rm/shared';
import type { AuthorizationSubject, StudentProfileUpdateInput } from '@rm/shared';
import {
  AUTHORIZATION_FORBIDDEN_MESSAGE,
  AuthorizationGuard,
} from '../access-control/authorization-guard';
import {
  assertDeclaredProfileInputFields,
  parseStoredStudentProfile,
  readProfileOwnerId,
  toStudentProfileView,
} from './student-profile.contract';
import type { StoredStudentProfile, StudentProfileView } from './student-profile.contract';
import { PROFILE_REPOSITORY } from './student-profile.port';
import type {
  StudentProfile,
  ProfileRepository,
  StoredPrivacyConsent,
} from './student-profile.port';

/**
 * 学生画像切片（P5 最小垂直切片，本人自服务部分）：
 * - `GET   /me/profile` 读取本人画像（`profile:self:read`）
 * - `PATCH /me/profile` 更新本人画像（`profile:self:update`）
 *
 * 三条硬约束：
 * 1. **主体与资源归属都来自服务端**：权限点、数据范围与资源归属都是服务端解析值。`/me/profile`
 *    的资源就是会话主体本人，因此 SELF 判定的 `resourceUserId` 取 `subject.userId`（会话主体，
 *    不是请求体，也不是存储记录）。客户端提交的 `roles`/`scope`/`groupId`/`userId` 不进入判定，
 *    且会被输入闭集直接拒绝。
 * 2. **授权先于任何存储访问**：`requireOwnProfile` 先经 `AuthorizationGuard`（其下是
 *    `RUOYI_AUTHZ_ADAPTER` 端口 → canonical 谓词），拒绝即 403；未登记权限/范围/角色在端口层已
 *    fail-closed。**取数与请求体校验都排在授权之后**：无权主体既观察不到画像是否存在，
 *    也拿不到任何字段级校验反馈。
 * 3. **输出前再校验一次**：存储记录必须满足读取契约（枚举闭集 + 时间格式 + 高敏感字段形状），
 *    违反者按服务端缺陷 500 处理；对外视图不含 `userId`/`studentNo`/`phone`/`privacyConsent`。
 *
 * 本切片不做（明确留给后续切片）：画像**创建**（首次提交，契约基线中的 `PUT /me/profile`）、
 * 首次提交后的**锁定**与管理员代改、更正申请、审计落库与幂等键。
 *
 * 判定顺序（GET 与 PATCH 一致，且被测试固定）：
 * 无有效会话 → 401（认证边界，见 controller）；授权拒绝 → 403；主体无画像 → 404；
 * 存储归属与主体不一致（异常仓储/横向越权）→ 403；存储记录违反读取契约 → 500；请求体非法 → 400。
 * 由于 `/me/profile` 的资源就是**服务端主体本人**，取数只按会话主体进行，
 * 因此 404/403 的先后不会把他人资源的存在性泄露给调用方。
 */
@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(PROFILE_REPOSITORY) private readonly repository: ProfileRepository,
  ) {}

  /** 本人画像：先按服务端主体做 SELF 授权，再取数并校验存储归属一致性 */
  getMyProfile(subject: AuthorizationSubject): StudentProfileView {
    return this.toView(this.requireOwnProfile(subject, PermissionPoint.ProfileSelfRead));
  }

  /** 更新本人画像：闭集 + 共享 schema 校验后，按服务端归属合并写回 */
  updateMyProfile(subject: AuthorizationSubject, body: unknown): StudentProfileView {
    // 1. 授权 + 读取 + 归属校验（403 / 404 / 500 都在这一步产生，先于请求体校验）
    const existing = this.requireOwnProfile(subject, PermissionPoint.ProfileSelfUpdate);

    // 2. 输入闭集 → 字段级校验（共享 zod schema）：未知字段、身份/权限字段、未登记枚举、
    //    越界数值、控制字符、「未同意隐私政策」等一律抛 ZodError，由统一异常过滤器映射为 400。
    assertDeclaredProfileInputFields(body);
    const input = studentProfileUpdateSchema.parse(body);

    // 3. 合并（归属/创建时间 immutable）→ 写前校验 → 写回 → 输出前校验
    const now = new Date().toISOString();
    const next = mergeStoredProfile(existing, input, now);
    const persisted = this.repository.save(this.assertStoredProfile(next));
    return this.toView(persisted);
  }

  /**
   * **授权先行**，再取本人画像。
   *
   * 1. **先授权**：`/me/profile` 的资源归属就是会话主体本人，所以 SELF 判定的 `resourceUserId`
   *    取 `subject.userId`（服务端会话解析值，不来自请求体，也不来自存储）。这一步不访问任何
   *    存储：未授权主体连「是否存在画像」都观察不到。
   * 2. **再取数**：取数键同样是 `subject.userId`，因此不会触达他人资源；无记录 → 404。
   * 3. **归属一致性纵深防御**：存储记录自带的 `userId` 必须等于主体，否则即便授权通过也判 403
   *    （异常仓储 / 横向越权 / 数据被外部改写）。该 403 与授权拒绝使用同一文案，
   *    调用方无法据此区分原因。
   */
  private requireOwnProfile(
    subject: AuthorizationSubject,
    permission: PermissionPoint,
  ): StoredStudentProfile {
    this.guard.assertAuthorized(subject, {
      permission,
      scope: DataScope.Self,
      resourceUserId: subject.userId,
    });

    const record = this.repository.findByUserId(subject.userId);
    if (!record) {
      throw new NotFoundException('本人画像不存在');
    }

    if (readProfileOwnerId(record) !== subject.userId) {
      throw new ForbiddenException(AUTHORIZATION_FORBIDDEN_MESSAGE);
    }

    return this.assertStoredProfile(record);
  }

  /** 存储记录必须满足读取契约，否则按服务端缺陷 500（日志不含字段取值） */
  private assertStoredProfile(record: unknown): StoredStudentProfile {
    const parsed = parseStoredStudentProfile(record);
    if (!parsed.ok) {
      this.logger.error(
        `[profiles] 存储记录违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException('学生画像数据完整性校验失败');
    }
    return parsed.value;
  }

  /** 输出边界：即便是仓储返回的对象也要先过读取契约，再投影为不含敏感字段的视图 */
  private toView(record: StudentProfile): StudentProfileView {
    return toStudentProfileView(this.assertStoredProfile(record));
  }
}

/**
 * 合并一次 PATCH：
 * - `userId` / `createdAt` 是归属与生命周期字段，**永远**沿用存储值，请求体无法影响；
 * - 文本字段允许用空串清空（空串归一为「未填写」），与视图的「按存在性输出」保持一致；
 * - `updatedAt` 由服务端时间决定；
 * - 隐私同意时间由服务端记录：客户端提供的 `consentedAt` 仅作本地记录参考，
 *   缺省时取服务端当前时间。
 */
function mergeStoredProfile(
  existing: StoredStudentProfile,
  input: StudentProfileUpdateInput,
  now: string,
): StudentProfile {
  const researchExperience = optionalText(input.researchExperience ?? existing.researchExperience);
  const competitionExperience = optionalText(
    input.competitionExperience ?? existing.competitionExperience,
  );
  const strengths = optionalText(input.strengths ?? existing.strengths);

  return {
    userId: existing.userId,
    name: input.name ?? existing.name,
    studentNo: input.studentNo ?? existing.studentNo,
    college: input.college ?? existing.college,
    major: input.major ?? existing.major,
    grade: input.grade ?? existing.grade,
    phone: input.phone ?? existing.phone,
    skills: input.skills ?? existing.skills,
    programmingLevel: input.programmingLevel ?? existing.programmingLevel,
    ...(researchExperience ? { researchExperience } : {}),
    ...(competitionExperience ? { competitionExperience } : {}),
    availableTime: input.availableTime ?? existing.availableTime,
    researchInterests: input.researchInterests ?? existing.researchInterests,
    ...(strengths ? { strengths } : {}),
    intendedFields: input.intendedFields ?? existing.intendedFields,
    privacyConsent: mergePrivacyConsent(existing.privacyConsent, input, now),
    createdAt: existing.createdAt,
    updatedAt: now,
  };
}

/** 空串归一为「未填写」：存储层只保留有值的可选文本 */
function optionalText(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function mergePrivacyConsent(
  existing: StoredPrivacyConsent,
  input: StudentProfileUpdateInput,
  now: string,
): StoredPrivacyConsent {
  const consent = input.privacyConsent;
  if (!consent) return existing;
  return {
    policyVersion: consent.policyVersion,
    consentedAt: consent.consentedAt ? consent.consentedAt.toISOString() : now,
  };
}
