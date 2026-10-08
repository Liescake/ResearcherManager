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
 * - 不做授权判定、不生成归属信息：`userId` 由 service 从服务端主体写入。
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

  create(record: EducationRecord): EducationRecord {
    if (this.records.has(record.id)) {
      // 主键冲突属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new Error(`升学记录 ID 冲突: ${record.id}`);
    }
    this.records.set(record.id, { ...record });
    return { ...record };
  }

  findById(recordId: string): EducationRecord | undefined {
    const record = this.records.get(recordId);
    return record ? { ...record } : undefined;
  }

  listByUserId(userId: string): readonly EducationRecord[] {
    return [...this.records.values()]
      .filter((record) => record.userId === userId)
      .map((record) => ({ ...record }));
  }
}
