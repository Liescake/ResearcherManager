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
import { InMemoryProfileRepository } from './student-profile.in-memory-repository';
import { createLazyPostgresStudentProfileRepository } from './student-profile.postgres-repository';
import { PROFILE_REPOSITORY, type ProfileRepository } from './student-profile.port';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

/**
 * 学生画像切片：P5 第一个**有业务实现**的本人自服务模块（读取 + 更新本人画像）。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `profiles → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `profiles → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * ## 持久化绑定（本切片的唯一换绑点）
 * | 条件 | 绑定 | 依据 |
 * |---|---|---|
 * | 未解析出 `DATABASE_URL` | `InMemoryProfileRepository` | 开发/测试保持现状；生产环境它自身拒绝构造 |
 * | 已解析出 `DATABASE_URL` 且有 `SQL_CONNECTION_FACTORY` | `createLazyPostgresStudentProfileRepository` | 延迟建连；生产准入由启动期依赖就绪门禁判定 |
 * | 已解析出 `DATABASE_URL` 但没有执行器工厂 | **抛错** | fail-closed：绝不悄悄退回内存画像存储 |
 *
 * 「延迟建连」很关键：装配阶段不碰数据库，所以「数据库已配置但执行器未 attest / 依赖未就绪」会由
 * 启动期门禁给出**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED`、
 * `PROFILE_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`），而不是在这里表现为一个数据库连接错误。
 *
 * 与 `AuthModule` 的分流口径完全一致（同一份纯函数 `resolveAppDatabaseConfig`，不额外读环境变量）。
 * 已知约束：PostgreSQL 实现的归属主键是 `uuid`（见 `student-profile.port.ts` 的存储 ID 域），
 * 因此绑定到数据库实现时，**非 UUID 的会话主体**会被 adapter 在进入 SQL 之前 fail-closed 拒绝
 * （`INVALID_SUBJECT`）；会话主体标识收敛为 UUID 属于后续切片。
 *
 * ## 为什么 `InMemoryProfileRepository` 不再是 provider
 * 它是**实现**，不是绑定：`PROFILE_REPOSITORY` 是唯一取用点。让它同时作为一个 provider 会引入
 * 「容器里那个实例」与「端口上那个实例」两份状态 —— 测试往其中一个 `seed`、service 却读另一个，
 * 是典型的静默失效。测试因此统一 `app.get<InMemoryProfileRepository>(PROFILE_REPOSITORY)` 取夹具。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖，也不改动 health / runtime-info /
 * education 等既有路由；对外只新增 `/me/profile` 的 `GET` 与 `PATCH` 两条路由。
 */
export function createProfileRepository(
  env: AppEnv,
  sqlConnectionFactory: SqlConnectionFactory | undefined,
): ProfileRepository {
  // 配置解析是纯函数：复用 `DatabaseModule` 的同一份解析（含生产环境 fail-closed 规则），
  // 不额外读环境变量，也不建立任何连接。
  const resolution = resolveAppDatabaseConfig(env);

  if (resolution.status !== 'configured') {
    return new InMemoryProfileRepository(env);
  }
  if (sqlConnectionFactory === undefined) {
    throw new Error(
      '数据库已配置但未提供 SQL_CONNECTION_FACTORY：拒绝退回内存画像仓储（fail-closed）',
    );
  }
  const factory: SqlConnectionFactory = sqlConnectionFactory;
  return createLazyPostgresStudentProfileRepository(async (): Promise<SqlExecutor> =>
    factory.connect(resolution.config),
  );
}

/** 画像仓储端口的 provider（可选注入执行器工厂：`inject` 的 `optional` 保证测试装配无需数据库模块） */
const PROFILE_REPOSITORY_PROVIDER: FactoryProvider = {
  provide: PROFILE_REPOSITORY,
  useFactory: (
    env: AppEnv,
    sqlConnectionFactory: SqlConnectionFactory | undefined,
  ): ProfileRepository => createProfileRepository(env, sqlConnectionFactory),
  inject: [APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }],
};

@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [ProfilesController],
  providers: [ProfilesService, PROFILE_REPOSITORY_PROVIDER],
})
export class ProfilesModule {}
