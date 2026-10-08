import { z } from 'zod';
import { AI_ERROR_CODE_VALUES, findPiiKeys } from '@rm/ai-adapter';
import {
  MATCHING_MIN_RECOMMENDATIONS,
  MATCHING_REQUEST_STATUS_VALUES,
  MatchingRequestStatus,
  matchingRecommendationListSchema,
  trimmedText,
  uuidSchema,
} from '@rm/shared';
import type { MatchingRecommendationItem } from '@rm/shared';

/**
 * 匹配切片的**输入闭集**、**服务端独占字段清单**、**读取契约**与**输出白名单**。
 *
 * 输入闭集：发起请求只接受 `MATCHING_REQUEST_INPUT_FIELDS`（与共享
 * `matchingRequestInputSchema` 的键集一致，有回归断言）。出现闭集之外的字段
 * （`userId`、`roles`、`scope`、`groupId`、`status`…）一律 400，而不是「静默忽略」——
 * 客户端提交的归属、权限、范围与状态不是「被忽略的输入」，而是明确不被接受的输入，
 * 必须留下可观测的拒绝记录。
 *
 * 读取契约：存储记录在离开进程前必须满足本结构（枚举闭集 + 状态与推荐条数自洽 + ISO 时间），
 * 并额外做**值级 PII 扫描**（理由/建议里出现手机号、身份证号即拒绝外发）。未知状态、
 * 状态与条数矛盾、含敏感文本都属于服务端缺陷：绝不允许把这些内容当作正常输出返回。
 *
 * 输出白名单：对外视图逐字段显式赋值（见 `MATCHING_REQUEST_VIEW_FIELDS`），
 * **不含** `userId`（归属）、`inputSnapshotHash`（脱敏快照摘要，属内部处理记录），
 * 也不含任何学生画像原始字段（年级、专业、技能、经历摘要等一律不进入响应）——
 * 客户端因此没有任何可回传的归属/画像信息可用于伪造，模型输出也只能以
 * `groupId/score/reason/advice` 四条白名单字段出现。
 */

/** 发起接口声明的请求字段闭集：必须与共享 `matchingRequestInputSchema` 的键集一致（有回归断言） */
export const MATCHING_REQUEST_INPUT_FIELDS = ['profileVersion'] as const;

/**
 * 服务端独占字段（**禁止客户端提交**）：即使它们不在共享 schema 内，也必须给出可区分的
 * 拒绝原因，避免「以为是业务字段但被静默剥离」。这些字段只能来自服务端会话、状态机、
 * 召回来源或存储。
 */
export const FORBIDDEN_MATCHING_REQUEST_FIELDS = [
  'id',
  'requestId',
  'matchingRequestId',
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
  'status',
  'recommendations',
  'result',
  'groups',
  'modelVersion',
  'promptVersion',
  'fallbackUsed',
  'degradationCode',
  'inputSnapshotHash',
  'snapshotHash',
  'student',
  'candidates',
  'profile',
  'createdAt',
  'updatedAt',
] as const;

/**
 * 对外视图的字段白名单（顺序即文档顺序）。
 * 这是本接口对外契约的唯一来源：新增字段必须先登记到这里，并由
 * `matching.controller.spec.ts` 的「字段闭集」与「敏感值不泄露」用例守住。
 */
export const MATCHING_REQUEST_VIEW_FIELDS = [
  'id',
  'status',
  'profileVersion',
  'recommendations',
  'fallbackUsed',
  'modelVersion',
  'promptVersion',
  'degradationCode',
  'createdAt',
  'updatedAt',
] as const;

export type MatchingRequestViewField = (typeof MATCHING_REQUEST_VIEW_FIELDS)[number];

/** 读取契约违规、归属与会话主体不一致等内部缺陷的统一对外文案（共用同一句，避免区分内部原因） */
export const MATCHING_REQUEST_INTEGRITY_MESSAGE = '匹配数据完整性校验失败';

/** 存储记录读取契约：字段 + 状态闭集 + 状态/条数自洽 + ISO 时间戳 + 降级码闭集 */
export const storedMatchingRequestSchema = z
  .object({
    id: uuidSchema,
    userId: trimmedText(1, 64, '归属主体'),
    status: z.enum(MATCHING_REQUEST_STATUS_VALUES),
    profileVersion: z.number().int().min(1).max(1_000_000).optional(),
    inputSnapshotHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u, '输入快照摘要必须是 sha256 十六进制'),
    recommendations: matchingRecommendationListSchema,
    modelVersion: trimmedText(1, 64, '模型版本'),
    promptVersion: trimmedText(1, 64, '提示词版本'),
    fallbackUsed: z.boolean(),
    degradationCode: z.enum(AI_ERROR_CODE_VALUES).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((value, ctx) => {
    const count = value.recommendations.length;
    // 只有 completed 保证「有可展示结果」；pending（尚未产出）与另两个终态都必须为空
    if (value.status === MatchingRequestStatus.Completed) {
      if (count < MATCHING_MIN_RECOMMENDATIONS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recommendations'],
          message: `completed 状态必须携带至少 ${MATCHING_MIN_RECOMMENDATIONS} 条推荐`,
        });
      }
      return;
    }
    if (count > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recommendations'],
        message: `${value.status} 状态不得携带推荐结果`,
      });
    }
  });

