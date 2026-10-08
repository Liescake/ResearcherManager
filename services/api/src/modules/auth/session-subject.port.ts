import type { AuthorizationSubject } from '@rm/shared';

/**
 * 认证边界端口：把「客户端会话凭证」解析为**服务端主体**（`AuthorizationSubject`）。
 *
 * 为什么必须是一个端口，而不是直接读请求头里的角色：
 * - P4 之前既没有数据库也没有微信登录，但业务路由从第一行起就需要「服务端解析的主体」。
 *   本端口把该依赖显式化：默认绑定内存基线（`session-subject.baseline.ts`），
 *   生产必须把 DI 令牌 `SESSION_SUBJECT_RESOLVER` 换绑到持久化实现（数据库/Redis 会话表）。
 * - 主体（userId / roles / groupIds）只能来自服务端会话存储；
 *   请求体、查询串、客户端自定义头里的 `roles`/`scope`/`groupId` **永不**作为判定输入。
 *
 * 边界事实（可机器判定，见 `auth/session-subject.spec.ts`）：
 * - 内存基线如实声明 `persistent = false`、`productionReady = false`；
 * - 内存基线在 `NODE_ENV=production` 下**拒绝构造**（`session-store.in-memory.ts`），
 *   因此不存在「用进程内 Map 冒充生产存储」的可用路径；
 * - 默认装配不预置任何会话：未绑定真实存储时所有需要认证的路由返回 401，而不是放行。
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
  readonly sessionId: string;
  readonly subject: AuthorizationSubject;
}

/** 会话存储端口：内存基线与数据库实现共用同一接口 */
export interface SessionStore {
  readonly capabilities: SessionBackendCapabilities;
  findSession(sessionId: string): SessionRecord | undefined;
}

/**
 * 凭证 → 主体端口。
 * 无法解析（未携带、格式非法、会话不存在、主体含未登记枚举）一律返回 `undefined`，
 * 由调用方转 401；本端口不抛业务异常，也不解释失败原因，避免给探测者额外信息。
 */
export interface SessionSubjectResolver {
  readonly capabilities: SessionBackendCapabilities;
  resolveSubject(authorizationHeader: string | undefined): AuthorizationSubject | undefined;
}

/** DI 令牌：会话存储 */
export const SESSION_STORE = Symbol('SESSION_STORE');

/** DI 令牌：凭证 → 服务端主体解析器 */
export const SESSION_SUBJECT_RESOLVER = Symbol('SESSION_SUBJECT_RESOLVER');
