import { z } from 'zod';
import { riskFreeText, trimmedText, uuidSchema } from '@rm/shared';
import {
  NOTIFICATION_STATUS_VALUES,
  NOTIFICATION_TYPE_VALUES,
  NotificationStatus,
} from './notifications.port';

/**
 * 站内通知切片的**输入闭集**、**读取契约**与**输出白名单**。
 *
 * 输入闭集（两条路由都不接受任何「授权/归属声明」）：
 * - 两个端点都**不声明任何查询参数**：`?userId=`/`?roles=`/`?scope=`/`?groupId=` 等一律 400，
 *   而不是「恰好没读它」——客户端提交的归属与权限声明不是被忽略的输入，而是明确不被接受的输入；
 * - `PATCH .../{notificationId}/read` **不接受任何请求体字段**：标记已读是纯状态变更，
 *   唯一输入是路径里的通知 ID；`status`/`read`/`readAt`/`userId`/`roles`/`scope` 等服务端字段
 *   出现即 400（给出可区分的拒绝原因）；
 * - 路径参数必须是 UUID：本切片的主键形态是 UUID，`not-a-uuid` 在取数之前即被拒绝（400），
 *   因此「非法 ID」与「合法但不可见」在状态码上可区分，而「不可见」的两种成因（不存在 /
 *   非本人所有）则不可区分（见下）。
 *
 * 读取契约（存储记录离开进程前的最后一道门）：字段类型、枚举闭集、ISO 时间戳，外加两条
 * **跨字段不变式**：`read` 必须带服务端 `readAt`，`unread` 不得携带 `readAt`。未知枚举
 * （例如数据库迁移先于代码上线，或数据被外部改写）属于服务端缺陷：按 500 处理，
 * 绝不允许把未知状态当成合法值返回。
 *
 * 输出白名单：对外视图**恰好**是 `NOTIFICATION_VIEW_FIELDS` 这些字段，且出口再过一遍
 * `.strict()` 闭集——多出字段即 500，绝不外发。视图**不含** `userId`（归属）：自读范围下
 * 调用方本来就是归属主体本人，响应里不需要、也不应该携带归属字段，因此客户端没有任何
 * 可回传的归属信息可用于伪造。
 *
 * PII 防线：标题与正文按共享 `riskFreeText` 校验（身份证号、长数字标识、疑似密钥一律命中）。
 * 命中即视为存储损坏（500），**且日志只写字段路径、不写取值**，因此即使通知正文被写入
 * 了身份证号或密钥，也不会经由本切片的任何响应或日志外发。
 */

/** 对外视图字段白名单（顺序用于文档与回归断言） */
export const NOTIFICATION_VIEW_FIELDS = [
  'id',
  'type',
  'title',
  'body',
  'status',
  'createdAt',
  'readAt',
  'updatedAt',
] as const;

/** 对外视图的必需字段（`readAt` 只在已读记录上出现，故不在必需集合内） */
export const NOTIFICATION_VIEW_REQUIRED_FIELDS = [
  'id',
  'type',
  'title',
  'body',
  'status',
  'createdAt',
  'updatedAt',
] as const;

/** 读取契约违规的统一对外文案（与其它切片一致：不区分内部原因，细节只进日志） */
export const NOTIFICATION_INTEGRITY_MESSAGE = '通知数据完整性校验失败';

/**
 * 单条通知不可见时的统一文案：**不存在**与**非本人所有**共用同一状态码（404）与同一文案，
 * 因此调用方无法用「404 vs 403」「不同文案」构造存在性探测。
 */
export const NOTIFICATION_NOT_VISIBLE_MESSAGE = '目标通知不存在或不可见';

/**
 * 跨字段不变式：阅读状态与已读时间必须自洽。
 * 两种违规都指向 `readAt`，且不携带取值，便于日志给出可定位但不含敏感内容的路径。
 */
function assertReadAtMatchesStatus(
  record: { readonly status: NotificationStatus; readonly readAt?: string },
  ctx: z.RefinementCtx,
): void {
  if (record.status === NotificationStatus.Read && record.readAt === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['readAt'],
      message: '已读通知必须带服务端已读时间',
    });
  }
  if (record.status === NotificationStatus.Unread && record.readAt !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['readAt'],
      message: '未读通知不得携带已读时间',
    });
  }
}

