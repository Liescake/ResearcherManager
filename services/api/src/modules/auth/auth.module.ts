import { Module } from '@nestjs/common';
import { BearerSessionSubjectResolver } from './session-subject.baseline';
import { SESSION_STORE, SESSION_SUBJECT_RESOLVER } from './session-subject.port';
import { InMemorySessionStore } from './session-store.in-memory';

/**
 * 认证与会话模块：微信凭证校验与账号状态（P4）尚未实现，当前只落地**认证边界的接缝**——
 * 把会话凭证解析为服务端主体，供业务路由使用。
 *
 * 绑定关系：
 * - `SESSION_STORE` → `InMemorySessionStore`（内存基线，默认空、生产拒绝构造）；
 * - `SESSION_SUBJECT_RESOLVER` → `BearerSessionSubjectResolver`（`Bearer <sessionId>` → 主体）。
 *
 * 迁移方式（可整步回退）：生产把 `SESSION_STORE`（或直接 `SESSION_SUBJECT_RESOLVER`）
 * 换绑到持久化实现的同一接口，业务模块（当前为 `EducationModule`）无需改动。
 *
 * 边界事实：本模块不注册任何路由、不读取 `process.env`（配置只经 `APP_ENV` 令牌，
 * 由 @Global 的 `ConfigModule` 提供），也不含微信登录实现，因此不改变现有 API 对外行为。
 */
@Module({
  providers: [
    InMemorySessionStore,
    { provide: SESSION_STORE, useExisting: InMemorySessionStore },
    BearerSessionSubjectResolver,
    { provide: SESSION_SUBJECT_RESOLVER, useExisting: BearerSessionSubjectResolver },
  ],
  exports: [
    SESSION_SUBJECT_RESOLVER,
    SESSION_STORE,
    InMemorySessionStore,
    BearerSessionSubjectResolver,
  ],
})
export class AuthModule {}
