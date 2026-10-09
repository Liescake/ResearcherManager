import { describe, expect, it } from 'vitest';
import { Role } from '@rm/shared';
import type {
  PersistenceCapabilities,
  SqlExecutor,
  SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import {
  assertPostgresSessionSqlHygiene,
  assertPostgresSessionStoreCapabilities,
  createLazyPostgresSessionStore,
  createPostgresSessionStore,
  digestSessionTicket,
  POSTGRES_SESSION_INSERT_SQL,
  POSTGRES_SESSION_PURGE_SQL,
  POSTGRES_SESSION_REVOKE_SQL,
  POSTGRES_SESSION_SELECT_SQL,
  POSTGRES_SESSION_STORE_CAPABILITIES,
  POSTGRES_SESSIONS_SELECTED_COLUMNS,
  PostgresSessionStore,
  PostgresSessionStoreError,
  sessionPlaceholderIndexes,
} from './session-store.postgres-repository';
import { generateSessionTicket, isSessionTicket, sessionTicketDigest } from './session-ticket';
import type { CreateSessionInput } from './session-subject.port';

/**
 * PostgreSQL 会话存储 adapter 的**离线**单测（不连数据库、不引入驱动）。
 *
 * 覆盖四类可机器判定的性质：
 * 1. **只存不可逆摘要**：创建与读取下发的参数里只有 `sha256(票据)`，原始票据不出现在 SQL、
 *    参数或错误信息里；
 * 2. **语句形态**：显式列投影（无 `*`）、逐位连续的 `$n` 参数位、无分号/注释/字面量；
 * 3. **行契约 fail-closed**：未知列、缺列、非法摘要、非法主体、空/超量角色、非对象范围一律拒绝，
 *    且错误信息只含字段路径（不含取值）；
 * 4. **故障与无效凭证可区分**：票据形状非法 → `undefined` / `false` 且**零 SQL**；
 *    执行器异常 → `EXECUTOR_FAILURE`（不含驱动原文）；写入行数不符 → `STORAGE_VIOLATION`。
 *
 * 真实建库、建表迁移与四个生命周期操作的真实验证在
 * `db/postgres/__tests__/postgres-integration.spec.ts`（需要 `TEST_DATABASE_URL`）。
 */

const CAPABILITIES: PersistenceCapabilities = {
  backend: 'postgres',
  persistent: true,
  productionReady: false,
};

interface QueryCall {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** 记录式执行器替身：不连库、不解析 SQL，只把调用与结果固定下来 */
function stubExecutor(
  responder: (sql: string, parameters: readonly unknown[]) => unknown = () => ({
    rows: [],
    rowCount: 0,
  }),
  capabilities: PersistenceCapabilities = CAPABILITIES,
): { readonly executor: SqlExecutor; readonly calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const executor = {
    capabilities,
    async query(sql: string, parameters: readonly unknown[] = []): Promise<SqlQueryResult> {
      calls.push({ sql, parameters });
      return responder(sql, parameters) as SqlQueryResult;
    },
  };
  return { executor: executor as unknown as SqlExecutor, calls };
}

/** 合法行：摘要与主体都落在存储契约内 */
function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: digestSessionTicket(generateSessionTicket()),
    user_id: 'u-student-1',
    roles: [Role.Student],
    scope: {},
    ...overrides,
  };
}

/** 捕获错误（含非 Error 抛出物），供逐条断言 code / issues */
function captureError(run: () => unknown): PostgresSessionStoreError {
  try {
    run();
  } catch (error) {
    if (error instanceof PostgresSessionStoreError) {
      return error;
    }
    throw error;
  }
  throw new Error('测试前置失败：期望抛出 PostgresSessionStoreError');
}

async function captureAsyncError(run: () => Promise<unknown>): Promise<PostgresSessionStoreError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PostgresSessionStoreError) {
      return error;
    }
    throw error;
  }
  throw new Error('测试前置失败：期望抛出 PostgresSessionStoreError');
}

