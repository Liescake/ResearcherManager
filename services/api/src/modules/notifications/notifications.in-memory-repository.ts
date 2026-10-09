import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type {
  Notification,
  NotificationRepository,
  NotificationRepositoryCapabilities,
} from './notifications.port';

/**
 * 通知仓储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久」：
 * - 只持有本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下**直接拒绝构造**，迫使生产把 `NOTIFICATION_REPOSITORY`
 *   换绑到数据库实现（见 `notifications.port.ts` 的替换说明），
 *   而不是让「重启即丢数据」的内存结构悄悄承担生产通知职责；
 * - 不做授权判定、不生成归属、不推进状态：`userId` 由 service 从服务端会话主体写入，
 *   `status`/`readAt` 由 service 经纯函数状态机写入；
 * - **不做读取契约校验**：存储层损坏（未知枚举、PII 正文、`read` 缺 `readAt`）必须能被
 *   出口的 fail-closed 门禁看见，因此基线不代替出口做校验，也不静默修正非法记录；
 *   写入只保证「主键唯一」「归属不可变」「只更新既有记录」三条存储自身的完整性约束。
 * - **异步契约**：与 PostgreSQL 实现同语义（`Promise` 返回），因此「有没有数据库」是同一条
 *   调用形状下的两种绑定，service / controller 不需要分支。
 */
@Injectable()
export class InMemoryNotificationRepository implements NotificationRepository {
  readonly capabilities: NotificationRepositoryCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly notifications = new Map<string, Notification>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存通知仓储（InMemoryNotificationRepository）：请把 NOTIFICATION_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  async create(notification: Notification): Promise<Notification> {
    if (this.notifications.has(notification.id)) {
      // 主键冲突属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new Error(`通知 ID 冲突: ${notification.id}`);
    }
    this.notifications.set(notification.id, { ...notification });
    return { ...notification };
  }

  async findById(notificationId: string, ownerUserId: string): Promise<Notification | undefined> {
    const record = this.notifications.get(notificationId);
    // 归属同样下推：即使命中主键，非本人所有也一律按「不存在」返回（与数据库实现的
    // `WHERE id = $1 AND user_id = $2` 同语义），不把归属隔离降级为「上层记得复核」。
    if (!record || record.userId !== ownerUserId) {
      return undefined;
    }
    return { ...record };
  }

  async listByUserId(userId: string): Promise<readonly Notification[]> {
    return [...this.notifications.values()]
      .filter((record) => record.userId === userId)
      .map((record) => ({ ...record }));
  }

  async save(notification: Notification): Promise<Notification> {
    const existing = this.notifications.get(notification.id);
    if (!existing) {
      // 只允许更新既有记录：插入必须走 create 路径，避免绕过创建路径造出记录
      throw new Error(`通知不存在，拒绝写入: ${notification.id}`);
    }
    if (existing.userId !== notification.userId) {
      // 归属不可变：拿他人通知的 ID 改写他人数据在存储层被关闭（与数据库实现同语义）
      throw new Error(`通知归属不符，拒绝写入: ${notification.id}`);
    }
    this.notifications.set(notification.id, { ...notification });
    return { ...notification };
  }
}
