import { Body, Controller, Get, Headers, Inject, Query, Req } from '@nestjs/common';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import { toAuditRequestContext } from './audit.contract';
import type { AuditEventView } from './audit.contract';
import { AuditService } from './audit.service';

/**
 * 本人审计摘要：
 * `GET /api/v1/me/audit-events` —— 返回本人可查看的审计事件**脱敏摘要**。
 *
 * 路径与权限点：`/me/*` 是「本人」语义路由，权限点与数据范围沿用闭集目录里的 self 点
 * （`profile:self:read` + `SELF`，理由与偏差说明见 `audit.service.ts` 的「读取口径」）。
 * 管理端审计查询（`/admin/audit-logs`，`audit:read`）、按主体/资源/时间检索、拒绝结果留痕、
 * 改前/改后快照与归档留存不在本切片。
 *
 * 认证与授权分工（刻意不用全局 Guard，避免「看起来覆盖所有路由」的假象）：
 * 1. 方法显式声明它需要会话：`@Headers('authorization')` → `requireSubject()`
 *    → 无有效会话即 401；主体只来自服务端会话存储，控制器不解析任何角色字段，
 *    也不读取任何自定义头（`x-user-id`/`x-actor-user-id`/`x-roles`/`x-scope`/`x-group-id`
 *    都不进入判定）；
 * 2. 资源级判定在 service 内经由 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口）完成，
 *    且**先于任何仓储访问**（也先于任何审计写入），拒绝即 403；控制器不自行判断权限，
 *    也不拼接判定入参；
 * 3. 请求上下文只取**传输层事实**：`@Req()` 不交给 service，而是先经 `toAuditRequestContext()`
 *    白名单提取（只读 `socket.remoteAddress`），因此 `x-forwarded-for`/`x-real-ip` 之类的
 *    客户端头无法影响审计里的网络归属，service 也拿不到整个请求对象；
 * 4. 输入闭集：`@Query()` 与 `@Body()` 原样交给 service，在授权之后判定。本端点不声明任何
 *    查询参数、也不接受任何请求体字段，因此 `?actorUserId=`/`?userId=`/`?roles=`/`?scope=`/
 *    `?ip=`/`?requestId=`/`?result=` 与 `{ result: 'success' }` 之类一律 400
 *    `VALIDATION_FAILED`（给出可区分的拒绝原因），而不是静默忽略；
 * 5. 审计写入发生在响应组装之后（「先读后记」），因此成功响应只反映请求到达前已存在的事件，
 *    而「读一次审计 = 存储里多一条审计」由端口与 service 保证。
 *
 * 响应统一由 `ApiResponseInterceptor` 包成 `{ data, meta, error }`，
 * 异常统一由 `ApiExceptionFilter` 映射为稳定错误码（401/400/403/500）。
 */
@Controller('me/audit-events')
export class AuditController {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  @Get()
  async listMyAuditEvents(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: unknown,
    @Body() body: unknown,
    @Req() request: unknown,
  ): Promise<AuditEventView[]> {
    return this.audit.listMyAuditEvents(
      await requireSubject(this.sessions, authorization),
      toAuditRequestContext(request),
      query,
      body,
    );
  }
}
