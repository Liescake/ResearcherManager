import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import { parseExportDownloadAuditEntry } from './exports.contract';
import type { ExportDownloadAuditEntry, ExportDownloadAuditSink } from './exports.port';

/**
 * 下载审计出口的**内存基线**：开发与测试用，缺失真实审计落库实现时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久」：
 * - 只持有本实例的数组，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `NODE_ENV=production` 下**直接拒绝构造**，迫使生产把 `EXPORT_DOWNLOAD_AUDIT`
 *   换绑到真实的追加写实现（真实实现应把同一条目写入审计存储）；
 * - **只装脱敏条目**：写入前用严格契约校验（恰好 `requestId` / `exportIdDigest` / `result`
 *   三个字段），任何多余字段（产物内容、产物句柄、存储 key / 路径 / URL / 文件名、归属主体、
 *   角色、请求头、IP、原始错误）都会让写入 fail-closed 抛错，而不是被静默剥离或静默落库；
 * - **不提供公开读取面**：`entries()` 仅供服务端测试/运维核对留痕事实（不在端口上），
 *   返回副本，调用方无法就地改写已写入的审计条目；
 * - 不做授权判定，也不生成任何字段：条目由 service 从服务端常量、服务端时钟与服务端 UUID 构造。
 */
@Injectable()
export class InMemoryExportDownloadAuditSink implements ExportDownloadAuditSink {
  readonly capabilities = Object.freeze({
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  });

  private readonly recorded: ExportDownloadAuditEntry[] = [];

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存下载审计出口（InMemoryExportDownloadAuditSink）：请把 EXPORT_DOWNLOAD_AUDIT 绑定到持久化实现',
      );
    }
  }

  async record(entry: ExportDownloadAuditEntry): Promise<void> {
    const parsed = parseExportDownloadAuditEntry(entry);
    if (!parsed.ok) {
      // 只写字段路径与违规类型，不写取值：脱敏门禁自己不得成为泄漏点
      throw new Error(
        `下载审计条目违反严格契约（字段路径：${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}）`,
      );
    }
    this.recorded.push(Object.freeze({ ...parsed.value }));
  }

  /** 仅供服务端测试/运维核对留痕事实（**不在端口上**）：返回副本，调用方无法就地改写 */
  entries(): readonly ExportDownloadAuditEntry[] {
    return this.recorded.map((entry) => ({ ...entry }));
  }
}
