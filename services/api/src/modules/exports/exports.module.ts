import { Module, type FactoryProvider } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import { resolveAppDatabaseConfig } from '../../db/database.module';
import { SQL_CONNECTION_FACTORY } from '../../db/ports/sql-executor.port';
import type { SqlConnectionFactory, SqlExecutor } from '../../db/ports/sql-executor.port';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { InMemoryExportArtifactStore } from './exports.artifact-store.in-memory';
import { ExportsController } from './exports.controller';
import { InMemoryExportRepository } from './exports.in-memory-repository';
import { createLazyPostgresExportRepository } from './exports.postgres-repository';
import { EXPORT_ARTIFACT_STORE, EXPORT_REPOSITORY } from './exports.port';
import type { ExportRepository } from './exports.port';
import { ExportsService } from './exports.service';

/**
 * 导出模块（docs/P2-架构与数据设计.md §2「exports | 异步导出、脱敏、有效期、下载审计」声明的边界）。
 *
 * 本切片只落地其中**本人导出请求的最小垂直切片**：
 * - `POST /me/exports` 创建本人的导出请求（服务端白名单资源 + 字段）；
 * - `GET  /me/exports` 本人导出请求列表与状态。
 *
 * 真实文件生成与字段级脱敏、有效期与清理、下载路由与下载审计、管理端 `POST /admin/exports`
 * （`export:{resource}:create`）、列表分页与筛选属于后续切片，必须继续留在本模块内，
 * 不得跨模块直接调用其他领域模块的仓储（导出范围只由本模块的服务端字段白名单决定）。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `exports → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `exports → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * ## 持久化绑定（本切片的唯一换绑点）
 * | 条件 | 绑定 | 依据 |
 * |---|---|---|
 * | 未解析出 `DATABASE_URL` | `InMemoryExportRepository` | 开发/测试保持现状；生产环境它自身拒绝构造 |
 * | 已解析出 `DATABASE_URL` 且有 `SQL_CONNECTION_FACTORY` | `createLazyPostgresExportRepository` | 延迟建连（`export_jobs`，迁移 `0013`）；生产准入由启动期依赖就绪门禁判定 |
 * | 已解析出 `DATABASE_URL` 但没有执行器工厂 | **抛错** | fail-closed：绝不悄悄退回内存导出存储 |
 *
 * 「延迟建连」很关键：装配阶段不碰数据库，所以「数据库已配置但执行器未 attest / 依赖未就绪」
 * 会由启动期门禁给出**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED`、
 * `EXPORT_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`），而不是在这里表现为一个数据库连接错误。
 *
 * 与 `AuthModule` / `ComplianceModule` / `AuditModule` / `NotificationsModule` / `GroupsModule`
 * 等的分流口径完全一致（同一份纯函数 `resolveAppDatabaseConfig`，不额外读环境变量）。
 * 已知约束：PostgreSQL 实现的归属主键是 `uuid`（见 `exports.port.ts` 的
 * `EXPORT_REPOSITORY_STORAGE_ID_DOMAIN`），因此绑定到数据库实现时，**非 UUID 的会话主体**
 * （基线是 `u-student-1` 这类安全 ID）会被 adapter 在**进入 SQL 之前** fail-closed 拒绝
 * （`INVALID_SUBJECT`），且不触发任何数据库连接；会话主体标识收敛为 UUID 属于后续切片
 * （已登记在 adapter 的验证清单里）。
 *
 * ## 为什么 `InMemoryExportRepository` 不再是 provider
 * 它是**实现**，不是绑定：`EXPORT_REPOSITORY` 是唯一取用点。让它同时作为一个 provider 会引入
 * 「容器里那个实例」与「端口上那个实例」两份状态 —— 测试往其中一个 `create`、service 却读另一个，
 * 是典型的静默失效；在「数据库已配置」的运行时里更会同时存在一个**永远不被使用**的内存仓储实例，
 * 让「当前到底落到了哪个后端」变得不可判定。测试因此统一
 * `app.get<InMemoryExportRepository>(EXPORT_REPOSITORY)` 取夹具
 * （见 `exports.binding.spec.ts` 与 `exports.controller.spec.ts`）。
 *
 * ## 为什么产物存储仍然是内存实现且仍是 provider
 * `EXPORT_ARTIFACT_STORE` 的**真实实现（对象存储 / 临时文件区）不在本切片**（用户明确要求
 * 不实现真实文件外发与第三方存储）。它保持内存基线 + 显式 provider 绑定，因此换绑点只有一处，
 * 且它如实声明 `persistent = false` / `productionReady = false`，生产环境由 `PersistenceBoundaryService`
 * 与依赖就绪门禁拦下 —— 不会被误当作可用的生产产物存储。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖、不新增第三方依赖
 * （复用 `@rm/shared`），也不改动 health / runtime-info / profiles / groups / memberships /
 * achievements / education / matching / statistics / notifications / audit 等既有路由；
 * 对外只新增 `/me/exports` 的两条路由。
 */
export function createExportRepository(
  env: AppEnv,
  sqlConnectionFactory: SqlConnectionFactory | undefined,
): ExportRepository {
  // 配置解析是纯函数：复用 `DatabaseModule` 的同一份解析（含生产环境 fail-closed 规则），
  // 不额外读环境变量，也不建立任何连接。
  const resolution = resolveAppDatabaseConfig(env);

  if (resolution.status !== 'configured') {
    return new InMemoryExportRepository(env);
  }
  if (sqlConnectionFactory === undefined) {
    throw new Error(
      '数据库已配置但未提供 SQL_CONNECTION_FACTORY：拒绝退回内存导出仓储（fail-closed）',
    );
  }
  const factory: SqlConnectionFactory = sqlConnectionFactory;
  return createLazyPostgresExportRepository(async (): Promise<SqlExecutor> =>
    factory.connect(resolution.config),
  );
}

/** 导出请求仓储端口的 provider（可选注入执行器工厂：`inject` 的 `optional` 保证测试装配无需数据库模块） */
const EXPORT_REPOSITORY_PROVIDER: FactoryProvider = {
  provide: EXPORT_REPOSITORY,
  useFactory: (
    env: AppEnv,
    sqlConnectionFactory: SqlConnectionFactory | undefined,
  ): ExportRepository => createExportRepository(env, sqlConnectionFactory),
  inject: [APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }],
};

@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [ExportsController],
  providers: [
    ExportsService,
    EXPORT_REPOSITORY_PROVIDER,
    InMemoryExportArtifactStore,
    { provide: EXPORT_ARTIFACT_STORE, useExisting: InMemoryExportArtifactStore },
  ],
})
export class ExportsModule {}
