import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type { AuditEvent, AuditRepository, AuditRepositoryCapabilities } from './audit.port';

/**
 * 审计仓储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久、仅追加」：
 * - 只持有本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下**直接拒绝构造**，迫使生产把 `AUDIT_REPOSITORY`
 *   换绑到数据库实现（见 `audit.port.ts` 的替换说明），
 *   而不是让「重启即丢数据」的内存结构悄悄承担生产审计职责；
 * - **没有** update / delete 方法：审计只追加（docs/P2-数据约束与迁移设计.md §1
 *   「禁止级联删除审计」），因此内存基线也无法提供改写入口；
 * - 入库记录**被冻结**：即使调用方持有同一对象引用也无法就地改写，避免「审计记录可变」；
 * - 不做授权判定、不生成归属/结果/时间戳：这些由 service 从服务端会话与时钟写入；
 * - **不做读取契约校验**：存储层损坏（未知枚举、摘要含 PII、明文 IP、多出字段）必须能被出口的
 *   fail-closed 门禁看见，因此基线不代替出口做校验，也不静默修正非法记录；
 *   写入只保证「主键唯一」这一存储自身的完整性约束。
 */
@Injectable()
export class InMemoryAuditRepository implements AuditRepository {
  readonly capabilities: AuditRepositoryCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly events = new Map<string, AuditEvent>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存审计仓储（InMemoryAuditRepository）：请把 AUDIT_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  append(event: AuditEvent): AuditEvent {
    if (this.events.has(event.id)) {
      // 主键冲突属于服务端缺陷（ID 由服务端生成），不得静默覆盖既有审计记录
      throw new Error(`审计事件 ID 冲突: ${event.id}`);
    }
    const stored = freezeEvent(event);
    this.events.set(stored.id, stored);
    return stored;
  }

  /**
   * 只返回「主体本人 **且** 标记为本人可见」的记录，按追加顺序。
   * 过滤行为**不作为安全边界**：service 仍会逐条复核归属与可见标记（纵深防御）。
   */
  listVisibleByActor(actorUserId: string): readonly AuditEvent[] {
    return [...this.events.values()]
      .filter((record) => record.actorUserId === actorUserId && record.selfVisible)
      .map((record) => freezeEvent(record));
  }
}

/** 审计记录不可变：入库与出库都返回冻结副本，调用方无法就地改写已记录的事实 */
function freezeEvent(event: AuditEvent): AuditEvent {
  return Object.freeze({ ...event });
}
