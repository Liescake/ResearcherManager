import type { AppEnv } from '../../config/env';
import { parseSelfStatisticsView, parseStatisticsCount } from './statistics.contract';
import type { SelfStatisticsView } from './statistics.contract';
import {
  STATISTICS_REPOSITORY_TOKEN_NAMES,
  StatisticsSource,
  type SelfStatisticsCapabilities,
  type SelfStatisticsRepository,
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

/** 聚合端口的内存基线所需的四个来源（由模块的四个 provider 注入，便于测试逐来源 seed） */
export interface InMemorySelfStatisticsSources {
  readonly education: StatisticsCountRepository;
  readonly applications: StatisticsCountRepository;
  readonly achievements: StatisticsCountRepository;
  readonly matching: StatisticsCountRepository;
}

/**
 * `SelfStatisticsRepository` 的**内存聚合基线**：把四个来源端口组合成一次读数。
 *
 * 为什么组合而不是另存一份 `Map`：四个来源端口是「本人有数据 / 他人有数据」这类场景的既有
 * 装配点（控制器 spec 直接对它们 `seed()`），组合后内存路径与持久化路径的语义差异只剩
 * 「一条聚合 SELECT」与「四次内存查表」—— 计数口径完全一致，测试夹具不需要改写。
 *
 * 能力声明如实为 `persistent = false`、`productionReady = false`，并在 `NODE_ENV=production`
 * 下拒绝构造（与四个来源基线同一口径）。
 */
export class InMemorySelfStatisticsRepository implements SelfStatisticsRepository {
  readonly capabilities: SelfStatisticsCapabilities = Object.freeze({
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  });

  constructor(
    env: AppEnv,
    private readonly sources: InMemorySelfStatisticsSources,
  ) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存统计聚合基线（InMemorySelfStatisticsRepository）：请把 SELF_STATISTICS_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  async readCountsByUserId(ownerUserId: string): Promise<SelfStatisticsView> {
    const candidate = {
      educationRecords: this.read(this.sources.education, StatisticsSource.Education, ownerUserId),
      applications: this.read(
        this.sources.applications,
        StatisticsSource.Applications,
        ownerUserId,
      ),
      achievements: this.read(
        this.sources.achievements,
        StatisticsSource.Achievements,
        ownerUserId,
      ),
      matchingRequests: this.read(this.sources.matching, StatisticsSource.Matching, ownerUserId),
    };
    const parsed = parseSelfStatisticsView(candidate);
    if (!parsed.ok) {
      throw new Error(
        `内存统计聚合基线读数违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
    }
    return parsed.value;
  }

  /**
   * 单来源读数：先复核端口**声明的来源**与它被装配到的槽位一致，再校验计数值。
   *
   * 「端口装错来源」不会返回错误数字，而是返回**另一类口径**的数字 —— 那比报错更危险，
   * 因为它看起来完全正常。因此这里 fail-closed，与持久化实现的「列清单 / 行契约」同一口径。
   */
  private read(
    source: StatisticsCountRepository,
    expected: StatisticsSource,
    ownerUserId: string,
  ): number {
    if (source.capabilities.source !== expected) {
      throw new Error(
        `内存统计来源装配错误: 端口期望 ${expected}，实际 ${String(source.capabilities.source)}`,
      );
    }
    const parsed = parseStatisticsCount(source.countByUserId(ownerUserId));
    if (!parsed.ok) {
      throw new Error(
        `内存统计来源读数违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
    }
    return parsed.value;
  }
}

/** DI 工厂：内存聚合基线（未配置数据库时的默认绑定） */
export function createInMemorySelfStatisticsRepository(
  env: AppEnv,
  sources: InMemorySelfStatisticsSources,
): SelfStatisticsRepository {
  return new InMemorySelfStatisticsRepository(env, sources);
}
