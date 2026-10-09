import { z } from 'zod';
import { uuidSchema } from '@rm/shared';
import type { SqlExecutor } from '../../db/ports/sql-executor.port';
import {
  NOTIFICATION_VIEW_FIELDS,
  markNotificationRead,
  parseStoredNotification,
  storedNotificationSchema,
  type StoredNotification,
} from './notifications.contract';
import {
  NOTIFICATION_REPOSITORY_BACKEND_POSTGRES,
  NOTIFICATION_STATUS_VALUES,
  NOTIFICATION_TYPE_VALUES,
  NotificationStatus,
  NotificationType,
  type Notification,
  type NotificationRepository,
  type NotificationRepositoryCapabilities,
} from './notifications.port';

/**
 * 站内通知的 **PostgreSQL 仓储 adapter**。
 *
 * ## 装配方式（本切片的换绑点）
 * - **装配由业务模块的工厂决定**：`NotificationsModule` 经 `createNotificationRepository` 按
 *   「是否解析出 `DATABASE_URL`」分流——未配置时绑定 `InMemoryNotificationRepository`，
 *   配置时绑定本文件经 `createLazyPostgresNotificationRepository` 构造的**延迟建连**实现
 *   （表由迁移 `0010` 建立）。装配阶段一次都不碰数据库，因此「数据库已配置但依赖不就绪」
 *   由启动期门禁给出结构化违规，而不是在这里表现为一个数据库连接错误；
 * - **不引入** `pg` / Prisma / TypeORM 等驱动或 ORM 依赖：本文件只依赖驱动无关的
 *   `SqlExecutor` 端口（`db/ports/sql-executor.port.ts`），真实执行器由消费方在「启用数据库」
 *   那一步显式提供；
 * - **不声称生产可用**：能力声明固定为 `backend = postgres`、`persistent = true`、
 *   `productionReady = false`。在完成会话主体 UUID 收敛、`TRANSITION_REJECTED` 的 409 映射
 *   与依赖就绪登记（封存声明 + 集成测试证据）之前，`NODE_ENV=production`（或已配置数据库）
 *   的启动仍会被启动期门禁拒绝（`productionReady !== true` / `DEPENDENCY_NOT_VERIFIED`）。
 *
 * ## 为什么端口是异步的
 * 运行时端口 `NotificationRepository` 已是 Promise 语义（`notifications.port.ts`），service /
 * controller 与内存基线在同一片切片一起改成异步，因此不存在「同步绑定 + 异步实现混用」。
 * `AsyncNotificationRepository` 保留为**等价别名**（历史名称）。
 *
 * ## 与内存基线的语义对应（逐条可核对）
 * | 内存基线 | 本 adapter |
 * |---|---|
 * | `create` 同 ID 冲突抛错 | `INSERT … ON CONFLICT (id) DO NOTHING` 无返回行 → `CONFLICT` |
 * | `findById` 未命中返回 `undefined` | `WHERE id = $1 AND user_id = $2` 无行 → `undefined` |
 * | `listByUserId` 只返回该主体记录 | `WHERE user_id = $1`（归属下推）+ 逐条归属复核 |
 * | `save` 记录不存在抛错 | 条件写入未命中 + 诊断查询无行 → `NOT_FOUND` |
 *
 * 与内存基线的**唯一刻意差异**：内存基线是「同进程直接覆盖」，因此非法状态转移在存储层没有
 * 拦截点；数据库实现必须防并发与绕过路径，因此把「本次转移是否合法」下推为**条件写入**
 * （前驱集合由 `notifications.contract.ts` 的标记已读状态机求逆派生）。所有**合法**转移的语义
 * 逐字节一致；**非法**转移一律 fail-closed 且不产生任何写入。
 *
 * ## 安全边界（本文件的六条硬约束）
 * 1. **参数化 SQL + 固定标识符**：所有客户端可控的值一律走 `$1…$n` 占位符绑定；进入 SQL 文本的
 *    只有模块常量（表名、列清单、状态机派生的谓词），且都经过 `assertSqlIdentifier` 校验，
 *    不存在任何「值 → SQL 文本」的路径（占位符与参数由同一份列清单派生，不会数量漂移）；
 * 2. **显式字段映射 + 严格行契约**：数据库行必须满足严格（`.strict()`）的行契约（未知列、
 *    非法枚举、非 UUID、坏时间戳一律拒绝），再**逐字段显式映射**为领域记录（列 → 字段的对应
 *    关系由 `POSTGRES_NOTIFICATION_COLUMN_FIELDS` 单一事实来源给出，并另由
 *    `POSTGRES_NOTIFICATION_FIELD_COLUMNS` 在编译期强制「每个领域字段都有对应列」），最后再过一次
 *    `notifications.contract.ts` 的读取契约；任何一步不合规都 **fail-closed** 抛错，
 *    绝不把未登记字段、未知状态或半成品记录交给上层；
 * 3. **subject / 归属隔离**：`userId` 必须由调用方（service）从服务端会话主体写入，必须是合法、
 *    非空、规范小写形的 UUID（**存储 ID 域约束**，见 `notifications.port.ts`）；adapter
 *    不生成、不覆盖归属，并且**把归属下推进 SQL**：列表与单条读取都只返回请求主体的记录；
 *    返回行上再逐条复核归属（不一致即 `OWNER_VIOLATION`）——他人记录既不出库、也不得回流；
 * 4. **read 状态转换 fail-closed 且幂等**：`status` 只接受闭集取值；`save` 把「目标状态是否可由
 *    当前存储状态到达」派生为 `status::text = ANY($n::text[])` 条件谓词（前驱集合取自标记已读
 *    状态机的**逆映射**），非法转移**不命中任何行**、不产生任何写入，并由一次**归属范围内**的
 *    诊断查询区分 `NOT_FOUND`（记录不存在/归属不符）与 `TRANSITION_REJECTED`（转移非法）；
 *    `read` 是终态，因此对已读记录再写一次同样被拒绝——`readAt` 不可能被重复请求改写；
 *    `unread` 没有任何前驱，因此 `save` 也无法把记录写回未读；
 * 5. **公开视图不携带归属、内部 payload / 路径 / URL / storage handle 与 PII**：adapter 只在
 *    **内部存储记录**上承载 `userId`（不静默丢弃），对外裁剪由 `notifications.contract.ts` 的
 *    `toNotificationView` 负责；本文件显式声明**存储侧内部列**（`POSTGRES_NOTIFICATION_INTERNAL_COLUMNS`）
 *    与**公开输出裁剪列**（`POSTGRES_NOTIFICATION_VIEW_EXCLUDED_COLUMNS`），并在模块加载期自检
 *    「裁剪列及其映射字段绝不落在公开视图白名单内」（`assertNotificationViewExclusion`）；
 *    内部列刻意**不进入**列清单，因此既不进 SELECT / RETURNING，也不进领域对象；
 * 6. **个人级内容只走内部存储契约，绝不进日志与错误消息**：`title` / `body`（字段字典：个人级）
 *    在本人自读范围内是合法内容，因此不做对外裁剪以外的加工，但**绝不**写进错误消息与日志；
 *    错误消息**只带字段路径与违规类型**，避免把数据内容或注入载荷写进日志与错误响应。
 *
 * ## 尚未解决 / 已登记的前置（因此 productionReady 恒为 false）
 * 已落地：官方 `pg` 驱动引入（只出现在 `db/postgres/` 驱动层）；`notifications` 由迁移 `0010`
 * 建出（列清单与本文件 `POSTGRES_NOTIFICATION_COLUMNS` 双射）；端口改为异步；
 * 真实 PostgreSQL 集成验证（建表、主键冲突、按归属取数与排序、条件写入与并发重复标记已读）
 * 见 `db/postgres/__tests__/notifications-integration.spec.ts`（需 `TEST_DATABASE_URL`，未配置时明确 skip）。
 * **仍未落地**：会话主体 `userId` 收敛为 UUID（当前基线是 `u-student-1`，绑定数据库实现时被
 * `assertPostgresNotificationSubject` fail-closed 拒绝）；`TRANSITION_REJECTED` 的对外映射
 * （409 而不是 500）；依赖就绪登记表里的封存声明与验证证据。这些都已登记在
 * `POSTGRES_NOTIFICATION_REPOSITORY_VERIFICATION_STEPS` 里，不能只写声明。
 */

