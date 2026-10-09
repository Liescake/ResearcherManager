import { Module, type FactoryProvider } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import { resolveAppDatabaseConfig } from '../../db/database.module';
import { SQL_CONNECTION_FACTORY } from '../../db/ports/sql-executor.port';
import type { SqlConnectionFactory, SqlExecutor } from '../../db/ports/sql-executor.port';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { GroupsController } from './groups.controller';
import { InMemoryGroupRepository } from './groups.in-memory-repository';
import { createLazyPostgresGroupRepository } from './groups.postgres-repository';
import { GROUP_REPOSITORY } from './groups.port';
import type { GroupRepository } from './groups.port';
import { GroupsService } from './groups.service';

/**
 * 小组、开放状态与招募要求 模块（docs/P2-架构与数据设计.md §2 声明的边界）。
 *
 * 本切片只落地其中**最小垂直切片**（分页浏览可见的开放小组 / 创建小组），因此模块内目前只有
 * `groups.*` 一组文件；小组详情、修改/停用（含状态机）、成员关系、负责人指派与审核编排
 * 属于后续切片，必须继续留在本模块内，不得跨模块直接调用。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `groups → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `groups → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * ## 持久化绑定（本切片的唯一换绑点）
 * | 条件 | 绑定 | 依据 |
 * |---|---|---|
 * | 未解析出 `DATABASE_URL` | `InMemoryGroupRepository` | 开发/测试保持现状；生产环境它自身拒绝构造 |
 * | 已解析出 `DATABASE_URL` 且有 `SQL_CONNECTION_FACTORY` | `createLazyPostgresGroupRepository` | 延迟建连（`research_groups`，迁移 `0011`）；生产准入由启动期依赖就绪门禁判定 |
 * | 已解析出 `DATABASE_URL` 但没有执行器工厂 | **抛错** | fail-closed：绝不悄悄退回内存小组存储 |
 *
 * 「延迟建连」很关键：装配阶段不碰数据库，所以「数据库已配置但执行器未 attest / 依赖未就绪」
 * 会由启动期门禁给出**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED`、
 * `GROUP_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`），而不是在这里表现为一个数据库连接错误。
 *
 * 与 `AuthModule` / `AuditModule` / `NotificationsModule` / `ProfilesModule` 等的分流口径完全一致
 * （同一份纯函数 `resolveAppDatabaseConfig`，不额外读环境变量）。已知约束：PostgreSQL 实现的
 * 归属主键是 `uuid`（见 `groups.port.ts` 的存储 ID 域说明），因此绑定到数据库实现时，
 * **非 UUID 的资源标识（会话主体的 `groupIds` / `assignedResourceIds`）** 会被 adapter 在进入
 * SQL 之前 fail-closed 拒绝（`INVALID_QUERY`）；会话主体标识收敛为 UUID 属于后续切片。
 *
 * ## 为什么 `InMemoryGroupRepository` 不再是 provider
 * 它是**实现**，不是绑定：`GROUP_REPOSITORY` 是唯一取用点。让它同时作为一个 provider 会引入
 * 「容器里那个实例」与「端口上那个实例」两份状态 —— 测试往其中一个 `create`、service 却读另一个，
 * 是典型的静默失效。测试因此统一 `app.get<InMemoryGroupRepository>(GROUP_REPOSITORY)` 取夹具。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖，也不改动 health / runtime-info /
 * profiles / memberships / achievements / education / matching / statistics / notifications
 * 等既有路由；对外只新增 `/groups` 的两条路由。
 */
export function createGroupRepository(
  env: AppEnv,
  sqlConnectionFactory: SqlConnectionFactory | undefined,
): GroupRepository {
  // 配置解析是纯函数：复用 `DatabaseModule` 的同一份解析（含生产环境 fail-closed 规则），
  // 不额外读环境变量，也不建立任何连接。
  const resolution = resolveAppDatabaseConfig(env);

  if (resolution.status !== 'configured') {
    return new InMemoryGroupRepository(env);
  }
  if (sqlConnectionFactory === undefined) {
    throw new Error(
      '数据库已配置但未提供 SQL_CONNECTION_FACTORY：拒绝退回内存小组仓储（fail-closed）',
    );
  }
  const factory: SqlConnectionFactory = sqlConnectionFactory;
  return createLazyPostgresGroupRepository(async (): Promise<SqlExecutor> =>
    factory.connect(resolution.config),
  );
}

/** 小组仓储端口的 provider（可选注入执行器工厂：`inject` 的 `optional` 保证测试装配无需数据库模块） */
const GROUP_REPOSITORY_PROVIDER: FactoryProvider = {
  provide: GROUP_REPOSITORY,
  useFactory: (
    env: AppEnv,
    sqlConnectionFactory: SqlConnectionFactory | undefined,
  ): GroupRepository => createGroupRepository(env, sqlConnectionFactory),
  inject: [APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }],
};

@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [GroupsController],
  providers: [GroupsService, GROUP_REPOSITORY_PROVIDER],
})
export class GroupsModule {}
