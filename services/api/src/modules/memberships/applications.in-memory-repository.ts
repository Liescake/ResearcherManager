import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type {
  Application,
  ApplicationRepository,
  ApplicationRepositoryCapabilities,
} from './applications.port';

/**
 * 入组申请仓储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久」：
 * - 只持有本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下直接拒绝构造，迫使生产把 `APPLICATION_REPOSITORY`
 *   换绑到数据库实现（见 `applications.port.ts` 的替换说明），
 *   而不是让「重启即丢数据」的内存结构悄悄承担生产存储职责；
 * - 不做授权判定、不做状态转移、不生成归属信息：`userId`/`status` 由 service 从服务端
 *   主体与共享状态机写入。
 */
@Injectable()
export class InMemoryApplicationRepository implements ApplicationRepository {
  readonly capabilities: ApplicationRepositoryCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly applications = new Map<string, Application>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存入组申请仓储（InMemoryApplicationRepository）：请把 APPLICATION_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  create(application: Application): Application {
    if (this.applications.has(application.id)) {
      // 主键冲突属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new Error(`入组申请 ID 冲突: ${application.id}`);
    }
    this.applications.set(application.id, { ...application });
    return { ...application };
  }

  findById(applicationId: string): Application | undefined {
    const record = this.applications.get(applicationId);
    return record ? { ...record } : undefined;
  }

  listByUserId(userId: string): readonly Application[] {
    return [...this.applications.values()]
      .filter((record) => record.userId === userId)
      .map((record) => ({ ...record }));
  }

  listByUserAndGroup(userId: string, groupId: string): readonly Application[] {
    return [...this.applications.values()]
      .filter((record) => record.userId === userId && record.groupId === groupId)
      .map((record) => ({ ...record }));
  }

  save(application: Application): Application {
    if (!this.applications.has(application.id)) {
      // 只允许更新既有记录：插入必须走 create 路径，避免绕过状态机入口
      throw new Error(`入组申请不存在，拒绝写入: ${application.id}`);
    }
    this.applications.set(application.id, { ...application });
    return { ...application };
  }
}
