/**
 * 不可变业务审计记录的**显式持久化端口**与存储侧词汇表
 * （docs/P2-架构与数据设计.md §2「audit | 不可变业务审计记录」，数据字典 §4 `audit_logs`）。
 *
 * 为什么是端口：P5 阶段尚未引入数据库（迁移计划见 `db/migrations/`），但审计切片不能因此
 * 把「进程内 Map」当成生产存储。这里把持久化依赖显式化：
 * - 默认绑定内存基线 `InMemoryAuditRepository`，它如实声明 `persistent = false`、
 *   `productionReady = false`，并在 `NODE_ENV=production` 下**拒绝构造**；
 * - 引入 PostgreSQL（`audit_logs` 表）后只需把 DI 令牌 `AUDIT_REPOSITORY` 换绑到同一接口的
 *   实现，service / controller 无需改动，因此这一迁移步可整步回退。
 *
 * 边界事实（可机器判定，见 `audit.controller.spec.ts`）：
 * - 端口**只提供追加与读取**：没有 update / delete / 覆盖写方法，因此「审计删除能力不存在」
 *   （docs/P1-权限矩阵.md §4、P2-权限目录与状态机.md §1）在端口层面就没有可用的入口；
 * - 仓储**不做授权判定**，也**不生成归属与时间**：`actorUserId` 只由 service 从服务端会话主体
 *   写入，`requestId` / `ipHash` / `occurredAt` / `result` 只由服务端生成，
 *   永不来自请求体、查询串或自定义头；资源级判定属于 `AuthorizationGuard`；
 * - 仓储只按服务端主体取数（`listVisibleByActor`）：本切片**没有**「按客户端提交的 actor 取数」
 *   这类方法，因此「拿他人的审计记录」在端口层面就没有可用的查询入口；
 * - 仓储返回的每条记录都必须能被读取契约（`audit.contract.ts`）校验：service 会在出口逐条复核
 *   归属与本人可见标记并校验字段闭集，违反者按服务端缺陷处理（500），
 *   绝不允许把他人记录、仅管理端可见的记录或未知枚举当成正常输出返回给调用方。
 *
 * 本切片只承载**本人审计摘要的最小垂直切片**：`GET /me/audit-events`（本人可查看事件的脱敏摘要）
 * 以及该请求自身的服务端审计写入（`audit_self_events_read`）。
 * 管理端审计查询（`GET /admin/audit-logs`，`audit:read`）、按主体/资源/时间检索、拒绝结果的留痕、
 * 改前/改后快照、理由字段、链式完整性校验、留存与归档策略属于后续切片。
 */

/**
 * 审计事件类型**闭集**（受控操作字典的最小切片）：未登记取值一律视为存储损坏。
 * 这些取值只描述「发生了什么操作」，**不参与任何授权判定**，也不影响可见范围。
 */
export const AuditEventType = {
  /** 本人画像提交/更正 */
  ProfileSelfUpdate: 'profile_self_update',
  /** 本人提交入组申请 */
  MembershipApply: 'membership_apply',
  /** 入组申请审核（负责人/管理员视角） */
  MembershipReview: 'membership_review',
  /** 成果审核 */
  AchievementReview: 'achievement_review',
  /** 升学记录审核 */
  EducationReview: 'education_review',
  /** 本人发起匹配请求 */
  MatchingRequest: 'matching_request',
  /** 本人读取自身审计摘要（本切片写入的唯一事件类型） */
  SelfAuditEventsRead: 'audit_self_events_read',
} as const;
export type AuditEventType = (typeof AuditEventType)[keyof typeof AuditEventType];
export const AUDIT_EVENT_TYPE_VALUES = [
  AuditEventType.ProfileSelfUpdate,
  AuditEventType.MembershipApply,
  AuditEventType.MembershipReview,
  AuditEventType.AchievementReview,
  AuditEventType.EducationReview,
  AuditEventType.MatchingRequest,
  AuditEventType.SelfAuditEventsRead,
] as const;

/**
 * 审计结果**闭集**：只有「成功 / 被拒绝 / 失败」三个取值。
 *
 * 本切片的成功读路径只写入 `success`；`denied`（授权拒绝）与 `failed`（业务失败）留给后续切片
 * 的留痕通道（拒绝留痕需要限定与限流，见 `audit.service.ts` 的「尚不包含」），
 * 但读取契约接受它们，因此这三者在出口都是**合法值**，未登记取值才是存储损坏。
 */
export const AuditResult = {
  Success: 'success',
  Denied: 'denied',
  Failed: 'failed',
} as const;
export type AuditResult = (typeof AuditResult)[keyof typeof AuditResult];
export const AUDIT_RESULT_VALUES = [
  AuditResult.Success,
  AuditResult.Denied,
  AuditResult.Failed,
] as const;