/** 存储记录读取契约：字段 + 枚举闭集 + ISO 时间戳 + 「状态/已读时间」不变式 + 免 PII 文本 */
export const storedNotificationSchema = z
  .object({
    id: uuidSchema,
    userId: trimmedText(1, 64, '归属主体'),
    type: z.enum(NOTIFICATION_TYPE_VALUES),
    title: riskFreeText(1, 200, '通知标题'),
    body: riskFreeText(0, 2000, '通知正文'),
    status: z.enum(NOTIFICATION_STATUS_VALUES),
    createdAt: z.string().datetime(),
    readAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime(),
  })
  .superRefine(assertReadAtMatchesStatus);

export type StoredNotification = z.infer<typeof storedNotificationSchema>;

/** 对外视图读取契约：白名单闭集（`.strict()` 使「多出字段」成为可检测的违规） */
export const notificationViewSchema = z
  .object({
    id: uuidSchema,
    type: z.enum(NOTIFICATION_TYPE_VALUES),
    title: riskFreeText(1, 200, '通知标题'),
    body: riskFreeText(0, 2000, '通知正文'),
    status: z.enum(NOTIFICATION_STATUS_VALUES),
    createdAt: z.string().datetime(),
    readAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine(assertReadAtMatchesStatus);

/**
 * 对外视图：**不含** `userId`（归属），也不含任何内部处理记录。
 * 归属不随响应回传，客户端因此没有任何可回传的归属信息可用于伪造。
 */
export interface NotificationView {
  id: string;
  type: StoredNotification['type'];
  title: string;
  body: string;
  status: StoredNotification['status'];
  createdAt: string;
  readAt?: string;
  updatedAt: string;
}

export interface NotificationContractIssue {
  readonly kind: 'invalid' | 'unexpected';
  readonly path: string;
}

export type StoredNotificationParse =
  | { readonly ok: true; readonly value: StoredNotification }
  | { readonly ok: false; readonly issues: readonly NotificationContractIssue[] };

export type NotificationViewParse =
  | { readonly ok: true; readonly value: NotificationView }
  | { readonly ok: false; readonly issues: readonly NotificationContractIssue[] };

/**
 * 把 zod 的 issue 归一为「字段路径 + 违规类型」，**不回传字段取值**。
 * 多出字段（`unrecognized_keys`）的键名在 `issue.keys` 里而不在 `issue.path` 上，
 * 因此逐键展开为一条 issue，避免把「多了哪个字段」丢成 `(root)`。
 */
function toIssues(error: z.ZodError): NotificationContractIssue[] {
  const issues: NotificationContractIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        issues.push({ kind: 'unexpected', path: key });
      }
      continue;
    }
    issues.push({ kind: 'invalid', path: issue.path.join('.') || '(root)' });
  }
  return issues;
}

/** 校验并规范化一条存储记录（失败时只给字段路径与违规类型，不给取值） */
export function parseStoredNotification(record: unknown): StoredNotificationParse {
  const parsed = storedNotificationSchema.safeParse(record);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return { ok: false, issues: toIssues(parsed.error) };
}

/** 出口门禁：对外视图必须是白名单闭集（多出字段、非法字段值一律违规） */
export function parseNotificationView(view: unknown): NotificationViewParse {
  const parsed = notificationViewSchema.safeParse(view);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return { ok: false, issues: toIssues(parsed.error) };
}

/** 校验后的存储记录 → 对外视图（逐字段显式赋值，不使用对象展开，避免未知字段外泄） */
export function toNotificationView(record: StoredNotification): NotificationView {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    body: record.body,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.readAt ? { readAt: record.readAt } : {}),
    updatedAt: record.updatedAt,
  };
}

/**
 * 标记已读的**状态机**（唯一前向边 `unread -> read`，且幂等）：
 * - `unread` → 返回新记录：`status = read`、`readAt = now`、`updatedAt = now`；
 * - `read`（终态）→ 原样返回 `changed = false`：不写库、不改写 `readAt`，
 *   因此重复请求不会产生第二次状态变化，也不会让「已读时间」随重试漂移。
 *
 * 只改状态与时间戳：归属、类型、标题、正文、创建时间逐字段沿用存储值（显式赋值而非展开），
 * 避免把未知字段带进存储。
 */
export function markNotificationRead(
  record: StoredNotification,
  now: string,
): { readonly changed: boolean; readonly record: StoredNotification } {
  if (record.status === NotificationStatus.Read) {
    return { changed: false, record };
  }
  return {
    changed: true,
    record: {
      id: record.id,
      userId: record.userId,
      type: record.type,
      title: record.title,
      body: record.body,
      status: NotificationStatus.Read,
      createdAt: record.createdAt,
      readAt: now,
      updatedAt: now,
    },
  };
}

