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
 * 存储层异常的统一文案：数据损坏与「仓储未按主体过滤」**共用**同一条，
 * 因此调用方无法据此区分原因，也不会从中读到他人记录的任何字段。
 */
const EDUCATION_RECORD_INTEGRITY_MESSAGE = '升学记录数据完整性校验失败';

/**
 * 升学记录切片（P4 最小垂直切片，学生自服务部分）：
 * - `GET  /me/education-records`      本人升学记录列表（`education:self:read`）
 * - `POST /me/education-records`      新建本人升学记录（`education:self:create`）
 * - `GET  /me/education-records/{id}` 本人单条升学记录（`education:self:read`，按资源归属判定）
 *
 * 三条硬约束：
 * 1. **主体与资源归属都来自服务端**：权限点、数据范围是服务端常量；
 *    `resourceUserId` 取自服务端会话主体（自建 / 自读列表 / 单条读取的第一步），
 *    客户端提交的 `roles`/`scope`/`groupId`/`userId` 不进入判定，且会被输入闭集直接拒绝。
 * 2. **授权先于业务处理**：每次读写都先经 `AuthorizationGuard`（其下是 `RUOYI_AUTHZ_ADAPTER`
 *    端口 → canonical 谓词），拒绝即 403；未登记权限/范围/角色在端口层已 fail-closed。
 * 3. **输出前再校验一次**：存储记录必须满足读取契约（枚举闭集 + 时间格式）**且归属与会话主体
 *    一致**，违反者按服务端缺陷 500 处理（仓储未按主体过滤即属此类），不允许把未知枚举或
 *    他人记录当成正常数据返回。
 *
 * ## 判定顺序与 403 / 404 的口径（本切片随异步端口收敛而明确）
 * 单条读取的流程是「先行 SELF 授权（`resourceUserId` = 会话主体）→ 按**资源 ID + 主体归属**
 * 取数 → 归属二次授权」。因此：
 * - 未认证 → 401（controller）；无该权限点 / 未登记角色 → 403；
 * - 记录不存在，**或**记录存在但不属于该主体 → 统一 404（两者在仓储层不可区分），
 *   他人资源的存在性因此不可探测（此前同步端口的 403/404 差别会泄露存在性）；
 * - 仓储返回了他人归属（异常实现 / 数据被外部改写）→ 归属二次授权拒绝 403；
 * - 存储记录违反读取契约 → 500。
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
  async listMyRecords(subject: AuthorizationSubject): Promise<EducationRecordView[]> {
    this.authorizeSelf(subject, PermissionPoint.EducationSelfRead, subject.userId);
    const records = await this.repository.listByUserId(subject.userId);
    return records.map((record) => this.toView(record, subject.userId));
  }

  /** 新建本人记录：归属与审核态都由服务端决定，请求体只提供业务字段 */
  async createMyRecord(subject: AuthorizationSubject, body: unknown): Promise<EducationRecordView> {
    this.authorizeSelf(subject, PermissionPoint.EducationSelfCreate, subject.userId);

    // 输入闭集 → 字段级校验（共享 zod schema）：未知枚举、越界年份、控制字符、
    // 「已录取但缺院校或去向」等一律抛 ZodError，由统一异常过滤器映射为 400。
    assertDeclaredInputFields(body);
    const input = educationRecordInputSchema.parse(body);

    const now = new Date().toISOString();
    const record = await this.repository.create({
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

    return this.toView(record, subject.userId);
  }

  /**
   * 单条记录：**先授权、再把归属下推到取数**。
   *
   * 判定顺序（被测试固定）：
   * 1. **先行 SELF 授权**：`resourceUserId` 取服务端会话主体，不访问存储，未授权主体连
   *    「是否存在该资源」都观察不到（403）；
   * 2. **取数**：`findById(recordId, subject.userId)` 把归属下推进仓储（PostgreSQL 侧是
   *    `WHERE id = $1 AND user_id = $2::uuid`），因此**他人记录根本不出库**；
   *    未命中（不存在，或存在但不属于该主体）统一 404 —— 两者**不可区分**，
   *    因此无法用存在性探测他人资源；
   * 3. **归属二次授权（纵深防御）**：仓储返回的记录仍要按**存储归属**再判一次 SELF；
   *    仓储未按主体过滤（异常实现 / 数据被外部改写）时由同一 guard 拒绝 → 403，
   *    与第 1 步文案一致，调用方无法据此区分原因。
   */
  async getMyRecord(subject: AuthorizationSubject, recordId: string): Promise<EducationRecordView> {
    this.authorizeSelf(subject, PermissionPoint.EducationSelfRead, subject.userId);

    const id = uuidSchema.parse(recordId);
    const record = await this.repository.findById(id, subject.userId);
    if (!record) {
      throw new NotFoundException('目标资源不存在或不可见');
    }

    // 二次 SELF 授权：判定入参取自**存储归属**（不是请求体，也不是会话主体）
    this.authorizeSelf(subject, PermissionPoint.EducationSelfRead, readRecordOwnerId(record));
    return this.toView(record, subject.userId);
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

  /**
   * 输出边界：
   * 1. 记录必须满足读取契约，否则按服务端缺陷 500，日志不含字段取值；
   * 2. 记录归属必须与调用方主体一致（纵深防御：仓储未按主体过滤 / 数据被外部改写）。
   *    两种情况使用**同一文案**，调用方无法据此区分「数据损坏」与「越权取数」，
   *    也不会看到他人记录的任何字段。
   */
  private toView(record: EducationRecord, expectedOwnerId: string): EducationRecordView {
    const parsed = parseStoredEducationRecord(record);
    if (!parsed.ok) {
      this.logger.error(
        `[education] 存储记录违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(EDUCATION_RECORD_INTEGRITY_MESSAGE);
    }
    if (readRecordOwnerId(parsed.value) !== expectedOwnerId) {
      this.logger.error('[education] 存储记录归属与会话主体不一致（仓储未按主体过滤）');
      throw new InternalServerErrorException(EDUCATION_RECORD_INTEGRITY_MESSAGE);
    }
    return toEducationRecordView(parsed.value);
  }
}
