import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { Role } from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../config/env';
import { requireSubject } from './require-subject';
import { InMemorySessionStore } from './session-store.in-memory';
import { isSessionTicket, sessionTicketDigest } from './session-ticket';
import {
  BearerSessionSubjectResolver,
  extractSessionId,
  normalizeSubject,
} from './session-subject.baseline';
import type { CreateSessionInput, SessionRecord, SessionStore } from './session-subject.port';

/**
 * 认证边界回归：会话凭证 → **服务端主体**。
 *
 * 关键约束（与 `AuthorizationGuard` 的资源级判定互补）：
 * - 凭证只允许 `Bearer <sessionId>` 形态；其余一律解析失败（→ 401）；
 * - 主体只能来自服务端存储；客户端提供的任何角色/范围信息都不参与；
 * - 存储里出现未登记角色/非法 ID 时整个主体作废（fail-closed），不退化成「按已知角色继续」；
 * - **存储不可用必须抛出**，不得退化成 401（否则数据库故障会被伪装成「所有人都未登录」）；
 * - 内存基线显式、实例级、非持久，并在生产环境拒绝构造。
 */

const developmentEnv = loadEnv({});

function storeWith(sessions: readonly { sessionId: string; subject: AuthorizationSubject }[]) {
  const store = new InMemorySessionStore(developmentEnv);
  for (const session of sessions) store.seed(session);
  return store;
}

const studentSession = {
  sessionId: 'session-student-1',
  subject: { userId: 'u-student-1', roles: [Role.Student] },
} as const;

describe('extractSessionId：严格解析 Bearer 凭证', () => {
  it('接受合法凭证（含首尾空白）', () => {
    expect(extractSessionId('Bearer session-student-1')).toBe('session-student-1');
    expect(extractSessionId('  Bearer session-student-1  ')).toBe('session-student-1');
    expect(extractSessionId(`Bearer ${'a'.repeat(128)}`)).toBe('a'.repeat(128));
  });

  it('拒绝其他 scheme、过短/过长、含非法字符与缺失凭证', () => {
    const cases: Array<string | undefined> = [
      undefined,
      '',
      'session-student-1',
      'Basic session-student-1',
      'Bearer',
      'Bearer short',
      'Bearer has space',
      `Bearer ${'a'.repeat(129)}`,
      'Bearer session/student',
      'Bearer session\nstudent',
    ];
    for (const header of cases) {
      expect(extractSessionId(header)).toBeUndefined();
    }
  });
});

describe('normalizeSubject：主体 fail-closed 规范化', () => {
  it('合法主体返回深拷贝，与存储内对象解耦', () => {
    const subject: AuthorizationSubject = {
      userId: 'u-student-1',
      roles: [Role.Student],
      groupIds: ['g-1'],
      assignedResourceIds: ['u-assigned-1'],
    };
    const normalized = normalizeSubject({ sessionId: 'session-1', subject });

    expect(normalized).toEqual(subject);
    expect(normalized).not.toBe(subject);
    expect(normalized?.roles).not.toBe(subject.roles);
  });

  it('缺失记录/空 userId/空角色/未登记角色/非法 ID 一律 undefined', () => {
    const invalid: Array<{ sessionId: string; subject: AuthorizationSubject } | undefined> = [
      undefined,
      { sessionId: 'session-1', subject: { userId: '', roles: [Role.Student] } },
      { sessionId: 'session-1', subject: { userId: 'u-1', roles: [] } },
      { sessionId: 'session-1', subject: { userId: 'u-1', roles: ['guest' as Role] } },
      {
        sessionId: 'session-1',
        subject: { userId: 'u-1', roles: [Role.Student, 'guest' as Role] },
      },
      { sessionId: 'session-1', subject: { userId: 'u-1', roles: [Role.Student], groupIds: [''] } },
      {
        sessionId: 'session-1',
        subject: { userId: 'u-1', roles: [Role.Student], assignedResourceIds: ['bad id'] },
      },
      { sessionId: 'session-1', subject: { userId: 'bad id', roles: [Role.Student] } },
    ];

    for (const record of invalid) {
      expect(normalizeSubject(record)).toBeUndefined();
    }
  });
});

