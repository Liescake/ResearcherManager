import { Inject, Injectable } from '@nestjs/common';
import { isRole } from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import {
  SESSION_STORE,
  type SessionBackendCapabilities,
  type SessionRecord,
  type SessionStore,
  type SessionSubjectResolver,
} from './session-subject.port';

/**
 * 基线实现：`Authorization: Bearer <sessionId>` → 服务端主体。
 *
 * 只做三件事，且全部 fail-closed：
 * 1. 严格解析 Bearer 凭证（字符集与长度白名单，拒绝其他 scheme 与空白/控制字符）；
 * 2. 用会话 ID 在服务端存储里查主体 —— 客户端提交的 `roles`/`scope`/`groupId` 不参与任何一步；
 * 3. 规范化主体：userId 非空、角色全部是已登记枚举、ID 列表逐项合法；
 *    任一不满足即返回 `undefined`（→ 401）。存储里出现未登记角色属于数据/版本异常，
 *    此时**不能**退化成「按已知角色继续」，只能整体拒绝。
 *
 * 本类不做授权判定：资源级判定仍由 `AuthorizationGuard` 负责。
 *
 * ## 存储边界的两种失败必须区分
 * - **票据对不上主体**（不存在 / 已撤销 / 已过期 / 主体不合法）→ `undefined` → 401；
 * - **存储读不出来**（连接失败、SQL 失败、行契约被破坏）→ 由 `SessionStore.findSession` 抛出，
 *   本方法**不吞**这些异常：挂上 `catch` 退化成 `undefined` 会把数据库故障伪装成「全部用户未登录」。
 *   原始异常文本的脱敏职责在存储层（adapter 只抛不含驱动原文的 `EXECUTOR_FAILURE`）。
 *
 * ## 为什么异步
 * 生产会话存储是 PostgreSQL，读取是一次 I/O。同步签名会迫使持久化实现引入进程内缓存
 * （即「主体其实来自本地副本，而不是服务端存储」），那正好会破坏本文件第 2 条性质。
 */
@Injectable()
export class BearerSessionSubjectResolver implements SessionSubjectResolver {
  constructor(@Inject(SESSION_STORE) private readonly store: SessionStore) {}

  get capabilities(): SessionBackendCapabilities {
    return this.store.capabilities;
  }

  async resolveSubject(
    authorizationHeader: string | undefined,
  ): Promise<AuthorizationSubject | undefined> {
    const sessionId = extractSessionId(authorizationHeader);
    if (!sessionId) return undefined;
    return normalizeSubject(await this.store.findSession(sessionId));
  }
}

/** `Bearer <sessionId>`：sessionId 采用与请求 ID 同级的安全字符集，长度 8—128 */
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._:-]{8,128})$/u;

export function extractSessionId(authorizationHeader: string | undefined): string | undefined {
  if (typeof authorizationHeader !== 'string') return undefined;
  const match = BEARER_PATTERN.exec(authorizationHeader.trim());
  return match?.[1];
}

/** ID 白名单：非空、无控制字符、长度受控，避免把任意字符串带进判定与日志 */
const SAFE_ID = /^[A-Za-z0-9._:@-]{1,64}$/u;

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

/**
 * 主体规范化（fail-closed）。
 * 角色是授权判定的唯一输入之一：出现未登记角色时必须拒绝整个主体，
 * 否则「版本升级新增角色但旧谓词不认识」会退化成静默放行。
 */
export function normalizeSubject(
  record: SessionRecord | undefined,
): AuthorizationSubject | undefined {
  if (!record) return undefined;
  const { subject } = record;

  if (!isSafeId(subject.userId)) return undefined;
  if (!Array.isArray(subject.roles) || subject.roles.length === 0) return undefined;
  if (!subject.roles.every((role) => isRole(role))) return undefined;
  if (subject.groupIds !== undefined && !subject.groupIds.every(isSafeId)) return undefined;
  if (subject.assignedResourceIds !== undefined && !subject.assignedResourceIds.every(isSafeId)) {
    return undefined;
  }

  return {
    userId: subject.userId,
    roles: [...subject.roles],
    ...(subject.groupIds ? { groupIds: [...subject.groupIds] } : {}),
    ...(subject.assignedResourceIds
      ? { assignedResourceIds: [...subject.assignedResourceIds] }
      : {}),
  };
}
