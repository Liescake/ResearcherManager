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
import { ApplicationReviewsController } from './application-reviews.controller';
import { InMemoryApplicationReviewRepository } from './application-reviews.in-memory-repository';
import { createLazyPostgresApplicationReviewRepository } from './applications.postgres-repository';
import { APPLICATION_REVIEW_REPOSITORY } from './application-reviews.port';
import type { ApplicationReviewRepository } from './application-reviews.port';
import { ApplicationReviewsService } from './application-reviews.service';

/**
 * 入退组申请与成员关系状态机 模块（docs/P2-架构与数据设计.md §2 声明的边界）。
 *
 * 本模块落地入组申请的**两个独立授权切片**：
 * - **申请人自服务**（`applications.*`）：创建 / 本人列表 / 本人撤回，主体恒为 `SELF`，
 *   取数谓词是「按申请人归属隔离」；
 * - **团队审核端**（`application-reviews.*`）：管理端列表与审核（通过/驳回），
 *   范围由服务端主体解析为 `GROUP`（服务端已验证的小组集合）或 `GLOBAL`，
 *   取数谓词是「按小组范围隔离」。
 *
 * 两个切片**刻意不共用端口**：申请人端口的每条谓词都以 `user_id` 为归属锚，审核端需要读**他人**
 * 申请，共用一条归属谓词必然把「他人记录不出库」降级为「调用方记得复核」。因此审核端有自己的
 * 令牌 `APPLICATION_REVIEW_REPOSITORY`、自己的范围类型、自己的 SQL（见两个 `*.port.ts` 的文件头）。
 * 成员关系、退组申请仍属后续切片，必须继续留在本模块内，不得跨模块直接调用。
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
 * education / profiles 等既有路由；对外只新增申请人端的三条路由
 * （`/me/applications` ×2 与 `/me/applications/{applicationId}/withdraw`）与审核端的两条路由
 * （`/admin/applications` 与 `/admin/applications/{applicationId}/review`）。
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

/**
 * **审核端**仓储的分流点（与申请人端**逐条同构**，但绑定到独立令牌 `APPLICATION_REVIEW_REPOSITORY`）。
 *
 * | 条件 | 绑定 | 依据 |
 * |---|---|---|
 * | 未解析出 `DATABASE_URL` | `InMemoryApplicationReviewRepository` | 开发/测试基线；生产环境它自身拒绝构造 |
 * | 已解析出 `DATABASE_URL` 且有 `SQL_CONNECTION_FACTORY` | `createLazyPostgresApplicationReviewRepository` | 延迟建连；读写同一张 `join_applications`（迁移 0003） |
 * | 已解析出 `DATABASE_URL` 但没有执行器工厂 | **抛错** | fail-closed：绝不悄悄退回内存审核存储 |
 *
 * 两个端口各自独立分流、独立登记（`db/persistence-bindings.ts`），因此生产门禁会**分别**判定
 * 「审核端读到的数据是不是持久的」，不会因为申请人端已换绑就默认审核端也换绑了。
 */
export function createApplicationReviewRepository(
  env: AppEnv,
  sqlConnectionFactory: SqlConnectionFactory | undefined,
): ApplicationReviewRepository {
  const resolution = resolveAppDatabaseConfig(env);

  if (resolution.status !== 'configured') {
    return new InMemoryApplicationReviewRepository(env);
  }
  if (sqlConnectionFactory === undefined) {
    throw new Error(
      '数据库已配置但未提供 SQL_CONNECTION_FACTORY：拒绝退回内存审核仓储（fail-closed）',
    );
  }
  const factory: SqlConnectionFactory = sqlConnectionFactory;
  return createLazyPostgresApplicationReviewRepository(async (): Promise<SqlExecutor> =>
    factory.connect(resolution.config),
  );
}

/** 审核端仓储端口的 provider（与申请人端同样的可选注入口径） */
const APPLICATION_REVIEW_REPOSITORY_PROVIDER: FactoryProvider = {
  provide: APPLICATION_REVIEW_REPOSITORY,
  useFactory: (
    env: AppEnv,
    sqlConnectionFactory: SqlConnectionFactory | undefined,
  ): ApplicationReviewRepository => createApplicationReviewRepository(env, sqlConnectionFactory),
  inject: [APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }],
};

@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [ApplicationsController, ApplicationReviewsController],
  providers: [
    ApplicationsService,
    ApplicationReviewsService,
    APPLICATION_REPOSITORY_PROVIDER,
    APPLICATION_REVIEW_REPOSITORY_PROVIDER,
  ],
})
export class MembershipsModule {}
