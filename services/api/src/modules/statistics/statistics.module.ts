import { Module, type FactoryProvider } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import { resolveAppDatabaseConfig } from '../../db/database.module';
import { SQL_CONNECTION_FACTORY } from '../../db/ports/sql-executor.port';
import type { SqlConnectionFactory, SqlExecutor } from '../../db/ports/sql-executor.port';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { StatisticsController } from './statistics.controller';
import {
  createAchievementStatisticsRepository,
  createApplicationStatisticsRepository,
  createEducationStatisticsRepository,
  createInMemorySelfStatisticsRepository,
  createMatchingStatisticsRepository,
} from './statistics.in-memory-repository';
import { createLazyPostgresSelfStatisticsRepository } from './statistics.postgres-repository';
import {
  ACHIEVEMENT_STATISTICS_REPOSITORY,
  APPLICATION_STATISTICS_REPOSITORY,
  EDUCATION_STATISTICS_REPOSITORY,
  MATCHING_STATISTICS_REPOSITORY,
  SELF_STATISTICS_REPOSITORY,
} from './statistics.port';
import type { SelfStatisticsRepository, StatisticsCountRepository } from './statistics.port';
import { StatisticsService } from './statistics.service';

/**
 * 统计模块（docs/P2-架构与数据设计.md §2 声明的「统一指标查询与明细下钻」边界）。
 *
 * 本切片落地其中**本人统计的最小垂直切片**：`GET /me/statistics` 返回服务端会话主体本人的
 * 教育记录 / 入组申请 / 成果 / 匹配请求条数。小组与全局统计（`statistics:flow:read` 等）、
 * 按状态与类型的分布、明细下钻、导出、缓存与审计落库属于后续切片，必须继续留在本模块内，
 * 不得跨模块直接调用其他领域模块的仓储（因此四类计数一律经本模块自己的计数端口读取）。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `statistics → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `statistics → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * ## 持久化绑定（本阶段：**只绑定这一个业务切片**）
 * 服务只依赖**一个**聚合读端口 `SELF_STATISTICS_REPOSITORY`，它的实现按「是否配置了数据库」分流：
 * - 未配置 `DATABASE_URL`：由四个内存来源端口组合出的内存聚合基线（默认全零，开发/测试行为不变）；
 * - 已配置 `DATABASE_URL`：`createLazyPostgresSelfStatisticsRepository` —— PostgreSQL 聚合读 adapter，
 *   延迟建连（模块装配阶段不碰数据库，保证「未 attest 的执行器」由启动期持久化边界拒绝，
 *   而不是在这里静默降级）。
 *
 * 四个来源令牌（`*_STATISTICS_REPOSITORY`）**保留**为内存基线的显式 seed 装配点
 * （控制器 spec 直接对它们写夹具），但已不再是服务的直接依赖：服务只经由聚合端口读数。
 * 其余十个 Postgres adapter 继续未绑定（见 `db/persistence/postgres-adapter-registry.ts`）。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖，也不改动 health / runtime-info /
 * profiles / groups / memberships / achievements / education / matching 等既有路由；
 * 对外只新增 `/me/statistics` 一条路由。
 */
export function createSelfStatisticsRepository(
  env: AppEnv,
  sqlConnectionFactory: SqlConnectionFactory | undefined,
  sources: {
    readonly education: StatisticsCountRepository;
    readonly applications: StatisticsCountRepository;
    readonly achievements: StatisticsCountRepository;
    readonly matching: StatisticsCountRepository;
  },
): SelfStatisticsRepository {
  // 配置解析是纯函数：复用 `DatabaseModule` 的同一份解析（含生产环境 fail-closed 规则），
  // 不额外读环境变量，也不建立任何连接。
  const resolution = resolveAppDatabaseConfig(env);

  if (resolution.status !== 'configured') {
    return createInMemorySelfStatisticsRepository(env, sources);
  }
  if (sqlConnectionFactory === undefined) {
    throw new Error(
      '数据库已配置但未提供 SQL_CONNECTION_FACTORY：拒绝退回内存统计实现（fail-closed）',
    );
  }
  const factory: SqlConnectionFactory = sqlConnectionFactory;
  return createLazyPostgresSelfStatisticsRepository(async (): Promise<SqlExecutor> =>
    factory.connect(resolution.config),
  );
}

/** 聚合端口的 provider（可选注入执行器工厂：`inject` 的 `optional` 保证测试装配无需数据库模块） */
const SELF_STATISTICS_REPOSITORY_PROVIDER: FactoryProvider = {
  provide: SELF_STATISTICS_REPOSITORY,
  useFactory: (
    env: AppEnv,
    sqlConnectionFactory: SqlConnectionFactory | undefined,
    education: StatisticsCountRepository,
    applications: StatisticsCountRepository,
    achievements: StatisticsCountRepository,
    matching: StatisticsCountRepository,
  ): SelfStatisticsRepository =>
    createSelfStatisticsRepository(env, sqlConnectionFactory, {
      education,
      applications,
      achievements,
      matching,
    }),
  inject: [
    APP_ENV,
    { token: SQL_CONNECTION_FACTORY, optional: true },
    EDUCATION_STATISTICS_REPOSITORY,
    APPLICATION_STATISTICS_REPOSITORY,
    ACHIEVEMENT_STATISTICS_REPOSITORY,
    MATCHING_STATISTICS_REPOSITORY,
  ],
};

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
    SELF_STATISTICS_REPOSITORY_PROVIDER,
  ],
})
export class StatisticsModule {}
