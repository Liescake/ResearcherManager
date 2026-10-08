/**
 * 站内通知（本人通知箱）切片的**显式持久化端口**与存储侧词汇表。
 *
 * 为什么是端口：P5 阶段尚未引入数据库（迁移计划见 `db/migrations/`），但业务切片不能因此
 * 把「进程内 Map」当成生产存储。这里把持久化依赖显式化：
 * - 默认绑定内存基线 `InMemoryNotificationRepository`，它如实声明 `persistent = false`、
 *   `productionReady = false`，并在 `NODE_ENV=production` 下**拒绝构造**；
 * - 引入 PostgreSQL（`notifications` 表）后只需把 DI 令牌 `NOTIFICATION_REPOSITORY`
 *   换绑到同一接口的实现，service / controller 无需改动，因此这一迁移步可整步回退。
 *
 * 边界事实：
 * - 仓储**不做授权判定**，也**不生成归属**：`userId` 只由 service 从服务端会话主体写入，
 *   永不来自请求体、查询串或自定义头；资源级判定属于 `AuthorizationGuard`；
 * - 仓储只按服务端主体取数（`listByUserId`）或按主键取单条（`findById`）：
 *   本切片**没有**「按客户端提交的 owner 取数」这类方法，因此「拿他人的通知」在端口层面
 *   就没有可用的查询入口；
 * - 仓储返回的每条记录都必须能被读取契约（`notifications.contract.ts`）校验：service 会
 *   在出口复核归属与字段闭集，违反者按服务端缺陷处理（列表 500 / 单条统一 404），
 *   绝不允许把他人记录或未知枚举当成正常输出返回给调用方；
 * - 数据库实现按 `AsyncNotificationRepository`（Promise 版，语义与内存基线一致）单独验证，
 *   **不与**当前同步绑定混用，也不得在同步端口绑定期间出现在任何模块的 provider 列表里。
 *
 * 本切片只承载**本人通知箱的最小垂直切片**：本人通知列表与「标记已读」。
 * 通知的生产侧（入组审核结果、成果/升学审核结果、匹配结果、站内公告等如何入库）、
 * 订阅消息下发与失败重试、批量已读、未读数、分页与排序、审计落库属于后续切片。
 */

/**
 * 通知类型**闭集**（存储侧词汇）：未登记取值一律视为存储损坏。
 * 这些取值只描述「通知因何产生」，**不参与任何授权判定**，也不影响可见范围。
 */
export const NotificationType = {
  /** 入组申请审核结果 */
  MembershipReview: 'membership_review',
  /** 成果审核结果 */
  AchievementReview: 'achievement_review',
  /** 升学记录审核结果 */
  EducationReview: 'education_review',
  /** 匹配请求处理结果 */
  MatchingResult: 'matching_result',
  /** 站内公告 */
  Announcement: 'announcement',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];
export const NOTIFICATION_TYPE_VALUES = [
  NotificationType.MembershipReview,
  NotificationType.AchievementReview,
  NotificationType.EducationReview,
  NotificationType.MatchingResult,
  NotificationType.Announcement,
] as const;

/**
 * 通知阅读状态**闭集**：只有「未读」与「已读」两个取值，`read` 是终态。
 * 标记已读是该状态机唯一的前向边（`unread -> read`），且**幂等**：已是 `read` 时不再写入，
 * 因此重复请求不会产生第二次状态变化，也不会改写 `readAt`。
 */
export const NotificationStatus = {
  Unread: 'unread',
  Read: 'read',
} as const;
export type NotificationStatus = (typeof NotificationStatus)[keyof typeof NotificationStatus];
export const NOTIFICATION_STATUS_VALUES = [
  NotificationStatus.Unread,
  NotificationStatus.Read,
] as const;

/**
 * 存储层的通知记录。
 *
 * 归属（`userId`）与状态（`status`/`readAt`）都是**服务端字段**：归属来自会话主体，
 * 状态只能由服务端状态机推进；客户端提交同名字段一律按输入闭集拒绝（400），不是静默剥离。
 */
