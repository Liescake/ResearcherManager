import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GroupStatus, Role } from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import { loadEnv } from '../../config/env';
import {
  DEFAULT_DEPENDENCY_READINESS_REGISTRY,
  evaluateDependencyStage,
} from '../../db/persistence/dependency-readiness';
import { evaluatePersistenceBoundary } from '../../db/persistence/production-guard';
import {
  createUnavailableSqlConnectionFactory,
  type SqlConnection,
  type SqlConnectionFactory,
  type SqlExecutor,
  type SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import { InMemoryGroupRepository } from './groups.in-memory-repository';
import { POSTGRES_GROUP_REPOSITORY_CAPABILITIES } from './groups.postgres-repository';
import {
  GROUP_REPOSITORY_BACKEND_POSTGRES,
  GROUP_REPOSITORY,
  type GroupListWindow,
  type GroupVisibilityQuery,
  type ResearchGroup,
} from './groups.port';
import { createGroupRepository } from './groups.module';

/**
 * 小组切片的**换绑分流点**（`createGroupRepository`）：把「科研小组的 PostgreSQL adapter 接入
 * 已配置数据库且执行器就绪的运行路径」这件事变成可机器判定的三条性质，而不是靠注释。
 *
 * 1. 未解析出 `DATABASE_URL` → 内存基线（开发/测试行为与切片之前一致，且如实声明非持久）；
 * 2. 已解析出 `DATABASE_URL` 但拿不到 `SQL_CONNECTION_FACTORY` → **抛错**（fail-closed：
 *    绝不悄悄退回内存小组存储）；
 * 3. 已解析出 `DATABASE_URL` 且拿到执行器工厂 → PostgreSQL adapter，且**延迟建连**：
 *    装配阶段一次都不碰数据库（否则「未 attest 的执行器」「依赖未就绪」就轮不到启动期门禁
 *    来给出结构化违规，而会在这里表现为一个数据库连接错误）。
 *
 * 另外固定三件事（小组切片特有的安全口径）：
 * - **生产环境（`NODE_ENV=production`）无数据库时**：配置解析先拒绝（不存在「生产用内存小组存储」
 *   的可用路径）；
 * - **存储 ID 域先判、再建连**：可见范围里的非 UUID 资源标识（会话基线的 `g-1`）与非 UUID 负责人
 *   都在解析执行器**之前**被拒绝，因此「范围外的小组」既不会进 SQL，也不会触发任何连接；
 * - **授权先于仓储访问**：service 是唯一取数入口，仓储的读写方法在授权拒绝时一次都不被调用
 *   （由 `groups.service.spec.ts` 直接回归；这里的端口语义用例固定「范围隔离」这一半）。
 */
const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';
const LEADER = '11111111-1111-4111-8111-111111111111';
const OTHER_LEADER = '22222222-2222-4222-8222-222222222222';
const GROUP_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_GROUP_ID = '44444444-4444-4444-8444-444444444444';
/** 会话基线形状的资源标识（「安全 ID」，但不是 UUID） */
const SESSION_STYLE_GROUP_ID = 'g-1';
/** 会话基线形状的主体（「安全 ID」，但不是 UUID） */
const SESSION_STYLE_SUBJECT = 'u-student-1';

const OPEN_QUERY: GroupVisibilityQuery = { includeAllOpenGroups: true, visibleGroupIds: [] };
const RESOURCE_QUERY: GroupVisibilityQuery = {
  includeAllOpenGroups: false,
  visibleGroupIds: [GROUP_ID],
};
const WINDOW: GroupListWindow = { offset: 0, limit: 20 };

function fixture(overrides: Partial<ResearchGroup> = {}): ResearchGroup {
  return {
    id: GROUP_ID,
    name: '智能机器人小组',
    description: '面向校内竞赛的机器人方向小组',
    researchDirections: ['机器人', '嵌入式'],
    recruitmentRequirements: { skills: ['C++'], headcount: 4 },
    leaderUserId: LEADER,
    status: GroupStatus.Open,
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    ...overrides,
  };
}

/** 只记录 connect 次数、不做任何真实连接的执行器工厂（延迟建连断言用） */
function countingFactory(): { factory: SqlConnectionFactory; connects: () => number } {
  let connects = 0;
  const connection: SqlConnection = {
    capabilities: { backend: 'postgres', persistent: true, productionReady: false },
    // 计数语句必须恰好返回一行（adapter 的 COUNT 契约），其余语句返回空结果集
    query: <Row = Record<string, unknown>>(sql: string): Promise<SqlQueryResult<Row>> =>
      Promise.resolve(
        (/COUNT\(\*\)/iu.test(sql)
          ? { rows: [{ total: '0' }], rowCount: 1 }
          : { rows: [], rowCount: 0 }) as unknown as SqlQueryResult<Row>,
      ),
    transaction: <Result>(run: (executor: SqlExecutor) => Promise<Result>): Promise<Result> =>
      run(connection),
    close: () => Promise.resolve(),
  };
  return {
    factory: {
      capabilities: { backend: 'postgres', persistent: true, productionReady: true },
      connect: () => {
        connects += 1;
        return Promise.resolve(connection);
      },
    },
    connects: () => connects,
  };
}

describe('小组仓储的持久化分流（createGroupRepository）', () => {
  it('未配置数据库：绑定内存基线，如实声明非持久 / 不可用于生产', async () => {
    const repository = createGroupRepository(loadEnv({ NODE_ENV: 'test' }), undefined);

    expect(repository).toBeInstanceOf(InMemoryGroupRepository);
    expect(repository.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });

    // 行为保持：开发/测试下仍可创建并按服务端判定产物取数
    const record = fixture();
    await repository.create(record);
    await expect(repository.listVisibleGroups(OPEN_QUERY, WINDOW)).resolves.toEqual([record]);
    await expect(repository.countVisibleGroups(OPEN_QUERY)).resolves.toBe(1);
  });

  it('配置了数据库但没有执行器工厂：抛错，绝不静默退回内存小组存储', () => {
    expect(() =>
      createGroupRepository(loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }), undefined),
    ).toThrow(/拒绝退回内存小组仓储/u);
  });

  it('配置了数据库且拿到执行器工厂：换绑到 PostgreSQL adapter，且构造时不建连', async () => {
    const { factory, connects } = countingFactory();
    const repository = createGroupRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      factory,
    );

    // 延迟建连：装配阶段一次都没有调用 connect（真正的准入判定属于启动期门禁）
    expect(connects()).toBe(0);
    expect(repository).not.toBeInstanceOf(InMemoryGroupRepository);
    expect(repository.capabilities).toEqual(POSTGRES_GROUP_REPOSITORY_CAPABILITIES);
    expect(repository.capabilities).toMatchObject({
      backend: GROUP_REPOSITORY_BACKEND_POSTGRES,
      persistent: true,
    });
    expect(repository.capabilities.productionReady).toBe(false);

    // 合法查询：这时才建连（一次），并且成功返回空列表
    await expect(repository.listVisibleGroups(OPEN_QUERY, WINDOW)).resolves.toEqual([]);
    expect(connects()).toBe(1);

    // 连接被复用：第二次取数不再建连
    await expect(repository.countVisibleGroups(OPEN_QUERY)).resolves.toBe(0);
    expect(connects()).toBe(1);
  });

  it('存储 ID 域先判、再建连：非 UUID 的可见资源标识在进入 SQL 之前就被拒绝', async () => {
    const { factory, connects } = countingFactory();
    const repository = createGroupRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      factory,
    );

    // 会话基线形状的资源标识（`g-1`）不是存储 ID 域内的标识：拒绝，且**不建连**。
    // 这正是「客户端/会话声明的 groupId 不得变成 SQL 里的范围」这条不变量在数据库路径上的落点。
    await expect(
      repository.listVisibleGroups(
        { includeAllOpenGroups: false, visibleGroupIds: [SESSION_STYLE_GROUP_ID] },
        WINDOW,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(
      repository.countVisibleGroups({
        includeAllOpenGroups: false,
        visibleGroupIds: [SESSION_STYLE_GROUP_ID],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(connects()).toBe(0);

    // 空 UUID 也是合法 UUID，因此它在**可见范围**里只是「匹配不到任何行」的标识
    // （存储层 CHECK 禁止空 UUID 主键，因此不可能被放大成任何真实小组）；
    // 但作为**负责人**它不是可用主体，必须在进入 SQL 之前被拒绝。
    const nilUuid = '00000000-0000-0000-0000-000000000000';
    await expect(repository.create(fixture({ leaderUserId: nilUuid }))).rejects.toMatchObject({
      code: 'INVALID_RECORD',
    });
    expect(connects()).toBe(0);

    // 非 UUID 负责人（会话基线的 `u-student-1`）同样在解析执行器之前被拒绝
    await expect(
      repository.create(fixture({ leaderUserId: SESSION_STYLE_SUBJECT })),
    ).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    expect(connects()).toBe(0);

    // 窗口形状也先判：非整数 / 负数窗口属于服务端缺陷，不得进入 SQL
    await expect(
      repository.listVisibleGroups(OPEN_QUERY, { offset: -1, limit: 20 }),
    ).rejects.toMatchObject({ code: 'INVALID_WINDOW' });
    await expect(
      repository.listVisibleGroups(OPEN_QUERY, { offset: 0, limit: 1.5 }),
    ).rejects.toMatchObject({ code: 'INVALID_WINDOW' });
    expect(connects()).toBe(0);

    // 合法请求才建连（证明上面的拒绝来自校验，而不是「谁都连不上」）
    await expect(repository.listVisibleGroups(OPEN_QUERY, WINDOW)).resolves.toEqual([]);
    expect(connects()).toBe(1);
  });

  it('执行器工厂是 fail-closed 的未验证驱动时：首次读写失败，错误文本不回显连接串', async () => {
    const repository = createGroupRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      createUnavailableSqlConnectionFactory('测试：未验证驱动'),
    );

    for (const run of [
      (): Promise<unknown> => repository.listVisibleGroups(OPEN_QUERY, WINDOW),
      (): Promise<unknown> => repository.countVisibleGroups(OPEN_QUERY),
    ]) {
      let captured: unknown;
      try {
        await run();
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(Error);
      const message = String((captured as Error).message);
      expect(message).not.toContain('://');
      expect(message).not.toContain('postgres');
      expect(message).not.toContain('password');
    }
  });

  it('生产环境且未配置数据库：配置解析先于任何绑定失败（不存在生产用内存小组存储）', () => {
    // 生产环境的 fail-closed 有两条，且**顺序固定**：先拒绝「没有数据库」，再轮到内存基线自检。
    // 因此这里断言的是配置层错误，而不是「先构造内存仓储再被它拒绝」。
    expect(() =>
      createGroupRepository(
        loadEnv({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) }),
        undefined,
      ),
    ).toThrow(/生产环境必须配置 DATABASE_URL/u);
  });

  it('生产配置了数据库但依赖不就绪：换绑到「持久但未验证」的 adapter，并由启动期门禁 fail-closed', async () => {
    // 生产只接受可校验身份的 TLS，因此「配置齐全」必须显式给出 verify-full 档位与证书路径
    const env = loadEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'x'.repeat(32),
      DATABASE_URL: 'postgresql://rm:secret@db.internal:5432/researcher_manager',
      DATABASE_SSL_MODE: 'verify-full',
      DATABASE_SSL_CA_PATH: '/etc/rm-tls/ca.pem',
    });

    // 1. 缺执行器工厂：工厂直接抛错（绝不悄悄退回内存）
    expect(() => createGroupRepository(env, undefined)).toThrow(/拒绝退回内存小组仓储/u);

    // 2. 有执行器工厂：绑定的是延迟建连的 PostgreSQL adapter，装配阶段不建连
    const { factory, connects } = countingFactory();
    const repository = createGroupRepository(env, factory);
    expect(repository.capabilities).toEqual(POSTGRES_GROUP_REPOSITORY_CAPABILITIES);
    expect(repository.capabilities.productionReady).toBe(false);
    expect(connects()).toBe(0);

    // 3. 该绑定在启动期被两道门禁拒绝（都在任何 connect 之前）：
    //    能力边界：自称「持久但未验证」不得进生产
    expect(
      evaluatePersistenceBoundary({
        nodeEnv: 'production',
        databaseConfigured: true,
        bindings: [
          {
            token: GROUP_REPOSITORY.description ?? 'GROUP_REPOSITORY',
            label: '小组仓储',
            capabilities: repository.capabilities,
          },
        ],
      }).violations.map((item) => item.rule),
    ).toEqual(['BACKEND_NOT_PRODUCTION_READY_IN_PRODUCTION']);

    //    依赖就绪门禁（业务阶段）：未持封存声明与已登记证据 ⇒ DEPENDENCY_NOT_VERIFIED
    //    （先于封存身份判定：未验证后端不得进入「是否封存」的比较）
    const readiness = evaluateDependencyStage({
      required: true,
      role: 'business',
      candidates: [
        {
          token: GROUP_REPOSITORY.description ?? 'GROUP_REPOSITORY',
          role: 'business',
          capabilities: repository.capabilities,
        },
      ],
      registry: DEFAULT_DEPENDENCY_READINESS_REGISTRY,
      now: '2026-10-10T00:00:00.000Z',
    });
    expect(readiness.state).toBe('rejected');
    expect(readiness.violations.map((item) => item.code)).toEqual(['DEPENDENCY_NOT_VERIFIED']);
    expect(readiness.violations[0]?.token).toBe('GROUP_REPOSITORY');
    expect(connects()).toBe(0);
  });
});

