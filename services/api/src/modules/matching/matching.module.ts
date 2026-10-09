import { Module, type FactoryProvider } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import { resolveAppDatabaseConfig } from '../../db/database.module';
import { SQL_CONNECTION_FACTORY } from '../../db/ports/sql-executor.port';
import type { SqlConnectionFactory, SqlExecutor } from '../../db/ports/sql-executor.port';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { createMatchingAiProvider } from './matching.ai-provider';
import { MatchingController } from './matching.controller';
import { InMemoryMatchingFeatureSource } from './matching.feature-source.in-memory';
import { InMemoryMatchingRepository } from './matching.in-memory-repository';
import { createLazyPostgresMatchingRepository } from './matching.postgres-repository';
import {
  MATCHING_AI_PROVIDER,
  MATCHING_FEATURE_SOURCE,
  MATCHING_REPOSITORY,
} from './matching.port';
import type { MatchingRepository } from './matching.port';
import { MatchingService } from './matching.service';

/**
 * 匹配模块（docs/P2-架构与数据设计.md §2 声明的「特征最小化、召回、AI 排序、校验、降级」边界）。
 *
 * 本切片只落地学生自服务部分（发起本人匹配请求 / 本人列表与状态）；管理端匹配记录、
 * 推荐历史与导出、画像版本核对、异步化处理属于后续切片，必须继续留在本模块内，
 * 不得跨模块直接调用。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `matching → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `matching → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * ## 持久化绑定（本切片的唯一换绑点）
 * | 条件 | 绑定 | 依据 |
 * |---|---|---|
 * | 未解析出 `DATABASE_URL` | `InMemoryMatchingRepository` | 开发/测试保持现状；生产环境它自身拒绝构造 |
 * | 已解析出 `DATABASE_URL` 且有 `SQL_CONNECTION_FACTORY` | `createLazyPostgresMatchingRepository` | 延迟建连（`ai_match_records`，迁移 `0005`）；生产准入由启动期依赖就绪门禁判定 |
 * | 已解析出 `DATABASE_URL` 但没有执行器工厂 | **抛错** | fail-closed：绝不悄悄退回内存匹配存储 |
 *
 * 「延迟建连」很关键：装配阶段不碰数据库，所以「数据库已配置但执行器未 attest / 依赖未就绪」
 * 会由启动期门禁给出**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED`、
 * `MATCHING_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`），而不是在这里表现为一个数据库连接错误。
 *
 * 与 `AuthModule` / `ComplianceModule` / `ExportsModule` 等的分流口径完全一致
 * （同一份纯函数 `resolveAppDatabaseConfig`，不额外读环境变量）。已知约束：PostgreSQL 实现的
 * 归属主键是 `uuid`（见 `matching.port.ts` 的 `MATCHING_REPOSITORY_STORAGE_ID_DOMAIN`），
 * 因此绑定到数据库实现时，**非 UUID 的会话主体**（基线是 `u-student-1` 这类安全 ID）与
 * 非 UUID 的召回小组标识会被 adapter 在**进入 SQL 之前** fail-closed 拒绝
 * （`INVALID_SUBJECT` / `INVALID_RECORD`，且不触发任何数据库连接）；会话主体与召回小组标识
 * 收敛为 UUID 属于后续切片（已登记在 adapter 的验证清单里）。
 *
 * ## 为什么 `InMemoryMatchingRepository` 不再是 provider
 * 它是**实现**，不是绑定：`MATCHING_REPOSITORY` 是唯一取用点。让它同时作为一个 provider 会引入
 * 「容器里那个实例」与「端口上那个实例」两份状态 —— 测试往其中一个 `create`、service 却读另一个，
 * 是典型的静默失效；在「数据库已配置」的运行时里更会同时存在一个**永远不被使用**的内存仓储实例，
 * 让「当前到底落到了哪个后端」变得不可判定。测试因此统一
 * `app.get<InMemoryMatchingRepository>(MATCHING_REPOSITORY)` 取夹具
 * （见 `matching.binding.spec.ts` 与 `matching.controller.spec.ts`）。
 *
 * 其余两个绑定保持不变，仍可在测试/迁移期整步替换：
 * - `MATCHING_FEATURE_SOURCE`  → `InMemoryMatchingFeatureSource`（默认空、不联动真实画像/小组，
 *   并对写入快照做 PII 门禁；生产拒绝构造）；
 * - `MATCHING_AI_PROVIDER`     → `createMatchingAiProvider(APP_ENV)`：`AI_PROVIDER=http-json`
 *   且匹配开关打开时绑定真实 HTTP provider（缺 `AI_BASE_URL` 启动即失败），否则绑定本地桩；
 *   开关关闭时适配层不会调用 provider，而是走明确的规则降级。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖、不新增第三方依赖
 * （复用 `@rm/shared` 与 `@rm/ai-adapter`），也不改动 health / runtime-info / education /
 * profiles / memberships / achievements / groups / exports 等既有路由；对外只新增
 * `/me/matching-requests` 的两条路由。
 */
export function createMatchingRepository(
  env: AppEnv,
  sqlConnectionFactory: SqlConnectionFactory | undefined,
): MatchingRepository {
  // 配置解析是纯函数：复用 `DatabaseModule` 的同一份解析（含生产环境 fail-closed 规则），
  // 不额外读环境变量，也不建立任何连接。
  const resolution = resolveAppDatabaseConfig(env);

  if (resolution.status !== 'configured') {
    return new InMemoryMatchingRepository(env);
  }
  if (sqlConnectionFactory === undefined) {
    throw new Error(
      '数据库已配置但未提供 SQL_CONNECTION_FACTORY：拒绝退回内存匹配仓储（fail-closed）',
    );
  }
  const factory: SqlConnectionFactory = sqlConnectionFactory;
  return createLazyPostgresMatchingRepository(async (): Promise<SqlExecutor> =>
    factory.connect(resolution.config),
  );
}

/** 匹配请求仓储端口的 provider（可选注入执行器工厂：`inject` 的 `optional` 保证测试装配无需数据库模块） */
const MATCHING_REPOSITORY_PROVIDER: FactoryProvider = {
  provide: MATCHING_REPOSITORY,
  useFactory: (
    env: AppEnv,
    sqlConnectionFactory: SqlConnectionFactory | undefined,
  ): MatchingRepository => createMatchingRepository(env, sqlConnectionFactory),
  inject: [APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }],
};

@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [MatchingController],
  providers: [
    MatchingService,
    MATCHING_REPOSITORY_PROVIDER,
    InMemoryMatchingFeatureSource,
    { provide: MATCHING_FEATURE_SOURCE, useExisting: InMemoryMatchingFeatureSource },
    { provide: MATCHING_AI_PROVIDER, useFactory: createMatchingAiProvider, inject: [APP_ENV] },
  ],
})
export class MatchingModule {}
