import type { AppEnv } from '../../config/env';
import { parseStatisticsCount } from './statistics.contract';
import {
  STATISTICS_REPOSITORY_TOKEN_NAMES,
  StatisticsSource,
  type StatisticsCountCapabilities,
  type StatisticsCountRepository,
} from './statistics.port';

/**
 * 计数读取端口的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、按来源隔离、默认全零」：
 * - 每个来源一个独立实例（由 `statistics.module.ts` 的四个 `useFactory` 绑定分别构造），
 *   状态只存在于实例自己的 `Map`，既不是模块级单例，也不跨进程/重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`，并标明来源；
 * - `NODE_ENV=production` 下直接拒绝构造，迫使生产把
 *   `*_STATISTICS_REPOSITORY` 换绑到持久化实现（见 `statistics.port.ts` 的替换说明），
 *   而不是让「重启即丢数据」的内存结构悄悄承担生产统计职责；
 * - **默认不预置任何数据**：未显式 `seed()` 时所有主体计数为 0。因此「空数据」是本基线的
 *   默认状态而不是异常状态：聚合端点稳定返回四个 0，而不是 404/500 或省略字段；
 * - 不做授权判定、不生成归属：`userId` 只由 service 从服务端会话主体传入；
 *   `seed()` 只接受服务端装配（开发/测试）给定的合法计数，非法计数值直接拒绝写入，
 *   避免基线自己造出「负数/小数」这类只有存储损坏时才会出现的值。
 */
export class InMemoryStatisticsCountRepository implements StatisticsCountRepository {
  readonly capabilities: StatisticsCountCapabilities;

  private readonly counts = new Map<string, number>();

  constructor(env: AppEnv, source: StatisticsSource) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        `生产环境禁止使用内存统计来源（InMemoryStatisticsCountRepository: ${source}）：请把 ${STATISTICS_REPOSITORY_TOKEN_NAMES[source]} 绑定到持久化实现`,
      );
    }
    this.capabilities = {
      backend: 'in-memory-baseline',
      source,
      persistent: false,
      productionReady: false,
    };
  }

  countByUserId(userId: string): number {
    return this.counts.get(userId) ?? 0;
  }

  /**
   * 仅供开发/测试装配：显式写入某个服务端主体的计数。
   * 计数值先过读取契约（0..上限的安全整数），非法值直接抛错而不是「写进去等出口再报 500」，
   * 这样出口的 500 只可能由真实存储损坏触发，测试不会把基线自身的错误当成存储异常。
   */
  seed(userId: string, count: number): void {
    if (typeof userId !== 'string' || userId === '') {
      throw new Error('统计基线 seed 需要非空的服务端主体 ID');
    }
    const parsed = parseStatisticsCount(count);
    if (!parsed.ok) {
      throw new Error('统计基线 seed 拒绝非法计数（必须是 0..上限 的整数）');
    }
    this.counts.set(userId, parsed.value);
  }
}

/** DI 工厂：升学记录计数来源（内存基线） */
export function createEducationStatisticsRepository(env: AppEnv): StatisticsCountRepository {
  return new InMemoryStatisticsCountRepository(env, StatisticsSource.Education);
}

/** DI 工厂：入组申请计数来源（内存基线） */
export function createApplicationStatisticsRepository(env: AppEnv): StatisticsCountRepository {
  return new InMemoryStatisticsCountRepository(env, StatisticsSource.Applications);
}

/** DI 工厂：成果计数来源（内存基线） */
export function createAchievementStatisticsRepository(env: AppEnv): StatisticsCountRepository {
  return new InMemoryStatisticsCountRepository(env, StatisticsSource.Achievements);
}

/** DI 工厂：匹配请求计数来源（内存基线） */
export function createMatchingStatisticsRepository(env: AppEnv): StatisticsCountRepository {
  return new InMemoryStatisticsCountRepository(env, StatisticsSource.Matching);
}