/**
 * 归属与范围隔离在**内存基线**上的回归（数据库实现由离线 adapter spec 与真库集成 spec 各自覆盖，
 * 两者必须同语义）。这一组用例固定的是 service 依赖的端口语义：归属由服务端写入且不可被他人取回、
 * 「范围外的小组」与「非开放小组」都不出库、列表与计数共用同一套可见性语义。
 */
describe('小组端口语义：归属与范围隔离（内存基线）', () => {
  async function seededRepository(): Promise<InMemoryGroupRepository> {
    const repository = new InMemoryGroupRepository(loadEnv({ NODE_ENV: 'test' }));
    await repository.create(fixture({ id: GROUP_ID, leaderUserId: LEADER, name: '本人负责小组' }));
    await repository.create(
      fixture({ id: OTHER_GROUP_ID, leaderUserId: OTHER_LEADER, name: '他人负责小组' }),
    );
    await repository.create(
      fixture({
        id: randomUUID(),
        leaderUserId: OTHER_LEADER,
        name: '已关闭小组',
        status: GroupStatus.Closed,
      }),
    );
    return repository;
  }

  it('范围隔离：资源级可见只出判定范围内的那一个小组（拿不到别人的小组）', async () => {
    const repository = await seededRepository();

    const visible = await repository.listVisibleGroups(RESOURCE_QUERY, WINDOW);
    expect(visible.map((item) => item.id)).toEqual([GROUP_ID]);
    expect(JSON.stringify(visible)).not.toContain('他人负责小组');
    await expect(repository.countVisibleGroups(RESOURCE_QUERY)).resolves.toBe(1);
  });

  it('非开放小组不出库，且列表与计数共用同一套可见性语义', async () => {
    const repository = await seededRepository();

    const all = await repository.listVisibleGroups(OPEN_QUERY, WINDOW);
    expect(all).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain('已关闭小组');
    // total（计数）必须与列表同语义：关闭的小组既不在 items 里，也不在 total 里
    await expect(repository.countVisibleGroups(OPEN_QUERY)).resolves.toBe(2);
  });

  it('空范围（includeAllOpenGroups=false 且 visibleGroupIds 为空）不会放大可见范围', async () => {
    const repository = await seededRepository();

    await expect(
      repository.listVisibleGroups({ includeAllOpenGroups: false, visibleGroupIds: [] }, WINDOW),
    ).resolves.toEqual([]);
    await expect(
      repository.countVisibleGroups({ includeAllOpenGroups: false, visibleGroupIds: [] }),
    ).resolves.toBe(0);
  });

  it('窗口只做切片，不扩大可见集合：offset 超界即空页，total 不受窗口影响', async () => {
    const repository = await seededRepository();

    await expect(
      repository.listVisibleGroups(OPEN_QUERY, { offset: 100, limit: 20 }),
    ).resolves.toEqual([]);
    await expect(repository.countVisibleGroups(OPEN_QUERY)).resolves.toBe(2);
  });

  it('主键冲突显式拒绝：同 ID 再写不静默覆盖，库里那一行逐字段不变', async () => {
    const repository = new InMemoryGroupRepository(loadEnv({ NODE_ENV: 'test' }));
    const original = fixture({ name: '原始小组名' });
    await repository.create(original);

    await expect(repository.create(fixture({ name: '被覆盖的小组名' }))).rejects.toThrow(
      /小组 ID 冲突/u,
    );

    const stored = await repository.listVisibleGroups(OPEN_QUERY, WINDOW);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('原始小组名');
  });

  it('仓储不把内部可变引用交给调用方：改动返回值不改写存储内容', async () => {
    const repository = new InMemoryGroupRepository(loadEnv({ NODE_ENV: 'test' }));
    await repository.create(fixture());

    const [first] = await repository.listVisibleGroups(OPEN_QUERY, WINDOW);
    expect(first).toBeDefined();
    const mutable = first as unknown as { name: string; researchDirections: string[] };
    mutable.name = '被外部改写';
    mutable.researchDirections.push('被外部追加');

    const [second] = await repository.listVisibleGroups(OPEN_QUERY, WINDOW);
    expect(second?.name).toBe('智能机器人小组');
    expect(second?.researchDirections).toEqual(['机器人', '嵌入式']);
  });
});

