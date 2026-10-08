import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { ApplicationsController } from './applications.controller';
import { InMemoryApplicationRepository } from './applications.in-memory-repository';
import { APPLICATION_REPOSITORY } from './applications.port';
import { ApplicationsService } from './applications.service';

/**
 * 入退组申请与成员关系状态机 模块（docs/P2-架构与数据设计.md §2 声明的边界）。
 *
 * 本切片只落地其中**入组申请的学生自服务部分**（创建 / 本人列表 / 本人撤回），
 * 因此模块内目前只有 `applications.*` 一组文件；成员关系、退组申请与管理端审核属于后续切片，
 * 必须继续留在本模块内，不得跨模块直接调用。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `memberships → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `memberships → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * 持久化绑定：`APPLICATION_REPOSITORY → InMemoryApplicationRepository`
 * （内存基线，非生产存储：`persistent = false`，`NODE_ENV=production` 下拒绝构造）。
 * 引入数据库后只替换这一个 provider 的绑定，controller/service 不改动。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖，也不改动 health / runtime-info /
 * education / profiles 等既有路由；对外只新增 `/me/applications` 的两条路由与
 * `/me/applications/{applicationId}/withdraw`。
 */
@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [ApplicationsController],
  providers: [
    ApplicationsService,
    InMemoryApplicationRepository,
    { provide: APPLICATION_REPOSITORY, useExisting: InMemoryApplicationRepository },
  ],
})
export class MembershipsModule {}
