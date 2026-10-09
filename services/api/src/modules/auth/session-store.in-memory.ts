import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import { generateSessionTicket, isSessionTicket } from './session-ticket';
import type {
  CreateSessionInput,
  IssuedSession,
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
 *   `SESSION_SUBJECT_RESOLVER`）换绑到数据库实现，而不是把内存当生产存储使用。
 *
 * 替换方式：`auth.module.ts` 的 `createSessionStore()` 在解析出 `DATABASE_URL` 时换绑到
 * `session-store.postgres-repository.ts` 的延迟实现；调用方（controller/service）无需改动。
 *
 * ## 与持久化实现的**刻意差异**（必须显式记录，避免被误读为「等价」）
 * 1. **键即显式 seed 的会话 ID**：本基线不落盘、不跨进程，所以 `findSession` 的入参直接当键用；
 *    「只存不可逆摘要」是**持久化存储**的约束，由 PostgreSQL adapter 承担（它只把
 *    `sessionTicketDigest(ticket)` 落库）。本基线的 `Map` 里出现的原始票据不会离开进程内存，
 *    也不会被写入任何日志或响应；
 * 2. **无存储层行契约**：内存基线不做行契约校验（存储层损坏必须能被出口门禁看见 —— 见
 *    `session-subject.spec.ts` 用「未登记角色」驱动 fail-closed），数据库实现则必须校验每一行。
 *
 * 生命周期四个方法齐全（创建 / 读取 / 撤销 / 过期清理），因此「换绑前后端口语义一致」可以在
 * **没有任何数据库**的情况下被单测钉住；真实存储的行契约与 SQL 由 adapter 的 spec 与
 * `db/postgres/__tests__/postgres-integration.spec.ts` 覆盖。
 */
@Injectable()
export class InMemorySessionStore implements SessionStore {
  readonly capabilities: SessionBackendCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  /** 存储项：记录 + 过期时刻（毫秒；`undefined` 表示显式 seed 的会话不设过期） */
  private readonly sessions = new Map<string, InMemorySessionEntry>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存会话存储（InMemorySessionStore）：请把 SESSION_STORE 绑定到持久化实现',
      );
    }
  }

  /**
   * 仅供开发/测试装配：显式写入一条会话，不接受任何隐式全局状态。
   *
   * `expiresAt` 省略时该会话**永不过期**（`purgeExpired` 不会删它）：seed 的用途是「让某个
   * 会话 ID 可被解析」，给它绑一个会随时间漂移的过期时刻只会让用例变得不稳定。需要覆盖过期语义的
   * 用例请用 `createSession()` 或显式传入 `expiresAt`。
   */
  seed(record: SessionRecord, options: { readonly expiresAt?: string } = {}): void {
    const expiresAtMs =
      options.expiresAt === undefined ? undefined : parseExpiry(options.expiresAt);
    this.sessions.set(record.sessionId, {
      record: copyRecord(record),
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      revoked: false,
    });
  }

  async findSession(ticket: string): Promise<SessionRecord | undefined> {
    const entry = this.liveEntry(ticket);
    return entry === undefined ? undefined : copyRecord(entry.record);
  }

  async createSession(input: CreateSessionInput): Promise<IssuedSession> {
    const expiresAtMs = parseExpiry(input.expiresAt);
    // 原始票据只在此处出现一次；存储里放的是这张票据本身（内存基线不落盘，见类注释第 1 条）
    const ticket = generateSessionTicket();
    const record: SessionRecord = {
      sessionId: ticket,
      subject: copySubject(input.subject),
    };
    this.sessions.set(ticket, { record, expiresAtMs, revoked: false });
    return { ticket, record: copyRecord(record), expiresAt: input.expiresAt };
  }

  async revokeSession(ticket: string): Promise<boolean> {
    const entry = this.sessions.get(ticket);
    if (entry === undefined || entry.revoked) {
      return false;
    }
    entry.revoked = true;
    return true;
  }

  async purgeExpired(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [ticket, entry] of this.sessions) {
      if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= now) {
        this.sessions.delete(ticket);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 会话 ID 形状自检（供测试与装配断言）：内存基线的键可以是任意显式 seed 的 ID，
   * 但**由 `createSession` 下发的**票据必须是规范形态，否则「换成 PostgreSQL 后立刻读不出来」。
   */
  isIssuedTicketShape(ticket: unknown): boolean {
    return isSessionTicket(ticket);
  }

  /** 可用的存储项：存在、未撤销、未过期；其余一律视为「这张票据无效」 */
  private liveEntry(ticket: string): InMemorySessionEntry | undefined {
    const entry = this.sessions.get(ticket);
    if (entry === undefined || entry.revoked) {
      return undefined;
    }
    if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= Date.now()) {
      return undefined;
    }
    return entry;
  }
}

interface InMemorySessionEntry {
  readonly record: SessionRecord;
  /** 过期时刻（毫秒）；`undefined` = seed 的不设过期会话 */
  readonly expiresAtMs?: number;
  revoked: boolean;
}

/** 过期时刻解析：只接受带时区的 ISO 时间戳，非法即抛（创建会话是服务端动作，非法属代码缺陷） */
function parseExpiry(expiresAt: string): number {
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) {
    throw new TypeError('会话过期时刻必须是带时区的 ISO 时间戳');
  }
  return parsed;
}

function copySubject(subject: SessionRecord['subject']): SessionRecord['subject'] {
  return {
    userId: subject.userId,
    roles: [...subject.roles],
    ...(subject.groupIds ? { groupIds: [...subject.groupIds] } : {}),
    ...(subject.assignedResourceIds
      ? { assignedResourceIds: [...subject.assignedResourceIds] }
      : {}),
  };
}

/** 返回副本：会话存储不得把内部可变引用交给调用方 */
function copyRecord(record: SessionRecord): SessionRecord {
  return { sessionId: record.sessionId, subject: copySubject(record.subject) };
}