/** 表名：与 docs/P2-架构与数据设计.md §2 的 `notifications`（站内状态）及端口注释一致 */
export const POSTGRES_NOTIFICATION_TABLE = 'notifications';

/**
 * 列清单：同时定义 `SELECT` 输出列、`INSERT` 列顺序与 `RETURNING` 输出列。
 *
 * 刻意不写 `SELECT *`：存储层新增列（内部 payload、跳转路径、action URL、附件句柄、
 * 订阅消息收件标识、软删除时间、审计字段、幂等键）不会因为本文件没更新就自动流进领域对象；
 * 配合行契约的 `.strict()`，未登记列会被显式拒绝而不是被静默带出。
 */
export const POSTGRES_NOTIFICATION_COLUMNS = [
  'id',
  'user_id',
  'type',
  'title',
  'body',
  'status',
  'read_at',
  'created_at',
  'updated_at',
] as const;

/** 列 → 领域字段的唯一事实来源（编译期强制覆盖 `Notification` 的全部字段） */
export const POSTGRES_NOTIFICATION_COLUMN_FIELDS = Object.freeze({
  id: 'id',
  user_id: 'userId',
  type: 'type',
  title: 'title',
  body: 'body',
  status: 'status',
  read_at: 'readAt',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
} as const satisfies Record<(typeof POSTGRES_NOTIFICATION_COLUMNS)[number], keyof Notification>);

/**
 * 领域字段 → 列的**反向**映射：与 `POSTGRES_NOTIFICATION_COLUMN_FIELDS` 构成双射。
 *
 * 为什么两份都要：`satisfies Record<column, keyof Notification>` 只保证「每个列都落在领域字段上」
 * （列 → 字段方向），不能保证「每个领域字段都有列」。反向映射用
 * `satisfies Record<keyof Notification, column>` 补上另一方向，于是「新增领域字段但忘记补列」
 * 与「列名拼错」都成为编译错误，而不是运行期静默丢字段。它同时是本文件判定
 * 「写入记录出现未登记字段」的字段名集合来源。
 */
export const POSTGRES_NOTIFICATION_FIELD_COLUMNS = Object.freeze({
  id: 'id',
  userId: 'user_id',
  type: 'type',
  title: 'title',
  body: 'body',
  status: 'status',
  createdAt: 'created_at',
  readAt: 'read_at',
  updatedAt: 'updated_at',
} as const satisfies Record<keyof Notification, (typeof POSTGRES_NOTIFICATION_COLUMNS)[number]>);

/**
 * 归属列：只在服务端内部流转，同时也是 SQL 归属谓词（`WHERE user_id = $n`）唯一使用的列。
 * 它**不进入**公开视图，也绝不进入错误消息与日志（他人归属不得回流、也不得外泄）。
 */
export const POSTGRES_NOTIFICATION_OWNER_COLUMNS: readonly (typeof POSTGRES_NOTIFICATION_COLUMNS)[number][] =
  Object.freeze(['user_id']);

/**
 * **存储侧内部列**（本 adapter 的列清单里刻意**没有**它们）。
 *
 * 这些列承载通知生产侧的内部处理数据：订阅消息模板变量（`payload`）、小程序内部跳转路径
 * （`deep_link_path`）、外部跳转 URL（`action_url`）、附件存储句柄（`attachment_storage_handle`）
 * 与订阅消息收件标识（`recipient_openid`，PII）。它们**不进 SELECT / RETURNING / INSERT**，
 * 因此既不进领域记录、也不进公开视图；把它们显式登记出来，是为了让「不泄露内部 payload /
 * 路径 / URL / storage handle / PII」成为**可机器校验**的边界，而不是「恰好没查」。
 *
 * 该清单与字段字典的对应关系需在 `notifications` 草案定稿时一次性对齐（已登记在验证清单里）。
 */
export const POSTGRES_NOTIFICATION_INTERNAL_COLUMNS = Object.freeze([
  'payload',
  'deep_link_path',
  'action_url',
  'attachment_storage_handle',
  'recipient_openid',
] as const);
export type PostgresNotificationInternalColumn =
  (typeof POSTGRES_NOTIFICATION_INTERNAL_COLUMNS)[number];

/**
 * 个人级 / 高敏内容列：在**本人自读**范围内是合法内容（`title` / `body`），因此不裁剪为
 * 「不可读」；但**绝不**写进错误消息与日志。`recipient_openid` 是存储侧 PII，本 adapter
 * 根本不投影它（见上面的内部列清单）。
 */
export const POSTGRES_NOTIFICATION_PII_COLUMNS: readonly string[] = Object.freeze([
  'title',
  'body',
  'recipient_openid',
] as const);

/**
 * 本 adapter 侧**不进入公开输出**的列：归属 + 全部存储侧内部列。
 *
 * 对外裁剪由 `toNotificationView` 负责（逐字段显式赋值、不展开），本清单用于机器校验
 * 「adapter 不把归属与内部列投影出去」，与「自读范围下响应里没有可回传的归属/内部信息」
 * 这一契约一致。
 */
export const POSTGRES_NOTIFICATION_VIEW_EXCLUDED_COLUMNS: readonly string[] = Object.freeze([
  'user_id',
  ...POSTGRES_NOTIFICATION_INTERNAL_COLUMNS,
] as const);

/**
 * 写回（`save`）允许变更的列：标记已读只改这些。
 *
 * 刻意**不含** `id` / `user_id` / `type` / `title` / `body` / `created_at`：它们由
 * `POSTGRES_NOTIFICATION_IMMUTABLE_COLUMNS` 声明为不可变，写回后逐条复核（不一致即
 * `IDENTITY_MISMATCH` / `OWNER_VIOLATION`），因此「改写归属」「改通知类型」「改写标题/正文」
 * 「改创建时间」四条路径在存储层被关闭，而不是靠调用方自律。
 */
export const POSTGRES_NOTIFICATION_MUTABLE_COLUMNS = [
  'status',
  'read_at',
  'updated_at',
] as const satisfies readonly (typeof POSTGRES_NOTIFICATION_COLUMNS)[number][];

/** 不可变列：写回后必须与请求记录逐字节一致（`id`/`user_id` 另有专属错误码） */
export const POSTGRES_NOTIFICATION_IMMUTABLE_COLUMNS = [
  'id',
  'user_id',
  'type',
  'title',
  'body',
  'created_at',
] as const satisfies readonly (typeof POSTGRES_NOTIFICATION_COLUMNS)[number][];

/** 仓储能力：持久但**未验证**，因此生产环境仍会被持久化边界守卫拦下 */
export const POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES: NotificationRepositoryCapabilities =
  Object.freeze({
    backend: NOTIFICATION_REPOSITORY_BACKEND_POSTGRES,
    persistent: true,
    productionReady: false,
  });

