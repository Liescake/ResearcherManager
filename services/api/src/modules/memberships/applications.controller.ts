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
} from '@nestjs/common';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import type { ApplicationView } from './applications.contract';
import { ApplicationsService } from './applications.service';

/**
 * 入组申请（本人自服务）：
 * - `POST /api/v1/me/applications`                          创建本人入组申请
 * - `GET  /api/v1/me/applications`                          本人申请列表
 * - `POST /api/v1/me/applications/{applicationId}/withdraw`  撤回本人待审核申请
 *
 * 契约基线把入组申请写作 `POST /join-applications`、撤回写作
 * `POST /join-applications/{id}/withdraw`（docs/P2-API契约基线.md §「小组与申请」）。
 * 本切片据本轮要求收敛为 `/me/applications` 这两条「本人」语义路由（列表为本人集合），
 * 权限点与数据范围沿用基线：`membership:self:create` / `membership:self:withdraw` + `SELF`。
 * 管理端列表与审核（`/admin/applications*`）不在本切片。
 *
 * 认证与授权分工（刻意不用全局 Guard，避免「看起来覆盖所有路由」的假象）：
 * 1. 每个方法显式声明它需要会话：`@Headers('authorization')` → `requireSubject()`
 *    → 无有效会话即 401；主体只来自服务端会话存储，控制器不解析任何角色字段；
 * 2. 资源级判定在 service 内经由 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口）完成，
 *    且**先于任何存储访问**，拒绝即 403；控制器不自行判断权限，也不拼接判定入参。
 *
 * 响应统一由 `ApiResponseInterceptor` 包成 `{ data, meta, error }`，
 * 异常统一由 `ApiExceptionFilter` 映射为稳定错误码（401/400/403/404/409/500）。
 * 撤回是对既有资源的幂等状态变更，因此显式返回 200（而不是 POST 默认的 201）。
 */
@Controller('me/applications')
export class ApplicationsController {
  constructor(
    @Inject(ApplicationsService) private readonly applications: ApplicationsService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  @Get()
  listMyApplications(
    @Headers('authorization') authorization: string | undefined,
  ): ApplicationView[] {
    return this.applications.listMyApplications(requireSubject(this.sessions, authorization));
  }

  @Post()
  createMyApplication(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): ApplicationView {
    return this.applications.createMyApplication(
      requireSubject(this.sessions, authorization),
      body,
    );
  }

  @Post(':applicationId/withdraw')
  @HttpCode(HttpStatus.OK)
  withdrawMyApplication(
    @Headers('authorization') authorization: string | undefined,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): ApplicationView {
    return this.applications.withdrawMyApplication(
      requireSubject(this.sessions, authorization),
      applicationId,
      body,
    );
  }
}
