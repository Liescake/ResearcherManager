import { Module, type FactoryProvider } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import { resolveAppDatabaseConfig } from '../../db/database.module';
import { SQL_CONNECTION_FACTORY } from '../../db/ports/sql-executor.port';
import type { SqlConnectionFactory, SqlExecutor } from '../../db/ports/sql-executor.port';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { ComplianceController } from './compliance.controller';
import { InMemoryComplianceRepository } from './compliance.in-memory-repository';
import { createLazyPostgresComplianceRepository } from './compliance.postgres-repository';
import { COMPLIANCE_REPOSITORY } from './compliance.port';
import type { ComplianceRepository } from './compliance.port';
import { ComplianceService } from './compliance.service';

/**
 * 合规模块（docs/P2-架构与数据设计.md §2「compliance | 同意、留存、更正、删除与归档流程」
 * 声明的边界）。本切片只落地其中**本人合规状态的最小读侧垂直切片**：
 * `GET /me/compliance-status` 返回本人的隐私同意 / 数据保留 / 导出可用性三个状态枚举。
 *
 * 记录与撤回同意、政策版本升级、保留期限配置与到期清理、更正与删除请求、归档与调查冻结、
 * 通知投递、审计落库、管理端合规视图属于后续切片，必须继续留在本模块内，
 * 不得跨模块直接调用其他领域模块的仓储。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `compliance → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `compliance → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * ## 持久化绑定（本切片的唯一换绑点）
 * | 条件 | 绑定 | 依据 |
 * |---|---|---|
 * | 未解析出 `DATABASE_URL` | `InMemoryComplianceRepository` | 开发/测试保持现状；生产环境它自身拒绝构造 |
 * | 已解析出 `DATABASE_URL` 且有 `SQL_CONNECTION_FACTORY` | `createLazyPostgresComplianceRepository` | 延迟建连（`user_compliance`，迁移 `0012`）；生产准入由启动期依赖就绪门禁判定 |
 * | 已解析出 `DATABASE_URL` 但没有执行器工厂 | **抛错** | fail-closed：绝不悄悄退回内存合规存储 |
 *
 * 「延迟建连」很关键：装配阶段不碰数据库，所以「数据库已配置但执行器未 attest / 依赖未就绪」
 * 会由启动期门禁给出**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED`、
 * `COMPLIANCE_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`），而不是在这里表现为一个数据库连接错误。
 *
 * 与 `AuthModule` / `AuditModule` / `NotificationsModule` / `GroupsModule` 等的分流口径完全一致
 * （同一份纯函数 `resolveAppDatabaseConfig`，不额外读环境变量）。已知约束：PostgreSQL 实现的
 * 归属主键是 `uuid`（见 `compliance.port.ts` 的存储 ID 域说明），因此绑定到数据库实现时，
 * **非 UUID 的会话主体**（基线是 `u-student-1` 这类安全 ID）会被 adapter 在**进入 SQL 之前**
 * fail-closed 拒绝（`INVALID_SUBJECT`），且不触发任何数据库连接；会话主体标识收敛为 UUID
 * 属于后续切片（已登记在 adapter 的验证清单里）。
 *
 * ## 为什么 `InMemoryComplianceRepository` 不再是 provider
 * 它是**实现**，不是绑定：`COMPLIANCE_REPOSITORY` 是唯一取用点。让它同时作为一个 provider 会引入
 * 「容器里那个实例」与「端口上那个实例」两份状态 —— 测试往其中一个 `seed`、service 却读另一个，
 * 是典型的静默失效。测试因此统一 `app.get<InMemoryComplianceRepository>(COMPLIANCE_REPOSITORY)`
 * 取夹具（见 `compliance.binding.spec.ts` 与 `compliance.controller.spec.ts`）。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖、不新增第三方依赖
 * （复用 `@rm/shared`），也不改动 health / runtime-info / profiles / groups / memberships /
 * achievements / education / matching / statistics / notifications / audit / exports 等既有路由；
 * 对外只新增 `/me/compliance-status` 这一条只读路由。
 */
export function createComplianceRepository(
  env: AppEnv,
  sqlConnectionFactory: SqlConnectionFactory | undefined,
): ComplianceRepository {
  // 配置解析是纯函数：复用 `DatabaseModule` 的同一份解析（含生产环境 fail-closed 规则），
  // 不额外读环境变量，也不建立任何连接。
  const resolution = resolveAppDatabaseConfig(env);

  if (resolution.status !== 'configured') {
    return new InMemoryComplianceRepository(env);
  }
  if (sqlConnectionFactory === undefined) {
    throw new Error(
      '数据库已配置但未提供 SQL_CONNECTION_FACTORY：拒绝退回内存合规仓储（fail-closed）',
    );
  }
  const factory: SqlConnectionFactory = sqlConnectionFactory;
  return createLazyPostgresComplianceRepository(async (): Promise<SqlExecutor> =>
    factory.connect(resolution.config),
  );
}

/** 合规仓储端口的 provider（可选注入执行器工厂：`inject` 的 `optional` 保证测试装配无需数据库模块） */
const COMPLIANCE_REPOSITORY_PROVIDER: FactoryProvider = {
  provide: COMPLIANCE_REPOSITORY,
  useFactory: (
    env: AppEnv,
    sqlConnectionFactory: SqlConnectionFactory | undefined,
  ): ComplianceRepository => createComplianceRepository(env, sqlConnectionFactory),
  inject: [APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }],
};

@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [ComplianceController],
  providers: [ComplianceService, COMPLIANCE_REPOSITORY_PROVIDER],
})
export class ComplianceModule {}
