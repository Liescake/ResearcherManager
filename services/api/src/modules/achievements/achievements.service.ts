import { randomUUID } from 'node:crypto';
import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { DataScope, PermissionPoint, achievementInputSchema } from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import {
  ACHIEVEMENT_INITIAL_REVIEW_STATUS,
  ACHIEVEMENT_INTEGRITY_MESSAGE,
  assertDeclaredAchievementInputFields,
  parseStoredAchievement,
  readRecordOwnerId,
  toAchievementView,
} from './achievements.contract';
import type { AchievementView } from './achievements.contract';
import { ACHIEVEMENT_REPOSITORY } from './achievements.port';
import type { Achievement, AchievementRepository } from './achievements.port';

/**
 * 成果切片（P5 最小垂直切片，学生自服务部分）：
 * - `GET  /me/achievements`  本人成果列表（`achievement:self:read`）
 * - `POST /me/achievements`  创建本人成果（`achievement:self:create`）
 *
 * 四条硬约束：
 * 1. **主体与归属都来自服务端**：`userId` 取自会话主体，`reviewStatus` 由服务端常量写入
 *    （恒为 pending），权限点与数据范围是服务端常量 `SELF`；客户端提交的
 *    `userId`/`roles`/`scope`/`groupId`/`reviewStatus` 既不能进入判定，也不能落库——
 *    它们由输入闭集直接拒绝（400），不是静默剥离。
 * 2. **授权先于任何仓储访问**：两条路由都先经 `AuthorizationGuard`（其下是
 *    `RUOYI_AUTHZ_ADAPTER` 端口 → canonical 谓词），拒绝即 403；`scope` 恒为服务端常量 `SELF`，
 *    `resourceUserId` 取会话主体。未授权主体既观察不到成果是否存在，也拿不到字段级校验反馈。
 * 3. **请求字段闭集**：只接受共享 `achievementInputSchema` 的字段
 *    （`type`/`title`/`awardLevel`/`description`/`achievedAt`/`evidenceFileId`）；
 *    未知枚举、越界长度、控制字符、`achievedAt` 非法时间、`evidenceFileId` 非 UUID、
 *    说明中含身份证号/密钥等敏感内容一律 400（共享 `riskFreeText`）。
 * 4. **输出前再校验一次**：存储记录必须满足读取契约（枚举闭集 + ISO 时间格式）**且归属
 *    与会话主体一致**，违反者按服务端缺陷 500 处理（仓储未按主体过滤即属此类），
 *    不允许把未知枚举或他人记录当成正常输出返回。
 *
 * 尚不包含（明确留给后续切片）：单条读取、更新（`achievement:self:update`）、
 * 审核（`achievement:review`，含审核人/意见/时间落库）、附件实体校验、
 * 幂等键与审计落库、列表分页与排序。
 */
@Injectable()
export class AchievementsService {
  private readonly logger = new Logger(AchievementsService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(ACHIEVEMENT_REPOSITORY) private readonly repository: AchievementRepository,
  ) {}

  /** 本人成果列表：先做集合级 SELF 判定，再按服务端主体取数 */
  listMyAchievements(subject: AuthorizationSubject): AchievementView[] {
    this.authorizeSelf(subject, PermissionPoint.AchievementSelfRead);
    return this.repository
      .listByUserId(subject.userId)
      .map((record) => this.toView(record, subject.userId));
  }

  /** 创建本人成果：归属与审核态都由服务端决定，请求体只提供业务字段 */
  createMyAchievement(subject: AuthorizationSubject, body: unknown): AchievementView {
    this.authorizeSelf(subject, PermissionPoint.AchievementSelfCreate);

    // 输入闭集 → 字段级校验（共享 zod schema）：未知枚举、越界标题、控制字符、
    // 「说明里含身份证号/密钥」等一律抛 ZodError，由统一异常过滤器映射为 400。
    assertDeclaredAchievementInputFields(body);
    const input = achievementInputSchema.parse(body);

    const now = new Date().toISOString();
    const created = this.repository.create({
      id: randomUUID(),
      userId: subject.userId,
      type: input.type,
      title: input.title,
      ...(input.awardLevel ? { awardLevel: input.awardLevel } : {}),
      ...(input.description ? { description: input.description } : {}),
      // 取得时间由服务端规范化为 ISO 8601（共享 schema 已把它强转为 Date）
      ...(input.achievedAt ? { achievedAt: input.achievedAt.toISOString() } : {}),
      ...(input.evidenceFileId ? { evidenceFileId: input.evidenceFileId } : {}),
      // 学生自建成果一律待审核：不允许自授权通过审核态（该权限属于 achievement:review）
      reviewStatus: ACHIEVEMENT_INITIAL_REVIEW_STATUS,
      createdAt: now,
      updatedAt: now,
    });

    return this.toView(created, subject.userId);
  }

  /**
   * 授权判定：权限点与范围恒为服务端常量 `SELF`，`resourceUserId` 默认取**会话主体**
   * （服务端解析值）；不接受任何客户端提交的字段。
   */
  private authorizeSelf(
    subject: AuthorizationSubject,
    permission: PermissionPoint,
    resourceUserId: string = subject.userId,
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
   * 2. 记录归属必须与调用方主体一致（纵深防御：仓储未按主体过滤 / 数据被外部改写），
   *    不一致时同样 500 且使用同一文案，调用方无法据此区分「数据损坏」与「越权取数」，
   *    也不会看到他人记录的任何字段。
   */
  private toView(record: Achievement, expectedOwnerId: string): AchievementView {
    const parsed = parseStoredAchievement(record);
    if (!parsed.ok) {
      this.logger.error(
        `[achievements] 存储记录违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(ACHIEVEMENT_INTEGRITY_MESSAGE);
    }
    if (readRecordOwnerId(parsed.value) !== expectedOwnerId) {
      this.logger.error('[achievements] 存储记录归属与会话主体不一致（仓储未按主体过滤）');
      throw new InternalServerErrorException(ACHIEVEMENT_INTEGRITY_MESSAGE);
    }
    return toAchievementView(parsed.value);
  }
}
