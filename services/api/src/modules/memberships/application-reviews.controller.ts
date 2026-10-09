import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import type { ApplicationReviewView } from './application-reviews.contract';
import { ApplicationReviewsService } from './application-reviews.service';

/**
 * 入组申请**团队审核端**（管理端）：
 * - `GET  /api/v1/admin/applications`                         管理端申请列表（按服务端范围）
 * - `POST /api/v1/admin/applications/{applicationId}/review`  审核（通过/驳回）
 *
 * 路由与权限点对齐 docs/P2-API契约基线.md §「小组与申请」的
 * `GET /admin/applications`、`POST /admin/applications/{id}/review`
 * （`membership:review:group` / `membership:review:global`，**按服务端范围**）。
 *
 * 认证与授权分工（与申请人端控制器同一套口径，刻意不用全局 Guard）：
 * 1. 每个方法显式声明它需要会话：`@Headers('authorization')` → `requireSubject()`
 *    → 无有效会话即 401；主体只来自服务端会话存储；
 * 2. 资源级判定在 service 内经由 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口）完成，
 *    且**先于任何存储访问与任何字段级校验**，拒绝即 403；
 * 3. 控制器**不解析**任何角色/范围字段，也不把 `@Req()` 整包交给 service：
 *    审核动作只把 `body` 作为「需要被闭集拒绝的未知物」传入，列表只传 `query` 同理。
 *
 * 与申请人端控制器（`applications.controller.ts`）的关系：**路由、权限点、端口、取数口径全部独立**。
 * 申请人端是 `/me/applications` + `SELF` + 归属下推 SQL；审核端是 `/admin/applications` +
 * `GROUP`/`GLOBAL` + 范围下推 SQL。两端不共享任何一条取数路径。
 *
 * 响应统一由 `ApiResponseInterceptor` 包成 `{ data, meta, error }`；
 * 异常统一由 `ApiExceptionFilter` 映射为稳定错误码（401/400/403/404/409/500）。
 * 审核是对既有资源的幂等状态变更，因此显式返回 200（而不是 POST 默认的 201）。
 */
@Controller('admin/applications')
export class ApplicationReviewsController {
  constructor(
    @Inject(ApplicationReviewsService) private readonly reviews: ApplicationReviewsService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  @Get()
  async listApplications(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<ApplicationReviewView[]> {
    return this.reviews.listApplications(await requireSubject(this.sessions, authorization), query);
  }

  @Post(':applicationId/review')
  @HttpCode(HttpStatus.OK)
  async reviewApplication(
    @Headers('authorization') authorization: string | undefined,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<ApplicationReviewView> {
    return this.reviews.reviewApplication(
      await requireSubject(this.sessions, authorization),
      applicationId,
      body,
    );
  }
}