/**
 * 转成生产可用前必须完成的验证清单（每一项都需要证据，不能只写声明）。
 *
 * 状态标注（本切片的进展；`productionReady` 仍为 false，因为**已落地不等于生产准入**）：
 * 1. 驱动依赖经评估后引入（`docs/P2-开源复用评估.md` 的 Prisma / TypeORM 比较结论）——**已落地**：
 *    官方 `pg` 已显式声明且只出现在 `db/postgres/` 驱动层；
 * 2. 对真实 PostgreSQL 的集成测试：建表迁移、`id` 主键冲突、按 `user_id` 取数与排序、
 *    **并发重复标记已读**（两个请求只有一个能命中条件写入）——**已落地**：
 *    `db/postgres/__tests__/notifications-integration.spec.ts`（需 `TEST_DATABASE_URL`，未配置时明确 skip）；
 * 3. `notifications` 由迁移 `0010_notifications.sql` 建出并执行验证（列清单与 `POSTGRES_NOTIFICATION_COLUMNS`
 *    双射；内部列清单与字段字典一次性对齐）——**已落地**；
 * 4. `NotificationRepository` 端口改为异步：service / controller 与其测试一起改——**已落地**；
 * 5. 会话主体 `userId` 收敛为 UUID（当前基线是 `u-student-1` 这类安全 ID，不满足存储 ID 域）
 *    ——**未落地**：绑定数据库实现时非 UUID 主体被 `assertPostgresNotificationSubject` fail-closed 拒绝；
 * 6. 路径参数 `notificationId` 收敛为**规范小写形**：读取契约只要求「是 UUID」，客户端可提交
 *    大写 UUID，而本 adapter 对域外查询键按「不存在」处理（见 `findById`），未收敛时大写 UUID
 *    会被判 404 而不是 400——**未落地**；
 * 7. 标记已读的**幂等**语义在存储层复核：重复请求在 service 侧由 `markNotificationRead`
 *    的 `changed = false` 分支短路，本 adapter 对「已读记录再写一次」按 `TRANSITION_REJECTED`
 *    处理（不产生写入、不改写 `readAt`），两条路径必须一起验证——**已落地**（离线 + 真库）；
 * 8. `save` 的 `TRANSITION_REJECTED` 在 service 层映射为 409 `STATE_TRANSITION_INVALID`
 *    （并发重复标记已读是客户端可见冲突，不是服务端缺陷，不得直接冒泡为 500）——**未落地**；
 * 9. 完成 5–8 后，才允许把 `productionReady` 改为 true，并同步删除能力自检
 *    （`assertPostgresNotificationRepositoryCapabilities` 会拒绝「未验证就声称生产可用」）。
 */
export const POSTGRES_NOTIFICATION_REPOSITORY_VERIFICATION_STEPS = [
  'driver-dependency-evaluated',
  'integration-tests-against-real-postgres',
  'notifications-schema-draft-created-and-promoted-to-migration',
  'notification-repository-port-migrated-to-async',
  'session-subject-user-ids-converged-to-uuid',
  'request-uuid-fields-normalized-to-canonical-lowercase',
  'read-state-idempotency-verified-at-storage-layer',
  'state-transition-rejection-mapped-to-409',
  'production-ready-capability-flipped-with-evidence',
] as const;

export type PostgresNotificationRepositoryErrorCode =
  | 'CAPABILITY_MISDECLARED'
  | 'INVALID_CONFIGURATION'
  | 'EXECUTOR_UNAVAILABLE'
  | 'EXECUTOR_NOT_POSTGRES'
  | 'EXECUTOR_NOT_PERSISTENT'
  | 'INVALID_SUBJECT'
  | 'INVALID_RECORD'
  | 'INVALID_ROW'
  | 'RESULT_SET_VIOLATION'
  | 'CONFLICT'
  | 'IDENTITY_MISMATCH'
  | 'OWNER_VIOLATION'
  | 'NOT_FOUND'
  | 'TRANSITION_REJECTED';

/**
 * adapter 的 fail-closed 错误。
 *
 * `issues` 只承载**字段路径与违规类型**（例如 `user_id`、`title(too_big)`、
 * `status(invalid_enum_value)`），不承载字段取值，避免把归属标识、通知标题/正文原文、
 * 内部 payload、注入载荷或连接信息写进日志与错误响应。
 */
export class PostgresNotificationRepositoryError extends Error {
  readonly code: PostgresNotificationRepositoryErrorCode;
  readonly issues: readonly string[];

  constructor(
    code: PostgresNotificationRepositoryErrorCode,
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PostgresNotificationRepositoryError';
    this.code = code;
    this.issues = [...issues];
  }
}

/**
 * 能力自检：**未验证的实现不得声称生产可用**。
 *
 * 任何环境都会执行（能力声明缺失属于代码缺陷，不能等生产才暴露）。
 * 生产可用性的提升必须与 `POSTGRES_NOTIFICATION_REPOSITORY_VERIFICATION_STEPS` 的证据、
 * 以及本断言的同步修改一起发生。
 */
export function assertPostgresNotificationRepositoryCapabilities(
  capabilities: NotificationRepositoryCapabilities = POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES,
): void {
  const issues: string[] = [];
  if (capabilities.backend !== NOTIFICATION_REPOSITORY_BACKEND_POSTGRES) {
    issues.push('backend');
  }
  if (capabilities.persistent !== true) {
    issues.push('persistent');
  }
  if (capabilities.productionReady !== false) {
    issues.push('productionReady');
  }
  if (issues.length > 0) {
    throw new PostgresNotificationRepositoryError(
      'CAPABILITY_MISDECLARED',
      `PostgreSQL 通知仓储能力声明不符（backend 必须是 ${NOTIFICATION_REPOSITORY_BACKEND_POSTGRES}、persistent=true、productionReady=false）：未完成驱动集成验证前不得声称生产可用`,
      issues,
    );
  }
}

/**
 * 公开视图裁剪的**泄漏检测**（纯函数，便于逐条用例固定）。
 *
 * 对每个「本 adapter 声明为不进入公开输出」的列，检查公开视图白名单里是否出现了该列名本身，
 * 或它映射到的领域字段名（例如 `user_id → userId`）。返回空数组表示无泄漏。
 */
export function findNotificationViewExclusionLeaks(
  viewFields: readonly string[],
): readonly string[] {
  const declared = new Set(viewFields);
  const columnFields: Record<string, string | undefined> = POSTGRES_NOTIFICATION_COLUMN_FIELDS;
  const leaks: string[] = [];
  for (const column of POSTGRES_NOTIFICATION_VIEW_EXCLUDED_COLUMNS) {
    if (declared.has(column)) {
      leaks.push(column);
    }
    const field = columnFields[column];
    if (field !== undefined && declared.has(field)) {
      leaks.push(field);
    }
  }
  return [...new Set(leaks)];
}

/**
 * 模块加载期自检：**公开视图白名单不得包含归属或存储侧内部列**。
 *
 * 归属（`user_id → userId`）与内部列（内部 payload、路径、URL、storage handle、PII 收件标识）
 * 只要有一个出现在公开视图白名单里，本断言立即 fail-closed，避免「悄悄把归属或内部列投影出去」
 * 这类改动通过测试。
 */
export function assertNotificationViewExclusion(viewFields: readonly string[]): void {
  const leaks = findNotificationViewExclusionLeaks(viewFields);
  if (leaks.length > 0) {
    throw new PostgresNotificationRepositoryError(
      'CAPABILITY_MISDECLARED',
      '公开视图白名单包含归属或存储侧内部列：不得把归属 / 内部 payload / 路径 / URL / storage handle / PII 投影出去',
      leaks,
    );
  }
}

/** 模块加载即校验：视图白名单与实际裁剪清单必须一致（见 `assertNotificationViewExclusion`） */
assertNotificationViewExclusion(NOTIFICATION_VIEW_FIELDS);

