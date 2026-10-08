import { Module } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { createMatchingAiProvider } from './matching.ai-provider';
import { MatchingController } from './matching.controller';
import { InMemoryMatchingFeatureSource } from './matching.feature-source.in-memory';
import { InMemoryMatchingRepository } from './matching.in-memory-repository';
import {
  MATCHING_AI_PROVIDER,
  MATCHING_FEATURE_SOURCE,
  MATCHING_REPOSITORY,
} from './matching.port';
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
 * 绑定关系（三个都可在测试/迁移期整步替换，controller/service 不改动）：
 * - `MATCHING_REPOSITORY`      → `InMemoryMatchingRepository`（非生产内存基线，生产拒绝构造）；
 * - `MATCHING_FEATURE_SOURCE`  → `InMemoryMatchingFeatureSource`（默认空、不联动真实画像/小组，
 *   并对写入快照做 PII 门禁；生产拒绝构造）；
 * - `MATCHING_AI_PROVIDER`     → `createMatchingAiProvider(APP_ENV)`：`AI_PROVIDER=http-json`
 *   且匹配开关打开时绑定真实 HTTP provider（缺 `AI_BASE_URL` 启动即失败），否则绑定本地桩；
 *   开关关闭时适配层不会调用 provider，而是走明确的规则降级。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖、不新增第三方依赖
 * （复用 `@rm/shared` 与 `@rm/ai-adapter`），也不改动 health / runtime-info / education /
 * profiles / memberships / achievements / groups 等既有路由；对外只新增
 * `/me/matching-requests` 的两条路由。
 */
@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [MatchingController],
  providers: [
    MatchingService,
    InMemoryMatchingRepository,
    { provide: MATCHING_REPOSITORY, useExisting: InMemoryMatchingRepository },
    InMemoryMatchingFeatureSource,
    { provide: MATCHING_FEATURE_SOURCE, useExisting: InMemoryMatchingFeatureSource },
    { provide: MATCHING_AI_PROVIDER, useFactory: createMatchingAiProvider, inject: [APP_ENV] },
  ],
})
export class MatchingModule {}
