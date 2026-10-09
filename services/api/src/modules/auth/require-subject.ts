import { UnauthorizedException } from '@nestjs/common';
import type { AuthorizationSubject } from '@rm/shared';
import type { SessionSubjectResolver } from './session-subject.port';

/**
 * 认证边界的 HTTP 出口：无有效会话一律 401，**不区分**「未携带凭证 / 凭证格式错误 /
 * 会话不存在 / 主体含未登记枚举」—— 统一文案与状态码，避免给探测者额外信息。
 *
 * 控制器只调用本函数拿到主体，然后把它交给 `AuthorizationGuard` 做资源级判定；
 * 控制器不得自行从请求体读取任何角色/范围/归属信息。
 *
 * ## 为什么是异步的
 * 会话主体来自服务端会话存储（生产为 PostgreSQL），解析必然是一次 I/O。返回 `Promise` 后
 * 调用点必须 `await` —— 这一步是**认证先于业务**的强制点：`await requireSubject(...)` 之后的
 * 每一行都在「主体已解析」之后执行，控制器无法在未认证的情况下先碰业务仓储。
 *
 * ## 故障与无效凭证的区别
 * - 票据无效 → `undefined` → 抛 401；
 * - 会话存储不可用 → 解析器**抛出**（不返回 `undefined`）→ 冒泡为 500（经统一异常过滤器脱敏），
 *   绝不被伪装成「未登录」。把可用性故障说成 401 会掩盖真实故障，也会让运维失去告警信号。
 */
export const UNAUTHENTICATED_MESSAGE = '登录状态无效或已过期，请重新登录';

export async function requireSubject(
  resolver: SessionSubjectResolver,
  authorizationHeader: string | undefined,
): Promise<AuthorizationSubject> {
  const subject = await resolver.resolveSubject(authorizationHeader);
  if (!subject) {
    throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);
  }
  return subject;
}
