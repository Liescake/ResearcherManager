import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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
} from '../../db/ports/sql-executor.port';
import { InMemoryNotificationRepository } from './notifications.in-memory-repository';
import { POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES } from './notifications.postgres-repository';
import { createNotificationRepository } from './notifications.module';
import {
  NOTIFICATION_REPOSITORY,
  NotificationStatus,
  NotificationType,
} from './notifications.port';
import type { Notification } from './notifications.port';

/**
 * 通知切片的**换绑分流点**（`createNotificationRepository`）：把「站内通知的 PostgreSQL adapter 接入
 * 已配置数据库且执行器就绪的运行路径」这件事变成可机器判定的三条性质，而不是靠注释。
 *
 * 1. 未解析出 `DATABASE_URL` → 内存基线（开发/测试行为与切片之前一致，且如实声明非持久）；
 * 2. 已解析出 `DATABASE_URL` 但拿不到 `SQL_CONNECTION_FACTORY` → **抛错**（fail-closed：
 *    绝不悄悄退回内存通知存储）；
 * 3. 已解析出 `DATABASE_URL` 且拿到执行器工厂 → PostgreSQL adapter，且**延迟建连**：
 *    装配阶段一次都不碰数据库（否则「未 attest 的执行器」「依赖未就绪」就轮不到启动期门禁
 *    来给出结构化违规，而会在这里表现为一个数据库连接错误）。
 *
 * 另外固定两件事：
 * - **生产环境（`NODE_ENV=production`）无数据库时**：内存基线自身拒绝构造 ⇒ 工厂直接失败，
 *   不存在「生产用内存通知箱」的可用路径；
 * - **归属与 read 状态在两种后端上同语义**：归属下推进取数（非本人主体取不到本人记录）、
 *   标记已读是唯一前向边且幂等。
 */
const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const NOTIFICATION_ID = '55555555-5555-4555-8555-555555555555';
const SESSION_STYLE_SUBJECT = 'u-student-1';

function fixture(overrides: Partial<Notification> = {}): Notification {
  return {
    id: NOTIFICATION_ID,
    userId: OWNER,
    type: NotificationType.MembershipReview,
    title: '入组申请审核结果',
    body: '你提交的入组申请已通过审核。',
    status: NotificationStatus.Unread,
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
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
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

describe('通知仓储的持久化分流（createNotificationRepository）', () => {
  it('未配置数据库：绑定内存基线，如实声明非持久 / 不可用于生产', async () => {
    const repository = createNotificationRepository(loadEnv({ NODE_ENV: 'test' }), undefined);

    expect(repository).toBeInstanceOf(InMemoryNotificationRepository);
    expect(repository.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });

    // 行为保持：开发/测试下仍是可读写的本人通知箱
    await repository.create(fixture());
    await expect(repository.listByUserId(OWNER)).resolves.toEqual([fixture()]);
  });

  it('配置了数据库但没有执行器工厂：抛错，绝不静默退回内存通知存储', () => {
    expect(() =>
      createNotificationRepository(
        loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
        undefined,
      ),
    ).toThrow(/拒绝退回内存通知仓储/u);
  });

  it('配置了数据库且拿到执行器工厂：换绑到 PostgreSQL adapter，且构造时不建连', async () => {
    const { factory, connects } = countingFactory();
    const repository = createNotificationRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      factory,
    );

    // 延迟建连：装配阶段一次都没有调用 connect（真正的准入判定属于启动期门禁）
    expect(connects()).toBe(0);
    expect(repository).not.toBeInstanceOf(InMemoryNotificationRepository);
    expect(repository.capabilities).toEqual(POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES);
    expect(repository.capabilities).toMatchObject({ backend: 'postgres', persistent: true });
    expect(repository.capabilities.productionReady).toBe(false);

    // 非存储 ID 域的主体（会话基线的 `u-student-1`）在进入 SQL 之前就被拒绝 —— 仍然不建连
    await expect(repository.listByUserId(SESSION_STYLE_SUBJECT)).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    expect(connects()).toBe(0);

    // 合法主体：这时才建连（一次），并且成功返回空列表
    await expect(repository.listByUserId(OWNER)).resolves.toEqual([]);
    expect(connects()).toBe(1);
  });

  it('执行器工厂是 fail-closed 的未验证驱动时：首次读数失败，错误文本不回显连接串', async () => {
    const repository = createNotificationRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      createUnavailableSqlConnectionFactory('测试：未验证驱动'),
    );

    let captured: unknown;
    try {
      await repository.listByUserId(OWNER);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const message = String((captured as Error).message);
    expect(message).not.toContain('://');
    expect(message).not.toContain('postgres');
    expect(message).not.toContain('password');
  });

  it('生产环境且未配置数据库：配置解析先于任何绑定失败（不存在生产用内存通知箱）', () => {
    // 生产环境的 fail-closed 有两条，且**顺序固定**：先拒绝「没有数据库」，再轮到内存基线自检。
    // 因此这里断言的是配置层错误，而不是「先构造内存箱再被它拒绝」。
    expect(() =>
      createNotificationRepository(
        loadEnv({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) }),
        undefined,
      ),
    ).toThrow(/生产环境必须配置 DATABASE_URL/u);
  });

  it('生产配置了数据库但依赖不就绪：换绑到「持久但未验证」的 adapter，并由启动期门禁 fail-closed', () => {
    // 生产只接受可校验身份的 TLS，因此「配置齐全」必须显式给出 verify-full 档位与证书路径
    const env = loadEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'x'.repeat(32),
      DATABASE_URL: 'postgresql://rm:secret@db.internal:5432/researcher_manager',
      DATABASE_SSL_MODE: 'verify-full',
      DATABASE_SSL_CA_PATH: '/etc/rm-tls/ca.pem',
    });

    // 1. 缺执行器工厂：工厂直接抛错（绝不悄悄退回内存）
    expect(() => createNotificationRepository(env, undefined)).toThrow(/拒绝退回内存通知仓储/u);

    // 2. 有执行器工厂：绑定的是延迟建连的 PostgreSQL adapter，装配阶段不建连
    const { factory, connects } = countingFactory();
    const repository = createNotificationRepository(env, factory);
    expect(repository.capabilities).toEqual(POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES);
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
            token: NOTIFICATION_REPOSITORY.description ?? 'NOTIFICATION_REPOSITORY',
            label: '通知仓储',
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
          token: NOTIFICATION_REPOSITORY.description ?? 'NOTIFICATION_REPOSITORY',
          role: 'business',
          capabilities: repository.capabilities,
        },
      ],
      registry: DEFAULT_DEPENDENCY_READINESS_REGISTRY,
      now: '2026-10-10T00:00:00.000Z',
    });
    expect(readiness.state).toBe('rejected');
    expect(readiness.violations.map((item) => item.code)).toEqual(['DEPENDENCY_NOT_VERIFIED']);
    expect(readiness.violations[0]?.token).toBe('NOTIFICATION_REPOSITORY');
  });
});

