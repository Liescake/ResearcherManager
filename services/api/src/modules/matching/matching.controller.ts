import { Body, Controller, Get, Headers, Inject, Post } from '@nestjs/common';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import { ok } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import type { MatchingRequestView } from './matching.contract';
import { MatchingService } from './matching.service';

/**
 * 匹配（本人自服务）：
 * - `GET  /api/v1/me/matching-requests`  本人匹配请求列表与状态
 * - `POST /api/v1/me/matching-requests`  发起本人匹配请求
 *
 * 路径与权限点对齐 docs/P2-API契约基线.md §「成果、升学、匹配」的本人自服务形态
 * （基线中的 `POST /matching/recommendations` 为「请求推荐」，本切片按 `/me/...` 收敛到
 * 会话主体自身；管理端 `/admin/matching-records` 与推荐历史不在本切片）。
 *
 * 认证与授权分工（刻意不用全局 Guard，避免「看起来覆盖所有路由」的假象）：
 * 1. 每个方法显式声明它需要会话：`@Headers('authorization')` → `requireSubject()`
 *    → 无有效会话即 401；主体只来自服务端会话存储，控制器不解析任何角色字段，
 *    也不读取任何自定义头（`x-user-id`/`x-roles`/`x-scope`/`x-group-id` 都不进入判定）；
 * 2. 资源级判定在 service 内经由 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口）完成，
 *    且**先于字段校验与任何仓储访问**，拒绝即 403；控制器不自行判断权限，也不拼接判定入参；
 * 3. 控制器不声明任何查询参数：查询串里的 `userId`/`roles`/`scope`/`groupId` 既不被读取
 *    也不被信任。
 *
 * 响应统一由 `ApiResponseInterceptor` 包成 `{ data, meta, error }`，
 * 异常统一由 `ApiExceptionFilter` 映射为稳定错误码（401/400/403/409/500）。
 */
@Controller('me/matching-requests')
export class MatchingController {
  constructor(
    @Inject(MatchingService) private readonly matching: MatchingService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  @Get()
  async listMyMatchingRequests(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<MatchingRequestView[]> {
    return this.matching.listMyMatchingRequests(await requireSubject(this.sessions, authorization));
  }

  @Post()
  async createMyMatchingRequest(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<ApiEnvelope<MatchingRequestView>> {
    const view = await this.matching.createMyMatchingRequest(
      await requireSubject(this.sessions, authorization),
      body,
    );
    return ok(view, { fallbackUsed: view.fallbackUsed, modelVersion: view.modelVersion });
  }
}
