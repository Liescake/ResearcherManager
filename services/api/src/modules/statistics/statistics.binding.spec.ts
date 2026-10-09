import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../config/env';
import { createUnavailableSqlConnectionFactory } from '../../db/ports/sql-executor.port';
import type { SqlConnectionFactory, SqlExecutor } from '../../db/ports/sql-executor.port';
import { createSelfStatisticsRepository } from './statistics.module';
import { InMemorySelfStatisticsRepository } from './statistics.in-memory-repository';
import { PostgresStatisticsRepository } from './statistics.postgres-repository';
import {
  ACHIEVEMENT_STATISTICS_REPOSITORY,
  APPLICATION_STATISTICS_REPOSITORY,
  EDUCATION_STATISTICS_REPOSITORY,
  MATCHING_STATISTICS_REPOSITORY,
} from './statistics.port';

/**
 * 统计切片的**换绑分流点**：这是本阶段唯一被绑定的业务持久化切片，因此它的分流规则必须
 * 可机器判定，而不是靠注释。
 *
 * 三条硬性质：
 * 1. 未配置数据库 → 内存聚合基线（默认全零，行为与切片之前一致）；
 * 2. 配置了数据库但拿不到执行器工厂 → **抛错**（拒绝静默退回内存）；
 * 3. 配置了数据库且拿到执行器工厂 → PostgreSQL 聚合读 adapter，且**延迟建连**：
 *    构造时不碰数据库（否则「未 attest 的执行器」就轮不到启动期持久化边界来拒绝了）。
 */
const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';

const OWNER = '11111111-1111-1111-1111-111111111111';

function fakeSources() {
  return {
    education: {
      capabilities: {
        backend: 'in-memory-baseline',
        source: 'education',
        persistent: false,
        productionReady: false,
      },
      countByUserId: () => 1,
    },
    applications: {
      capabilities: {
        backend: 'in-memory-baseline',
        source: 'applications',
        persistent: false,
        productionReady: false,
      },
      countByUserId: () => 2,
    },
    achievements: {
      capabilities: {
        backend: 'in-memory-baseline',
        source: 'achievements',
        persistent: false,
        productionReady: false,
      },
      countByUserId: () => 3,
    },
    matching: {
      capabilities: {
        backend: 'in-memory-baseline',
        source: 'matching',
        persistent: false,
        productionReady: false,
      },
      countByUserId: () => 4,
    },
  } as unknown as Parameters<typeof createSelfStatisticsRepository>[2];
}

describe('本人统计的持久化分流', () => {
  it('未配置数据库：内存聚合基线（如实声明非持久 / 不可用于生产）且一次读出四个计数', async () => {
    const repository = createSelfStatisticsRepository(
      loadEnv({ NODE_ENV: 'test' }),
      undefined,
      fakeSources(),
    );
    expect(repository).toBeInstanceOf(InMemorySelfStatisticsRepository);
    expect(repository.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    await expect(repository.readCountsByUserId('u-student-1')).resolves.toEqual({
      educationRecords: 1,
      applications: 2,
      achievements: 3,
      matchingRequests: 4,
    });
  });

  it('配置了数据库但没有执行器工厂：抛错，绝不静默退回内存实现', () => {
    expect(() =>
      createSelfStatisticsRepository(
        loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
        undefined,
        fakeSources(),
      ),
    ).toThrow(/拒绝退回内存统计实现/u);
  });

  it('配置了数据库且拿到执行器工厂：换绑到 PostgreSQL 聚合读 adapter，且构造时不建连', async () => {
    const connect = vi.fn();
    const sqlConnectionFactory: SqlConnectionFactory = {
      capabilities: { backend: 'postgres', persistent: true, productionReady: true },
      connect: connect as unknown as SqlConnectionFactory['connect'],
    };

    const repository = createSelfStatisticsRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      sqlConnectionFactory,
      fakeSources(),
    );

    // 延迟建连：装配阶段一次都没有调用 connect
    expect(connect).not.toHaveBeenCalled();
    expect(repository.capabilities).toMatchObject({ backend: 'postgres', persistent: true });

    // 非存储 ID 域的主体在进入 SQL 之前就被拒绝 —— 仍然不会调用 connect
    await expect(repository.readCountsByUserId('u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('执行器工厂是 fail-closed 的未验证驱动时：首次读数失败，错误文本不回显连接串', async () => {
    const factory = createUnavailableSqlConnectionFactory('测试：未验证驱动');
    const repository = createSelfStatisticsRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      factory,
      fakeSources(),
    );

    let captured: unknown;
    try {
      await repository.readCountsByUserId(OWNER);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(String((captured as Error).message)).not.toContain('://');
    expect(String((captured as Error).message)).not.toContain('postgres');
  });

  it('PostgreSQL 聚合读 adapter 实现的是聚合端口（同一次调用读出四类计数）', () => {
    const executor: SqlExecutor = {
      capabilities: { backend: 'postgres', persistent: true, productionReady: false },
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    };
    const adapter = new PostgresStatisticsRepository(executor);
    expect(typeof adapter.readCountsByUserId).toBe('function');
    expect(adapter.readCountsByUserId.length).toBe(1);
  });
});

/** 令牌稳定性：换绑点只认这四个来源令牌 + 聚合令牌，避免改名后登记表与实际装配漂移 */
describe('统计令牌常量', () => {
  it('四个来源令牌描述名与端口常量一致', () => {
    expect(
      [
        EDUCATION_STATISTICS_REPOSITORY,
        APPLICATION_STATISTICS_REPOSITORY,
        ACHIEVEMENT_STATISTICS_REPOSITORY,
        MATCHING_STATISTICS_REPOSITORY,
      ].map((token) => token.description),
    ).toEqual([
      'EDUCATION_STATISTICS_REPOSITORY',
      'APPLICATION_STATISTICS_REPOSITORY',
      'ACHIEVEMENT_STATISTICS_REPOSITORY',
      'MATCHING_STATISTICS_REPOSITORY',
    ]);
  });
});
