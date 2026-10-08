import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type {
  SessionBackendCapabilities,
  SessionRecord,
  SessionStore,
} from './session-subject.port';

/**
 * 会话存储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、默认空」：
 * - 状态只存在于本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启；
 * - 不预置任何账号或令牌，也不读取环境里的隐式凭据 —— 未显式 `seed()` 时任何请求都解析不到主体；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下直接拒绝构造，逼迫生产把 `SESSION_STORE`（进而
 *   `SESSION_SUBJECT_RESOLVER`）换绑到数据库/Redis 实现，而不是把内存当生产存储使用。
 *
 * 替换方式：生产提供同一 `SessionStore` 接口的实现并绑定 `SESSION_STORE`
 * （或直接换绑 `SESSION_SUBJECT_RESOLVER`），调用方（controller/service）无需改动。
 */
@Injectable()
export class InMemorySessionStore implements SessionStore {
  readonly capabilities: SessionBackendCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly sessions = new Map<string, SessionRecord>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存会话存储（InMemorySessionStore）：请把 SESSION_STORE 绑定到持久化实现',
      );
    }
  }

  /** 仅供开发/测试装配：显式写入一条会话，不接受任何隐式全局状态 */
  seed(record: SessionRecord): void {
    this.sessions.set(record.sessionId, {
      sessionId: record.sessionId,
      subject: {
        userId: record.subject.userId,
        roles: [...record.subject.roles],
        ...(record.subject.groupIds ? { groupIds: [...record.subject.groupIds] } : {}),
        ...(record.subject.assignedResourceIds
          ? { assignedResourceIds: [...record.subject.assignedResourceIds] }
          : {}),
      },
    });
  }

  findSession(sessionId: string): SessionRecord | undefined {
    const record = this.sessions.get(sessionId);
    if (!record) return undefined;
    // 返回副本：会话存储不得把内部可变引用交给调用方
    return {
      sessionId: record.sessionId,
      subject: {
        userId: record.subject.userId,
        roles: [...record.subject.roles],
        ...(record.subject.groupIds ? { groupIds: [...record.subject.groupIds] } : {}),
        ...(record.subject.assignedResourceIds
          ? { assignedResourceIds: [...record.subject.assignedResourceIds] }
          : {}),
      },
    };
  }
}
