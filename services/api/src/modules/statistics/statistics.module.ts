import { Module } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { StatisticsController } from './statistics.controller';
import {
  createAchievementStatisticsRepository,
  createApplicationStatisticsRepository,
  createEducationStatisticsRepository,
  createMatchingStatisticsRepository,
} from './statistics.in-memory-repository';
import {
  ACHIEVEMENT_STATISTICS_REPOSITORY,
  APPLICATION_STATISTICS_REPOSITORY,
  EDUCATION_STATISTICS_REPOSITORY,
  MATCHING_STATISTICS_REPOSITORY,
} from './statistics.port';
import { StatisticsService } from './statistics.service';

/**
 * 统计模块（docs/P2-架构与数据设计.md §2 声明的「统一指标查询与明细下钻」边界）。
 *
 * 本切片只落地其中**本人统计的最小垂直切片**：`GET /me/statistics` 返回服务端会话主体本人的
 * 教育记录 / 入组申请 / 成果 / 匹配请求条数。小组与全局统计（`statistics:flow:read` 等）、
 * 按状态与类型的分布、明细下钻、导出、缓存与审计落库属于后续切片，必须继续留在本模块内，
 * 不得跨模块直接调用其他领域模块的仓储（因此四类计数一律经本模块自己的计数端口读取）。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `statistics → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `statistics → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * 持久化绑定：四个计数令牌分别绑定到**各自独立**的内存基线
 * `InMemoryStatisticsCountRepository`（`persistent = false`、`productionReady = false`，
 * `NODE_ENV=production` 下拒绝构造，默认全零）。引入 PostgreSQL 后只替换这四个 provider 的绑定
 * （或把它们换绑到直接复用各领域仓储 / `SELECT count(*)` 的适配器），controller/service 不改动，
 * 因此这一步可整步回退。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖、不新增第三方依赖，
 * 也不改动 health / runtime-info / profiles / groups / memberships / achievements /
 * education / matching 等既有路由；对外只新增 `/me/statistics` 一条路由。
 */
@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [StatisticsController],
  providers: [
    StatisticsService,
    {
      provide: EDUCATION_STATISTICS_REPOSITORY,
      useFactory: createEducationStatisticsRepository,
      inject: [APP_ENV],
    },
    {
      provide: APPLICATION_STATISTICS_REPOSITORY,
      useFactory: createApplicationStatisticsRepository,
      inject: [APP_ENV],
    },
    {
      provide: ACHIEVEMENT_STATISTICS_REPOSITORY,
      useFactory: createAchievementStatisticsRepository,
      inject: [APP_ENV],
    },
    {
      provide: MATCHING_STATISTICS_REPOSITORY,
      useFactory: createMatchingStatisticsRepository,
      inject: [APP_ENV],
    },
  ],
})
export class StatisticsModule {}