describe('BearerSessionSubjectResolver：主体只来自服务端存储', () => {
  it('解析成功：主体取自会话存储，而不是请求携带的任何其他信息', async () => {
    const store = storeWith([studentSession]);
    const resolver = new BearerSessionSubjectResolver(store);

    await expect(resolver.resolveSubject('Bearer session-student-1')).resolves.toEqual({
      userId: 'u-student-1',
      roles: [Role.Student],
    });
    // 能力声明透传会话后端
    expect(resolver.capabilities).toEqual(store.capabilities);
  });

  it('会话不存在/凭证非法一律 undefined（调用方转 401）', async () => {
    const resolver = new BearerSessionSubjectResolver(storeWith([studentSession]));

    await expect(resolver.resolveSubject('Bearer session-student-1')).resolves.toBeDefined();
    const rejected: Array<string | undefined> = [
      undefined,
      '',
      'Bearer',
      'Bearer session-other-1',
      'Token session-student-1',
      'Bearer session-student-1 extra',
    ];
    for (const header of rejected) {
      await expect(resolver.resolveSubject(header)).resolves.toBeUndefined();
    }
  });

  it('会话存储里出现未登记角色：整个主体作废（401），不退化成已知角色', async () => {
    const store = storeWith([
      { sessionId: 'session-unknown-role', subject: { userId: 'u-x', roles: ['guest' as Role] } },
    ]);
    const resolver = new BearerSessionSubjectResolver(store);

    await expect(resolver.resolveSubject('Bearer session-unknown-role')).resolves.toBeUndefined();
  });

  it('默认装配（空存储）不提供任何隐式会话', async () => {
    const resolver = new BearerSessionSubjectResolver(new InMemorySessionStore(developmentEnv));

    await expect(resolver.resolveSubject('Bearer session-student-1')).resolves.toBeUndefined();
    await expect(resolver.resolveSubject('Bearer admin')).resolves.toBeUndefined();
  });

  it('存储不可用：异常必须抛出，不得被吞成 undefined（否则故障会伪装成「全部未登录」）', async () => {
    const failure = new Error('存储不可用（合成）');
    const broken: SessionStore = {
      capabilities: { backend: 'broken', persistent: true, productionReady: false },
      findSession: () => Promise.reject(failure),
      createSession: () => Promise.reject(failure),
      revokeSession: () => Promise.reject(failure),
      purgeExpired: () => Promise.reject(failure),
    };
    const resolver = new BearerSessionSubjectResolver(broken);

    // 1) 解析器：把存储异常原样抛出（不做任何加工，也不返回 undefined）
    await expect(resolver.resolveSubject('Bearer session-student-1')).rejects.toBe(failure);
    // 2) HTTP 出口：拿到的是存储异常，**不是** 401 —— 可用性故障与无效凭证必须可区分
    await expect(requireSubject(resolver, 'Bearer session-student-1')).rejects.toBe(failure);
  });

  it('格式非法的凭证在存储被调用之前就被拒绝（存储不会被无谓触碰）', async () => {
    let calls = 0;
    const counting: SessionStore = {
      capabilities: { backend: 'counting', persistent: true, productionReady: false },
      findSession: () => {
        calls += 1;
        return Promise.resolve(undefined);
      },
      createSession: () => Promise.reject(new Error('unused')),
      revokeSession: () => Promise.resolve(false),
      purgeExpired: () => Promise.resolve(0),
    };
    const resolver = new BearerSessionSubjectResolver(counting);

    expect(await resolver.resolveSubject('Basic session-student-1')).toBeUndefined();
    expect(await resolver.resolveSubject(undefined)).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe('requireSubject：无会话即 401，且不区分失败原因', () => {
  it('解析成功时返回主体', async () => {
    const resolver = new BearerSessionSubjectResolver(storeWith([studentSession]));

    await expect(requireSubject(resolver, 'Bearer session-student-1')).resolves.toEqual({
      userId: 'u-student-1',
      roles: [Role.Student],
    });
  });

  it('解析失败时抛 401 UNAUTHENTICATED，文案不暴露具体原因', async () => {
    const resolver = new BearerSessionSubjectResolver(storeWith([studentSession]));

    let thrown: unknown;
    try {
      await requireSubject(resolver, undefined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnauthorizedException);
    const response = (thrown as UnauthorizedException).getResponse();
    expect(response).toMatchObject({
      statusCode: 401,
      message: '登录状态无效或已过期，请重新登录',
    });
    expect(JSON.stringify(response)).not.toMatch(/session|Bearer|role/u);
  });
});

describe('InMemorySessionStore：显式、实例级、非持久', () => {
  it('seed 后可按会话 ID 取回；未 seed 的 ID 取不到', async () => {
    const store = storeWith([studentSession]);

    await expect(store.findSession('session-student-1')).resolves.toMatchObject({
      subject: { userId: 'u-student-1' },
    });
    await expect(store.findSession('session-student-2')).resolves.toBeUndefined();
  });

  it('对外只给副本：外部修改不会污染存储内的会话', async () => {
    const subject: { userId: string; roles: Role[] } = { userId: 'u-1', roles: [Role.Student] };
    const store = new InMemorySessionStore(developmentEnv);
    store.seed({ sessionId: 'session-copy-1', subject });

    // 1) seed 之后修改传入对象
    subject.roles.push(Role.SuperAdmin);
    const afterSeed = await store.findSession('session-copy-1');
    expect(afterSeed?.subject.roles).toEqual([Role.Student]);

    // 2) 修改 findSession 返回的副本
    (afterSeed?.subject.roles as Role[]).push(Role.SuperAdmin);
    const afterMutate = await store.findSession('session-copy-1');
    expect(afterMutate?.subject.roles).toEqual([Role.Student]);
  });

  it('能力声明如实反映非持久化，且生产环境拒绝构造', () => {
    const store = new InMemorySessionStore(developmentEnv);

    expect(store.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    expect(() => new InMemorySessionStore(loadEnv({ NODE_ENV: 'production' }))).toThrow(
      /生产环境禁止使用内存/u,
    );
  });
});

describe('InMemorySessionStore：会话生命周期（创建 / 读取 / 撤销 / 过期清理）', () => {
  const input: CreateSessionInput = {
    subject: { userId: 'u-student-1', roles: [Role.Student] },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };

  it('创建：下发规范形态的票据，且存储里只按该票据可查', async () => {
    const store = new InMemorySessionStore(developmentEnv);
    const issued = await store.createSession(input);

    // 票据形态必须落在「换成 PostgreSQL 也立刻可用」的形态上（43 字符 base64url，
    // 且与落库形 sha256 摘要的 64 字符十六进制不重叠）
    expect(isSessionTicket(issued.ticket)).toBe(true);
    expect(issued.expiresAt).toBe(input.expiresAt);
    expect(issued.record.sessionId).toBe(sessionTicketDigest(issued.ticket));
    expect(issued.record.subject).toEqual(input.subject);

    await expect(store.findSession(issued.ticket)).resolves.toMatchObject({
      sessionId: sessionTicketDigest(issued.ticket),
    });
  });

  it('创建：主体深拷贝，调用方事后修改入参不影响存储内容', async () => {
    const store = new InMemorySessionStore(developmentEnv);
    const mutable: { userId: string; roles: Role[] } = {
      userId: 'u-mutable-1',
      roles: [Role.Student],
    };
    const issued = await store.createSession({ ...input, subject: mutable });

    mutable.roles.push(Role.SuperAdmin);
    const found = await store.findSession(issued.ticket);
    expect(found?.subject.roles).toEqual([Role.Student]);
  });

  it('撤销：幂等，撤销后立即读不到（第一次 true、第二次 false，均不抛错）', async () => {
    const store = new InMemorySessionStore(developmentEnv);
    const issued = await store.createSession(input);

    await expect(store.revokeSession(issued.ticket)).resolves.toBe(true);
    await expect(store.revokeSession(issued.ticket)).resolves.toBe(false);
    await expect(store.findSession(issued.ticket)).resolves.toBeUndefined();
    // 撤销不存在 / 形状非法的票据：同样是 false，不抛错也不触碰存储
    await expect(store.revokeSession('not-a-ticket')).resolves.toBe(false);
  });

  it('过期清理：只删已过期会话，返回删除条数，且不影响未过期会话', async () => {
    const store = new InMemorySessionStore(developmentEnv);
    const live = await store.createSession(input);
    const expired = await store.createSession({
      ...input,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    // 过期会话在读取路径上已经不可用
    await expect(store.findSession(expired.ticket)).resolves.toBeUndefined();
    // 未过期会话仍然可用
    await expect(store.findSession(live.ticket)).resolves.toBeDefined();

    await expect(store.purgeExpired()).resolves.toBe(1);
    await expect(store.purgeExpired()).resolves.toBe(0);
    await expect(store.findSession(live.ticket)).resolves.toBeDefined();
  });

  it('seed 的会话默认不设过期：过期清理不会误删测试夹具', async () => {
    const store = storeWith([studentSession]);

    await expect(store.purgeExpired()).resolves.toBe(0);
    await expect(store.findSession('session-student-1')).resolves.toBeDefined();
  });

  it('seed 显式给出过期时刻时，过期清理按该时刻判定', async () => {
    const store = new InMemorySessionStore(developmentEnv);
    const record: SessionRecord = {
      sessionId: 'session-expiring-1',
      subject: { userId: 'u-1', roles: [Role.Student] },
    };
    store.seed(record, { expiresAt: new Date(Date.now() - 1).toISOString() });

    await expect(store.findSession('session-expiring-1')).resolves.toBeUndefined();
    await expect(store.purgeExpired()).resolves.toBe(1);
  });

  it('非法过期时刻在创建期即被拒绝（不产生半可用会话）', async () => {
    const store = new InMemorySessionStore(developmentEnv);

    await expect(
      store.createSession({ ...input, expiresAt: 'not-a-timestamp' }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
