import { Module } from '@nestjs/common';
import { AuthorizationPolicyModule } from '../access-control/authorization-policy.module';
import { BaselineRuoYiAuthzAdapter } from './ruoyi-adapter.baseline';
import { RUOYI_AUTHZ_ADAPTER } from './ruoyi-adapter.port';

/**
 * RuoYi 兼容适配器模块（可回退基线）。
 *
 * 只注册一个端口绑定：`RUOYI_AUTHZ_ADAPTER → BaselineRuoYiAuthzAdapter`。
 * 迁移到 RuoYi 时只需把该 provider 换成 RuoYi 侧实现（或在测试中替换令牌），
 * 调用方无需改动，因此这一迁移步可整步回退。消费该端口的 `AuthorizationGuard`
 * 位于 `AccessControlModule`（它导入本模块），本模块不反向依赖 access-control。
 *
 * 本模块导入的是 `AuthorizationPolicyModule`（叶子）而不是 `AccessControlModule`：
 * 后者依赖本模块导出的端口，若反向导入即形成模块环。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码，不引入 Maven 依赖，也不注册任何路由，
 * 因此不会改变现有 API 的对外行为。
 */
@Module({
  imports: [AuthorizationPolicyModule],
  providers: [
    BaselineRuoYiAuthzAdapter,
    { provide: RUOYI_AUTHZ_ADAPTER, useExisting: BaselineRuoYiAuthzAdapter },
  ],
  exports: [RUOYI_AUTHZ_ADAPTER, BaselineRuoYiAuthzAdapter],
})
export class RuoYiAdapterModule {}
