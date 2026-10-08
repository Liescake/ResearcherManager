import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { InMemoryNotificationRepository } from './notifications.in-memory-repository';
import { NOTIFICATION_REPOSITORY } from './notifications.port';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * 站内状态与订阅消息适配、失败重试 模块（docs/P2-架构与数据设计.md §2 声明的边界）。
 *
 * 本切片只落地其中**本人通知箱的最小垂直切片**：`GET /me/notifications`（本人通知列表）与
 * `PATCH /me/notifications/{notificationId}/read`（标记本人通知已读）。
 * 通知的生产侧（审核结果/匹配结果/公告如何入库与去重）、未读数、批量已读、删除与归档、
 * 分页与排序、订阅消息下发与失败重试、导出与审计落库属于后续切片，必须继续留在本模块内，
 * 不得跨模块直接调用其他领域模块的仓储。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `notifications → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `notifications → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * 持久化绑定：`NOTIFICATION_REPOSITORY → InMemoryNotificationRepository`（内存基线：
 * `persistent = false`、`productionReady = false`，`NODE_ENV=production` 下拒绝构造）。
 * 引入 PostgreSQL 后只替换这一个 provider 的绑定，controller/service 不改动，
 * 因此这一步可整步回退。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖、不新增第三方依赖，
 * 也不改动 health / runtime-info / profiles / groups / memberships / achievements /
 * education / matching / statistics 等既有路由；对外只新增 `/me/notifications` 的两条路由。
 */
@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    InMemoryNotificationRepository,
    { provide: NOTIFICATION_REPOSITORY, useExisting: InMemoryNotificationRepository },
  ],
})
export class NotificationsModule {}
