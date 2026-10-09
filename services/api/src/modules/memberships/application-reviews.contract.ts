import { z } from 'zod';
import {
  ApplicationStatus,
  ReviewDecision,
  APPLICATION_KIND_VALUES,
  trimmedText,
  uuidSchema,
} from '@rm/shared';
import { parseStoredApplication } from './applications.contract';
import type { StoredApplication, StoredApplicationParse } from './applications.contract';

/**
 * 入组申请**团队审核端**的输入闭集与输出视图。
 *
 * ## 输入闭集
 * 审核动作只接受 `REVIEW_INPUT_FIELDS`（`decision` / `comment`）。取值与「驳回必填意见」的规则
 * **不在本文件重新定义**：直接复用 `@rm/shared` 的 `applicationReviewInputSchema`（本文件有回归断言
 * 钉住键集一致），因此 API 层与共享校验、以及未来的 RuoYi 端不会出现两套审核词汇。
 *
 * 闭集之外的字段一律 400，尤其是 `FORBIDDEN_REVIEW_FIELDS` 里的服务端字段：
 * 客户端提交的 `status` / `reviewStatus` / `userId` / `roles` / `scope` / `groupId` 不是
 * 「被忽略的输入」，而是**明确不被接受**的输入，必须留下可观测的拒绝记录。
 * 注意 zod 默认会**静默剥离**未声明键，所以「拒绝」必须在 zod 之前由 `assertDeclaredReviewInputFields`
 * 完成 —— 否则一次越权尝试会表现为「字段没生效」，而不是「请求被拒绝」。
 *
 * ## 为什么审核端**不**接受 `groupId`
 * 申请人端把 `groupId` 当业务字段（申请目标小组）。审核端的 `groupId` 只有在一种意义上合法：
 * 「把已授权的可见范围缩小到某一个小组」。但那个决定已经由**服务端范围**表达了
 * （`ApplicationReviewScope`），而列表接口另有一条只读查询参数承担缩小范围的角色。
 * 因此审核**动作**（`POST /admin/applications/{id}/review`）的请求体里出现 `groupId` 只可能是
 * 客户端试图影响授权结果或改写归属，必须拒绝；审核记录的小组归属**只能**取自存储记录。
 *
 * ## 输出视图
 * `ApplicationReviewView` 是**审核端专用**视图，与申请人视图 `ApplicationView` 刻意不同：
 * - 它**包含** `applicantUserId` —— 审核者必须知道自己在审谁的申请，这是审核动作的对象本身；
 * - 它**不含**申请人视图那套「归属不外泄」的裁剪理由：申请人视图排除 `userId` 是为了让申请人
 *   没有任何可回传的归属信息，而审核端的受众是**已被服务端范围授权**的审核者，可见性由
 *   SQL 里的范围谓词界定（范围外的记录根本不出库）。
 * 两个视图的字段集差异是**刻意的**，不是漂移：共用的只有存储读取契约，不是投影。
 * 审核端视图同样**不含**任何可用于伪装的字段（没有 `scope` / `roles` / `permissions`）。
 *
 * 后续切片应把 `applicantUserId` 换成学生资料的最小投影（脱敏姓名/学号），
 * 让审核端不再直接暴露会话主体标识；在此之前本切片如实返回该标识，并把它限定在范围内。
 */

/** 审核动作的请求字段闭集：必须与共享 `applicationReviewInputSchema` 的键集一致（有回归断言） */
export const REVIEW_INPUT_FIELDS = ['decision', 'comment'] as const;

/**
 * 审核端**禁止客户端提交**的字段。
 *
 * 分三类，都要能被区分出来（消息里只出现字段名，不出现字段取值）：
 * - 授权声明类（`roles` / `scope` / `permissions` / `groupIds` / `assignedResourceIds`）；
 * - 归属与身份类（`userId` / `applicantId` / `ownerUserId` / `reviewedByUserId` / `reviewerId`）；
 * - 状态声明类（`status` / `reviewStatus` / `decision` 的别名 `kind` / `type` 等）。
 *
 * `groupId` 也在其中：审核动作的目标小组只能来自存储记录，客户端不得提供。
 */
export const FORBIDDEN_REVIEW_FIELDS = [
  'id',
  'applicationId',
  'userId',
  'applicantId',
  'ownerUserId',
  'groupIds',
  'groupId',
  'role',
  'roles',
  'scope',
  'dataScope',
  'permissions',
  'permissionPoints',
  'assignedResourceIds',
  'kind',
  'applicationKind',
  'type',
  'status',
  'reviewStatus',
  'reviewedByUserId',
  'reviewerId',
  'reviewedAt',
  'membershipId',
  'auditEventId',
  'createdAt',
  'updatedAt',
] as const;

/**
 * 列表接口允许的只读查询参数闭集。
 *
 * 只有 `groupId`，且它的角色是**意图**而不是授权：service 必须先用授权端口判定该小组是否在
 * 服务端范围之内，再把范围**收窄**成一个新的服务端 scope；判定失败即 403，绝不因为客户端
 * 传了 `groupId` 就把范围交给它。未列出的查询参数一律 400。
 */
export const REVIEW_QUERY_FIELDS = ['groupId'] as const;

/**
 * 审核决定 → 申请目标状态。
 *
 * 用显式映射而不是字符串拼接：共享 `ReviewDecision` 的取值（`approve`/`reject`）与
 * `ApplicationStatus` 的取值（`approved`/`rejected`）**拼写不同**，靠 `decision + 'd'` 之类的
 * 推导会在任一常量改名时静默产生一个不存在的状态。显式映射让改名变成编译错误。
 */