export interface Notification {
  readonly id: string;
  /** 归属主体：服务端会话解析值，非客户端输入 */
  readonly userId: string;
  /** 通知类型：必须在 `NOTIFICATION_TYPE_VALUES` 闭集内（未知枚举按存储损坏处理） */
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string;
  /** 阅读状态：只由服务端状态机推进 */
  readonly status: NotificationStatus;
  readonly createdAt: string;
  /** 标记已读的服务端时间；未读记录不得携带该字段（读取契约的不变式） */
  readonly readAt?: string;
  readonly updatedAt: string;
}

/** 存储后端能力声明：让上层与运维能机器判定当前后端是否持久化 */
export interface NotificationRepositoryCapabilities {
  readonly backend: string;
  /** 是否跨进程/重启保留（内存基线必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

/**
 * 通知仓储端口。
 *
 * 四个方法的语义边界：
 * - `create`：写入一条已由调用方补齐归属/状态/时间戳的新记录（本切片用于开发/测试装配，
 *   后续由通知生产侧复用；ID 冲突属于服务端缺陷，拒绝静默覆盖）；
 * - `findById`：按主键取单条，**不做归属过滤**——归属判定属于 service，且本切片要求
 *   「非本人所有」与「不存在」对外不可区分，因此不能靠仓储的过滤行为来充当安全边界；
 * - `listByUserId`：只返回该主体的记录；service 仍会逐条复核归属（纵深防御）；
 * - `save`：只更新既有记录（标记已读），不存在的主键拒绝写入，避免绕过创建路径造出记录。
 */
export interface NotificationRepository {
  readonly capabilities: NotificationRepositoryCapabilities;
  create(notification: Notification): Notification;
  findById(notificationId: string): Notification | undefined;
  listByUserId(userId: string): readonly Notification[];
  save(notification: Notification): Notification;
}

/**
 * PostgreSQL 后端标识（能力声明 `backend` 的规范取值）。
 *
 * 数据库 adapter、持久化边界守卫与运维摘要共用同一字面量，避免同一后端出现
 * `postgres` / `postgres-draft` / `postgresql` 多个拼写而无法机器比对。
 */
export const NOTIFICATION_REPOSITORY_BACKEND_POSTGRES = 'postgres';

/**
 * **存储 ID 域约束**：`notifications.id / user_id → users.id`，在存储侧是 `uuid`
 * （主键 UUID、时间 `timestamptz` 见 docs/P2-架构与数据设计.md §4 与
 * `db/migrations/0001_bootstrap.sql` 的设计约束）。
 *
 * 读取契约把 `userId` 写成 `trimmedText(1, 64)`（安全 ID 形，会话基线的 `u-student-1` 属于此形），
 * 而存储域**更严**：必须是「合法、非空、规范小写形」的 UUID。两者不矛盾（UUID 形必然落在
 * 1–64 长度内），但绑定到数据库实现的那一片切片必须把会话主体收敛为 UUID，否则 adapter 按本约束
 * **fail-closed 拒绝**，而不是退化成「放弃类型约束的字符串比较」。
 */
export const NOTIFICATION_REPOSITORY_STORAGE_ID_DOMAIN = 'uuid';

/**
 * **异步仓储契约**（数据库形状的 repository 端口，与 `NotificationRepository` 同语义）。
 *
 * 为什么与同步端口并存、而不是把它直接改成异步：同步端口是当前运行时绑定（内存基线，
 * 同步返回）。把它改成 Promise 是**跨模块契约变更**（service / controller 与既有 spec 必须一起改），
 * 只能与「引入经评估的驱动 + 集成验证」在同一片切片完成。在那之前，数据库 adapter 按本契约实现
 * 并单独验证，运行时绑定一动不动，因此「切换到数据库」与「回退到内存基线」都仍是可整步执行 /
 * 整步回退的操作。
 *
 * 方法集与同步端口逐字对应（`create` / `findById` / `listByUserId` / `save`，没有分页窗口），
 * 但有两处**刻意的签名差异**——两处都是**归属隔离强化**，不是语义漂移：
 * 1. `findById` 增加服务端主体参数 `ownerUserId`：数据库实现里不存在「只按资源 ID 命中就返回」
 *    的合法路径，归属必须**下推进 SQL**（`WHERE id = $1 AND user_id = $2`）。若保持
 *    `findById(notificationId)` 的签名，他人的通知会先出库、再指望上层复核——那是把归属隔离
 *    降级为「上层记得复核」；
 * 2. `save` 不额外接收主体：待写记录由 service 从**存储记录**构造（归属已在记录里），adapter 把
 *    `id + user_id` 一起下推进 `WHERE`，因此「拿他人通知的 ID 改写他人数据」在存储层被关闭。
 *
 * 实现者（当前只有 `notifications.postgres-repository.ts`）必须满足与内存基线**完全相同**的语义
 * （含「同 ID 重复写入视为服务端缺陷、不得静默覆盖」与「记录不存在时拒绝写入」），并额外守住五条
 * 边界：
 * 1. **归属只来自服务端**：`userId` 由 service 从服务端会话主体写入，adapter 不生成、不覆盖归属，
 *    并逐条复核「返回记录的归属 === 请求主体 / 请求记录的归属」，不一致即判服务端缺陷；
 * 2. **存储 ID 域**：主体、记录内的 `userId` 与资源标识必须落在
 *    `NOTIFICATION_REPOSITORY_STORAGE_ID_DOMAIN`（规范小写形 UUID）内，否则 fail-closed；
 * 3. **按服务端主体隔离**：`listByUserId` 与 `findById` 都必须把归属下推进 SQL，让「他人通知」
 *    根本不出库，并在返回行上**逐条**复核归属（纵深防御）；
 * 4. **状态闭集与 read 状态转换 fail-closed**：`status` 只接受闭集取值；`save` 必须把
 *    「本次转移是否合法」下推进为**条件写入**（合法前驱集合由 `notifications.contract.ts` 的
 *    标记已读状态机 `markNotificationRead` **求逆**派生，不引入第二套状态机）。非法转移
 *    **不产生任何写入**并显式抛错；`read` 是终态且标记已读**幂等**，因此对「已读记录再写一次」
 *    同样拒绝、绝不改写 `readAt`；`unread` 没有任何前驱，因此 `save` 也无法回退到未读；
 * 5. **每条返回记录都必须能被读取契约校验**：未知列、未知枚举、非法形状一律按服务端缺陷抛错；
 *    归属、个人级内容与存储侧**内部列**（内部 payload、路径、URL、storage handle、PII）
 *    **绝不**进入错误消息、日志与公开视图（公开视图由 `toNotificationView` 逐字段裁剪）。
 */
export interface AsyncNotificationRepository {
  readonly capabilities: NotificationRepositoryCapabilities;
  /** 写入一条已由调用方补齐归属/状态/时间戳的新记录；同 ID 冲突必须显式抛错，不得静默覆盖 */
  create(notification: Notification): Promise<Notification>;
  /**
   * 单条读取：**必须**同时给出服务端主体，归属下推进 SQL（他人通知不出库）。
   * 返回 `undefined` 表示「该主体名下不存在此通知」。
   */
  findById(notificationId: string, ownerUserId: string): Promise<Notification | undefined>;
  /** 只按归属主体取数：调用方必须是已授权访问该主体资源的服务端代码 */
  listByUserId(userId: string): Promise<readonly Notification[]>;
  /**
   * 写回一条已由 service 校验、且已完成**合法状态转移**的完整记录（标记已读）。
   * 记录不存在（或归属不符）时按服务端缺陷抛错，不得静默插入；非法状态转移必须 fail-closed
   * 且不产生任何写入。
   */
  save(notification: Notification): Promise<Notification>;
}

/** DI 令牌：通知仓储（真实实现应委托 `notifications` 表） */
export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');