/** 空 UUID：合法 UUID 但不是可用主体，读写路径一律拒绝 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * 存储 ID 域判定（单一事实来源）：合法 UUID **且**非空 **且** 规范小写形。
 *
 * 归属与范围复核是逐字节精确比较（`OWNER_VIOLATION`），而 UUID 文本在数据库侧大小写不敏感：
 * 若静默小写化，就会把「归属被改写」与「大小写差异」混成同一种静默修正；若原样绑定大写，
 * 数据库返回的规范小写形态又会与本地值不一致而误报越权。因此统一要求规范小写形。
 */
function isStorageUuid(value: unknown): value is string {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success && parsed.data !== NIL_UUID && parsed.data === parsed.data.toLowerCase();
}

/** 行契约里的存储标识列：形状 = 存储 ID 域（规范小写、非空），与写入侧同一判定 */
const storageUuidSchema = uuidSchema.refine(isStorageUuid, '必须是规范小写形的非空 UUID');

/** SQL 标识符白名单：只允许小写字母开头的裸标识符，杜绝用「列名 / 表名」夹带 SQL 片段 */
const SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/u;

function assertSqlIdentifier(value: string, label: string): string {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new PostgresNotificationRepositoryError(
      'INVALID_CONFIGURATION',
      `SQL 标识符不合规（必须是裸小写标识符）：${label}`,
      [label],
    );
  }
  return value;
}

/** 模块加载即校验：表名与列名一旦被改成非标识符形状，直接 fail-closed（不静默拼进 SQL） */
const TABLE_IDENTIFIER = assertSqlIdentifier(POSTGRES_NOTIFICATION_TABLE, 'table');
const COLUMN_LIST = POSTGRES_NOTIFICATION_COLUMNS.map((column) =>
  assertSqlIdentifier(column, 'column'),
).join(', ');

/** 逐列的类型转换：只在「列 → 参数占位」这一步使用，值本身永远不进入 SQL 文本 */
const COLUMN_PARAMETER_CASTS: Partial<
  Record<(typeof POSTGRES_NOTIFICATION_COLUMNS)[number], string>
> = {
  id: '::uuid',
  user_id: '::uuid',
  read_at: '::timestamptz',
  created_at: '::timestamptz',
  updated_at: '::timestamptz',
};

/** `VALUES ($1::uuid, $2::uuid, …)`：占位符与列一一对应，由列清单派生，不会出现数量漂移 */
const INSERT_VALUES = POSTGRES_NOTIFICATION_COLUMNS.map(
  (column, index) => `$${index + 1}${COLUMN_PARAMETER_CASTS[column] ?? ''}`,
).join(', ');

/**
 * 写入语句：客户端可控值全部走 `$n`；`ON CONFLICT (id) DO NOTHING` 让**主键冲突显式暴露**
 * （与内存基线 `create` 抛「通知 ID 冲突」同语义：入库记录 ID 由服务端生成，冲突属于服务端缺陷，
 * 不得静默覆盖、也没有任何可覆盖的列）。
 * 刻意**没有** `DO UPDATE`：本端口只提供创建，任何「写入即改写」都会绕过状态机与幂等切片。
 * `RETURNING` 让写入结果可被严格行契约复核（而不是「写完就当成功」）。
 */
const INSERT_SQL = `INSERT INTO ${TABLE_IDENTIFIER} (
  ${COLUMN_LIST}
) VALUES (${INSERT_VALUES})
ON CONFLICT (id) DO NOTHING
RETURNING ${COLUMN_LIST}`;

/**
 * 排序键：`created_at ASC, id ASC`——与内存基线的插入顺序一致（记录在生产侧 append 时写入
 * `createdAt = now`），并给出逐页稳定、可复现的**全序**（后续键集分页所需的稳定排序键）。
 * 本切片**不加** `LIMIT/OFFSET`：端口还没有分页窗口，adapter 自行截断会让结果与内存基线语义
 * 不一致（同名 spec 有边界断言）。
 */
const ORDER_BY = 'ORDER BY created_at ASC, id ASC';

/**
 * 按主体取数：主体走 `$1::uuid` 绑定，**归属下推进 SQL**（他人记录既不出库也不回流）；
 * 显式列清单，不使用 `SELECT *`。
 */
const SELECT_BY_OWNER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE user_id = $1::uuid
  ${ORDER_BY}`;

/**
 * 单条读取：`id` 与 `user_id` **同时**作为谓词，因此「只按资源 ID 命中就返回他人通知」这条路径
 * 在本 adapter 里不存在。
 */
const SELECT_BY_ID_FOR_OWNER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE id = $1::uuid AND user_id = $2::uuid`;

/** `save` 的 SET 片段：由可变列清单派生，占位符从 `$3` 起（`$1`/`$2` 留给 WHERE 的 id/user_id） */
const UPDATE_SET_LIST = POSTGRES_NOTIFICATION_MUTABLE_COLUMNS.map(
  (column, index) => `${column} = $${index + 3}${COLUMN_PARAMETER_CASTS[column] ?? ''}`,
).join(', ');

/** 状态转移谓词的占位符序号：可变列之后紧随其后 */
const UPDATE_PREDECESSOR_PARAMETER = POSTGRES_NOTIFICATION_MUTABLE_COLUMNS.length + 3;

/**
 * 写回语句：**条件写入**。`WHERE` 同时钉住 `id`、`user_id` 与「状态必须落在目标状态的合法前驱
 * 集合内」三件事：
 * - `id + user_id` ⇒ 拿他人通知的 ID 也写不中他人数据（归属隔离强化）；
 * - `status::text = ANY($n::text[])` ⇒ 非法状态转移**一行都不会被写入**，并且并发重复标记已读时
 *   只有第一个请求能命中（第二个 0 行 → `TRANSITION_REJECTED`），因此 `readAt` 不会被重复请求
 *   改写——存储层与 service 的幂等分支形成两道防线；
 * - 目标是未读时前驱集合为空数组 ⇒ 谓词永不命中 ⇒ **不存在「已读 → 未读」回退路径**。
 *
 * `status` 是列引用而非值，因此这里对列做 `::text` 转换：迁移尚未落成（`status` 可能是 `text`
 * 或枚举类型），转换让谓词与列类型声明无关，同时不影响 `id` 主键索引的命中。
 */
const UPDATE_SQL = `UPDATE ${TABLE_IDENTIFIER}
  SET ${UPDATE_SET_LIST}
  WHERE id = $1::uuid AND user_id = $2::uuid AND status::text = ANY($${UPDATE_PREDECESSOR_PARAMETER}::text[])
  RETURNING ${COLUMN_LIST}`;

/**
 * 失败分类用的诊断查询：**只在条件写入 0 行时执行**，且同样被 `id + user_id` 双重限定，
 * 因此它只读取「请求主体自己的那条记录」的状态，不做任何跨归属探测、也不回显状态取值。
 */
const SELECT_STATUS_FOR_OWNER_SQL = `SELECT status
  FROM ${TABLE_IDENTIFIER}
  WHERE id = $1::uuid AND user_id = $2::uuid`;

/**
 * 数据库行契约（**严格**）。
 *
 * `.strict()` 是「字段污染」防线：数据库返回的未登记列（内部 payload、跳转路径、action URL、
 * 附件句柄、订阅消息收件标识这类 PII、`deleted_at`、幂等键…）会让解析失败，而不是被静默丢弃
 * 或带进领域对象。列缺失同样失败（PG 对 SELECT 列表中存在的列一定返回键，缺键说明驱动或 SQL
 * 已被改动）。
 *
 * 存储标识列使用 `storageUuidSchema`（规范小写、非空）：它把「存储层不变量」写成行契约，
 * 也让 `findById` 的「域外查询键必然无命中」成为可证明的结论而不是约定。
 *
 * 枚举闭集与列上的形状约束在这里先拦一道；**内容安全**（身份证号 / 长数字标识 / 疑似密钥）与
 * 「`read` 必带 `readAt`、`unread` 不得带 `readAt`」这两条跨字段不变式的最终判定交给
 * `notifications.contract.ts`（映射后用 `parseStoredNotification` 复核）。
 */
