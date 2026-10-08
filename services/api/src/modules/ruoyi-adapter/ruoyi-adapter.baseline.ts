import { Injectable, Optional } from '@nestjs/common';
import type { AuthorizationRequest, AuthorizationSubject, PermissionGrant } from '@rm/shared';
import { isDataScope, isPermissionPoint, isRole } from '@rm/shared';
import { AuthorizationPolicy } from '../access-control/authorization-policy';
import {
  AUTHZ_CONTRACT_ID,
  AUTHZ_CONTRACT_RELATIVE_PATH,
  AUTHZ_CONTRACT_VERSION,
} from './contract/contract-identity';
import type {
  AuthorizationDecision,
  AuthorizationObserver,
  RuoYiAdapterCapabilities,
  RuoYiAuthzAdapter,
} from './ruoyi-adapter.port';

/**
 * 基线实现：**只做委托**，不引入第二套授权规则。
 *
 * 判定仍然由 `AuthorizationPolicy`（其下是 packages/shared 的 `isAuthorized` /
 * `canGrantPermissions`）完成——这使得「适配器路径」与「基线路径」在契约重放里
 * 必然得到同一结果。适配器额外承担的只有两件事：
 * 1. 边界强制转换：未登记的权限/范围/角色在进入谓词前就判拒绝（fail-closed）；
 * 2. 结构化决策 + 可选观察者，便于接入后续审计切片。
 *
 * 本类不是安全边界本身：API 层必须继续使用 AuthorizationGuard 把拒绝转成 403。
 */
@Injectable()
export class BaselineRuoYiAuthzAdapter implements RuoYiAuthzAdapter {
  readonly capabilities: RuoYiAdapterCapabilities = {
    backend: 'nestjs-baseline',
    delegatesToCanonicalPredicate: true,
    menuRbacBackend: false,
    ruoyiDataScopeBackend: false,
    contract: { id: AUTHZ_CONTRACT_ID, version: AUTHZ_CONTRACT_VERSION },
    ruoyiSourceIncluded: false,
    mavenDependencyIntroduced: false,
  };

  constructor(
    private readonly policy: AuthorizationPolicy,
    @Optional() private readonly observer?: AuthorizationObserver,
  ) {}

  /** 供上层/测试读取契约来源，确认适配器镜像是哪一份夹具 */
  static describeContractSource(): { relativePath: string; contractId: string } {
    return { relativePath: AUTHZ_CONTRACT_RELATIVE_PATH, contractId: AUTHZ_CONTRACT_ID };
  }

  checkAuthorization(
    subject: AuthorizationSubject,
    request: AuthorizationRequest,
  ): AuthorizationDecision {
    const rejected = rejectUnregistered(subject, request);
    if (rejected) return this.report('authorize', rejected, subject, request);

    const allowed = this.policy.authorize(subject, request);
    return this.report(
      'authorize',
      allowed ? { allowed: true, reason: 'allowed' } : { allowed: false, reason: 'policy-denied' },
      subject,
      request,
    );
  }

  checkGrant(
    actor: AuthorizationSubject,
    grants: readonly PermissionGrant[],
  ): AuthorizationDecision {
    const allowed = this.policy.canConfigure(actor, grants);
    const decision: AuthorizationDecision = allowed
      ? { allowed: true, reason: 'allowed' }
      : { allowed: false, reason: 'policy-denied' };
    if (this.observer) {
      this.observer.observe({
        kind: 'grant',
        allowed: decision.allowed,
        reason: decision.reason,
        ...(grants[0]
          ? { permission: String(grants[0].permission), scope: String(grants[0].scope) }
          : {}),
      });
    }
    return decision;
  }

  private report(
    kind: 'authorize' | 'grant',
    decision: AuthorizationDecision,
    subject: AuthorizationSubject,
    request: AuthorizationRequest,
  ): AuthorizationDecision {
    if (this.observer) {
      this.observer.observe({
        kind,
        allowed: decision.allowed,
        reason: decision.reason,
        permission: String(request.permission),
        scope: String(request.scope),
        // 刻意不记录 userId / groupId / resourceUserId：观察者只服务审计聚合，不落隐私标识
      });
    }
    return decision;
  }
}

/**
 * 边界强制转换：主体或请求含未登记枚举时直接判拒绝。
 * 这是**默认拒绝**在适配器层的体现，并且必须在调用谓词前发生，
 * 以免未来替换谓词时丢失这条约束。
 */
function rejectUnregistered(
  subject: AuthorizationSubject,
  request: AuthorizationRequest,
): AuthorizationDecision | undefined {
  if (!subject.userId) return { allowed: false, reason: 'unknown-subject' };
  if (!subject.roles.every((role) => isRole(role)))
    return { allowed: false, reason: 'unknown-role' };
  if (!isPermissionPoint(request.permission)) {
    return { allowed: false, reason: 'unknown-permission' };
  }
  if (!isDataScope(request.scope)) return { allowed: false, reason: 'unknown-scope' };
  return undefined;
}
