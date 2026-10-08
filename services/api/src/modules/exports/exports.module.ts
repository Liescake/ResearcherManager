import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { InMemoryExportArtifactStore } from './exports.artifact-store.in-memory';
import { ExportsController } from './exports.controller';
import { InMemoryExportRepository } from './exports.in-memory-repository';
import { EXPORT_ARTIFACT_STORE, EXPORT_REPOSITORY } from './exports.port';
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
 * 绑定关系（两个都可在测试/迁移期整步替换，controller/service 不改动）：
 * - `EXPORT_REPOSITORY`     → `InMemoryExportRepository`（导出请求事实；非生产内存基线，
 *   `persistent = false` / `productionReady = false`，`NODE_ENV=production` 下拒绝构造）；
 * - `EXPORT_ARTIFACT_STORE` → `InMemoryExportArtifactStore`（服务端产物存储；同样如实声明
 *   非持久、生产拒绝构造，返回值只有不透明句柄，不含路径/URL/存储 key）。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖、不新增第三方依赖
 * （复用 `@rm/shared`），也不改动 health / runtime-info / profiles / groups / memberships /
 * achievements / education / matching / statistics / notifications / audit 等既有路由；
 * 对外只新增 `/me/exports` 的两条路由。
 */
@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [ExportsController],
  providers: [
    ExportsService,
    InMemoryExportRepository,
    { provide: EXPORT_REPOSITORY, useExisting: InMemoryExportRepository },
    InMemoryExportArtifactStore,
    { provide: EXPORT_ARTIFACT_STORE, useExisting: InMemoryExportArtifactStore },
  ],
})
export class ExportsModule {}
