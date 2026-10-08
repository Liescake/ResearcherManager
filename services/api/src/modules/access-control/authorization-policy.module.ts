import { Module } from '@nestjs/common';
import { AuthorizationPolicy } from './authorization-policy';

/**
 * 授权策略单一事实来源模块（叶子模块：不导入任何其他模块）。
 *
 * 单独成模块是为了打断模块环：授权边界 `AuthorizationGuard` 必须消费适配器端口
 * `RUOYI_AUTHZ_ADAPTER`（由 `RuoYiAdapterModule` 绑定），而适配器实现
 * `BaselineRuoYiAuthzAdapter` 又必须注入本策略。若策略与 guard 同处一个模块，
 * 就会出现 `access-control → ruoyi-adapter → access-control`；把策略下沉为无依赖的叶子后，
 * 依赖方向成为单向链：
 *
 * `access-control（guard）→ ruoyi-adapter（端口绑定）→ authorization-policy（canonical 谓词）`
 *
 * 因此 `AuthorizationGuard` 与 `AuthorizationPolicy` 的对外可用性都不变，
 * 但 Nest 模块图无环（回归见 `access-control.module.spec.ts`）。
 */
@Module({
  providers: [AuthorizationPolicy],
  exports: [AuthorizationPolicy],
})
export class AuthorizationPolicyModule {}
