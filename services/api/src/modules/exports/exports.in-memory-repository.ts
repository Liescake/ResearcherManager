import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type { ExportRepository, ExportRepositoryCapabilities, ExportRequest } from './exports.port';

/**
 * 导出请求仓储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久」：
 * - 只持有本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下**直接拒绝构造**，迫使生产把 `EXPORT_REPOSITORY`
 *   换绑到数据库实现（见 `exports.port.ts` 的替换说明），
 *   而不是让「重启即丢数据」的内存结构悄悄承担生产导出事实的持久化职责；
 * - 不做授权判定、不生成归属/状态/时间戳：这些只由 service 从服务端会话、状态机与时钟写入；
 * - **不做读取契约校验**：存储层损坏（未知枚举、字段不在白名单、状态与产物不自洽）必须能被
 *   出口的 fail-closed 门禁看见，因此基线不代替出口做校验，也不静默修正非法记录；
 *   写入只保证「主键唯一」「归属不可改写」这两条存储自身的完整性约束；
 * - **没有**删除/归档方法：本切片不提供「删除导出请求」的能力。
 */
@Injectable()
export class InMemoryExportRepository implements ExportRepository {
  readonly capabilities: ExportRepositoryCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly requests = new Map<string, ExportRequest>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存导出仓储（InMemoryExportRepository）：请把 EXPORT_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  async create(request: ExportRequest): Promise<ExportRequest> {
    if (this.requests.has(request.id)) {
      // 主键冲突属于服务端缺陷（ID 由服务端生成），不得静默覆盖既有导出请求
      throw new Error(`导出请求 ID 冲突: ${request.id}`);
    }
    this.requests.set(request.id, copyRequest(request));
    return copyRequest(request);
  }

  async save(request: ExportRequest): Promise<ExportRequest> {
    const existing = this.requests.get(request.id);
    if (!existing) {
      // 覆盖写入未知 id 说明调用链已错（状态机推进只针对已创建的请求），不得退化成插入
      throw new Error(`导出请求不存在，无法更新: ${request.id}`);
    }
    if (existing.ownerUserId !== request.ownerUserId) {
      // 归属不得在更新中被改写：归属只来自服务端会话主体的首次写入
      throw new Error(`导出请求归属不一致，拒绝更新: ${request.id}`);
    }
    this.requests.set(request.id, copyRequest(request));
    return copyRequest(request);
  }

  /**
   * 只返回该服务端主体名下的记录，按创建顺序。
   * 过滤行为**不作为安全边界**：service 仍会逐条复核归属（纵深防御）。
   */
  async listByOwnerId(ownerUserId: string): Promise<readonly ExportRequest[]> {
    return [...this.requests.values()]
      .filter((record) => record.ownerUserId === ownerUserId)
      .map((record) => copyRequest(record));
  }
}

/** 返回副本：仓储不得把内部可变引用（含字段数组）交给调用方 */
function copyRequest(request: ExportRequest): ExportRequest {
  return { ...request, fields: [...request.fields] };
}
