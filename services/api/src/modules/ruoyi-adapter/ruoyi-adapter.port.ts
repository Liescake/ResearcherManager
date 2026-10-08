import type { AuthorizationRequest, AuthorizationSubject, PermissionGrant } from '@rm/shared';

/**
 * RuoYi 兼容适配器端口（可回退基线）。
 *
 * 目的：在「RuoYi 体系」尚未准入（无 JDK 17 / Maven / 许可证 / SBOM / PostgreSQL 门禁证据）
 * 之前，为后端迁移预留一个**稳定的边界**——上层代码只依赖本接口，不直接依赖 NestJS 基线谓词，
 * 也不依赖任何 RuoYi 实现。当前实现是基线；将来 RuoYi 侧实现同一接口后即可切换，
 * 且**不需要改动调用方**，因此该迁移步可随时回退。
 *
 * 硬约束（与 contracts/README.md §4 一致）：
 * - 默认拒绝：未登记权限、角色范围不匹配、缺少服务端解析的归属信息一律拒绝。
 * - 客户端提交的 scope / groupId / role / 资源归属**永不**作为判定输入；
 *   本端口只接受服务端已解析的 `AuthorizationSubject` 与 `AuthorizationRequest`。
 * - RuoYi 菜单/按钮 RBAC 只能作为粗粒度入口，不能替代资源级判定。
 * - 本端口不承载认证（401）、状态机、审计落库与脱敏，它们是后续切片。
 */

/** 适配器能提供的后端能力声明；用于让上层显式区分「基线」与「RuoYi 已接入」 */
export interface RuoYiAdapterCapabilities {
  /** 当前后端形态 */
  readonly backend: 'nestjs-baseline' | 'ruoyi';
  /** 判定入口：始终委托给 packages/shared 的单一事实来源谓词 */
  readonly delegatesToCanonicalPredicate: true;
  /** 是否已接入 RuoYi 菜单/按钮 RBAC（基线为 false：仅预留，不声称已接入） */
  readonly menuRbacBackend: boolean;
  /** 是否已接入服务端数据权限映射（基线为 false） */
  readonly ruoyiDataScopeBackend: boolean;
  /** 镜像的契约标识与版本 */
  readonly contract: { readonly id: string; readonly version: string };
  /** 边界事实：本模块不包含 RuoYi/Java 源码，也不引入 Maven 依赖 */
  readonly ruoyiSourceIncluded: false;
  readonly mavenDependencyIntroduced: false;
}

/** 判定结果；`reason` 只用于日志/审计与排错，不返回给客户端 */
export type AuthorizationDenyReason =
  'unknown-subject' | 'unknown-permission' | 'unknown-scope' | 'unknown-role' | 'policy-denied';

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: 'allowed' | AuthorizationDenyReason;
}

/** 判定观察者：只接收脱敏后的判定元数据，用于接审计切片 */
export interface AuthorizationObserver {
  observe(event: AuthorizationObservation): void;
}

export interface AuthorizationObservation {
  readonly kind: 'authorize' | 'grant';
  readonly allowed: boolean;
  readonly reason: string;
  readonly permission?: string;
  readonly scope?: string;
}

/** 对外端口：RuoYi 与 NestJS 基线实现同一接口 */
export interface RuoYiAuthzAdapter {
  readonly capabilities: RuoYiAdapterCapabilities;
  /**
   * 资源级判定。入参必须是服务端解析结果；返回结构化决策而不是抛异常，
   * 便于审计与测试（API 层再用 AuthorizationGuard 转成 403 FORBIDDEN）。
   */
  checkAuthorization(
    subject: AuthorizationSubject,
    request: AuthorizationRequest,
  ): AuthorizationDecision;
  /** 权限配置判定（谁能给谁授予什么） */
  checkGrant(
    actor: AuthorizationSubject,
    grants: readonly PermissionGrant[],
  ): AuthorizationDecision;
}

/** DI 令牌：上层注入端口而不是具体实现 */
export const RUOYI_AUTHZ_ADAPTER = Symbol('RUOYI_AUTHZ_ADAPTER');