export function reviewDecisionToApplicationStatus(decision: ReviewDecision): ApplicationStatus {
  switch (decision) {
    case ReviewDecision.Approve:
      return ApplicationStatus.Approved;
    case ReviewDecision.Reject:
      return ApplicationStatus.Rejected;
    default: {
      // 穷尽性检查：共享枚举新增取值时这里会编译失败，而不是在运行时返回 undefined
      const exhaustive: never = decision;
      throw new Error(`未知审核决定: ${String(exhaustive)}`);
    }
  }
}

/** 审核端对外视图：见文件头的投影说明 */
export interface ApplicationReviewView {
  id: string;
  /** 申请人（审核对象）：审核端合法可见，且只在服务端范围之内返回 */
  applicantUserId: string;
  groupId: string;
  kind: StoredApplication['kind'];
  note?: string;
  status: StoredApplication['status'];
  reviewedByUserId?: string;
  reviewComment?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 校验后的存储记录 → 审核端视图（逐字段显式赋值，不使用对象展开） */
export function toApplicationReviewView(record: StoredApplication): ApplicationReviewView {
  return {
    id: record.id,
    applicantUserId: record.userId,
    groupId: record.groupId,
    kind: record.kind,
    ...(record.note ? { note: record.note } : {}),
    status: record.status,
    ...(record.reviewedByUserId ? { reviewedByUserId: record.reviewedByUserId } : {}),
    ...(record.reviewComment ? { reviewComment: record.reviewComment } : {}),
    ...(record.reviewedAt ? { reviewedAt: record.reviewedAt } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** 读取契约复用申请人端那一份（同一张表、同一份存储契约），只在此处转发便于审核端引用 */
export function parseReviewedApplication(record: unknown): StoredApplicationParse {
  return parseStoredApplication(record);
}

/** 字段路径 + 违规类型（**绝不含字段取值**） */
function unexpectedFieldIssues(
  keys: readonly string[],
  forbidden: readonly string[],
  context: string,
): z.ZodError {
  return new z.ZodError(
    keys.map((key) => ({
      code: 'unrecognized_keys' as const,
      keys: [key],
      path: [key] as (string | number)[],
      message: forbidden.includes(key)
        ? `禁止设置服务端字段 ${key}`
        : `${context}包含未声明字段 ${key}`,
    })),
  );
}

/**
 * 审核动作请求体闭集门禁：出现闭集之外的字段即抛 `ZodError`（由统一异常过滤器映射为 400）。
 *
 * 非对象请求体（缺体、`null`、数组、标量）不在这里拒绝，交给字段级 schema 判非法 ——
 * 与申请人端的口径一致，避免把「形状错误」和「越权字段」混成同一类拒绝原因。
 */
export function assertDeclaredReviewInputFields(body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;

  const declared: readonly string[] = REVIEW_INPUT_FIELDS;
  const forbidden: readonly string[] = FORBIDDEN_REVIEW_FIELDS;
  const unexpected = Object.keys(body).filter((key) => !declared.includes(key));
  if (unexpected.length === 0) return;

  throw unexpectedFieldIssues(unexpected, forbidden, '请求体');
}

/**
 * 列表查询参数闭集门禁：只允许 `REVIEW_QUERY_FIELDS`。
 *
 * 与请求体不同，查询参数在语义上必须是**标量**：`?groupId=a&groupId=b` 会让 NestJS 交出数组，
 * 而「客户端自定义一个小组集合」正是范围谓词最容易被绕开的地方，因此数组一律拒绝。
 */
export function assertDeclaredReviewQueryFields(query: unknown): void {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) return;

  const declared: readonly string[] = REVIEW_QUERY_FIELDS;
  const unexpected = Object.keys(query).filter((key) => !declared.includes(key));
  if (unexpected.length > 0) {
    throw unexpectedFieldIssues(unexpected, FORBIDDEN_REVIEW_FIELDS, '查询参数');
  }

  const groupId = (query as { groupId?: unknown }).groupId;
  if (Array.isArray(groupId)) {
    throw new z.ZodError([
      {
        code: 'unrecognized_keys' as const,
        keys: ['groupId'],
        path: ['groupId'],
        message: '查询参数 groupId 只允许出现一次',
      },
    ]);
  }
}

/** 列表查询参数（闭集校验后）：`groupId` 是「收窄范围」的意图，不是授权 */
export interface ReviewListQuery {
  readonly groupId?: string;
}

/**
 * 从闭集校验后的查询参数里取出**已声明**的 `groupId`。
 *
 * 刻意只做「取出 + 空串归一」：格式与授权判定分别由共享 schema 与授权端口完成，
 * 本函数不做任何安全判定（它对越权完全不设防，因此**不得**被单独使用）。
 */
export function readReviewListGroupId(query: unknown): string | undefined {
  if (typeof query !== 'object' || query === null) return undefined;
  const value = (query as { groupId?: unknown }).groupId;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 路径参数 schema：申请 ID 必须是 UUID */
export const reviewApplicationIdSchema = z.object({ applicationId: uuidSchema });

/**
 * 列表查询参数 `groupId` 的**形状**契约（授权判定之后才会用到）。
 *
 * 形状与授权是两件事：形状非法 → 400（客户端输入错误）；形状合法但不在服务端范围内 → 403。
 * 先做授权再做形状校验的顺序由 service 固定，本 schema 只承担形状那一半。
 */
export const reviewListGroupIdSchema = z.object({ groupId: uuidSchema });

/** 审核意见的最大长度（与 `join_applications.review_comment` 的列约束一致） */
export const REVIEW_COMMENT_MAX_LENGTH = 500;

/** 审核意见（可选）的字段级 schema：复用共享裁剪规则，仅用于服务端写入前复核 */
export const reviewCommentSchema = trimmedText(0, REVIEW_COMMENT_MAX_LENGTH, '审核意见').optional();

export { APPLICATION_KIND_VALUES };
