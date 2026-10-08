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
 *   绝不允许把他人记录或未知枚举当成正常输出返回给调用方。
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

/** DI 令牌：通知仓储（真实实现应委托 `notifications` 表） */
export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');
