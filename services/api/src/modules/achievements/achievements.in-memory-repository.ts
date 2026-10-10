import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type {
  Achievement,
  AchievementRepository,
  AchievementRepositoryCapabilities,
} from './achievements.port';

/**
 * 成果仓储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久」：
 * - 只持有本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下直接拒绝构造，迫使生产把 `ACHIEVEMENT_REPOSITORY`
 *   换绑到数据库实现（见 `achievements.port.ts` 的替换说明），
 *   而不是让「重启即丢数据」的内存结构悄悄承担生产存储职责；
 * - 不做授权判定、不生成归属信息：`userId`/`reviewStatus` 由 service 从服务端主体与
 *   服务端常量写入。
 *
 * 方法签名与 PostgreSQL 实现**逐字一致**（都返回 `Promise`）：换绑实现不需要改 service，
 * 也不会出现「同步实现被当成已完成、异步实现尚未返回」这类只在生产才暴露的时序差异。
 */
@Injectable()
export class InMemoryAchievementRepository implements AchievementRepository {
  readonly capabilities: AchievementRepositoryCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly achievements = new Map<string, Achievement>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存成果仓储（InMemoryAchievementRepository）：请把 ACHIEVEMENT_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  async create(achievement: Achievement): Promise<Achievement> {
    if (this.achievements.has(achievement.id)) {
      // 主键冲突属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new Error(`成果 ID 冲突: ${achievement.id}`);
    }
    this.achievements.set(achievement.id, { ...achievement });
    return { ...achievement };
  }

  /**
   * 单条读取**同时**按资源 ID 与归属命中：与 PostgreSQL 实现（`WHERE id = $1 AND user_id = $2`）
   * 同语义。
   *
   * 只按资源 ID 命中会把「他人记录」交给 service，让归属判定退化成**取数之后**的复核
   * （也正是存在性可被探测的原因）。这里与数据库实现一致地做归属命中，
   * 因此「不存在」与「存在但不属于该主体」在两种实现下都返回 `undefined`。
   */
  async findById(achievementId: string, ownerUserId: string): Promise<Achievement | undefined> {
    const record = this.achievements.get(achievementId);
    if (record === undefined || record.userId !== ownerUserId) {
      return undefined;
    }
    return { ...record };
  }

  async listByUserId(userId: string): Promise<readonly Achievement[]> {
    return [...this.achievements.values()]
      .filter((record) => record.userId === userId)
      .map((record) => ({ ...record }));
  }
}