const postgresNotificationRowSchema = z
  .object({
    id: storageUuidSchema,
    user_id: storageUuidSchema,
    type: z.enum(NOTIFICATION_TYPE_VALUES),
    title: z.string().min(1).max(200),
    body: z.string().max(2000),
    status: z.enum(NOTIFICATION_STATUS_VALUES),
    read_at: z.union([z.date(), z.string()]).nullable(),
    created_at: z.union([z.date(), z.string()]),
    updated_at: z.union([z.date(), z.string()]),
  })
  .strict();

/** 诊断查询的行契约：只取状态列，同样严格（多列/缺列都算驱动或 SQL 被改动） */
const postgresNotificationStatusRowSchema = z
  .object({ status: z.enum(NOTIFICATION_STATUS_VALUES) })
  .strict();

/** 写入记录允许出现的字段名集合：由「领域字段 → 列」双射派生（单一事实来源，不会漂移） */
const WRITABLE_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.keys(POSTGRES_NOTIFICATION_FIELD_COLUMNS),
);

/** 只保留字段路径与违规类型，绝不含字段取值（归属、标题与正文原文不进错误消息） */
function describeIssues(error: z.ZodError): readonly string[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      // 只列出**字段名**（不是字段取值）：让「契约漂移 / 字段污染」可定位，同时不泄露数据
      return issue.keys.map((key) => `${key}(unexpected)`);
    }
    return [`${issue.path.join('.') || '(root)'}(${issue.code})`];
  });
}

function invalidRow(error: z.ZodError, label = 'row'): PostgresNotificationRepositoryError {
  return new PostgresNotificationRepositoryError(
    'INVALID_ROW',
    `数据库行不符合 postgres 行契约（${label}）`,
    describeIssues(error),
  );
}

/** 时间列 → ISO 字符串；坏时间戳 fail-closed（不产生 `Invalid Date` 之类的半成品） */
function toIsoTimestamp(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PostgresNotificationRepositoryError('INVALID_ROW', `时间列不是合法时间戳：${label}`, [
      label,
    ]);
  }
  return date.toISOString();
}

/**
 * 标记已读状态机的求逆探针：只使用**模块常量**，不含任何真实通知内容（因此不可能把数据
 * 写进日志或错误消息）。`read` 的探针必须带 `readAt`、`unread` 的探针不得带 `readAt`，
 * 与读取契约的跨字段不变式一致。
 */
const PREDECESSOR_PROBE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PREDECESSOR_PROBE_OWNER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PREDECESSOR_PROBE_NOW = '2000-01-01T00:00:00.000Z';

function predecessorProbe(status: NotificationStatus): StoredNotification {
  const base = {
    id: PREDECESSOR_PROBE_ID,
    userId: PREDECESSOR_PROBE_OWNER,
    type: NotificationType.Announcement,
    title: 'predecessor-probe',
    body: '',
    status,
    createdAt: PREDECESSOR_PROBE_NOW,
    updatedAt: PREDECESSOR_PROBE_NOW,
  };
  return status === NotificationStatus.Read ? { ...base, readAt: PREDECESSOR_PROBE_NOW } : base;
}

/**
 * 两个状态之间是否存在**标记已读状态机**允许的前向边。
 *
 * 判定用的是状态机函数本身（`markNotificationRead`）：把 `from` 状态的探针推进一步，
 * 只有「确实发生了状态变化（`changed = true`）」且「推进结果恰好是 `to`」才算合法边。
 * `changed` 这一条把 `read -> read`（幂等重放）排除在「可写回」之外：
 * 幂等由 service 的短路分支实现，而**存储层不接受**「已读再写一次」——否则 `readAt` 会被
 * 重复请求改写，幂等就只剩口头约定。
 */
export function canAdvanceNotificationStatus(
  from: NotificationStatus,
  to: NotificationStatus,
): boolean {
  const advanced = markNotificationRead(predecessorProbe(from), PREDECESSOR_PROBE_NOW);
  return advanced.changed && advanced.record.status === to;
}

/**
 * 目标状态的**合法前驱集合**：由标记已读状态机的**逆映射**派生（顺序取自
 * `NOTIFICATION_STATUS_VALUES`，保证 SQL 参数逐字节可复现）。
 *
 * 为什么用逆映射而不是在 adapter 里再写一份转移表：状态机的唯一权威是
 * `notifications.contract.ts` 的 `markNotificationRead`；这里只做**求逆**，
 * 因此契约新增/删除转移时条件写入的谓词自动跟随，不会出现「两套状态机」。
 * 注意 `unread` 没有任何前驱：本函数返回空集合，条件写入因此永不命中——`save` 无法回退到未读。
 */
export function notificationStatusPredecessors(
  status: NotificationStatus,
): readonly NotificationStatus[] {
  return NOTIFICATION_STATUS_VALUES.filter((from) => canAdvanceNotificationStatus(from, status));
}

/**
 * 行 → 领域记录：**逐字段显式映射**（不使用展开），再整体过一次读取契约。
 *
 * 顺序刻意如此：先按严格行契约解析（拒绝未登记列 / 未知枚举 / 坏 UUID / 坏时间戳 / 坏形状），
 * 再显式取字段构造新对象（即使行里有额外内容也不会被带出），最后用 `parseStoredNotification`
 * 复核共享读取契约（枚举闭集 + ISO 时间 + `read`/`readAt` 不变式 + 免 PII 文本），
 * 任一环节不合规都抛错。
 */
function mapRow(row: unknown): Notification {
  const parsedRow = postgresNotificationRowSchema.safeParse(row);
  if (!parsedRow.success) {
    throw invalidRow(parsedRow.error);
  }
  const dbRow = parsedRow.data;

  const record = {
    id: dbRow.id,
    // 归属：adapter 只承载，不生成、不覆盖；对外由 toNotificationView 裁剪
    userId: dbRow.user_id,
    type: dbRow.type,
    title: dbRow.title,
    body: dbRow.body,
    status: dbRow.status,
    createdAt: toIsoTimestamp(dbRow.created_at, 'created_at'),
    ...(dbRow.read_at === null ? {} : { readAt: toIsoTimestamp(dbRow.read_at, 'read_at') }),
    updatedAt: toIsoTimestamp(dbRow.updated_at, 'updated_at'),
  };

  const parsedRecord = parseStoredNotification(record);
  if (!parsedRecord.ok) {
    throw new PostgresNotificationRepositoryError(
      'INVALID_ROW',
      '数据库行映射后不符合通知读取契约',
      parsedRecord.issues.map((issue) => `${issue.path}(${issue.kind})`),
    );
  }
  return parsedRecord.value;
}

/**
 * 执行器 fail-closed 校验：没有执行器、执行器不像 PostgreSQL、或声明为**非持久**
 * （内存替身）时一律拒绝，而不是「先跑起来再说」。
 */
