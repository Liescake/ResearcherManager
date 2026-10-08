import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DataScope,
  PermissionPoint,
  ReviewStatus,
  educationRecordInputSchema,
  uuidSchema,
} from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import {
  assertDeclaredInputFields,
  parseStoredEducationRecord,
  readRecordOwnerId,
  toEducationRecordView,
} from './education-records.contract';
import type { EducationRecordView } from './education-records.contract';
import { EDUCATION_RECORD_REPOSITORY } from './education-records.port';
import type { EducationRecord, EducationRecordRepository } from './education-records.port';

/**
 * 升学记录切片（P4 最小垂直切片，学生自服务部分）：
 * - `GET  /me/education-records`      本人升学记录列表（`education:self:read`）
 * - `POST /me/education-records`      新建本人升学记录（`education:self:create`）
 * - `GET  /me/education-records/{id}` 本人单条升学记录（`education:self:read`，按资源归属判定）
 *
 * 三条硬约束：
 * 1. **主体与资源归属都来自服务端**：权限点、数据范围是服务端常量；
 *    `resourceUserId` 分别取自服务端主体（自建/自读列表）或存储记录（单条读取），
 *    客户端提交的 `roles`/`scope`/`groupId`/`userId` 不进入判定，且会被输入闭集直接拒绝。
 * 2. **授权先于业务处理**：每次读写都先经 `AuthorizationGuard`（其下是 `RUOYI_AUTHZ_ADAPTER`
 *    端口 → canonical 谓词），拒绝即 403；未登记权限/范围/角色在端口层已 fail-closed。
 * 3. **输出前再校验一次**：存储记录必须满足读取契约（枚举闭集 + 时间格式），
 *    违反者按服务端缺陷 500 处理，不允许把未知枚举当成合法数据返回。
 *
 * 尚不包含（明确留给后续切片）：状态流转/审核（`education:review`）、更新与撤回、
 * 统计口径（`statistics:education:read` 与 `computeAdmissionRate`）、幂等键与审计落库。
 */
@Injectable()
export class EducationRecordsService {
  private readonly logger = new Logger(EducationRecordsService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(EDUCATION_RECORD_REPOSITORY) private readonly repository: EducationRecordRepository,
  ) {}

  /** 本人记录列表：集合级 SELF 判定后，按服务端主体取数 */
  listMyRecords(subject: AuthorizationSubject): EducationRecordView[] {
    this.authorizeSelf(subject, PermissionPoint.EducationSelfRead, subject.userId);
    return this.repository.listByUserId(subject.userId).map((record) => this.toView(record));
  }

  /** 新建本人记录：归属与审核态都由服务端决定，请求体只提供业务字段 */
  createMyRecord(subject: AuthorizationSubject, body: unknown): EducationRecordView {
    this.authorizeSelf(subject, PermissionPoint.EducationSelfCreate, subject.userId);

    // 输入闭集 → 字段级校验（共享 zod schema）：未知枚举、越界年份、控制字符、
    // 「已录取但缺院校或去向」等一律抛 ZodError，由统一异常过滤器映射为 400。
    assertDeclaredInputFields(body);
    const input = educationRecordInputSchema.parse(body);

    const now = new Date().toISOString();
    const record = this.repository.create({
      id: randomUUID(),
      userId: subject.userId,
      year: input.year,
      type: input.type,
      status: input.status,
      ...(input.institutionOrDestination
        ? { institutionOrDestination: input.institutionOrDestination }
        : {}),
      // 学生自建记录一律待审核：不允许自授权通过审核态（该权限属于 education:review）
      reviewStatus: ReviewStatus.Pending,
      createdAt: now,
      updatedAt: now,
    });

    return this.toView(record);
  }

  /** 单条记录：归属只从存储解析；不存在与无权访问分别返回 404 / 403 */
  getMyRecord(subject: AuthorizationSubject, recordId: string): EducationRecordView {
    const id = uuidSchema.parse(recordId);
    const record = this.repository.findById(id);
    if (!record) {
      throw new NotFoundException('目标资源不存在或不可见');
    }

    // 先按存储给出的归属判定，再校验记录能否安全输出：
    // 归属不可读时按空串处理 → SELF 谓词必然拒绝（403），不会因为「记录损坏」而把
    // 存在性/损坏细节泄露给非归属方。
    this.authorizeSelf(subject, PermissionPoint.EducationSelfRead, readRecordOwnerId(record));
    return this.toView(record);
  }

  /** 授权判定：权限点与范围是服务端常量，资源归属由调用方给出（服务端解析结果） */
  private authorizeSelf(
    subject: AuthorizationSubject,
    permission: PermissionPoint,
    resourceUserId: string,
  ): void {
    this.guard.assertAuthorized(subject, {
      permission,
      scope: DataScope.Self,
      resourceUserId,
    });
  }

  /** 输出边界：记录必须满足读取契约，否则按服务端缺陷 500，且日志不含字段取值 */
  private toView(record: EducationRecord): EducationRecordView {
    const parsed = parseStoredEducationRecord(record);
    if (!parsed.ok) {
      this.logger.error(
        `[education] 存储记录违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException('升学记录数据完整性校验失败');
    }
    return toEducationRecordView(parsed.value);
  }
}
