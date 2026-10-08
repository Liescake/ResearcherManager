import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { ComplianceController } from './compliance.controller';
import { InMemoryComplianceRepository } from './compliance.in-memory-repository';
import { COMPLIANCE_REPOSITORY } from './compliance.port';
import { ComplianceService } from './compliance.service';

/**
 * 合规模块（docs/P2-架构与数据设计.md §2「compliance | 同意、留存、更正、删除与归档流程」
 * 声明的边界）。本切片只落地其中**本人合规状态的最小读侧垂直切片**：
 * `GET /me/compliance-status` 返回本人的隐私同意 / 数据保留 / 导出可用性三个状态枚举。
 *
 * 记录与撤回同意、政策版本升级、保留期限配置与到期清理、更正与删除请求、归档与调查冻结、
 * 通知投递、审计落库、管理端合规视图属于后续切片，必须继续留在本模块内，
 * 不得跨模块直接调用其他领域模块的仓储。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `compliance → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `compliance → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * 绑定关系（可在测试/迁移期整步替换，controller/service 不改动）：
 * `COMPLIANCE_REPOSITORY` → `InMemoryComplianceRepository`（非生产内存基线，
 * `persistent = false` / `productionReady = false`，`NODE_ENV=production` 下拒绝构造）。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖、不新增第三方依赖
 * （复用 `@rm/shared`），也不改动 health / runtime-info / profiles / groups / memberships /
 * achievements / education / matching / statistics / notifications / audit / exports 等既有路由；
 * 对外只新增 `/me/compliance-status` 这一条只读路由。
 */
@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [ComplianceController],
  providers: [
    ComplianceService,
    InMemoryComplianceRepository,
    { provide: COMPLIANCE_REPOSITORY, useExisting: InMemoryComplianceRepository },
  ],
})
export class ComplianceModule {}
