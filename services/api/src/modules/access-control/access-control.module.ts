import { Module } from '@nestjs/common';
import { AuthorizationGuard } from './authorization-guard';
import { AuthorizationPolicy } from './authorization-policy';

/** API 授权策略模块；业务模块通过 AuthorizationPolicy 使用共享的默认拒绝规则。 */
@Module({
  providers: [AuthorizationPolicy, AuthorizationGuard],
  exports: [AuthorizationPolicy, AuthorizationGuard],
})
export class AccessControlModule {}