export type StoredMatchingRequest = z.infer<typeof storedMatchingRequestSchema>;

/**
 * 对外视图：**不含** `userId` 与 `inputSnapshotHash`，也不含任何画像原始字段。
 * 推荐结果只以白名单化的四条字段出现（`MatchingRecommendationItem`）。
 */
export interface MatchingRequestView {
  id: string;
  status: StoredMatchingRequest['status'];
  profileVersion?: number;
  recommendations: MatchingRecommendationItem[];
  fallbackUsed: boolean;
  modelVersion: string;
  promptVersion: string;
  degradationCode?: StoredMatchingRequest['degradationCode'];
  createdAt: string;
  updatedAt: string;
}

export interface MatchingRequestContractIssue {
  readonly kind: 'invalid' | 'unexpected';
  readonly path: string;
}

export type StoredMatchingRequestParse =
  | { readonly ok: true; readonly value: StoredMatchingRequest }
  | { readonly ok: false; readonly issues: readonly MatchingRequestContractIssue[] };

/**
 * 校验并规范化一条存储记录（一次解析，避免「先断言后使用」的重复解析）。
 *
 * 除了结构校验，这里还做**值级 PII 扫描**：推荐理由/建议里出现手机号、身份证号等个人标识时，
 * 该记录不允许离开进程（结构合法但内容不可外发）。失败时只返回字段路径与违规类型，
 * 不返回字段取值。
 */
export function parseStoredMatchingRequest(record: unknown): StoredMatchingRequestParse {
  const parsed = storedMatchingRequestSchema.safeParse(record);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        kind: issue.code === 'unrecognized_keys' ? ('unexpected' as const) : ('invalid' as const),
        path: issue.path.join('.') || '(root)',
      })),
    };
  }
  if (findPiiKeys(parsed.data.recommendations).length > 0) {
    return { ok: false, issues: [{ kind: 'invalid', path: 'recommendations' }] };
  }
  return { ok: true, value: parsed.data };
}

/** 校验后的存储记录 → 对外视图（逐字段显式赋值，不使用对象展开） */
export function toMatchingRequestView(record: StoredMatchingRequest): MatchingRequestView {
  return {
    id: record.id,
    status: record.status,
    ...(record.profileVersion !== undefined ? { profileVersion: record.profileVersion } : {}),
    recommendations: record.recommendations.map((item) => ({
      groupId: item.groupId,
      score: item.score,
      reason: item.reason,
      advice: item.advice,
    })),
    fallbackUsed: record.fallbackUsed,
    modelVersion: record.modelVersion,
    promptVersion: record.promptVersion,
    ...(record.degradationCode ? { degradationCode: record.degradationCode } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * 字段闭集门禁：请求体出现未声明字段时抛 `ZodError`，由 `ApiExceptionFilter` 统一映射为
 * 400 `VALIDATION_FAILED` + `details.issues`。
 *
 * `path` 指向违规字段本身，`message` 区分「服务端独占字段」与「未声明字段」：
 * 前者是必须显式拒绝的越权尝试（归属/角色/范围/状态/推荐结果），后者是契约漂移。
 * 非对象请求体（缺体、`null`、数组、标量）不在这里拒绝，交给字段级 schema 判非法。
 */
export function assertDeclaredMatchingRequestInputFields(body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;

  const declared: readonly string[] = MATCHING_REQUEST_INPUT_FIELDS;
  const forbidden: readonly string[] = FORBIDDEN_MATCHING_REQUEST_FIELDS;
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

export type RecommendationCheck =
  | { readonly ok: true; readonly value: MatchingRecommendationItem[] }
  | { readonly ok: false; readonly cause: 'schema' | 'pii' };

/**
 * 推荐结果外发前的最后一道门：结构（共享 schema，含 UUID/分数/长度/内容安全）
 * **加**值级 PII 扫描（理由或建议里出现手机号、身份证号等个人标识即拒绝）。
 *
 * 两道检查都不返回命中内容，只返回一个原因码，调用方据此决定「降级」还是「按服务端缺陷处理」。
 */
export function checkMatchingRecommendations(raw: unknown): RecommendationCheck {
  const parsed = matchingRecommendationListSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, cause: 'schema' };
  }
  if (findPiiKeys(parsed.data).length > 0) {
    return { ok: false, cause: 'pii' };
  }
  return { ok: true, value: parsed.data.map((item) => ({ ...item })) };
}

/** 供测试与调用方复用：记录归属主体（不可读时返回空串，交由调用方按服务端缺陷处理） */
export function readMatchingRequestOwnerId(record: {
  readonly userId?: unknown;
}): string {
  return typeof record.userId === 'string' ? record.userId : '';
}
