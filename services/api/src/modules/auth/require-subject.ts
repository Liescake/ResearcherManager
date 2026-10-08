import { UnauthorizedException } from '@nestjs/common';
import type { AuthorizationSubject } from '@rm/shared';
import type { SessionSubjectResolver } from './session-subject.port';

/**
 * 认证边界的 HTTP 出口：无有效会话一律 401，**不区分**「未携带凭证 / 凭证格式错误 /
 * 会话不存在 / 主体含未登记枚举」—— 统一文案与状态码，避免给探测者额外信息。
 *
 * 控制器只调用本函数拿到主体，然后把它交给 `AuthorizationGuard` 做资源级判定；
 * 控制器不得自行从请求体读取任何角色/范围/归属信息。
 */
export const UNAUTHENTICATED_MESSAGE = '登录状态无效或已过期，请重新登录';

export function requireSubject(
  resolver: SessionSubjectResolver,
  authorizationHeader: string | undefined,
): AuthorizationSubject {
  const subject = resolver.resolveSubject(authorizationHeader);
  if (!subject) {
    throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);
  }
  return subject;
}
