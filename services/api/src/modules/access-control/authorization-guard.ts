import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthorizationRequest, AuthorizationSubject, PermissionGrant } from '@rm/shared';
import { AuthorizationPolicy } from '../access-control/authorization-policy';

/**
 * 可复用的 API 授权边界：调用方必须传入服务端解析的主体与资源范围。
 * 不读取请求体中的 roles、scope 或 groupId，也不伪装成已接入所有业务路由的全局 Guard。
 */
@Injectable()
export class AuthorizationGuard {
  constructor(private readonly policy: AuthorizationPolicy) {}

  assertAuthorized(subject: AuthorizationSubject, request: AuthorizationRequest): void {
    if (!this.policy.authorize(subject, request)) {
      throw new ForbiddenException('无权执行该操作');
    }
  }

  assertCanConfigure(subject: AuthorizationSubject, grants: readonly PermissionGrant[]): void {
    if (!this.policy.canConfigure(subject, grants)) {
      throw new ForbiddenException('无权配置权限');
    }
  }
}