function assertUsableExecutor(executor: unknown): SqlExecutor {
  if (typeof executor !== 'object' || executor === null) {
    throw new PostgresNotificationRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      '未提供 SQL 执行器：PostgreSQL 通知仓储拒绝在半可用状态下构造或调用',
      ['executor'],
    );
  }
  const candidate = executor as { query?: unknown; capabilities?: unknown };
  if (typeof candidate.query !== 'function') {
    throw new PostgresNotificationRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器缺少 query 方法：PostgreSQL 通知仓储拒绝在半可用状态下构造或调用',
      ['executor.query'],
    );
  }
  const capabilities = candidate.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new PostgresNotificationRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器未声明能力（backend/persistent/productionReady）',
      ['executor.capabilities'],
    );
  }
  const { backend, persistent } = capabilities as { backend?: unknown; persistent?: unknown };
  if (typeof backend !== 'string' || backend.trim() === '') {
    throw new PostgresNotificationRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器的能力声明缺少 backend 标识',
      ['executor.capabilities.backend'],
    );
  }
  if (!/^postgres/iu.test(backend.trim())) {
    throw new PostgresNotificationRepositoryError(
      'EXECUTOR_NOT_POSTGRES',
      'SQL 执行器声明的后端不是 PostgreSQL：拒绝把本 adapter 挂到其他存储上',
      ['executor.capabilities.backend'],
    );
  }
  if (persistent !== true) {
    throw new PostgresNotificationRepositoryError(
      'EXECUTOR_NOT_PERSISTENT',
      'SQL 执行器声明为非持久后端（内存替身）：PostgreSQL 通知仓储拒绝在其上运行',
      ['executor.capabilities.persistent'],
    );
  }
  return executor as SqlExecutor;
}

/**
 * **存储 ID 域约束**：主体与记录内的存储标识必须是合法、非空、且为**规范小写形**的 UUID。
 *
 * 非 UUID 的标识（例如会话基线的 `u-student-1`，或注入式载荷）会让数据库侧 `uuid`
 * 比较退化为「转换失败 / 放弃类型约束」，因此在这里 fail-closed 拒绝，
 * **绝不绑定进 SQL**（错误信息也不回显该值本身）。
 */
function requireStorageUuid(
  value: unknown,
  code: PostgresNotificationRepositoryErrorCode,
  message: string,
  label: string,
): string {
  if (!isStorageUuid(value)) {
    throw new PostgresNotificationRepositoryError(code, message, [label]);
  }
  return value;
}

/** 服务端主体：会话解析值，非法即服务端缺陷（不得静默按「查不到」处理） */
function requireSubject(userId: unknown): string {
  return requireStorageUuid(
    userId,
    'INVALID_SUBJECT',
    '取数主体必须落在存储 ID 域内（合法且非空的规范小写 UUID）：非 UUID 的 userId 属于服务端缺陷，不得进入 SQL',
    'userId',
  );
}

/**
 * 写入记录校验：字段名闭集（未登记字段 → `(unexpected)`）+ 读取契约（含 `read`/`readAt`
 * 跨字段不变式）+ 存储 ID 域。
 *
 * 这里刻意**不**用 `storedNotificationSchema.strict()`：该契约是 `ZodEffects`（带
 * `superRefine`），没有 `.strict()`；而 zod 默认会**静默剥离**未登记字段。因此先用
 * `POSTGRES_NOTIFICATION_FIELD_COLUMNS` 的键集合显式比对原始字段名（拒绝而不是剥离），
 * 再交给读取契约做形状与不变式校验。
 */
function assertWritableRecord(record: unknown): Notification {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new PostgresNotificationRepositoryError(
      'INVALID_RECORD',
      '待写入的通知不是对象：拒绝把非记录值交给写入路径',
      ['(root)'],
    );
  }
  const unexpected = Object.keys(record).filter((key) => !WRITABLE_FIELD_NAMES.has(key));
  if (unexpected.length > 0) {
    // 只列字段名，不回显取值；拒绝而不是静默剥离（与内存基线的「无字段闭集」相比是更严的防线）
    throw new PostgresNotificationRepositoryError(
      'INVALID_RECORD',
      '待写入的通知含未登记字段（字段污染）：拒绝写入',
      unexpected.map((key) => `${key}(unexpected)`),
    );
  }

  const parsed = storedNotificationSchema.safeParse(record);
  if (!parsed.success) {
    throw new PostgresNotificationRepositoryError(
      'INVALID_RECORD',
      '待写入的通知不符合读取契约（含非法取值或 read/readAt 不自洽）',
      describeIssues(parsed.error),
    );
  }
  const writable = parsed.data;
  for (const [label, value] of [
    ['id', writable.id],
    ['user_id', writable.userId],
  ] as const) {
    requireStorageUuid(
      value,
      'INVALID_RECORD',
      '待写入的通知含不在存储 ID 域内的标识（必须是合法且非空的规范小写 UUID）',
      label,
    );
  }
  return writable;
}

/**
 * 结果集形状 fail-closed：执行器必须返回对象且带 `rows` 数组。
 * 「少字段 / 类型不对」属于驱动或替身实现缺陷，不得被当成「空结果」静默放过
 * （否则会把基础设施故障伪装成「该主体尚无通知」）。
 */
function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new PostgresNotificationRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果不是对象（驱动 / 替身实现缺陷）',
      ['result'],
    );
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new PostgresNotificationRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果缺少 rows 数组（驱动 / 替身实现缺陷）',
      ['rows'],
    );
  }
  return rows;
}

/** 单行结果：0 行 → `NOT_FOUND`；多行 → 结果集违约（主键唯一性被破坏） */
function singleRow(rows: readonly unknown[], scope: string): unknown {
  if (rows.length === 0) {
    throw new PostgresNotificationRepositoryError('NOT_FOUND', scope, ['id']);
  }
  if (rows.length > 1) {
    throw new PostgresNotificationRepositoryError(
      'RESULT_SET_VIOLATION',
      '按主键取数返回了多行：主键唯一性被破坏',
      ['id'],
    );
  }
  return rows[0];
}

/**
 * 写入参数：**由列清单派生**（列 → 字段 → 值），因此参数顺序永远与 SQL 占位符一致；
 * `Record<keyof Notification, unknown>` 让「新增领域字段但忘记补参数」成为编译错误。
 * 缺失的可选字段（`readAt`）写 `NULL`（而不是 `undefined` 或省略列）。
 * `title` / `body` 原样传入（空串是合法正文，不归一为 NULL，避免往返不一致）。
 */
function writeParameters(record: Notification): readonly unknown[] {
  const values: Record<keyof Notification, unknown> = {
    id: record.id,
    userId: record.userId,
    type: record.type,
    title: record.title,
    body: record.body,
    status: record.status,
    createdAt: record.createdAt,
    readAt: record.readAt ?? null,
    updatedAt: record.updatedAt,
  };
  return POSTGRES_NOTIFICATION_COLUMNS.map(
    (column) => values[POSTGRES_NOTIFICATION_COLUMN_FIELDS[column]],
  );
}

/**
 * 写回参数：`$1`/`$2` 是 WHERE 的 `id`/`user_id`，其后按**可变列清单**顺序给出值，
 * 最后一个参数是目标状态的合法前驱集合（条件谓词）。占位符与参数由同一份清单派生。
 */
function saveParameters(record: Notification, predecessors: readonly string[]): readonly unknown[] {
  const values: Record<(typeof POSTGRES_NOTIFICATION_MUTABLE_COLUMNS)[number], unknown> = {
    status: record.status,
    read_at: record.readAt ?? null,
    updated_at: record.updatedAt,
  };
  return [
    record.id,
    record.userId,
    ...POSTGRES_NOTIFICATION_MUTABLE_COLUMNS.map((column) => values[column]),
    [...predecessors],
  ];
}

/**
 * 写回后的**逐列复核**（写回语句不含这些不可变列，因此理论上它们不可能变化）。
 *
 * 复核是为了拦住「存储层触发器 / SQL 被改写 / 驱动串行错位」这类纵深风险，并让「改写归属」
 * 有专属错误码：`id` → `IDENTITY_MISMATCH`、`user_id` → `OWNER_VIOLATION`，
 * 其余 `POSTGRES_NOTIFICATION_IMMUTABLE_COLUMNS`（`type` / `title` / `body` / `created_at`）
 * 以及本次写入的 `status` / `read_at` / `updated_at` → `IDENTITY_MISMATCH`。
 * 列清单与实现的对应关系由同名 spec 的**逐列行为断言**钉住（翻转任一列都会失败）。
 */
