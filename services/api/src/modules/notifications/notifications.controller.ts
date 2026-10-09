import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import type { NotificationView } from './notifications.contract';
import { NotificationsService } from './notifications.service';

/**
 * 站内通知（本人通知箱）：
 * - `GET   /api/v1/me/notifications`                        本人通知列表
 * - `PATCH /api/v1/me/notifications/{notificationId}/read`  标记本人通知已读
 *
 * 路径与权限点：`/me/*` 是「本人」语义路由，权限点与数据范围沿用闭集目录里的 self 点
 * （`profile:self:read` / `profile:self:update` + `SELF`，理由与偏差说明见
 * `notifications.service.ts` 的「读取口径」）。通知的生产侧（审核结果、匹配结果、公告入库）、
 * 未读数、批量已读、删除与订阅消息下发不在本切片。
 *
 * 认证与授权分工（刻意不用全局 Guard，避免「看起来覆盖所有路由」的假象）：
 * 1. 每个方法显式声明它需要会话：`@Headers('authorization')` → `requireSubject()`
 *    → 无有效会话即 401；主体只来自服务端会话存储，控制器不解析任何角色字段，
 *    也不读取任何自定义头（`x-user-id`/`x-roles`/`x-scope`/`x-group-id` 都不进入判定）；
 * 2. 资源级判定在 service 内经由 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口）完成，
 *    且**先于任何仓储访问**，拒绝即 403；控制器不自行判断权限，也不拼接判定入参；
 * 3. 输入闭集：`@Query()` 与 `@Body()` 原样交给 service，在授权之后判定。本模块的两个端点
 *    都不声明任何查询参数，`PATCH` 也不接受任何请求体字段，因此 `?userId=`/`?roles=`/`?scope=`/
 *    `?groupId=` 与 `{ status: 'read' }` 之类一律 400 `VALIDATION_FAILED`（给出可区分的拒绝原因），
 *    而不是静默忽略——客户端提交的授权与状态声明既不被读取，也不被信任；
 * 4. 越权与不存在对外**不可区分**：单条标记已读时「不存在」「非本人所有」「归属不可读」
 *    统一为同一个 404 与同一文案（`NOTIFICATION_NOT_VISIBLE_MESSAGE`），因此本切片不存在
 *    「用通知 ID 探测他人是否有该通知」的路径；
 * 5. 标记已读是对既有资源的幂等状态变更，因此显式返回 200（而不是 PATCH 之外的其它状态码）。
 *
 * 响应统一由 `ApiResponseInterceptor` 包成 `{ data, meta, error }`，
 * 异常统一由 `ApiExceptionFilter` 映射为稳定错误码（401/400/403/404/500）。
 */
@Controller('me/notifications')
export class NotificationsController {
  constructor(
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  @Get()
  async listMyNotifications(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<NotificationView[]> {
    // 认证先于业务：`await requireSubject` 解析完成之后才会碰仓储（无有效会话即 401，
    // 且此时 service 与仓储一次都没有被调用）
    return await this.notifications.listMyNotifications(
      await requireSubject(this.sessions, authorization),
      query,
    );
  }

  @Patch(':notificationId/read')
  @HttpCode(HttpStatus.OK)
  async markMyNotificationRead(
    @Headers('authorization') authorization: string | undefined,
    @Param('notificationId') notificationId: string,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<NotificationView> {
    return await this.notifications.markMyNotificationRead(
      await requireSubject(this.sessions, authorization),
      notificationId,
      body,
      query,
    );
  }
}
