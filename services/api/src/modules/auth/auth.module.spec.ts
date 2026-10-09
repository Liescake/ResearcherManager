import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../config/env';
import { DatabaseConfigError } from '../../db/config/database-config';
import type {
  SqlConnection,
  SqlConnectionFactory,
  SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import { createSessionStore } from './auth.module';
import { InMemorySessionStore } from './session-store.in-memory';
import { POSTGRES_SESSION_STORE_CAPABILITIES } from './session-store.postgres-repository';
import { generateSessionTicket } from './session-ticket';

/**
 * 会话存储的**绑定分流**单测（`auth.module.ts` 的 `createSessionStore`）。
 *
 * 三条口径必须被钉住，因为它们是「无数据库的开发/测试行为不变」与「配了数据库就绝不悄悄退回
 * 内存存储」这两条要求的唯一接线点：
 * 1. 未解析出 `DATABASE_URL` → 内存基线（且未 seed 时解析不到任何主体）；
 * 2. 已解析出 `DATABASE_URL` → PostgreSQL 实现（延迟建连：**装配阶段零连接**）；
 * 3. 已解析出 `DATABASE_URL` 但没有执行器工厂 → 直接抛错（fail-closed，不退化成内存存储）。
 *
 * 生产环境缺少 `DATABASE_URL` 的 fail-closed 由 `resolveAppDatabaseConfig` 承担（同一份口径），
 * 这里只固定「它确实在构造会话存储时被调用」。
 */

const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager_test';

/** 记录式连接工厂：只统计 connect 次数，返回一个可查询的替身连接 */
function stubFactory(): {
  readonly factory: SqlConnectionFactory;
  readonly connects: () => number;
} {
  let connects = 0;
  const capabilities = {
    backend: 'postgres',
    persistent: true,
    productionReady: false,
  } as const;
  const connection: SqlConnection = {
    capabilities,
    async query<Row = Record<string, unknown>>(): Promise<SqlQueryResult<Row>> {
      return { rows: [], rowCount: 0 };
    },
    async transaction<Result>(run: (executor: SqlConnection) => Promise<Result>): Promise<Result> {
      return run(connection);
    },
    async close(): Promise<void> {
      return undefined;
    },
  };
  return {
    factory: {
      capabilities,
      connect(): Promise<SqlConnection> {
        connects += 1;
        return Promise.resolve(connection);
      },
    },
    connects: () => connects,
  };
}

describe('createSessionStore：按是否配置数据库分流', () => {
  it('未配置数据库：内存基线（如实声明非持久，未 seed 时解析不到主体）', async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    const store = createSessionStore(env, undefined);

    expect(store).toBeInstanceOf(InMemorySessionStore);
    expect(store.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    await expect(store.findSession('session-student-1')).resolves.toBeUndefined();
  });

  it('已配置数据库：换绑到 PostgreSQL 实现，且装配阶段不建立任何连接', async () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL });
    const { factory, connects } = stubFactory();

    const store = createSessionStore(env, factory);

    expect(store).not.toBeInstanceOf(InMemorySessionStore);
    expect(store.capabilities).toEqual(POSTGRES_SESSION_STORE_CAPABILITIES);
    // 延迟建连：构造期没有任何 connect
    expect(connects()).toBe(0);
  });

  it('已配置数据库：首次读取才建连（形状非法的票据不触发连接）', async () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL });
    const { factory, connects } = stubFactory();
    const store = createSessionStore(env, factory);

    await expect(store.findSession('not-a-ticket')).resolves.toBeUndefined();
    expect(connects()).toBe(0);

    // 规范票据才会走到连接（替身返回 0 行 ⇒ 票据无效，但连接确实建立了）
    await expect(store.findSession(generateSessionTicket())).resolves.toBeUndefined();
    expect(connects()).toBe(1);
  });

  it('已配置数据库但没有执行器工厂：直接抛错（fail-closed，不退回内存存储）', () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL });

    expect(() => createSessionStore(env, undefined)).toThrow(
      /数据库已配置但未提供 SQL_CONNECTION_FACTORY/u,
    );
  });

  it('生产环境缺少 DATABASE_URL：配置解析 fail-closed（在会话存储构造期即失败）', () => {
    const env = loadEnv({ NODE_ENV: 'production' });

    let captured: unknown;
    try {
      createSessionStore(env, stubFactory().factory);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(DatabaseConfigError);
    expect((captured as DatabaseConfigError).code).toBe('DATABASE_URL_REQUIRED_IN_PRODUCTION');
  });

  it('生产环境已配置数据库：换绑到 PostgreSQL 实现（生产可用性由启动期门禁判定）', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://rm:pw@db.example.com:5432/researcher_manager',
      DATABASE_SSL_MODE: 'verify-full',
    });

    const store = createSessionStore(env, stubFactory().factory);
    expect(store.capabilities).toEqual(POSTGRES_SESSION_STORE_CAPABILITIES);
  });
});
