import { Module } from '@nestjs/common';
import { RuoYiAdapterModule } from '../ruoyi-adapter/ruoyi-adapter.module';
import { AuthorizationGuard } from './authorization-guard';
import { AuthorizationPolicyModule } from './authorization-policy.module';

/**
 * API 授权边界模块：业务模块通过 AuthorizationPolicy 使用共享的默认拒绝规则，
 * 通过 AuthorizationGuard 把「拒绝」转成 403。
 *
 * `AuthorizationGuard` 不再直接注入策略，而是消费 `RUOYI_AUTHZ_ADAPTER` 端口，
 * 因此本模块导入 `RuoYiAdapterModule`（端口绑定）。策略经 `AuthorizationPolicyModule`
 * 重导出，调用方（`imports: [AccessControlModule]` 后注入 `AuthorizationPolicy`）无需改动。
 *
 * 依赖为单向链，无模块环：`access-control → ruoyi-adapter → authorization-policy`。
 */
@Module({
  imports: [AuthorizationPolicyModule, RuoYiAdapterModule],
  providers: [AuthorizationGuard],
  exports: [AuthorizationPolicyModule, AuthorizationGuard],
})
export class AccessControlModule {}
