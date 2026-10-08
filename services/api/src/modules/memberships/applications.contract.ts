import { z } from 'zod';
import {
  APPLICATION_KIND_VALUES,
  APPLICATION_STATUS_VALUES,
  ApplicationKind,
  ApplicationStatus,
  trimmedText,
  uuidSchema,
} from '@rm/shared';
import type { Application } from './applications.port';

/**
 * 入组申请切片的**输入闭集**、**服务端独占字段清单**与**读取契约**。
 *
 * 输入闭集：创建接口只接受 `APPLICATION_INPUT_FIELDS`（与共享 `joinApplicationInputSchema`
 * 的键集一致，有回归断言）。出现闭集之外的字段（`status`、`reviewStatus`、`userId`、`roles`、
 * `scope`、`groupIds`、`kind`…）一律 400，而不是「静默忽略」——客户端提交的审核状态、归属、
 * 角色与范围不是「被忽略的输入」，而是明确不被接受的输入，必须留下可观测的拒绝记录。
 *
 * `groupId` 的定位（刻意与 `groupIds` 区分）：
 * - **单数 `groupId` 是申请目标小组**，是业务字段：契约基线明确要求
 *   `POST /join-applications` 请求包含 `groupId`（docs/P2-API契约基线.md §核心请求约束）；
 * - **复数 `groupIds` / `scope` / `dataScope` 是授权声明**，属于服务端会话解析结果，
 *   客户端提交一律 400；授权判定的 `scope` 恒为服务端常量 `SELF`，目标小组从不进入判定；
 * - 因此本切片既满足契约基线，又保证客户端无法用任何提交字段影响授权结果。
 *
 * 读取契约：存储记录在离开进程前必须满足本结构（含枚举闭集与 ISO 时间戳）。未知枚举
 * （例如数据库迁移先于代码上线、或数据被外部改写）属于服务端缺陷：由 service 判为 500，
 * 绝不允许把未知状态当作合法值返回给调用方。
 *
 * 对外视图：**不含** `userId`（归属）、`reviewedByUserId`（审核人身份）、`reviewComment`
 * 与 `reviewedAt`（内部处理记录）。审核字段属于后续审核切片的输出边界，本切片在读取契约里
 * 校验它们的存储形状（违规 500），但**绝不**投影到任何响应里：客户端因此没有任何可回传的
 * 归属/审核信息可用于伪造。
 */

/** 创建接口声明的请求字段闭集：必须与共享 `joinApplicationInputSchema` 的键集一致（有回归断言） */
export const APPLICATION_INPUT_FIELDS = ['groupId', 'note'] as const;

/**
 * 服务端独占字段（**禁止客户端提交**）：即使它们不在共享 schema 内，也必须给出可区分的拒绝原因，
 * 避免「以为是业务字段但被静默剥离」。这些字段的取值只能来自服务端状态机、会话或存储。
 */
export const FORBIDDEN_APPLICATION_FIELDS = [
  'id',
  'applicationId',
  'userId',
  'applicantId',
  'ownerUserId',
  'groupIds',
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
  'decision',
  'reviewedByUserId',
  'reviewerId',
  'reviewComment',
  'reviewedAt',
  'membershipId',
  'auditEventId',
  'createdAt',
  'updatedAt',
] as const;

/**
 * 服务端写入的申请初始状态。
 * 共享状态机中没有任何转移指向 `pending`（回归断言守住），因此它是唯一合法的入口状态；
 * 审核态（approved/rejected/completed）只能由后续审核切片在授权与事务中推进。
 */
export const APPLICATION_INITIAL_STATUS = ApplicationStatus.Pending;

/** 本切片承载的申请类型（入组）；退组申请属于后续切片，客户端不能通过 `kind` 改写 */
export const APPLICATION_SLICE_KIND = ApplicationKind.Join;

/** 存储记录读取契约：字段 + 枚举闭集 + ISO 时间戳 */
export const storedApplicationSchema = z.object({
  id: uuidSchema,
  userId: trimmedText(1, 64, '归属主体'),
  groupId: uuidSchema,
  kind: z.enum(APPLICATION_KIND_VALUES),
  note: trimmedText(0, 1000, '申请备注').optional(),
  status: z.enum(APPLICATION_STATUS_VALUES),
  reviewedByUserId: trimmedText(1, 64, '审核人').optional(),
  reviewComment: trimmedText(0, 500, '审核意见').optional(),
  reviewedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type StoredApplication = z.infer<typeof storedApplicationSchema>;

/**
 * 对外视图：**不含** `userId`，也**不含**审核人/审核意见/审核时间与审计事件 ID。
 * 归属与审核处理记录不随响应回传，客户端没有任何可回传的归属信息可用于伪造。
 */
export interface ApplicationView {
  id: string;
  groupId: string;
  kind: StoredApplication['kind'];
  note?: string;
  status: StoredApplication['status'];
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationContractIssue {
  readonly kind: 'invalid' | 'unexpected';
  readonly path: string;
}

export type StoredApplicationParse =
  | { readonly ok: true; readonly value: StoredApplication }
  | { readonly ok: false; readonly issues: readonly ApplicationContractIssue[] };

/**
 * 校验并规范化一条存储记录（一次解析，避免「先断言后使用」的重复解析）。
 * 失败时只返回字段路径与违规类型，不返回字段取值。
 */
export function parseStoredApplication(record: unknown): StoredApplicationParse {
  const parsed = storedApplicationSchema.safeParse(record);
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
export function toApplicationView(record: StoredApplication): ApplicationView {
  return {
    id: record.id,
    groupId: record.groupId,
    kind: record.kind,
    ...(record.note ? { note: record.note } : {}),
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * 字段闭集门禁：请求体出现未声明字段时抛 `ZodError`，由 `ApiExceptionFilter` 统一映射为
 * 400 `VALIDATION_FAILED` + `details.issues`。
 *
 * `path` 指向违规字段本身，`message` 区分「服务端独占字段」与「未声明字段」：
 * 前者是必须显式拒绝的越权尝试（审核状态、归属、角色/范围），后者是契约漂移，
 * 两者都要能被观测到。
 * 非对象请求体（缺体、`null`、数组、标量）不在这里拒绝，交给字段级 schema 判非法。
 */
export function assertDeclaredApplicationInputFields(body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;

  const declared: readonly string[] = APPLICATION_INPUT_FIELDS;
  const forbidden: readonly string[] = FORBIDDEN_APPLICATION_FIELDS;
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

/**
 * 撤回接口的请求体闭集**为空**：唯一输入是路径里的申请 ID，任何请求体字段（尤其是 `status`
 * 这类状态声明）都必须被显式拒绝，而不是被忽略。
 */
export function assertNoWithdrawBodyFields(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;

  if (Array.isArray(body)) {
    throw new z.ZodError([
      {
        code: 'unrecognized_keys' as const,
        keys: ['(array)'],
        path: [] as (string | number)[],
        message: '撤回申请不接受请求体',
      },
    ]);
  }

  const keys = Object.keys(body);
  if (keys.length === 0) return;

  throw new z.ZodError(
    keys.map((key) => ({
      code: 'unrecognized_keys' as const,
      keys: [key],
      path: [key] as (string | number)[],
      message: `撤回申请不接受请求体字段 ${key}`,
    })),
  );
}

/** 供测试与调用方复用：记录归属主体（不可读时返回空串，交由授权判定默认拒绝） */
export function readApplicationOwnerId(record: Application): string {
  return typeof record.userId === 'string' ? record.userId : '';
}
