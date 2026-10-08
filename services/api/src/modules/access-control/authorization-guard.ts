import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { AuthorizationRequest, AuthorizationSubject, PermissionGrant } from '@rm/shared';
import { RUOYI_AUTHZ_ADAPTER, type RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';

/**
 * 403 统一文案：授权拒绝与服务端发现「存储归属与主体不一致」时共用同一句话，
 * 使调用方无法据此区分「无权」与「数据异常」，避免泄露判定内部状态。
 */
export const AUTHORIZATION_FORBIDDEN_MESSAGE = '无权执行该操作';

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
    if (!this.canAuthorize(subject, request)) {
      throw new ForbiddenException(AUTHORIZATION_FORBIDDEN_MESSAGE);
    }
  }

  /**
   * 只读判定：与 `assertAuthorized` 走**同一个端口、同一套入参**，但不抛异常。
   *
   * 存在的理由只有一个：集合级列表端点的可见范围可能由**多个服务端候选范围**共同表达
   * （例如「本人视角」+「所属小组视角」），服务需要逐个候选询问端口再取并集。
   * 若没有本方法，调用方只能靠捕获 403 来判断，那会把「拒绝」当成控制流。
   *
   * 与 `assertAuthorized` 一样：不解释、不返回端口的结构化拒绝原因，
   * 也不接受任何客户端提交的角色/范围/归属；拒绝原因只留在端口内部（供审计切片使用）。
   */
  canAuthorize(subject: AuthorizationSubject, request: AuthorizationRequest): boolean {
    return this.adapter.checkAuthorization(subject, request).allowed;
  }

  assertCanConfigure(subject: AuthorizationSubject, grants: readonly PermissionGrant[]): void {
    if (!this.adapter.checkGrant(subject, grants).allowed) {
      throw new ForbiddenException('无权配置权限');
    }
  }
}