const VALID_INPUT: CreateSessionInput = {
  subject: { userId: 'u-student-1', roles: [Role.Student] },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

describe('会话语句：形态与参数位（加载期断言 + 逐条复核）', () => {
  it('四条语句的占位符逐位连续且不重复', () => {
    expect(sessionPlaceholderIndexes(POSTGRES_SESSION_INSERT_SQL)).toEqual([1, 2, 3, 4, 5]);
    expect(sessionPlaceholderIndexes(POSTGRES_SESSION_SELECT_SQL)).toEqual([1]);
    expect(sessionPlaceholderIndexes(POSTGRES_SESSION_REVOKE_SQL)).toEqual([1]);
    expect(sessionPlaceholderIndexes(POSTGRES_SESSION_PURGE_SQL)).toEqual([]);
  });

  it('读取语句是显式列投影：无通配符，且过期/撤销只出现在谓词里', () => {
    expect(POSTGRES_SESSION_SELECT_SQL).not.toContain('*');
    expect(
      POSTGRES_SESSION_SELECT_SQL.startsWith(
        `SELECT ${POSTGRES_SESSIONS_SELECTED_COLUMNS.join(', ')} FROM sessions`,
      ),
    ).toBe(true);
    const projection = POSTGRES_SESSION_SELECT_SQL.slice(
      0,
      POSTGRES_SESSION_SELECT_SQL.indexOf(' FROM '),
    );
    expect(projection).not.toContain('expires_at');
    expect(projection).not.toContain('revoked_at');
    expect(POSTGRES_SESSION_SELECT_SQL).toContain('revoked_at IS NULL');
    expect(POSTGRES_SESSION_SELECT_SQL).toContain('expires_at > now()');
  });

  it('过期判定使用数据库时钟（now()），不接受调用方传入时刻', () => {
    expect(POSTGRES_SESSION_SELECT_SQL).toContain('now()');
    expect(POSTGRES_SESSION_REVOKE_SQL).toContain('now()');
    expect(POSTGRES_SESSION_PURGE_SQL).toContain('now()');
    expect(POSTGRES_SESSION_PURGE_SQL).not.toContain('$1');
  });

  it('语句卫生自检：拒绝分号 / 注释 / 字面量 / 通配符', () => {
    for (const sql of [
      POSTGRES_SESSION_INSERT_SQL,
      POSTGRES_SESSION_SELECT_SQL,
      POSTGRES_SESSION_REVOKE_SQL,
      POSTGRES_SESSION_PURGE_SQL,
    ]) {
      expect(() => assertPostgresSessionSqlHygiene(sql, 'ok')).not.toThrow();
    }
    expect(captureError(() => assertPostgresSessionSqlHygiene('SELECT *', 'x')).code).toBe(
      'SQL_VIOLATION',
    );
    expect(captureError(() => assertPostgresSessionSqlHygiene("SELECT 1 -- 'x'", 'x')).code).toBe(
      'SQL_VIOLATION',
    );
  });
});

describe('能力声明与自检', () => {
  it('声明固定为 postgres / persistent=true / productionReady=false', () => {
    expect(POSTGRES_SESSION_STORE_CAPABILITIES).toEqual({
      backend: 'postgres',
      persistent: true,
      productionReady: false,
    });
  });

  it('自检：真实声明放行，三类错误登记抛错', () => {
    expect(() => assertPostgresSessionStoreCapabilities()).not.toThrow();
    expect(() =>
      assertPostgresSessionStoreCapabilities({ ...CAPABILITIES, productionReady: true }),
    ).toThrow(/producible|生产可用|productionReady/u);
    expect(() =>
      assertPostgresSessionStoreCapabilities({ ...CAPABILITIES, persistent: false }),
    ).toThrow(PostgresSessionStoreError);
    expect(() =>
      assertPostgresSessionStoreCapabilities({ ...CAPABILITIES, backend: 'in-memory-baseline' }),
    ).toThrow(PostgresSessionStoreError);
  });

  it('构造期自检：非 postgres / 非持久 / 缺 query 的执行器一律拒绝', () => {
    const cases: readonly { readonly executor: unknown; readonly code: string }[] = [
      { executor: undefined, code: 'EXECUTOR_UNAVAILABLE' },
      { executor: { capabilities: CAPABILITIES }, code: 'EXECUTOR_UNAVAILABLE' },
      {
        executor: { query: async () => ({ rows: [], rowCount: 0 }) },
        code: 'EXECUTOR_UNAVAILABLE',
      },
      {
        executor: {
          query: async () => ({ rows: [], rowCount: 0 }),
          capabilities: { backend: 'sqlite', persistent: true, productionReady: false },
        },
        code: 'EXECUTOR_NOT_POSTGRES',
      },
      {
        executor: {
          query: async () => ({ rows: [], rowCount: 0 }),
          capabilities: { backend: 'postgres', persistent: false, productionReady: false },
        },
        code: 'EXECUTOR_NOT_PERSISTENT',
      },
    ];
    for (const { executor, code } of cases) {
      expect(captureError(() => new PostgresSessionStore(executor as SqlExecutor)).code).toBe(code);
    }
  });

  it('能力声明被改写：每次调用前重新自检，拒绝继续运行', async () => {
    const { executor } = stubExecutor();
    const store = new PostgresSessionStore(executor);
    (store as unknown as { capabilities: PersistenceCapabilities }).capabilities = {
      backend: 'postgres',
      persistent: true,
      productionReady: true,
    };

    const error = await captureAsyncError(() => store.findSession(generateSessionTicket()));
    expect(error.code).toBe('CAPABILITY_MISDECLARED');
  });
});

describe('findSession：只把摘要绑定进 SQL', () => {
  it('形状非法的票据：零 SQL、返回 undefined', async () => {
    const { executor, calls } = stubExecutor();
    const store = new PostgresSessionStore(executor);

    for (const ticket of ['', 'short', 'g'.repeat(64), 'A'.repeat(64), 'session-student-1']) {
      await expect(store.findSession(ticket)).resolves.toBeUndefined();
    }
    expect(calls).toEqual([]);
  });

  it('命中：下发的参数只有票据摘要，原始票据不出现在 SQL、参数与返回值里', async () => {
    const ticket = generateSessionTicket();
    const digest = sessionTicketDigest(ticket);
    const { executor, calls } = stubExecutor(() => ({
      rows: [
        sessionRow({ session_id: digest, roles: [Role.GroupLeader], scope: { groupIds: ['g-1'] } }),
      ],
      rowCount: 1,
    }));
    const store = new PostgresSessionStore(executor);

    const record = await store.findSession(ticket);

    expect(record).toEqual({
      sessionId: digest,
      subject: { userId: 'u-student-1', roles: [Role.GroupLeader], groupIds: ['g-1'] },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe(POSTGRES_SESSION_SELECT_SQL);
    expect(calls[0]?.parameters).toEqual([digest]);
    // 「只存/只用不可逆摘要」的硬断言：原始票据不得出现在任何被下发或被返回的内容里
    expect(digest).not.toBe(ticket);
    expect(JSON.stringify(calls[0])).not.toContain(ticket);
    expect(JSON.stringify(record)).not.toContain(ticket);
  });

  it('0 行 = 票据无效（合法的 undefined）；多行 = STORAGE_VIOLATION', async () => {
    const miss = stubExecutor(() => ({ rows: [], rowCount: 0 }));
    await expect(
      new PostgresSessionStore(miss.executor).findSession(generateSessionTicket()),
    ).resolves.toBeUndefined();

    const row = sessionRow();
    const duplicated = stubExecutor(() => ({ rows: [row, row], rowCount: 2 }));
    const error = await captureAsyncError(() =>
      new PostgresSessionStore(duplicated.executor).findSession(generateSessionTicket()),
    );
    expect(error.code).toBe('STORAGE_VIOLATION');
  });

  it('归属复核：返回行的摘要与请求不一致时拒绝（他人会话不得回流）', async () => {
    const { executor } = stubExecutor(() => ({ rows: [sessionRow()], rowCount: 1 }));
    const store = new PostgresSessionStore(executor);

    const error = await captureAsyncError(() => store.findSession(generateSessionTicket()));
    expect(error.code).toBe('STORAGE_VIOLATION');
    expect(error.issues).toEqual(['session_id']);
  });

  it('行契约 fail-closed：未知列 / 缺列 / 非法摘要 / 非法主体 / 空角色 / 非法角色 / 非对象范围 / 未知范围键', async () => {
    const ticket = generateSessionTicket();
    const digest = sessionTicketDigest(ticket);
    const base = sessionRow({ session_id: digest });
    const missingColumn: Record<string, unknown> = { ...base };
    delete missingColumn['roles'];

    const cases: readonly Record<string, unknown>[] = [
      { ...base, extra_column: 'x' },
      missingColumn,
      { ...base, session_id: 'not-a-digest' },
      { ...base, user_id: '' },
      { ...base, user_id: 'bad id' },
      { ...base, roles: [] },
      { ...base, roles: Array.from({ length: 17 }, () => Role.Student) },
      { ...base, roles: ['Guest'] },
      { ...base, roles: [Role.Student, 42] },
      { ...base, scope: 'not-an-object' },
      { ...base, scope: { unknownKey: ['g-1'] } },
      { ...base, scope: { groupIds: [''] } },
    ];

    for (const row of cases) {
      const { executor } = stubExecutor(() => ({ rows: [row], rowCount: 1 }));
      const error = await captureAsyncError(() =>
        new PostgresSessionStore(executor).findSession(ticket),
      );
      expect(error.code).toBe('INVALID_ROW');
      // 错误项只承载字段路径：不得把行取值带出去
      for (const issue of error.issues) {
        expect(issue).not.toContain('u-student-1');
        expect(issue).not.toContain(ticket);
      }
    }
  });

  it('执行器异常收敛为 EXECUTOR_FAILURE：不含驱动原文、cause 与 SQL', async () => {
    const driverText = 'password=sup3r-s3cret host=db.internal';
    const { executor } = stubExecutor(() => {
      throw new Error(driverText);
    });
    const store = new PostgresSessionStore(executor);

    const error = await captureAsyncError(() => store.findSession(generateSessionTicket()));
    expect(error.code).toBe('EXECUTOR_FAILURE');
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialized).not.toContain(driverText);
    expect(serialized).not.toContain('sup3r-s3cret');
    expect(serialized).not.toContain('db.internal');
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it('结果集形状非法（缺 rows）按 INVALID_ROW 拒绝，不静默当成「票据无效」', async () => {
    const { executor } = stubExecutor(() => ({}));
    const store = new PostgresSessionStore(executor);

    const error = await captureAsyncError(() => store.findSession(generateSessionTicket()));
    expect(error.code).toBe('INVALID_ROW');
  });
});

describe('createSession：只落摘要，主体与过期时刻先行校验', () => {
  it('写入参数是 [摘要, userId, roles, scope, expiresAt]，原始票据不出现在任何下发内容里', async () => {
    const { executor, calls } = stubExecutor(() => ({ rows: [], rowCount: 1 }));
    const store = new PostgresSessionStore(executor);

    const issued = await store.createSession({
      subject: {
        userId: 'u-leader-1',
        roles: [Role.GroupLeader],
        groupIds: ['g-1'],
        assignedResourceIds: ['u-assigned-1'],
      },
      expiresAt: VALID_INPUT.expiresAt,
    });

    expect(isSessionTicket(issued.ticket)).toBe(true);
    expect(issued.record.sessionId).toBe(sessionTicketDigest(issued.ticket));
    expect(issued.expiresAt).toBe(VALID_INPUT.expiresAt);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe(POSTGRES_SESSION_INSERT_SQL);
    expect(calls[0]?.parameters).toEqual([
      sessionTicketDigest(issued.ticket),
      'u-leader-1',
      [Role.GroupLeader],
      JSON.stringify({ groupIds: ['g-1'], assignedResourceIds: ['u-assigned-1'] }),
      VALID_INPUT.expiresAt,
    ]);
    expect(JSON.stringify(calls[0])).not.toContain(issued.ticket);
  });

  it('无范围主体写入空对象（不是 null，也不是缺列）', async () => {
    const { executor, calls } = stubExecutor(() => ({ rows: [], rowCount: 1 }));
    const store = new PostgresSessionStore(executor);

    await store.createSession(VALID_INPUT);
    expect(calls[0]?.parameters[3]).toBe('{}');
  });

  it('非法主体 / 非法过期时刻：INVALID_SUBJECT / INVALID_EXPIRY，且零 SQL', async () => {
    const cases: readonly { readonly input: CreateSessionInput; readonly code: string }[] = [
      {
        input: { ...VALID_INPUT, subject: { userId: '', roles: [Role.Student] } },
        code: 'INVALID_SUBJECT',
      },
      {
        input: { ...VALID_INPUT, subject: { userId: 'bad id', roles: [Role.Student] } },
        code: 'INVALID_SUBJECT',
      },
      { input: { ...VALID_INPUT, subject: { userId: 'u-1', roles: [] } }, code: 'INVALID_SUBJECT' },
      {
        input: { ...VALID_INPUT, subject: { userId: 'u-1', roles: ['Guest' as Role] } },
        code: 'INVALID_SUBJECT',
      },
      {
        input: {
          ...VALID_INPUT,
          subject: { userId: 'u-1', roles: [Role.Student], groupIds: [''] },
        },
        code: 'INVALID_SUBJECT',
      },
      {
        input: {
          ...VALID_INPUT,
          subject: { userId: 'u-1', roles: [Role.Student], groupIds: ['bad id'] },
        },
        code: 'INVALID_SUBJECT',
      },
      { input: { ...VALID_INPUT, expiresAt: 'not-a-timestamp' }, code: 'INVALID_EXPIRY' },
      {
        input: { ...VALID_INPUT, expiresAt: new Date(Date.now() - 1000).toISOString() },
        code: 'INVALID_EXPIRY',
      },
      {
        input: { ...VALID_INPUT, expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() },
        code: 'INVALID_EXPIRY',
      },
    ];

    for (const { input, code } of cases) {
      const { executor, calls } = stubExecutor(() => ({ rows: [], rowCount: 1 }));
      const error = await captureAsyncError(() =>
        new PostgresSessionStore(executor).createSession(input),
      );
      expect(error.code).toBe(code);
      expect(calls).toEqual([]);
      // 错误信息不回显取值（主体 ID 与过期时刻都不出现）
      const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(serialized).not.toContain('bad id');
      expect(serialized).not.toContain(input.expiresAt);
    }
  });

  it('rowCount 不等于 1：STORAGE_VIOLATION（绝不给客户端一张没落库的票据）', async () => {
    for (const rowCount of [0, 2]) {
      const { executor } = stubExecutor(() => ({ rows: [], rowCount }));
      const error = await captureAsyncError(() =>
        new PostgresSessionStore(executor).createSession(VALID_INPUT),
      );
      expect(error.code).toBe('STORAGE_VIOLATION');
    }
  });

  it('rowCount 缺失（驱动缺陷）：STORAGE_VIOLATION，不静默当成功', async () => {
    const { executor } = stubExecutor(() => ({ rows: [] }));
    const error = await captureAsyncError(() =>
      new PostgresSessionStore(executor).createSession(VALID_INPUT),
    );
    expect(error.code).toBe('STORAGE_VIOLATION');
  });
});

describe('revokeSession / purgeExpired', () => {
  it('撤销：形状非法的票据零 SQL、返回 false', async () => {
    const { executor, calls } = stubExecutor(() => ({ rows: [], rowCount: 1 }));
    const store = new PostgresSessionStore(executor);

    await expect(store.revokeSession('not-a-ticket')).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('撤销：rowCount 1 → true（幂等第二次为 0 → false），且只绑定摘要', async () => {
    let rowCount = 1;
    const { executor, calls } = stubExecutor(() => ({ rows: [], rowCount }));
    const store = new PostgresSessionStore(executor);
    const ticket = generateSessionTicket();

    await expect(store.revokeSession(ticket)).resolves.toBe(true);
    rowCount = 0;
    await expect(store.revokeSession(ticket)).resolves.toBe(false);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toBe(POSTGRES_SESSION_REVOKE_SQL);
    expect(calls[0]?.parameters).toEqual([sessionTicketDigest(ticket)]);
    expect(JSON.stringify(calls)).not.toContain(ticket);
  });

  it('撤销影响多行：STORAGE_VIOLATION（主键约束被破坏）', async () => {
    const { executor } = stubExecutor(() => ({ rows: [], rowCount: 2 }));
    const error = await captureAsyncError(() =>
      new PostgresSessionStore(executor).revokeSession(generateSessionTicket()),
    );
    expect(error.code).toBe('STORAGE_VIOLATION');
  });

  it('过期清理：下发无参数 DELETE，返回删除条数', async () => {
    const { executor, calls } = stubExecutor(() => ({ rows: [], rowCount: 3 }));
    const store = new PostgresSessionStore(executor);

    await expect(store.purgeExpired()).resolves.toBe(3);
    expect(calls).toEqual([{ sql: POSTGRES_SESSION_PURGE_SQL, parameters: [] }]);
  });
});

describe('createPostgresSessionStore / createLazyPostgresSessionStore', () => {
  it('工厂不再二次包装：交给端口的就是 adapter 实例', () => {
    const { executor } = stubExecutor();
    const store = createPostgresSessionStore(executor);
    expect(store).toBeInstanceOf(PostgresSessionStore);
    expect(store.capabilities).toEqual(CAPABILITIES);
  });

  it('延迟建连：形状非法 / 输入非法的调用**不会**触发任何连接', async () => {
    let connections = 0;
    const store = createLazyPostgresSessionStore(async () => {
      connections += 1;
      return stubExecutor().executor;
    });

    await expect(store.findSession('not-a-ticket')).resolves.toBeUndefined();
    await expect(store.revokeSession('not-a-ticket')).resolves.toBe(false);
    await expect(store.createSession({ ...VALID_INPUT, expiresAt: 'nope' })).rejects.toBeInstanceOf(
      PostgresSessionStoreError,
    );
    expect(connections).toBe(0);
  });

  it('延迟建连：首次真正读写才建连，且连接被复用', async () => {
    let connections = 0;
    const { executor, calls } = stubExecutor(() => ({ rows: [], rowCount: 0 }));
    const store = createLazyPostgresSessionStore(async () => {
      connections += 1;
      return executor;
    });

    await store.findSession(generateSessionTicket());
    await store.findSession(generateSessionTicket());
    await store.purgeExpired();

    expect(connections).toBe(1);
    expect(calls).toHaveLength(3);
  });

  it('延迟建连：连接失败不缓存失败结果（下一次调用会重试）', async () => {
    let attempt = 0;
    const { executor } = stubExecutor(() => ({ rows: [], rowCount: 0 }));
    const store = createLazyPostgresSessionStore(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new PostgresSessionStoreError('EXECUTOR_FAILURE', '合成连接失败');
      }
      return executor;
    });

    await expect(store.purgeExpired()).rejects.toBeInstanceOf(PostgresSessionStoreError);
    await expect(store.purgeExpired()).resolves.toBe(0);
    expect(attempt).toBe(2);
  });
});
