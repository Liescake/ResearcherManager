import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { Role } from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../config/env';
import { requireSubject } from './require-subject';
import {
  BearerSessionSubjectResolver,
  extractSessionId,
  normalizeSubject,
} from './session-subject.baseline';
import { InMemorySessionStore } from './session-store.in-memory';

/**
 * 认证边界回归：会话凭证 → **服务端主体**。
 *
 * 关键约束（与 `AuthorizationGuard` 的资源级判定互补）：
 * - 凭证只允许 `Bearer <sessionId>` 形态；其余一律解析失败（→ 401）；
 * - 主体只能来自服务端存储；客户端提供的任何角色/范围信息都不参与；
 * - 存储里出现未登记角色/非法 ID 时整个主体作废（fail-closed），不退化成「按已知角色继续」；
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
  it('解析成功：主体取自会话存储，而不是请求携带的任何其他信息', () => {
    const store = storeWith([studentSession]);
    const resolver = new BearerSessionSubjectResolver(store);

    expect(resolver.resolveSubject('Bearer session-student-1')).toEqual({
      userId: 'u-student-1',
      roles: [Role.Student],
    });
    // 能力声明透传会话后端
    expect(resolver.capabilities).toEqual(store.capabilities);
  });

  it('会话不存在/凭证非法一律 undefined（调用方转 401）', () => {
    const resolver = new BearerSessionSubjectResolver(storeWith([studentSession]));

    expect(resolver.resolveSubject('Bearer session-student-1')).toBeDefined();
    const rejected: Array<string | undefined> = [
      undefined,
      '',
      'Bearer',
      'Bearer session-other-1',
      'Token session-student-1',
      'Bearer session-student-1 extra',
    ];
    for (const header of rejected) {
      expect(resolver.resolveSubject(header)).toBeUndefined();
    }
  });

  it('会话存储里出现未登记角色：整个主体作废（401），不退化成已知角色', () => {
    const store = storeWith([
      { sessionId: 'session-unknown-role', subject: { userId: 'u-x', roles: ['guest' as Role] } },
    ]);
    const resolver = new BearerSessionSubjectResolver(store);

    expect(resolver.resolveSubject('Bearer session-unknown-role')).toBeUndefined();
  });

  it('默认装配（空存储）不提供任何隐式会话', () => {
    const resolver = new BearerSessionSubjectResolver(new InMemorySessionStore(developmentEnv));

    expect(resolver.resolveSubject('Bearer session-student-1')).toBeUndefined();
    expect(resolver.resolveSubject('Bearer admin')).toBeUndefined();
  });
});

describe('requireSubject：无会话即 401，且不区分失败原因', () => {
  it('解析成功时返回主体', () => {
    const resolver = new BearerSessionSubjectResolver(storeWith([studentSession]));

    expect(requireSubject(resolver, 'Bearer session-student-1')).toEqual({
      userId: 'u-student-1',
      roles: [Role.Student],
    });
  });

  it('解析失败时抛 401 UNAUTHENTICATED，文案不暴露具体原因', () => {
    const resolver = new BearerSessionSubjectResolver(storeWith([studentSession]));

    let thrown: unknown;
    try {
      requireSubject(resolver, undefined);
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
  it('seed 后可按会话 ID 取回；未 seed 的 ID 取不到', () => {
    const store = storeWith([studentSession]);

    expect(store.findSession('session-student-1')?.subject.userId).toBe('u-student-1');
    expect(store.findSession('session-student-2')).toBeUndefined();
  });

  it('对外只给副本：外部修改不会污染存储内的会话', () => {
    const subject: { userId: string; roles: Role[] } = { userId: 'u-1', roles: [Role.Student] };
    const store = new InMemorySessionStore(developmentEnv);
    store.seed({ sessionId: 'session-copy-1', subject });

    // 1) seed 之后修改传入对象
    subject.roles.push(Role.SuperAdmin);
    expect(store.findSession('session-copy-1')?.subject.roles).toEqual([Role.Student]);

    // 2) 修改 findSession 返回的副本
    const found = store.findSession('session-copy-1');
    (found?.subject.roles as Role[]).push(Role.SuperAdmin);
    expect(store.findSession('session-copy-1')?.subject.roles).toEqual([Role.Student]);
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