describe('小组令牌与装配常量', () => {
  it('DI 令牌描述名保持不变（登记表与装配按名字比对）', () => {
    expect(GROUP_REPOSITORY.description).toBe('GROUP_REPOSITORY');
  });

  it('PostgreSQL adapter 的能力声明如实反映「持久但未验证」', () => {
    expect(POSTGRES_GROUP_REPOSITORY_CAPABILITIES).toEqual({
      backend: 'postgres',
      persistent: true,
      productionReady: false,
    });
    expect(Object.isFrozen(POSTGRES_GROUP_REPOSITORY_CAPABILITIES)).toBe(true);
  });

  it('分流点不读环境变量以外的配置来源：同一个 env 只产生一种绑定（重复调用稳定）', () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    const first = createGroupRepository(env, undefined);
    const second = createGroupRepository(env, undefined);
    expect(first).toBeInstanceOf(InMemoryGroupRepository);
    expect(second).toBeInstanceOf(InMemoryGroupRepository);
    expect(first).not.toBe(second);
  });

  it('会话基线形状的主体不参与数据库绑定判定（绑定只按 DATABASE_URL 分流）', () => {
    const subject: AuthorizationSubject = {
      userId: SESSION_STYLE_SUBJECT,
      roles: [Role.Student],
    };
    // 主体形状只影响 adapter 的存储 ID 域判定，不影响「绑定到哪个实现」
    expect(createGroupRepository(loadEnv({ NODE_ENV: 'test' }), undefined)).toBeInstanceOf(
      InMemoryGroupRepository,
    );
    expect(subject.userId).not.toBe(LEADER);
  });
});
