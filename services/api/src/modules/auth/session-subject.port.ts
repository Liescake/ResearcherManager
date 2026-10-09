import type { AuthorizationSubject } from '@rm/shared';

/**
 * 认证边界端口：把「客户端会话凭证」解析为**服务端主体**（`AuthorizationSubject`）。
 *
 * 为什么必须是一个端口，而不是直接读请求头里的角色：
 * - P4 之前既没有数据库也没有微信登录，但业务路由从第一行起就需要「服务端解析的主体」。
 *   本端口把该依赖显式化：默认绑定内存基线（`session-store.in-memory.ts`），
 *   生产必须把 DI 令牌 `SESSION_STORE` 换绑到持久化实现（数据库会话表，见
 *   `session-store.postgres-repository.ts`）。
 * - 主体（userId / roles / groupIds）只能来自服务端会话存储；
 *   请求体、查询串、客户端自定义头里的 `roles`/`scope`/`groupId` **永不**作为判定输入。
 *
 * 边界事实（可机器判定，见 `auth/session-subject.spec.ts`）：
 * - 内存基线如实声明 `persistent = false`、`productionReady = false`；
 * - 内存基线在 `NODE_ENV=production` 下**拒绝构造**（`session-store.in-memory.ts`），
 *   因此不存在「用进程内 Map 冒充生产存储」的可用路径；
 * - 默认装配不预置任何会话：未绑定真实存储时所有需要认证的路由返回 401，而不是放行。
 *
 * ## 为什么 `findSession` 是异步的
 * 持久化会话存储（PostgreSQL）的读取必然是一次 I/O。把读取固定成异步，是为了让**同一份**端口
 * 能同时被内存基线与数据库实现满足，而不是给数据库实现留一条「同步假象」（缓存 / 预载）——
 * 那种做法会让「主体来自服务端存储」这条性质在换绑后悄悄失效。调用方（
 * `BearerSessionSubjectResolver` / `requireSubject` / controller）因此统一 `await`。
 *
 * ## 敏感票据的处理口径（贯穿本端口的硬约束）
 * `findSession` / `revokeSession` 接收的是**客户端提交的原始票据**；持久化实现必须只把票据的
 * 不可逆摘要落库（`session-ticket.ts` 的 `sessionTicketDigest`），原始票据不得写入存储、日志、
 * 错误信息或任何响应。`SessionRecord.sessionId` 因此是**摘要**，不是可再次使用的凭证。
 */

/** 认证后端能力声明：让上层与运维能机器判定会话后端是否可持久化 */
export interface SessionBackendCapabilities {
  /** 后端标识，例如 `in-memory-baseline` */
  readonly backend: string;
  /** 会话是否跨进程/重启保留（内存基线必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

/** 会话记录：主体由服务端存储给出，不由请求决定 */
export interface SessionRecord {
  /** 会话主键：**票据摘要**（不是可再次使用的原始票据） */
  readonly sessionId: string;
  readonly subject: AuthorizationSubject;
}

/** 创建会话的输入：主体与过期时刻都由服务端决定，不接受任何客户端字段 */
export interface CreateSessionInput {
  readonly subject: AuthorizationSubject;
  /** 过期时刻（带时区的 ISO 时间戳）；必须由服务端时钟计算 */
  readonly expiresAt: string;
}

/** 创建结果：**原始票据只在这里出现一次**，之后只有摘要可查 */
export interface IssuedSession {
  /**
   * 交给客户端的**原始**会话票据（`Authorization: Bearer <ticket>` 的值）。
   * 它只存在于本次返回值里：持久化实现只落库它的不可逆摘要，调用方负责自行转交，不得记录。
   */
  readonly ticket: string;
  readonly record: SessionRecord;
  /** 与 `record` 对应的过期时刻（带时区的 ISO 时间戳），便于调用方设置 Cookie/缓存头 */
  readonly expiresAt: string;
}

/**
 * 会话存储端口：内存基线与数据库实现共用同一接口。
 *
 * 四个方法覆盖会话的完整生命周期（创建 / 读取 / 撤销 / 过期清理），因此「会话后端是否真的能承担
 * 生产职责」可以被同一组测试逐条验证，而不是只验证读取路径。
 */
export interface SessionStore {
  readonly capabilities: SessionBackendCapabilities;

  /**
   * 按**客户端提交的原始票据**读取会话；未过期且未撤销时返回主体记录，否则 `undefined`。
   *
   * 读取失败 / 存储不可用一律**抛出**，不得退化成 `undefined`：`undefined` 的语义是
   * 「这张票据无效」（→ 401），而「存储读不出来」是可用性故障，两者混同会让故障被静默当成未登录。
   */
  findSession(ticket: string): Promise<SessionRecord | undefined>;

  /** 创建会话并返回一次性原始票据（持久化实现只保存其摘要） */
  createSession(input: CreateSessionInput): Promise<IssuedSession>;

  /** 撤销会话（幂等）。返回本次调用是否真的把一条未撤销会话置为已撤销 */
  revokeSession(ticket: string): Promise<boolean>;

  /** 过期清理：删除已过期会话，返回删除条数（幂等） */
  purgeExpired(): Promise<number>;
}

/**
 * 凭证 → 主体端口。
 * 无法解析（未携带、格式非法、会话不存在、主体含未登记枚举）一律返回 `undefined`，
 * 由调用方转 401；本端口不抛业务异常，也不解释失败原因，避免给探测者额外信息。
 *
 * 存储可用性故障与 `undefined` 的区别同上：故障必须抛出（→ 500 且已脱敏），不得被吞成 401。
 */
export interface SessionSubjectResolver {
  readonly capabilities: SessionBackendCapabilities;
  resolveSubject(
    authorizationHeader: string | undefined,
  ): Promise<AuthorizationSubject | undefined>;
}

/** DI 令牌：会话存储 */
export const SESSION_STORE = Symbol('SESSION_STORE');

/** DI 令牌：凭证 → 服务端主体解析器 */
export const SESSION_SUBJECT_RESOLVER = Symbol('SESSION_SUBJECT_RESOLVER');
