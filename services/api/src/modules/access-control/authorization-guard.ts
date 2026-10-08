import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { AuthorizationRequest, AuthorizationSubject, PermissionGrant } from '@rm/shared';
import { RUOYI_AUTHZ_ADAPTER, type RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';

/**
 * 可复用的 API 授权边界：调用方必须传入服务端解析的主体与资源范围。
 *
 * 判定**只经由适配器端口** `RUOYI_AUTHZ_ADAPTER` 执行，不直接依赖 `AuthorizationPolicy`：
 * - 基线期端口绑定 `BaselineRuoYiAuthzAdapter`，它把判定委托给 canonical 谓词
 *   （`AuthorizationPolicy` → `packages/shared` 的 `isAuthorized` / `canGrantPermissions`），
 *   因此本 guard 的行为与「直接调用策略」逐条一致；
 * - 迁移期只需替换端口 provider（或在测试中替换 DI 令牌），本 guard 与调用方无需改动；
 * - 端口额外保证 fail-closed（未登记权限/范围/角色在进谓词前即拒绝），guard 只负责把拒绝
 *   转成 403，不解释、不记录端口给出的结构化原因，避免把授权内部原因暴露给客户端。
 *
 * 不读取请求体中的 roles、scope 或 groupId，也不伪装成已接入所有业务路由的全局 Guard。
 */
@Injectable()
export class AuthorizationGuard {
  constructor(@Inject(RUOYI_AUTHZ_ADAPTER) private readonly adapter: RuoYiAuthzAdapter) {}

  assertAuthorized(subject: AuthorizationSubject, request: AuthorizationRequest): void {
    if (!this.adapter.checkAuthorization(subject, request).allowed) {
      throw new ForbiddenException('无权执行该操作');
    }
  }

  assertCanConfigure(subject: AuthorizationSubject, grants: readonly PermissionGrant[]): void {
    if (!this.adapter.checkGrant(subject, grants).allowed) {
      throw new ForbiddenException('无权配置权限');
    }
  }
}
