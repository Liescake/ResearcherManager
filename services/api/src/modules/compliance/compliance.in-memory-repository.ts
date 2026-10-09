import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type {
  ComplianceRecord,
  ComplianceRepository,
  ComplianceRepositoryCapabilities,
} from './compliance.port';

/**
 * 合规状态仓储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久、只读」：
 * - 状态只存在于本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下**直接拒绝构造**，迫使生产把 `COMPLIANCE_REPOSITORY`
 *   换绑到持久化实现（见 `compliance.port.ts` 的替换说明），
 *   而不是让「重启即丢数据」的内存结构悄悄承担生产合规事实的读取职责；
 * - **没有写入口**：本类不实现 `create`/`save`/`delete`/`archive`（端口也没有这些方法），
 *   因此 API 侧无法经由读取路径改写同意、留存或导出可用性事实；
 * - 不做授权判定、不生成归属：归属只由调用方从服务端会话主体传入；
 * - **不做读取契约校验**：存储层损坏（未知枚举、状态不自洽、被塞入内部字段）必须能被
 *   出口的 fail-closed 门禁看见，因此基线不代替出口做校验，也不静默修正非法记录；
 *   它只保证「按主体取数」与「返回副本」这两条存储自身的完整性约束。
 *
 * `seed()` 是**仅供开发/测试装配**的显式写入（与会话基线的 `seed` 同构）：
 * 不预置任何账号，也不读取环境里的隐式数据；未显式 `seed` 时任何主体都查不到记录，
 * service 因此按 fail-closed 返回 500，而不是凭空给出「看起来正常」的合规状态。
 */
@Injectable()
export class InMemoryComplianceRepository implements ComplianceRepository {
  readonly capabilities: ComplianceRepositoryCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly records = new Map<string, ComplianceRecord>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存合规仓储（InMemoryComplianceRepository）：请把 COMPLIANCE_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  /** 仅供开发/测试装配：显式写入一条合规状态，不接受任何隐式全局状态 */
  seed(record: ComplianceRecord): void {
    this.records.set(record.ownerUserId, { ...record });
  }

  /**
   * 只返回该服务端主体名下的记录，没有则 `undefined`（由 service 按 fail-closed 处理）。
   * 过滤行为**不作为安全边界**：service 仍会复核归属与读取契约（纵深防御）。
   *
   * 返回类型是 `Promise`：端口已收敛为异步唯一契约（见 `compliance.port.ts`），
   * 数据库实现与内存基线因此实现**同一个**接口，换绑不再需要第二个并存契约。
   * 内存基线的实现体仍是同步查表（`async` 只是契约形状），因此不引入任何真实异步行为。
   */
  async findByUserId(ownerUserId: string): Promise<ComplianceRecord | undefined> {
    const record = this.records.get(ownerUserId);
    // 返回副本：仓储不得把内部可变引用交给调用方
    return record ? { ...record } : undefined;
  }
}
