import { Body, Controller, Get, Headers, Inject, Post, Query } from '@nestjs/common';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import type { ExportRequestView } from './exports.contract';
import { ExportsService } from './exports.service';

/**
 * 本人导出请求（学生自服务）：
 * - `GET  /api/v1/me/exports` 本人导出请求列表与状态；
 * - `POST /api/v1/me/exports` 创建本人的导出请求。
 *
 * 路径与权限点对齐 docs/P2-API契约基线.md §「统计、导出、配置」的导出形态
 * （基线中的 `POST /admin/exports` 由 `resource` 决定原子权限、且下载与有效期另立路由，
 * 本切片按 `/me/...` 收敛到会话主体自身，只落地**受理 + 状态**这一段；
 * 管理端导出、真实文件生成与下载不在本切片）。
 *
 * 认证与授权分工（刻意不用全局 Guard，避免「看起来覆盖所有路由」的假象）：
 * 1. 每个方法显式声明它需要会话：`@Headers('authorization')` → `requireSubject()`
 *    → 无有效会话即 401；主体只来自服务端会话存储，控制器不解析任何角色字段，
 *    也不读取任何自定义头（`x-user-id`/`x-roles`/`x-scope`/`x-group-id` 都不进入判定）；
 * 2. 资源级判定在 service 内经由 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口）完成，
 *    且**先于字段校验与任何端口调用**，拒绝即 403；控制器不自行判断权限，也不拼接判定入参；
 * 3. `@Query()` 与 `@Body()` 原样交给 service，在授权之后判定：本切片不声明任何查询参数、
 *    请求体只声明 `resource` / `fields`，因此 `?userId=`/`?status=`/`?fileUrl=`/`?path=` 与
 *    `{ userId, roles, scope, groupId, status, fileUrl, path }` 之类一律 400 `VALIDATION_FAILED`
 *    （给出可区分的拒绝原因），而不是静默忽略——客户端提交的归属、授权、状态与产物位置
 *    既不被读取，也不被信任。
 *
 * 响应统一由 `ApiResponseInterceptor` 包成 `{ data, meta, error }`，
 * 异常统一由 `ApiExceptionFilter` 映射为稳定错误码（401/400/403/409/500）。
 */
@Controller('me/exports')
export class ExportsController {
  constructor(
    @Inject(ExportsService) private readonly exports: ExportsService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  @Get()
  listMyExportRequests(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: unknown,
  ): ExportRequestView[] {
    return this.exports.listMyExportRequests(requireSubject(this.sessions, authorization), query);
  }

  @Post()
  createMyExportRequest(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: unknown,
    @Body() body: unknown,
  ): ExportRequestView {
    return this.exports.createMyExportRequest(
      requireSubject(this.sessions, authorization),
      query,
      body,
    );
  }
}