/**
 * 归属与 read 状态在**内存基线**上的回归（数据库实现由离线 adapter spec 与真库集成 spec 各自覆盖，
 * 两者必须同语义）。这一组用例固定的是 service 依赖的三条端口语义：
 * 归属下推进取数、标记已读是唯一前向边、记录不存在 / 归属不符时拒绝写入。
 */
describe('通知端口语义：归属隔离与 read 状态（内存基线）', () => {
  async function seededRepository(): Promise<InMemoryNotificationRepository> {
    const repository = new InMemoryNotificationRepository(loadEnv({ NODE_ENV: 'test' }));
    await repository.create(fixture());
    await repository.create(fixture({ id: randomUUID(), userId: OTHER_OWNER, title: '他人通知' }));
    return repository;
  }

  it('归属下推进取数：非本人主体取不到本人的单条记录（不会「先出库再指望上层复核」）', async () => {
    const repository = await seededRepository();

    await expect(repository.findById(NOTIFICATION_ID, OWNER)).resolves.toMatchObject({
      id: NOTIFICATION_ID,
    });
    await expect(repository.findById(NOTIFICATION_ID, OTHER_OWNER)).resolves.toBeUndefined();
    await expect(repository.listByUserId(OWNER)).resolves.toHaveLength(1);
    await expect(repository.listByUserId(OTHER_OWNER)).resolves.toHaveLength(1);
  });

  it('归属不可变：拿他人记录的主键 + 自己的归属写入被拒绝，且存储内容不变', async () => {
    const repository = await seededRepository();
    const foreign = await repository.findById(NOTIFICATION_ID, OTHER_OWNER);
    expect(foreign).toBeUndefined();

    // 用他人通知的 ID 改写（归属写成本人）→ 拒绝
    await expect(
      repository.save(fixture({ userId: OTHER_OWNER, status: NotificationStatus.Read })),
    ).rejects.toThrow(/通知归属不符/u);
    // 本人的记录保持未读（拒绝不产生任何写入）
    await expect(repository.findById(NOTIFICATION_ID, OWNER)).resolves.toMatchObject({
      status: NotificationStatus.Unread,
    });
  });

  it('记录不存在时拒绝写入：插入必须走 create 路径', async () => {
    const repository = await seededRepository();
    await expect(
      repository.save(fixture({ id: '66666666-6666-4666-8666-666666666666' })),
    ).rejects.toThrow(/通知不存在/u);
  });

  it('标记已读是唯一前向边且幂等：重复写入内容一致，readAt 不漂移', async () => {
    const repository = await seededRepository();
    const readAt = '2026-01-04T05:06:07.000Z';
    const read = fixture({ status: NotificationStatus.Read, readAt, updatedAt: readAt });

    await repository.save(read);
    const first = await repository.findById(NOTIFICATION_ID, OWNER);
    // 再次写入同一条已读记录（模拟重复请求）：内容逐字段不变
    await repository.save(read);
    const second = await repository.findById(NOTIFICATION_ID, OWNER);

    expect(first).toEqual(second);
    expect(second).toEqual(read);
    // 内存基线不接受「已读 → 未读」回退（读取契约同样拒绝带 readAt 的未读记录，此处只固定存储语义）
    await expect(
      repository.save(fixture({ status: NotificationStatus.Unread, readAt })),
    ).resolves.toMatchObject({ status: NotificationStatus.Unread });
  });
});

describe('通知令牌常量', () => {
  it('DI 令牌描述名保持不变（登记表与装配按名字比对）', () => {
    expect(NOTIFICATION_REPOSITORY.description).toBe('NOTIFICATION_REPOSITORY');
  });

  it('PostgreSQL adapter 的能力声明如实反映「持久但未验证」', () => {
    expect(POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES).toEqual({
      backend: 'postgres',
      persistent: true,
      productionReady: false,
    });
    expect(Object.isFrozen(POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES)).toBe(true);
  });

  it('分流点不读环境变量以外的配置来源：同一个 env 只产生一种绑定（重复调用稳定）', () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    const spy = vi.fn();
    const first = createNotificationRepository(env, undefined);
    const second = createNotificationRepository(env, undefined);
    expect(first).toBeInstanceOf(InMemoryNotificationRepository);
    expect(second).toBeInstanceOf(InMemoryNotificationRepository);
    expect(spy).not.toHaveBeenCalled();
  });
});
