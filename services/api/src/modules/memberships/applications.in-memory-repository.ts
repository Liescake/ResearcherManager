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
 *   换绑到数据库实现（见 `applications.port.ts` 的替换说明与 `memberships.module.ts` 的唯一换绑点），
 *   而不是让「重启即丢数据」的内存结构悄悄承担生产存储职责；
 * - 不做授权判定、不做状态转移、不生成归属信息：`userId`/`status` 由 service 从服务端
 *   主体与共享状态机写入。
 *
 * 端口是**异步**的（见 `applications.port.ts`）：本内存实现同样返回 Promise，因此
 * service 的调用顺序（授权 → 输入校验 → 仓储）在换绑前后逐字节一致，
 * 换绑不会引入「同步实现掩盖顺序错误」这一类差异。归属语义与 PostgreSQL 实现一致：
 * `findById` 只返回「资源 ID 与归属同时命中」的记录，**他人记录不出库**（返回 `undefined`）。
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

  async create(application: Application): Promise<Application> {
    if (this.applications.has(application.id)) {
      // 主键冲突属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new Error(`入组申请 ID 冲突: ${application.id}`);
    }
    this.applications.set(application.id, { ...application });
    return { ...application };
  }

  /**
   * 单条读取：**归属与资源 ID 同时命中**才返回（与 PostgreSQL 实现的下推谓词同语义）。
   * 他人主体的申请返回 `undefined`，与「不存在」不可区分。
   */
  async findById(applicationId: string, ownerUserId: string): Promise<Application | undefined> {
    const record = this.applications.get(applicationId);
    if (!record || record.userId !== ownerUserId) {
      return undefined;
    }
    return { ...record };
  }

  async listByUserId(userId: string): Promise<readonly Application[]> {
    return [...this.applications.values()]
      .filter((record) => record.userId === userId)
      .map((record) => ({ ...record }));
  }

  async listByUserAndGroup(userId: string, groupId: string): Promise<readonly Application[]> {
    return [...this.applications.values()]
      .filter((record) => record.userId === userId && record.groupId === groupId)
      .map((record) => ({ ...record }));
  }

  async save(application: Application): Promise<Application> {
    if (!this.applications.has(application.id)) {
      // 只允许更新既有记录：插入必须走 create 路径，避免绕过状态机入口
      throw new Error(`入组申请不存在，拒绝写入: ${application.id}`);
    }
    this.applications.set(application.id, { ...application });
    return { ...application };
  }
}
