import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type {
  EducationRecord,
  EducationRecordRepository,
  EducationRecordRepositoryCapabilities,
} from './education-records.port';

/**
 * 升学记录仓储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久」：
 * - 只持有本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下直接拒绝构造，迫使生产把 `EDUCATION_RECORD_REPOSITORY`
 *   换绑到数据库实现（见 `education-records.port.ts` 的替换说明），
 *   而不是让「重启即丢数据」的内存结构悄悄承担生产存储职责；
 * - 不做授权判定、不生成归属信息：`userId` 由 service 从服务端主体写入；
 * - 与 PostgreSQL 实现同语义的是**归属命中**：`findById(recordId, ownerUserId)` 只返回
 *   「资源 ID 与归属同时命中」的记录，因此内存基线下他人记录同样不出库、也不可探测。
 */
@Injectable()
export class InMemoryEducationRecordRepository implements EducationRecordRepository {
  readonly capabilities: EducationRecordRepositoryCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly records = new Map<string, EducationRecord>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存升学记录仓储（InMemoryEducationRecordRepository）：请把 EDUCATION_RECORD_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  create(record: EducationRecord): Promise<EducationRecord> {
    if (this.records.has(record.id)) {
      // 主键冲突属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new Error(`升学记录 ID 冲突: ${record.id}`);
    }
    this.records.set(record.id, { ...record });
    return Promise.resolve({ ...record });
  }

  /**
   * 单条读取**同时**按资源 ID 与归属命中：与 PostgreSQL 实现同语义。
   *
   * 只按资源 ID 命中会把「他人记录」交给 service，让归属判定退化成**取数之后**的复核
   * （也正是存在性可被探测的原因）。这里与数据库实现一致地做归属命中，
   * 因此「不存在」与「存在但不属于该主体」在两种实现下都返回 `undefined`。
   */
  findById(recordId: string, ownerUserId: string): Promise<EducationRecord | undefined> {
    const record = this.records.get(recordId);
    if (record === undefined || record.userId !== ownerUserId) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({ ...record });
  }

  listByUserId(userId: string): Promise<readonly EducationRecord[]> {
    const records = [...this.records.values()]
      .filter((record) => record.userId === userId)
      .map((record) => ({ ...record }));
    return Promise.resolve(records);
  }
}
