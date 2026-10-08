import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type {
  MatchingRepository,
  MatchingRepositoryCapabilities,
  MatchingRequest,
} from './matching.port';

/**
 * 匹配请求仓储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久」：
 * - 只持有本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下直接拒绝构造，迫使生产把 `MATCHING_REPOSITORY`
 *   换绑到数据库实现（见 `matching.port.ts` 的替换说明），
 *   而不是让「重启即丢数据」的内存结构悄悄承担生产存储职责；
 * - 不做授权判定、不生成归属与状态：`userId`/`status`/摘要/时间戳只由 service 写入。
 */
@Injectable()
export class InMemoryMatchingRepository implements MatchingRepository {
  readonly capabilities: MatchingRepositoryCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly requests = new Map<string, MatchingRequest>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存匹配仓储（InMemoryMatchingRepository）：请把 MATCHING_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  create(request: MatchingRequest): MatchingRequest {
    if (this.requests.has(request.id)) {
      // 主键冲突属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new Error(`匹配请求 ID 冲突: ${request.id}`);
    }
    this.requests.set(request.id, { ...request, recommendations: [...request.recommendations] });
    return this.copy(request);
  }

  save(request: MatchingRequest): MatchingRequest {
    const existing = this.requests.get(request.id);
    if (!existing) {
      // 覆盖写入未知 id 说明调用链已错（状态机推进只针对已创建的请求），不得退化成插入
      throw new Error(`匹配请求不存在，无法更新: ${request.id}`);
    }
    if (existing.userId !== request.userId) {
      // 归属不得在更新中被改写：归属只来自服务端会话主体的首次写入
      throw new Error(`匹配请求归属不一致，拒绝更新: ${request.id}`);
    }
    this.requests.set(request.id, { ...request, recommendations: [...request.recommendations] });
    return this.copy(request);
  }

  findById(requestId: string): MatchingRequest | undefined {
    const record = this.requests.get(requestId);
    return record ? this.copy(record) : undefined;
  }

  listByUserId(userId: string): readonly MatchingRequest[] {
    return [...this.requests.values()]
      .filter((record) => record.userId === userId)
      .map((record) => this.copy(record));
  }

  /** 返回副本：仓储不得把内部可变引用（含数组）交给调用方 */
  private copy(record: MatchingRequest): MatchingRequest {
    return { ...record, recommendations: [...record.recommendations] };
  }
}
