import { Injectable } from '@nestjs/common';
import {
  canGrantPermissions,
  isAuthorized,
  type AuthorizationRequest,
  type AuthorizationSubject,
  type PermissionGrant,
} from '@rm/shared';

/**
 * API 层唯一授权策略入口。控制器/服务应在执行读写、导出或配置前调用它；
 * 认证主体及 groupIds 必须由服务端会话/数据库解析，不接受客户端直传。
 */
@Injectable()
export class AuthorizationPolicy {
  authorize(subject: AuthorizationSubject, request: AuthorizationRequest): boolean {
    return isAuthorized(subject, request);
  }

  canConfigure(subject: AuthorizationSubject, grants: readonly PermissionGrant[]): boolean {
    return canGrantPermissions(subject, grants);
  }
}
