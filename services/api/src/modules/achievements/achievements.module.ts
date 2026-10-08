import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { AchievementsController } from './achievements.controller';
import { InMemoryAchievementRepository } from './achievements.in-memory-repository';
import { ACHIEVEMENT_REPOSITORY } from './achievements.port';
import { AchievementsService } from './achievements.service';

/**
 * 成果、附件与审核 模块（docs/P2-架构与数据设计.md §2 声明的边界）。
 *
 * 本切片只落地其中**成果的学生自服务部分**（创建本人成果 / 本人成果列表），
 * 因此模块内目前只有 `achievements.*` 一组文件；附件实体、审核（`achievement:review`）、
 * 单条读取与更新、导出与统计属于后续切片，必须继续留在本模块内，不得跨模块直接调用。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `achievements → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `achievements → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * 持久化绑定：`ACHIEVEMENT_REPOSITORY → InMemoryAchievementRepository`
 * （内存基线，非生产存储：`persistent = false`，`NODE_ENV=production` 下拒绝构造）。
 * 引入数据库后只替换这一个 provider 的绑定，controller/service 不改动。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖，也不改动 health / runtime-info /
 * education / profiles / memberships 等既有路由；对外只新增 `/me/achievements` 的两条路由。
 */
@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [AchievementsController],
  providers: [
    AchievementsService,
    InMemoryAchievementRepository,
    { provide: ACHIEVEMENT_REPOSITORY, useExisting: InMemoryAchievementRepository },
  ],
})
export class AchievementsModule {}
