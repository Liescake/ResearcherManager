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
import { InMemoryAuditRepository } from './audit.in-memory-repository';
import { createLazyPostgresAuditRepository } from './audit.postgres-repository';
import { AUDIT_REPOSITORY, type AuditRepository } from './audit.port';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * 不可变业务审计记录（仅追加，不提供删除接口） 模块（docs/P2-架构与数据设计.md §2 声明的边界）。
 *
 * 本切片只落地其中**本人审计摘要的最小垂直切片**：`GET /me/audit-events`（本人可查看事件的
 * 脱敏摘要）与该请求自身的服务端审计写入（`audit_self_events_read`）。
 * 管理端审计查询（`GET /admin/audit-logs`，`audit:read`）、按主体/资源/时间检索与分页、
 * 拒绝/失败结果留痕、改前/改后快照与理由字段、链式完整性校验、留存与归档策略属于后续切片，
 * 必须继续留在本模块内，不得跨模块直接调用其他领域模块的仓储。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `audit → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `audit → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * ## 持久化绑定（本切片的唯一换绑点）
 * | 条件 | 绑定 | 依据 |
 * |---|---|---|
 * | 未解析出 `DATABASE_URL` | `InMemoryAuditRepository` | 开发/测试保持现状；生产环境它自身拒绝构造 |
 * | 已解析出 `DATABASE_URL` 且有 `SQL_CONNECTION_FACTORY` | `createLazyPostgresAuditRepository` | 延迟建连（`audit_logs`，迁移 `0009`）；生产准入由启动期依赖就绪门禁判定 |
 * | 已解析出 `DATABASE_URL` 但没有执行器工厂 | **抛错** | fail-closed：绝不悄悄退回内存审计存储 |
 *
 * 「延迟建连」很关键：装配阶段不碰数据库，所以「数据库已配置但执行器未 attest / 依赖未就绪」会由
 * 启动期门禁给出**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED`、
 * `AUDIT_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`），而不是在这里表现为一个数据库连接错误。
 *
 * 与 `AuthModule` / `ProfilesModule` 等的分流口径完全一致（同一份纯函数 `resolveAppDatabaseConfig`，
 * 不额外读环境变量）。已知约束：PostgreSQL 实现的归属主键是 `uuid`（见 `audit.port.ts` 的存储 ID 域），
 * 因此绑定到数据库实现时，**非 UUID 的会话主体**会被 adapter 在进入 SQL 之前 fail-closed 拒绝
 * （`INVALID_SUBJECT`）；会话主体标识收敛为 UUID 属于后续切片。
 *
 * ## 为什么 `InMemoryAuditRepository` 不再是 provider
 * 它是**实现**，不是绑定：`AUDIT_REPOSITORY` 是唯一取用点。让它同时作为一个 provider 会引入
 * 「容器里那个实例」与「端口上那个实例」两份状态 —— 测试往其中一个 `append`、service 却读另一个，
 * 是典型的静默失效。测试因此统一 `app.get<InMemoryAuditRepository>(AUDIT_REPOSITORY)` 取夹具。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖、不新增第三方依赖，
 * 也不改动 health / runtime-info / profiles / groups / memberships / achievements /
 * education / matching / statistics / notifications 等既有路由；对外只新增
 * `/me/audit-events` 这一条路由。
 */
export function createAuditRepository(
  env: AppEnv,
  sqlConnectionFactory: SqlConnectionFactory | undefined,
): AuditRepository {
  // 配置解析是纯函数：复用 `DatabaseModule` 的同一份解析（含生产环境 fail-closed 规则），
  // 不额外读环境变量，也不建立任何连接。
  const resolution = resolveAppDatabaseConfig(env);

  if (resolution.status !== 'configured') {
    return new InMemoryAuditRepository(env);
  }
  if (sqlConnectionFactory === undefined) {
    throw new Error(
      '数据库已配置但未提供 SQL_CONNECTION_FACTORY：拒绝退回内存审计仓储（fail-closed）',
    );
  }
  const factory: SqlConnectionFactory = sqlConnectionFactory;
  return createLazyPostgresAuditRepository(async (): Promise<SqlExecutor> =>
    factory.connect(resolution.config),
  );
}

/** 审计仓储端口的 provider（可选注入执行器工厂：`inject` 的 `optional` 保证测试装配无需数据库模块） */
const AUDIT_REPOSITORY_PROVIDER: FactoryProvider = {
  provide: AUDIT_REPOSITORY,
  useFactory: (
    env: AppEnv,
    sqlConnectionFactory: SqlConnectionFactory | undefined,
  ): AuditRepository => createAuditRepository(env, sqlConnectionFactory),
  inject: [APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }],
};

@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [AuditController],
  providers: [AuditService, AUDIT_REPOSITORY_PROVIDER],
})
export class AuditModule {}
