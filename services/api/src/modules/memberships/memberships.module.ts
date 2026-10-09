import { Module, type FactoryProvider } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import { resolveAppDatabaseConfig } from '../../db/database.module';
import {
  SQL_CONNECTION_FACTORY,
  type SqlConnectionFactory,
  type SqlExecutor,
} from '../../db/ports/sql-executor.port';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { ApplicationsController } from './applications.controller';
import { InMemoryApplicationRepository } from './applications.in-memory-repository';
import { createLazyPostgresApplicationRepository } from './applications.postgres-repository';
import { APPLICATION_REPOSITORY } from './applications.port';
import type { ApplicationRepository } from './applications.port';
import { ApplicationsService } from './applications.service';

/**
 * 入退组申请与成员关系状态机 模块（docs/P2-架构与数据设计.md §2 声明的边界）。
 *
 * 本切片只落地其中**入组申请的学生自服务部分**（创建 / 本人列表 / 本人撤回），
 * 因此模块内目前只有 `applications.*` 一组文件；成员关系、退组申请与管理端审核属于后续切片，
 * 必须继续留在本模块内，不得跨模块直接调用。**审核侧不复用本切片的绑定**：本端口的取数口径
 * 是「按服务端主体（申请人）归属隔离」，团队审核者要读他人申请必须另有自己的
 * 端口 / 权限点（`membership:review:group` / `membership:review:global`）与独立切片。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `memberships → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `memberships → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * ## 持久化绑定（本切片的唯一换绑点）
 * | 条件 | 绑定 | 依据 |
 * |---|---|---|
 * | 未解析出 `DATABASE_URL` | `InMemoryApplicationRepository` | 开发/测试保持现状；生产环境它自身拒绝构造（且生产缺 `DATABASE_URL` 在配置解析阶段就已被拒绝） |
 * | 已解析出 `DATABASE_URL` 且有 `SQL_CONNECTION_FACTORY` | `createLazyPostgresApplicationRepository` | 延迟建连；生产准入由启动期依赖就绪门禁判定 |
 * | 已解析出 `DATABASE_URL` 但没有执行器工厂 | **抛错** | fail-closed：绝不悄悄退回内存入组申请存储 |
 *
 * 「延迟建连」很关键：装配阶段不碰数据库，所以「数据库已配置但执行器未 attest / 依赖未就绪」会由
 * 启动期门禁给出**结构化违规**（`SQL_CONNECTION_FACTORY[SQL_EXECUTOR_VERIFICATION_FAILED]`、
 * `APPLICATION_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`），而不是在这里表现为一个数据库连接错误。
 * 也就是说：**生产配置了数据库但依赖不就绪 ⇒ 启动即失败，PostgreSQL 实现不会上线服务请求**。
 *
 * 与 `AuthModule` / `ProfilesModule` / `AchievementsModule` / `EducationModule` /
 * `StatisticsModule` 的分流口径完全一致（同一份纯函数 `resolveAppDatabaseConfig`，
 * 不额外读环境变量，也不建立任何连接）。
 *
 * 已知约束：PostgreSQL 实现的归属主键是 `uuid`（见 `applications.port.ts` 的存储 ID 域），
 * 因此绑定到数据库实现时，**非 UUID 的会话主体**会被 adapter 在进入 SQL 之前 fail-closed 拒绝
 * （`INVALID_SUBJECT`）；会话主体标识收敛为 UUID 属于后续切片，已登记在
 * `POSTGRES_APPLICATION_REPOSITORY_VERIFICATION_STEPS`。
 *
 * ## 为什么 `InMemoryApplicationRepository` 不再是 provider
 * 它是**实现**，不是绑定：`APPLICATION_REPOSITORY` 是唯一取用点。让它同时作为一个 provider
 * 会引入「容器里那个实例」与「端口上那个实例」两份状态 —— 测试往其中一个写入、service 却读另一个，
 * 是典型的静默失效；更严重的是它会在生产环境实例化时抛错，**即使端口已经被换绑到数据库实现**。
 * 测试因此统一 `app.get<ApplicationRepository>(APPLICATION_REPOSITORY)` 取夹具
 * （未配置数据库时该令牌上就是这个内存实现）。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖，也不改动 health / runtime-info /
 * education / profiles 等既有路由；对外只新增 `/me/applications` 的两条路由与
 * `/me/applications/{applicationId}/withdraw`。
 */
export function createApplicationRepository(
  env: AppEnv,
  sqlConnectionFactory: SqlConnectionFactory | undefined,
): ApplicationRepository {
  // 配置解析是纯函数：复用 `DatabaseModule` 的同一份解析（含生产环境 fail-closed 规则），
  // 不额外读环境变量，也不建立任何连接。
  const resolution = resolveAppDatabaseConfig(env);

  if (resolution.status !== 'configured') {
    return new InMemoryApplicationRepository(env);
  }
  if (sqlConnectionFactory === undefined) {
    throw new Error(
      '数据库已配置但未提供 SQL_CONNECTION_FACTORY：拒绝退回内存入组申请仓储（fail-closed）',
    );
  }
  const factory: SqlConnectionFactory = sqlConnectionFactory;
  return createLazyPostgresApplicationRepository(async (): Promise<SqlExecutor> =>
    factory.connect(resolution.config),
  );
}

/** 入组申请仓储端口的 provider（可选注入执行器工厂：`inject` 的 `optional` 保证测试装配无需数据库模块） */
const APPLICATION_REPOSITORY_PROVIDER: FactoryProvider = {
  provide: APPLICATION_REPOSITORY,
  useFactory: (
    env: AppEnv,
    sqlConnectionFactory: SqlConnectionFactory | undefined,
  ): ApplicationRepository => createApplicationRepository(env, sqlConnectionFactory),
  inject: [APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }],
};

@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, APPLICATION_REPOSITORY_PROVIDER],
})
export class MembershipsModule {}
