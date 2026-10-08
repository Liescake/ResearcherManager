import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { GroupsController } from './groups.controller';
import { InMemoryGroupRepository } from './groups.in-memory-repository';
import { GROUP_REPOSITORY } from './groups.port';
import { GroupsService } from './groups.service';

/**
 * 小组、开放状态与招募要求 模块（docs/P2-架构与数据设计.md §2 声明的边界）。
 *
 * 本切片只落地其中**最小垂直切片**（浏览可见的开放小组 / 创建小组），因此模块内目前只有
 * `groups.*` 一组文件；小组详情、修改/停用（含状态机）、成员关系、负责人指派与审核编排
 * 属于后续切片，必须继续留在本模块内，不得跨模块直接调用。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `groups → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `groups → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * 持久化绑定：`GROUP_REPOSITORY → InMemoryGroupRepository`
 * （内存基线，非生产存储：`persistent = false`，`NODE_ENV=production` 下拒绝构造）。
 * 引入数据库后只替换这一个 provider 的绑定，controller/service 不改动。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖，也不改动 health / runtime-info /
 * education / profiles / memberships / achievements 等既有路由；对外只新增 `/groups` 的两条路由。
 */
@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [GroupsController],
  providers: [
    GroupsService,
    InMemoryGroupRepository,
    { provide: GROUP_REPOSITORY, useExisting: InMemoryGroupRepository },
  ],
})
export class GroupsModule {}
