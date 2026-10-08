import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { InMemoryAuditRepository } from './audit.in-memory-repository';
import { AUDIT_REPOSITORY } from './audit.port';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * 不可变业务审计记录（仅追加，不提供删除接口） 模块（docs/P2-架构与数据设计.md §2 声明的边界）。
 *
 * 本切片只落地其中**本人审计摘要的最小垂直切片**：`GET /me/audit-events`（本人可查看事件的
 * 脱敏摘要）与该请求自身的服务端审计写入（`audit_self_events_read`）。
 * 管理端审计查询（`GET /admin/audit-logs`，`audit:read`）、按主体/资源/时间检索与分页、
 * 拒绝/失败结果留痕、改前/改后快照与理由字段、链式完整性校验、留存与归档策略属于后续切片，
 * 必须继续留在本模块内，不得跨模块直接调用其他领域模块的仓储。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `audit → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `audit → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * 持久化绑定：`AUDIT_REPOSITORY → InMemoryAuditRepository`（内存基线：
 * `persistent = false`、`productionReady = false`，`NODE_ENV=production` 下拒绝构造）。
 * 引入 PostgreSQL 后只替换这一个 provider 的绑定，controller/service 不改动，
 * 因此这一步可整步回退。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖、不新增第三方依赖，
 * 也不改动 health / runtime-info / profiles / groups / memberships / achievements /
 * education / matching / statistics / notifications 等既有路由；对外只新增
 * `/me/audit-events` 这一条路由。
 */
@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [AuditController],
  providers: [
    AuditService,
    InMemoryAuditRepository,
    { provide: AUDIT_REPOSITORY, useExisting: InMemoryAuditRepository },
  ],
})
export class AuditModule {}