function assertWriteRoundTrip(requested: Notification, stored: Notification): void {
  if (stored.id !== requested.id) {
    throw new PostgresNotificationRepositoryError(
      'IDENTITY_MISMATCH',
      '返回记录的主键与请求写入的主键不一致（他人记录不得作为写入结果回流）',
      ['id'],
    );
  }
  if (stored.userId !== requested.userId) {
    throw new PostgresNotificationRepositoryError(
      'OWNER_VIOLATION',
      '返回记录的归属与请求写入的归属不一致（他人归属不得回流）',
      ['user_id'],
    );
  }
  for (const [column, requestedValue, storedValue] of [
    ['type', requested.type, stored.type],
    ['title', requested.title, stored.title],
    ['body', requested.body, stored.body],
    ['created_at', requested.createdAt, stored.createdAt],
    ['status', requested.status, stored.status],
    ['read_at', requested.readAt, stored.readAt],
    ['updated_at', requested.updatedAt, stored.updatedAt],
  ] as const) {
    if (storedValue !== requestedValue) {
      throw new PostgresNotificationRepositoryError(
        'IDENTITY_MISMATCH',
        `返回记录的 ${column} 与请求写入的值不一致（不可变列 / 写入结果不得被改写）`,
        [column],
      );
    }
  }
}

/**
 * 基于 `SqlExecutor` 的 PostgreSQL 通知仓储。
 *
 * 构造与每次调用都会重新校验执行器（`assertUsableExecutor`）与自身能力声明，
 * 因此「执行器被换掉 / 被降级」或「能力声明被改写」都会 fail-closed，而不是静默继续。
 * 本类**不是** Nest provider（不带任何 Nest 装饰器），也未在任何模块中注册。
 */
