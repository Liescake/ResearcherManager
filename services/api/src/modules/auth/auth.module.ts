import { Module, type FactoryProvider } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import { resolveAppDatabaseConfig } from '../../db/database.module';
import {
  SQL_CONNECTION_FACTORY,
  type SqlConnectionFactory,
  type SqlExecutor,
} from '../../db/ports/sql-executor.port';
import { InMemorySessionStore } from './session-store.in-memory';
import { createLazyPostgresSessionStore } from './session-store.postgres-repository';
import { BearerSessionSubjectResolver } from './session-subject.baseline';
import { SESSION_STORE, SESSION_SUBJECT_RESOLVER, type SessionStore } from './session-subject.port';

/**
 * 认证与会话模块：微信凭证校验与账号状态（P4）尚未实现，当前只落地**认证边界的接缝**——
 * 把会话凭证解析为服务端主体，供业务路由使用。
 *
 * 绑定关系：
 * - `SESSION_STORE` → `createSessionStore()`：**按是否配置数据库分流**（见下）；
 * - `SESSION_SUBJECT_RESOLVER` → `BearerSessionSubjectResolver`（`Bearer <sessionId>` → 主体）。
 *
 * ## 会话存储的分流（本切片的唯一换绑点）
 * | 条件 | 绑定 | 依据 |
 * |---|---|---|
 * | 未解析出 `DATABASE_URL` | `InMemorySessionStore` | 开发/测试保持现状；生产环境它自身拒绝构造 |
 * | 已解析出 `DATABASE_URL` 且有 `SQL_CONNECTION_FACTORY` | `createLazyPostgresSessionStore` | 延迟建连；生产准入由启动期门禁判定 |
 * | 已解析出 `DATABASE_URL` 但没有执行器工厂 | **抛错** | fail-closed：绝不悄悄退回内存存储 |
 *
 * 「延迟建连」很关键：装配阶段不碰数据库，所以「数据库已配置但执行器未 attest / 依赖未就绪」会由
 * 启动期门禁给出**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED`、
 * `SESSION_STORE[DEPENDENCY_NOT_VERIFIED]`），而不是在这里表现为一个数据库连接错误。
 * 生产环境配置了数据库却拿不到可用的会话后端时，启动在**任何连接之前**即失败。
 *
 * ## 为什么 `InMemorySessionStore` 不再是 provider
 * 它是**实现**，不是绑定：`SESSION_STORE` 是唯一取用点。让它同时作为一个 provider 会引入
 * 「容器里那个实例」与「端口上那个实例」两份状态 —— 开发/测试往其中一个 `seed`、解析却读另一个，
 * 是典型的静默失效。测试因此统一 `app.get<InMemorySessionStore>(SESSION_STORE)` 取夹具。
 *
 * 边界事实：本模块不注册任何路由、不读取 `process.env`（配置只经 `APP_ENV` 令牌，
 * 由 @Global 的 `ConfigModule` 提供；数据库配置经纯函数 `resolveAppDatabaseConfig` 解析），
 * 也不含微信登录实现，因此不改变现有 API 对外行为。
 */
export function createSessionStore(
  env: AppEnv,
  sqlConnectionFactory: SqlConnectionFactory | undefined,
): SessionStore {
  // 配置解析是纯函数：复用 `DatabaseModule` 的同一份解析（含生产环境 fail-closed 规则），
  // 不额外读环境变量，也不建立任何连接。
  const resolution = resolveAppDatabaseConfig(env);

  if (resolution.status !== 'configured') {
    return new InMemorySessionStore(env);
  }
  if (sqlConnectionFactory === undefined) {
    throw new Error(
      '数据库已配置但未提供 SQL_CONNECTION_FACTORY：拒绝退回内存会话存储（fail-closed）',
    );
  }
  const factory: SqlConnectionFactory = sqlConnectionFactory;
  return createLazyPostgresSessionStore(async (): Promise<SqlExecutor> =>
    factory.connect(resolution.config),
  );
}

/** 会话存储端口的 provider（可选注入执行器工厂：`inject` 的 `optional` 保证测试装配无需数据库模块） */
const SESSION_STORE_PROVIDER: FactoryProvider = {
  provide: SESSION_STORE,
  useFactory: (env: AppEnv, sqlConnectionFactory: SqlConnectionFactory | undefined): SessionStore =>
    createSessionStore(env, sqlConnectionFactory),
  inject: [APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }],
};

@Module({
  providers: [
    SESSION_STORE_PROVIDER,
    BearerSessionSubjectResolver,
    { provide: SESSION_SUBJECT_RESOLVER, useExisting: BearerSessionSubjectResolver },
  ],
  exports: [SESSION_SUBJECT_RESOLVER, SESSION_STORE, BearerSessionSubjectResolver],
})
export class AuthModule {}