/**
 * 被操作资源类型**闭集**：审计记录用「类型 + 可选 ID」指向业务资源，不使用表名或路径，
 * 避免把存储实现细节带进对外契约。未登记取值一律视为存储损坏。
 */
export const AuditResourceType = {
  User: 'user',
  StudentProfile: 'student_profile',
  Membership: 'membership',
  Achievement: 'achievement',
  EducationRecord: 'education_record',
  MatchingRequest: 'matching_request',
  AuditEvent: 'audit_event',
} as const;
export type AuditResourceType = (typeof AuditResourceType)[keyof typeof AuditResourceType];
export const AUDIT_RESOURCE_TYPE_VALUES = [
  AuditResourceType.User,
  AuditResourceType.StudentProfile,
  AuditResourceType.Membership,
  AuditResourceType.Achievement,
  AuditResourceType.EducationRecord,
  AuditResourceType.MatchingRequest,
  AuditResourceType.AuditEvent,
] as const;

/**
 * 存储层的审计记录（追加写、不可变）。
 *
 * 除 `summary` 与 `resourceType` / `resourceId` 外，**每一个字段都是服务端独占字段**：
 * - `actorUserId`：会话主体（`SESSION_SUBJECT_RESOLVER` 解析值），非客户端输入；
 * - `result` / `occurredAt`：由服务端在写入时确定，客户端不得声明；
 * - `requestId`：**服务端生成的关联 ID**（不使用客户端可提交的 `x-request-id`，见
 *   `audit.contract.ts` 的说明）；
 * - `ipHash`：对端地址的 sha256（数据字典 §4「IP 只存哈希/脱敏」），明文 IP 不入库；
 * - `selfVisible`：该事件是否允许在**本人**审计摘要（`/me/audit-events`）中展示。
 *   它是服务端的可见性口径，**不是**授权判定：授权先由 `AuthorizationGuard` 完成，
 *   该标记只用于把「仅管理端可见」的事件排除在本人摘要之外。
 */
export interface AuditEvent {
  readonly id: string;
  /** 操作主体：服务端会话解析值，非客户端输入 */
  readonly actorUserId: string;
  /** 事件类型：必须在 `AUDIT_EVENT_TYPE_VALUES` 闭集内（未知枚举按存储损坏处理） */
  readonly type: AuditEventType;
  /** 结果：必须在 `AUDIT_RESULT_VALUES` 闭集内 */
  readonly result: AuditResult;
  /** 资源类型：必须在 `AUDIT_RESOURCE_TYPE_VALUES` 闭集内 */
  readonly resourceType: AuditResourceType;
  /** 资源标识（可选）：指向具体业务资源，缺失表示事件不绑定单条资源 */
  readonly resourceId?: string;
  /** 免 PII 的服务端摘要：身份证号、长数字标识、疑似密钥一律视为存储损坏 */
  readonly summary: string;
  /** 是否允许出现在本人审计摘要中（服务端口径，非授权判定） */
  readonly selfVisible: boolean;
  /** 服务端生成的请求关联 ID */
  readonly requestId: string;
  /** 对端地址的 sha256（64 位十六进制），明文 IP 不入库、不外发 */
  readonly ipHash: string;
  /** 事件发生时间（服务端时钟，ISO 8601） */
  readonly occurredAt: string;
}

/** 存储后端能力声明：让上层与运维能机器判定当前后端是否持久化 */
export interface AuditRepositoryCapabilities {
  readonly backend: string;
  /** 是否跨进程/重启保留（内存基线必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

/**
 * 审计仓储端口（**仅追加**）。
 *
 * 两个方法的语义边界：
 * - `append`：追加一条已由调用方补齐主体/结果/时间戳的服务端记录，返回入库后的记录；
 *   主键冲突属于服务端缺陷（ID 由服务端生成），拒绝静默覆盖；审计记录不可变，
 *   写入后没有更新入口，因此「业务 API 删除或改写审计」在类型层面即不可表达；
 * - `listVisibleByActor`：只返回「主体本人 **且** 标记为本人可见」的记录，按追加顺序；
 *   service 仍会逐条复核归属与可见标记（纵深防御：仓储的过滤行为不作为安全边界）。
 */
export interface AuditRepository {
  readonly capabilities: AuditRepositoryCapabilities;
  append(event: AuditEvent): AuditEvent;
  listVisibleByActor(actorUserId: string): readonly AuditEvent[];
}

/** DI 令牌：审计仓储（真实实现应委托 `audit_logs` 表） */
export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');