export class PostgresNotificationRepository implements NotificationRepository {
  readonly capabilities: NotificationRepositoryCapabilities =
    POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES;

  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    assertPostgresNotificationRepositoryCapabilities(this.capabilities);
    this.executor = assertUsableExecutor(executor);
  }

  /** 每次调用前的自检：能力声明与执行器都必须仍然可用 */
  private usableExecutor(): SqlExecutor {
    assertPostgresNotificationRepositoryCapabilities(this.capabilities);
    return assertUsableExecutor(this.executor);
  }

  /** 取数结果的行映射 + 归属复核（列表路径共用，避免两处语义漂移） */
  private mapScopedRows(rows: readonly unknown[], ownerId: string): readonly Notification[] {
    const records = rows.map((row) => mapRow(row));

    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id)) {
        throw new PostgresNotificationRepositoryError(
          'RESULT_SET_VIOLATION',
          '返回结果包含重复的通知 ID：结果集违反取数契约',
          ['id'],
        );
      }
      seen.add(record.id);
      if (record.userId !== ownerId) {
        throw new PostgresNotificationRepositoryError(
          'OWNER_VIOLATION',
          '返回了请求主体之外的通知（他人记录不得回流）',
          ['user_id'],
        );
      }
    }
    return records;
  }

  /**
   * 写入一条已由调用方校验并补齐归属 / 类型 / 状态 / 时间戳的记录。
   *
   * - `userId` 必须是服务端会话主体（非法 UUID / 空 UUID / 非规范小写 / 未登记字段一律拒绝）；
   * - 主键冲突（`ON CONFLICT DO NOTHING` 无返回行）显式抛 `CONFLICT`，与内存基线同语义，
   *   不静默覆盖；
   * - 返回行必须能通过严格行契约与读取契约，且**主键、归属与其余列**都必须等于请求写入的
   *   记录（数据库回流出「他人记录」或字段被改写时判服务端缺陷）。
   */
  async create(notification: Notification): Promise<Notification> {
    const executor = this.usableExecutor();
    const writable = assertWritableRecord(notification);

    const result = await executor.query(INSERT_SQL, writeParameters(writable));

    const rows = rowsOf(result);
    if (rows.length === 0) {
      // 主键冲突（ON CONFLICT DO NOTHING）属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new PostgresNotificationRepositoryError(
        'CONFLICT',
        '通知 ID 冲突：写入未返回任何行（主键已存在）',
        ['id'],
      );
    }
    if (rows.length > 1) {
      throw new PostgresNotificationRepositoryError(
        'RESULT_SET_VIOLATION',
        '写入语句返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const created = mapRow(rows[0]);
    assertWriteRoundTrip(writable, created);
    return created;
  }

  /**
   * 单条读取（本人通知）。
   *
   * - 主体必须落在存储 ID 域内，否则 `INVALID_SUBJECT`，且不访问数据库；
   * - 资源 ID **不进入 SQL**：域外的查询键（非 UUID / 非规范小写 / 空 UUID）直接返回
   *   `undefined`（`undefined` 即「该主体名下不存在此通知」⇒ service 404）。依据是行契约钉住的
   *   存储层不变量——规范小写 UUID——因此域外查询键在合规存储里**必然无命中**；
   * - 归属下推进 SQL（`WHERE id = $1 AND user_id = $2`）：他人的通知既不出库，也不存在
   *   「只按资源 ID 命中就返回」的路径；返回行仍会复核主键与归属（纵深防御）；
   * - 多行返回判结果集违约（主键唯一性被破坏）。
   */
  async findById(notificationId: string, ownerUserId: string): Promise<Notification | undefined> {
    const executor = this.usableExecutor();
    const ownerId = requireSubject(ownerUserId);
    if (!isStorageUuid(notificationId)) {
      // 域外查询键：不访问数据库、也不抛错（「不存在」是确定结论，而不是服务端缺陷）
      return undefined;
    }

    const result = await executor.query(SELECT_BY_ID_FOR_OWNER_SQL, [notificationId, ownerId]);
    const rows = rowsOf(result);
    if (rows.length === 0) {
      return undefined;
    }
    if (rows.length > 1) {
      throw new PostgresNotificationRepositoryError(
        'RESULT_SET_VIOLATION',
        '按主键取数返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const record = mapRow(rows[0]);
    if (record.id !== notificationId) {
      throw new PostgresNotificationRepositoryError(
        'IDENTITY_MISMATCH',
        '返回记录的主键与请求查询的主键不一致',
        ['id'],
      );
    }
    if (record.userId !== ownerId) {
      throw new PostgresNotificationRepositoryError(
        'OWNER_VIOLATION',
        '返回了请求主体之外的通知（他人记录不得回流）',
        ['user_id'],
      );
    }
    return record;
  }

  /**
   * 按服务端主体取数（本人通知列表）。
   *
   * - 主体必须落在存储 ID 域内，否则 `INVALID_SUBJECT`，且不访问数据库；
   * - 归属下推进 SQL（`WHERE user_id = $1`），他人记录不会出库；每条返回记录都会**逐条复核
   *   归属**：返回了他人记录即判服务端缺陷并 fail-closed；
   * - 重复主键同样判结果集违约（避免同一记录在列表里出现两次而放大影响）；
   * - 无记录返回空数组（`[]`），不是 `undefined`，且不抛错；
   * - 不做任何本地截断：结果集大小由 SQL 决定（本切片端口没有分页窗口，`ORDER_BY` 只固定全序）。
   */
  async listByUserId(userId: string): Promise<readonly Notification[]> {
    const executor = this.usableExecutor();
    const ownerId = requireSubject(userId);

    const result = await executor.query(SELECT_BY_OWNER_SQL, [ownerId]);
    return this.mapScopedRows(rowsOf(result), ownerId);
  }

  /**
   * 写回一条已由 service 校验、且已完成**合法状态转移**的完整记录（标记已读）。
   *
   * 判定顺序（被测试固定）：
   * 1. 记录必须满足读取契约（含 `read`/`readAt` 跨字段不变式）且存储标识列落在存储 ID 域内，
   *    否则 `INVALID_RECORD`，不访问数据库；未知状态取值在这里就被闭集拦下；
   * 2. **条件写入**：`WHERE id = $1 AND user_id = $2 AND status::text = ANY($n)`，其中前驱集合由
   *    标记已读状态机逆映射派生。命中即写入成功；未命中说明三种可能之一，用一次**归属范围内**的
   *    诊断查询区分：
   *    - 诊断无行 ⇒ `NOT_FOUND`（记录不存在，或归属不符——与内存基线「记录不存在时拒绝写入」
   *      同语义，且不外泄「该 ID 属于他人」这一事实）；
   *    - 诊断有行（状态合法但不在目标状态的前驱集合内）⇒ `TRANSITION_REJECTED`，**没有任何写入**；
   *    - 诊断多行 ⇒ 结果集违约（主键唯一性被破坏）。
   * 3. 命中后复核 `id` / `user_id` / `type` / `title` / `body` / `created_at` 与写入的
   *    `status` / `read_at` / `updated_at`：不一致分别判 `IDENTITY_MISMATCH` / `OWNER_VIOLATION`。
   *
   * 本方法**不是幂等的**，这是刻意的：幂等由 service 的 `markNotificationRead`
   * （`changed = false` 分支不写库）保证；存储层对「已读记录再写一次」返回
   * `TRANSITION_REJECTED`，因此 `readAt` 不可能被重复请求改写。已登记在验证清单第 7 项。
   *
   * `TRANSITION_REJECTED` 在服务端是**客户端可见冲突**（并发重复标记已读）而不是缺陷：切换到
   * 数据库的那一片切片必须把它映射为 409 `STATE_TRANSITION_INVALID`（验证清单第 8 项）。
   */
  async save(notification: Notification): Promise<Notification> {
    const executor = this.usableExecutor();
    const writable = assertWritableRecord(notification);
    const predecessors = notificationStatusPredecessors(writable.status);

    const result = await executor.query(UPDATE_SQL, saveParameters(writable, predecessors));

    const rows = rowsOf(result);
    if (rows.length === 0) {
      // 0 行 ⇒ 不存在 / 归属不符 / 非法状态转移：用一次归属范围内的诊断查询分类，然后抛错
      throw await this.classifyUnwrittenSave(executor, writable);
    }
    if (rows.length > 1) {
      throw new PostgresNotificationRepositoryError(
        'RESULT_SET_VIOLATION',
        '写回语句返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const saved = mapRow(rows[0]);
    assertWriteRoundTrip(writable, saved);
    return saved;
  }

  /**
   * 条件写入 0 行时的失败分类：**归属范围内**读取当前状态，返回要抛的错误。
   *
   * 该查询只按 `id + user_id` 取 `status` 一列，因此既不跨归属探测，也不回显状态取值、
   * 不泄露他人通知是否存在。
   */
  private async classifyUnwrittenSave(
    executor: SqlExecutor,
    writable: Notification,
  ): Promise<PostgresNotificationRepositoryError> {
    const diagnostic = await executor.query(SELECT_STATUS_FOR_OWNER_SQL, [
      writable.id,
      writable.userId,
    ]);
    const rows = rowsOf(diagnostic);
    if (rows.length === 0) {
      return new PostgresNotificationRepositoryError(
        'NOT_FOUND',
        '通知不存在（或不属于该主体），拒绝写入：插入必须走 create 路径',
        ['id'],
      );
    }
    const current = singleRow(rows, '通知不存在（或不属于该主体），拒绝写入');
    const parsedStatus = postgresNotificationStatusRowSchema.safeParse(current);
    if (!parsedStatus.success) {
      throw invalidRow(parsedStatus.error, 'status');
    }
    return new PostgresNotificationRepositoryError(
      'TRANSITION_REJECTED',
      '非法 read 状态转换：当前存储状态不是目标状态的合法前驱（记录已是目标状态，或目标状态没有前驱），写入被拒绝且不产生任何更改',
      ['status'],
    );
  }
}

/** DI 工厂：把驱动无关的 `SqlExecutor` 装成通知仓储端口实现（本切片的换绑点之一） */
export function createPostgresNotificationRepository(
  executor: SqlExecutor,
): NotificationRepository {
  return new PostgresNotificationRepository(executor);
}

/**
 * 把「主体必须落在存储 ID 域内」变成可**先于建连**执行的断言（供分流点、service 与测试复用）。
 *
 * 为什么单独导出：延迟建连的实现必须在解析执行器**之前**判定主体，否则一个非 UUID 的会话主体
 * （例如会话基线的 `u-student-1`）会先触发一次数据库连接、再在 adapter 里被拒绝 —— 那既浪费连接，
 * 也让「主体域判定发生在任何连接之前」这条性质无法被测试固定。
 * 错误信息不带主体取值（见 `requireSubject`）。
 */
export function assertPostgresNotificationSubject(ownerUserId: unknown): string {
  return requireSubject(ownerUserId);
}

/**
 * 延迟建连的通知仓储：**模块装配阶段不碰数据库**。
 *
 * 为什么必须延迟：`SQL_CONNECTION_FACTORY.connect()` 在数据库已配置但执行器未通过 attest 契约时
 * 会抛错。如果在这里急切建连，启动失败会表现为「模块工厂抛了数据库错」，而不是启动期持久化边界
 * 给出的**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED` / `DECLARATION_NOT_SEALED` 等）；
 * 依赖就绪门禁也必须能在**任何连接之前**给出 `NOTIFICATION_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`。
 * 延迟后，判定顺序保持为「配置 → 持久化边界 / 依赖就绪 → 首次真正读库」。
 *
 * 连接只在首次读写时建立并被复用；建立失败不缓存失败结果（下一次调用会重试）。
 * 主体域先判、再建连：非存储 ID 域（非 UUID）的主体不会触发任何数据库连接。
 *
 * 写路径（`create` / `save`）上主体域由本函数先判（`INVALID_SUBJECT`），adapter 内部对**待写记录**
 * 还有第二道校验（字段闭集与记录形状 → `INVALID_RECORD`）。两者不冲突、也不重复：
 * 前者回答「这个主体在存储里可能合法吗」，后者回答「这条记录本身合规吗」。
 */
export function createLazyPostgresNotificationRepository(
  resolveExecutor: () => Promise<SqlExecutor>,
  capabilities: NotificationRepositoryCapabilities = POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES,
): NotificationRepository {
  assertPostgresNotificationRepositoryCapabilities(capabilities);

  let pending: Promise<SqlExecutor> | undefined;
  const executor = (): Promise<SqlExecutor> => {
    if (pending === undefined) {
      pending = resolveExecutor().catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };

  return {
    capabilities,
    async create(notification: Notification): Promise<Notification> {
      // 主体域先判、再建连：非存储 ID 域的写记录不应该触发任何数据库连接
      assertPostgresNotificationSubject(notification.userId);
      const resolved = await executor();
      return new PostgresNotificationRepository(resolved).create(notification);
    },
    async findById(notificationId: string, ownerUserId: string): Promise<Notification | undefined> {
      const ownerId = assertPostgresNotificationSubject(ownerUserId);
      const resolved = await executor();
      return new PostgresNotificationRepository(resolved).findById(notificationId, ownerId);
    },
    async listByUserId(userId: string): Promise<readonly Notification[]> {
      const ownerId = assertPostgresNotificationSubject(userId);
      const resolved = await executor();
      return new PostgresNotificationRepository(resolved).listByUserId(ownerId);
    },
    async save(notification: Notification): Promise<Notification> {
      assertPostgresNotificationSubject(notification.userId);
      const resolved = await executor();
      return new PostgresNotificationRepository(resolved).save(notification);
    },
  };
}