/** 路径参数闭集：唯一的路径输入是通知 ID，且必须是 UUID */
export const notificationIdParamsSchema = z.object({ notificationId: uuidSchema });

/** 两个端点声明的查询参数闭集：**空集**（`/me/notifications*` 不接受任何查询参数） */
export const NOTIFICATION_QUERY_FIELDS = [] as const;

/**
 * 服务端独占的查询串声明（**禁止客户端提交**）：这些名字是授权/归属口径
 * （身份、角色、范围、小组归属、权限点），只能来自服务端会话与常量。
 */
export const FORBIDDEN_NOTIFICATION_QUERY_FIELDS = [
  'userId',
  'userIds',
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
] as const;

/**
 * 查询串闭集门禁：出现任何查询参数即抛 `ZodError`，由 `ApiExceptionFilter` 统一映射为
 * 400 `VALIDATION_FAILED` + `details.issues`（`path` 指向违规参数本身）。
 *
 * 非对象查询（`undefined`／`null`，即无查询串）不在这里拒绝：那是「没有输入」的正常情况。
 * 重复参数（如 `?userId=a&userId=b`）在 Express 下会解析成数组，但键名仍然违规，因此同样被拒绝。
 */
export function assertDeclaredNotificationQueryFields(query: unknown): void {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) return;

  const declared: readonly string[] = NOTIFICATION_QUERY_FIELDS;
  const forbidden: readonly string[] = FORBIDDEN_NOTIFICATION_QUERY_FIELDS;
  const unexpected = Object.keys(query).filter((key) => !declared.includes(key));
  if (unexpected.length === 0) return;

  throw new z.ZodError(
    unexpected.map((key) => ({
      code: 'unrecognized_keys' as const,
      keys: [key],
      path: [key] as (string | number)[],
      message: forbidden.includes(key)
        ? `禁止使用查询参数 ${key}（授权与归属只来自服务端会话）`
        : `本端点不接受查询参数 ${key}`,
    })),
  );
}

/** 标记已读声明的请求体字段闭集：**空集**（唯一输入是路径里的通知 ID） */
export const NOTIFICATION_PATCH_BODY_FIELDS = [] as const;

/**
 * 服务端独占的请求体字段（**禁止客户端提交**）：状态、已读时间与归属只能由服务端写入。
 * 即使它们不在任何 schema 内，也要给出与「未声明字段」可区分的拒绝原因，
 * 避免「以为是业务字段但被静默剥离」。
 */
export const FORBIDDEN_NOTIFICATION_BODY_FIELDS = [
  'id',
  'notificationId',
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
  'read',
  'isRead',
  'readAt',
  'createdAt',
  'updatedAt',
] as const;

/**
 * 请求体闭集门禁：标记已读**不接受任何请求体字段**，出现即抛 `ZodError` → 400。
 *
 * 非对象请求体（缺体、`null`、数组、标量）不在这里拒绝：缺体是「没有输入」的正常情况；
 * 数组与标量交给 `path`/输入类型判定，本函数只负责「多出了不该有的字段」这一类违规。
 */
export function assertNoNotificationPatchBodyFields(body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;

  const declared: readonly string[] = NOTIFICATION_PATCH_BODY_FIELDS;
  const forbidden: readonly string[] = FORBIDDEN_NOTIFICATION_BODY_FIELDS;
  const unexpected = Object.keys(body).filter((key) => !declared.includes(key));
  if (unexpected.length === 0) return;

  throw new z.ZodError(
    unexpected.map((key) => ({
      code: 'unrecognized_keys' as const,
      keys: [key],
      path: [key] as (string | number)[],
      message: forbidden.includes(key)
        ? `禁止设置服务端字段 ${key}`
        : `本端点不接受请求体字段 ${key}`,
    })),
  );
}

/**
 * 记录归属主体：不可读（缺失/非字符串/空串）时返回空串。
 * 调用方据此把「归属不可读」并入「非本人所有」这一统一不可见路径，
 * 而不是因为存储损坏就把存在性细节泄露给非归属方。
 */
export function readNotificationOwnerId(record: { readonly userId?: unknown }): string {
  return typeof record.userId === 'string' && record.userId !== '' ? record.userId : '';
}
