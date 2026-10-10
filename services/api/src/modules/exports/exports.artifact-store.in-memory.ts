import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type {
  ExportArtifactContent,
  ExportArtifactRef,
  ExportArtifactSpec,
  ExportArtifactStore,
  ExportArtifactStoreCapabilities,
  ExportResource,
} from './exports.port';

/**
 * 内存基线内部存储键的前缀（服务端内部事实）：产物在基线里「落在哪里」由此派生。
 * 它**只存在于服务端进程内**，绝不进入任何 API 输出——`exports.controller.spec.ts`
 * 直接断言响应文本里不含该前缀、不含产物句柄本身。
 */
export const IN_MEMORY_EXPORT_STORAGE_PREFIX = 'memory-export-artifacts/';

/**
 * 内存基线的占位产物内容：**只含服务端字段白名单**（表头 + 字段名），不含任何资源数据、归属、
 * 证件号、联系方式或内部路径。
 *
 * 为什么可以这样：真正的字段级内容生成与脱敏属于后续切片（本基线不是生产实现，
 * 且在生产环境下拒绝构造）。占位内容由**服务端常量**派生，因此不存在「基线顺手把 PII 写进
 * 产物」的路径；它对下载切片的意义是「有确定长度、确定字节的内容可被读出」，
 * 从而让硬上限、响应头与审计这些**契约**得以被真实端到端验证，而不是靠伪造生产文件下载。
 */
function baselineArtifactBytes(spec: ExportArtifactSpec): Uint8Array {
  const lines = ['field', ...spec.fields];
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

/** 基线内部的产物描述（仅供服务端运维/测试核对存储事实，不属于端口能力） */
export interface InMemoryExportArtifactDescriptor {
  readonly artifactId: string;
  /** 服务端内部存储键（形如 `memory-export-artifacts/<owner>/<artifactId>.csv`），绝不外发 */
  readonly storageKey: string;
  readonly ownerUserId: string;
  readonly resource: ExportResource;
  readonly fields: readonly string[];
  /** 产物字节数：下载切片据此做硬上限判定（真实内容本身只在 `read` 时取副本） */
  readonly byteSize: number;
}

/**
 * 导出产物存储的**内存基线**：开发与测试用，缺失真实产物存储时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久、只在服务端」：
 * - 只持有本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下**直接拒绝构造**，迫使生产把 `EXPORT_ARTIFACT_STORE`
 *   换绑到真实产物存储（临时文件区/对象存储 + 有效期与清理策略）；
 * - 返回值只有一个**不透明** UUID 句柄：不含路径、URL、存储键或文件名，
 *   因此即使上层把它误放进响应，也拿不到可反推服务端存储位置的信息；
 * - `read` 只回**内容字节**（副本）：不含存储键、路径、下载地址、签名地址或文件名，
 *   因此端口在类型层面就没有「把内部位置或一次性签名交给调用方」的能力；
 * - 存储键仍然只存在于服务端内部（`findArtifactDescriptor` 仅供测试/运维核对），
 *   并且只以**摘要**形式进入下载审计（见 `exports.service.ts`）；
 * - 真正的**内容生成与脱敏**（读取各资源仓储、按字段白名单产出 Excel/CSV、字段级脱敏、
 *   有效期与清理）属于后续切片：本切片只固定「产物生成成功/失败」这一事实与「产物可被
 *   按句柄读回」这一最小读能力，不声称生产可用；
 * - 不做授权判定，也不决定归属与字段：spec 由 service 从服务端主体与已验证白名单推导，
 *   读取前由 service 完成归属与资源级判定。
 */
@Injectable()
export class InMemoryExportArtifactStore implements ExportArtifactStore {
  readonly capabilities: ExportArtifactStoreCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly artifacts = new Map<string, InMemoryExportArtifactDescriptor>();
  private readonly contents = new Map<string, Uint8Array>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存导出产物存储（InMemoryExportArtifactStore）：请把 EXPORT_ARTIFACT_STORE 绑定到持久化实现',
      );
    }
  }

  store(spec: ExportArtifactSpec): ExportArtifactRef {
    const artifactId = randomUUID();
    const bytes = baselineArtifactBytes(spec);
    const descriptor: InMemoryExportArtifactDescriptor = Object.freeze({
      artifactId,
      storageKey: `${IN_MEMORY_EXPORT_STORAGE_PREFIX}${spec.ownerUserId}/${artifactId}.csv`,
      ownerUserId: spec.ownerUserId,
      resource: spec.resource,
      fields: Object.freeze([...spec.fields]),
      byteSize: bytes.byteLength,
    });
    this.artifacts.set(artifactId, descriptor);
    this.contents.set(artifactId, bytes);

    // 只回不透明句柄：存储键留在服务端内部
    return { artifactId };
  }

  /**
   * 按不透明句柄读回产物内容。
   *
   * - 命中：返回**字节副本**（调用方无法就地改写基线内部内容）；
   * - 句柄不存在：返回 `undefined`（与「他人产物」不可区分，调用方按统一拒绝收敛）；
   * - 只返回内容字节：不含存储键、路径、下载地址、签名地址或文件名。
   */
  async read(artifactId: string): Promise<ExportArtifactContent | undefined> {
    const bytes = this.contents.get(artifactId);
    if (bytes === undefined) return undefined;
    return { bytes: Uint8Array.from(bytes) };
  }

  /**
   * 仅供服务端测试/运维核对内部存储事实（**不在端口上**，生产实现无需提供）。
   * 返回副本，调用方无法就地改写已存储的产物描述。
   */
  findArtifactDescriptor(artifactId: string): InMemoryExportArtifactDescriptor | undefined {
    const descriptor = this.artifacts.get(artifactId);
    return descriptor ? { ...descriptor, fields: [...descriptor.fields] } : undefined;
  }
}
