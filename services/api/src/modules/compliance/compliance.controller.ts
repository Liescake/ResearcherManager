import { Body, Controller, Get, Headers, Inject, Query } from '@nestjs/common';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import type { ComplianceStatusView } from './compliance.contract';
import { ComplianceService } from './compliance.service';

/**
 * 本人最小合规状态（学生自服务）：
 * `GET /api/v1/me/compliance-status` —— 本人隐私同意 / 数据保留 / 导出可用性三个状态。
 *
 * 认证与授权分工（刻意不用全局 Guard，避免「看起来覆盖所有路由」的假象）：
 * 1. 本方法显式声明它需要会话：`@Headers('authorization')` → `requireSubject()`
 *    → 无有效会话即 401；主体只来自服务端会话存储，控制器不解析任何角色字段，
 *    也不读取任何自定义头（`x-user-id`/`x-roles`/`x-scope`/`x-group-id`/`x-consent-text`
 *    都不进入判定）；
 * 2. 资源级判定在 service 内经由 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口）完成，
 *    且**先于输入校验与任何端口调用**，拒绝即 403；控制器不自行判断权限，也不拼接判定入参；
 * 3. `@Query()` 与 `@Body()` 原样交给 service，在授权之后判定：本端点不声明任何查询参数、
 *    也不声明任何请求体字段，因此 `?userId=`/`?roles=`/`?phone=` 与
 *    `{ userId, roles, scope, status }` 之类一律 400 `VALIDATION_FAILED`（给出可区分的拒绝原因），
 *    而不是静默忽略——客户端提交的归属、授权与合规事实声明既不被读取，也不被信任。
 *
 * 响应统一由 `ApiResponseInterceptor` 包成 `{ data, meta, error }`，
 * 异常统一由 `ApiExceptionFilter` 映射为稳定错误码（401/400/403/500）。
 */
@Controller('me/compliance-status')
export class ComplianceController {
  constructor(
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  @Get()
  async getMyComplianceStatus(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: unknown,
    @Body() body: unknown,
  ): Promise<ComplianceStatusView> {
    return this.compliance.getMyComplianceStatus(
      await requireSubject(this.sessions, authorization),
      query,
      body,
    );
  }
}
