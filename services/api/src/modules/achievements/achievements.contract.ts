import { z } from 'zod';
import {
  ACHIEVEMENT_TYPE_VALUES,
  REVIEW_STATUS_VALUES,
  ReviewStatus,
  riskFreeText,
  trimmedText,
  uuidSchema,
} from '@rm/shared';
import type { Achievement } from './achievements.port';

/**
 * 成果切片的**输入闭集**、**服务端独占字段清单**与**读取契约**。
 *
 * 输入闭集：创建接口只接受 `ACHIEVEMENT_INPUT_FIELDS`（与共享 `achievementInputSchema`
 * 的键集一致，有回归断言）。出现闭集之外的字段（`userId`、`roles`、`scope`、`groupId`、
 * `reviewStatus`…）一律 400，而不是「静默忽略」——客户端提交的归属、权限、范围与审核态
 * 不是「被忽略的输入」，而是明确不被接受的输入，必须留下可观测的拒绝记录。
 *
 * 读取契约：存储记录在离开进程前必须满足本结构（含枚举闭集与 ISO 时间格式）。未知枚举
 * （例如数据库迁移先于代码上线、或数据被外部改写）属于服务端缺陷：由 service 判为 500，
 * 绝不允许把未知状态当作合法值返回给调用方。
 *
 * 对外视图：**不含** `userId`（归属），也**不含**审核人身份/审核意见/审核时间/审计事件 ID
 * 这些内部处理记录。自读范围下调用方就是归属主体本人，响应里不需要、也不应该携带归属字段，
 * 这样客户端就没有任何可回传的归属信息可用于伪造。
 */

/** 创建接口声明的请求字段闭集：必须与共享 `achievementInputSchema` 的键集一致（有回归断言） */
export const ACHIEVEMENT_INPUT_FIELDS = [
  'type',
  'title',
  'awardLevel',
  'description',
  'achievedAt',
  'evidenceFileId',
] as const;

/**
 * 服务端独占字段（**禁止客户端提交**）：即使它们不在共享 schema 内，也必须给出可区分的
 * 拒绝原因，避免「以为是业务字段但被静默剥离」。这些字段只能来自服务端会话、状态机或存储。
 */
export const FORBIDDEN_ACHIEVEMENT_FIELDS = [
  'id',
  'achievementId',
  'userId',
  'ownerUserId',
  'role',
  'roles',
  'scope',
  'dataScope',
  'groupId',
  'groupIds',
  'permissions',
  'permissionPoints',
  'assignedResourceIds',
  'reviewStatus',
  'reviewComment',
  'reviewedByUserId',
  'reviewerId',
  'reviewedAt',
  'auditEventId',
  'createdAt',
  'updatedAt',
] as const;

/**
 * 服务端写入的初始审核态：学生自建成果一律待审核。
 * 自授权通过审核态需要 `achievement:review`（本切片不包含审核），因此入口状态只可能是 pending。
 */
export const ACHIEVEMENT_INITIAL_REVIEW_STATUS = ReviewStatus.Pending;

/** 读取契约违规或归属与会话主体不一致时的统一对外文案（两种情况共用，避免区分内部原因） */
export const ACHIEVEMENT_INTEGRITY_MESSAGE = '成果数据完整性校验失败';

/** 存储记录读取契约：字段 + 枚举闭集 + ISO 时间戳 */
export const storedAchievementSchema = z.object({
  id: uuidSchema,
  userId: trimmedText(1, 64, '归属主体'),
  type: z.enum(ACHIEVEMENT_TYPE_VALUES),
  title: trimmedText(1, 300, '成果标题'),
  awardLevel: trimmedText(0, 100, '获奖级别').optional(),
  description: riskFreeText(0, 2000, '成果说明').optional(),
  achievedAt: z.string().datetime().optional(),
  evidenceFileId: uuidSchema.optional(),
  reviewStatus: z.enum(REVIEW_STATUS_VALUES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type StoredAchievement = z.infer<typeof storedAchievementSchema>;

/**
 * 对外视图：**不含** `userId`，也不含审核人/审核意见/审核时间与审计事件 ID。
 * 归属与内部处理记录不随响应回传，客户端因此没有任何可回传的归属信息可用于伪造。
 */
export interface AchievementView {
  id: string;
  type: StoredAchievement['type'];
  title: string;
  awardLevel?: string;
  description?: string;
  achievedAt?: string;
  evidenceFileId?: string;
  reviewStatus: StoredAchievement['reviewStatus'];
  createdAt: string;
  updatedAt: string;
}

export interface AchievementContractIssue {
  readonly kind: 'invalid' | 'unexpected';
  readonly path: string;
}

export type StoredAchievementParse =
  | { readonly ok: true; readonly value: StoredAchievement }
  | { readonly ok: false; readonly issues: readonly AchievementContractIssue[] };

/**
 * 校验并规范化一条存储记录（一次解析，避免「先断言后使用」的重复解析）。
 * 失败时只返回字段路径与违规类型，不返回字段取值。
 */
export function parseStoredAchievement(record: unknown): StoredAchievementParse {
  const parsed = storedAchievementSchema.safeParse(record);
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

/** 校验后的存储记录 → 对外视图（逐字段显式赋值，不使用对象展开） */
export function toAchievementView(record: StoredAchievement): AchievementView {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    ...(record.awardLevel ? { awardLevel: record.awardLevel } : {}),
    ...(record.description ? { description: record.description } : {}),
    ...(record.achievedAt ? { achievedAt: record.achievedAt } : {}),
    ...(record.evidenceFileId ? { evidenceFileId: record.evidenceFileId } : {}),
    reviewStatus: record.reviewStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * 字段闭集门禁：请求体出现未声明字段时抛 `ZodError`，由 `ApiExceptionFilter` 统一映射为
 * 400 `VALIDATION_FAILED` + `details.issues`。
 *
 * `path` 指向违规字段本身，`message` 区分「服务端独占字段」与「未声明字段」：
 * 前者是必须显式拒绝的越权尝试（归属/角色/范围/审核态），后者是契约漂移，两者都要能被观测到。
 * 非对象请求体（缺体、`null`、数组、标量）不在这里拒绝，交给字段级 schema 判非法。
 */
export function assertDeclaredAchievementInputFields(body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;

  const declared: readonly string[] = ACHIEVEMENT_INPUT_FIELDS;
  const forbidden: readonly string[] = FORBIDDEN_ACHIEVEMENT_FIELDS;
  const unexpected = Object.keys(body).filter((key) => !declared.includes(key));
  if (unexpected.length === 0) return;

  throw new z.ZodError(
    unexpected.map((key) => ({
      code: 'unrecognized_keys' as const,
      keys: [key],
      path: [key] as (string | number)[],
      message: forbidden.includes(key)
        ? `禁止设置服务端字段 ${key}`
        : `请求体包含未声明字段 ${key}`,
    })),
  );
}

/** 供测试与调用方复用：记录归属主体（不可读时返回空串，交由调用方按服务端缺陷处理） */
export function readRecordOwnerId(record: Achievement): string {
  return typeof record.userId === 'string' ? record.userId : '';
}
