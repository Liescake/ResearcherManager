import { describe, expect, it, vi } from 'vitest';
import { ApplicationStatus, ApplicationKind } from '@rm/shared';
import { loadEnv } from '../../config/env';
import { bindingTokenName, PERSISTENCE_BINDINGS } from '../../db/persistence-bindings';
import {
  createUnavailableSqlConnectionFactory,
  type SqlConnectionFactory,
  type SqlExecutor,
} from '../../db/ports/sql-executor.port';
import { InMemoryApplicationReviewRepository } from './application-reviews.in-memory-repository';
import {
  POSTGRES_APPLICATION_REVIEW_REPOSITORY_CAPABILITIES,
  PostgresApplicationRepositoryError,
} from './applications.postgres-repository';
import {
  APPLICATION_REVIEW_REPOSITORY,
  ApplicationReviewConflictError,
} from './application-reviews.port';
import { APPLICATION_REPOSITORY } from './applications.port';
import type { Application } from './applications.port';
import { createApplicationReviewRepository } from './memberships.module';

/**
 * 审核端切片的**换绑分流点**回归（与其它切片同构，但断言审核端独有的两条性质）。
 *
 * 六条硬性质：
 * 1. 未配置数据库 → 内存基线（如实声明 `persistent=false`），且三个方法的范围语义与 PostgreSQL
 *    实现一致（范围外记录既不出库也不可写、空范围 fail-closed、非法转移不写入）；
 * 2. 配置了数据库但没有执行器工厂 → **抛错**，绝不静默退回内存审核存储；
 * 3. 配置了数据库且拿到执行器工厂 → PostgreSQL adapter，且**装配阶段一次都不建连**；
 * 4. 存储 ID 域与空范围在**进入 SQL 之前**判定（非 UUID 的范围/主体不触发任何连接）；
 * 5. **范围隔离在换绑后仍然成立**：`scope` 下推进 SQL（`group_id = ANY($n::uuid[])`），
 *    且范围取值不进入 SQL 文本；
 * 6. 端口在 `PERSISTENCE_BINDINGS` **已登记**且与申请人端令牌**不同** —— 否则生产门禁会
 *    「因为申请人端已换绑」而默认审核端也持久，这正是内存替身悄悄上生产的路径。
 *
 * 全部断言走运行时路径（`createApplicationReviewRepository` 与端口实现本身），不 mock 生产内部结构。
 */

const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';

const GROUP_A = '11111111-1111-4111-8111-111111111111';
const GROUP_B = '22222222-2222-4222-8222-222222222222';
const APPLICANT = '44444444-4444-4444-8444-444444444444';
const REVIEWER = '55555555-5555-4555-8555-555555555555';
const APPLICATION_ID = '66666666-6666-4666-8666-666666666666';
const NOW = '2026-05-01T00:00:00.000Z';

interface RecordedCall {
  readonly sql: string;
  readonly parameters: readonly unknown[] | undefined;
}

class RecordingExecutor implements SqlExecutor {
  readonly capabilities = {
    backend: 'postgres-test-double',
    persistent: true,
    productionReady: false,
  } as const;

  readonly calls: RecordedCall[] = [];
  private readonly responses: unknown[];

  constructor(responses: unknown[] = []) {
    this.responses = [...responses];
  }

  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ sql, parameters });
    const next = (this.responses.shift() ?? { rows: [], rowCount: 0 }) as {
      rows: Row[];
      rowCount: number;
    };
    return Promise.resolve(next);
  }
}

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: APPLICATION_ID,
    userId: APPLICANT,
    groupId: GROUP_A,
    kind: ApplicationKind.Join,
    status: ApplicationStatus.Pending,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function reviewedApplication(): Application {
  return application({
    status: ApplicationStatus.Approved,
    reviewedByUserId: REVIEWER,
    reviewedAt: NOW,
  });
}

function databaseRow(record: Application): Record<string, unknown> {
  return {
    id: record.id,
    user_id: record.userId,
    group_id: record.groupId,
    kind: record.kind,
    note: record.note ?? null,
    status: record.status,
    reviewed_by_user_id: record.reviewedByUserId ?? null,
    review_comment: record.reviewComment ?? null,
    reviewed_at: record.reviewedAt ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function factoryWith(connect: SqlConnectionFactory['connect']): SqlConnectionFactory {
  return {
    capabilities: { backend: 'postgres', persistent: true, productionReady: true },
    connect,
  };
}

function repositoryWith(executor: SqlExecutor): {
  readonly repository: ReturnType<typeof createApplicationReviewRepository>;
  readonly connect: ReturnType<typeof vi.fn>;
} {
  const connect = vi.fn(async () => executor);
  const repository = createApplicationReviewRepository(
    loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
    factoryWith(connect as unknown as SqlConnectionFactory['connect']),
  );
  return { repository, connect };
}

describe('审核端持久化分流', () => {
  it('未配置数据库：内存基线（如实声明非持久），范围语义与数据库实现一致', async () => {
    const repository = createApplicationReviewRepository(loadEnv({ NODE_ENV: 'test' }), undefined);

    expect(repository).toBeInstanceOf(InMemoryApplicationReviewRepository);
    expect(repository.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });

    const baseline = repository as InMemoryApplicationReviewRepository;
    baseline.seed(application({ id: APPLICATION_ID, groupId: GROUP_A }));
    baseline.seed(application({ id: '77777777-7777-4777-8777-777777777777', groupId: GROUP_B }));

    // 范围隔离：只看到本组
    await expect(
      repository.listForReview({ kind: 'groups', groupIds: [GROUP_A] }),
    ).resolves.toEqual([application({ id: APPLICATION_ID, groupId: GROUP_A })]);
    // 范围外单条读取与「不存在」同结果
    await expect(
      repository.findForReview('77777777-7777-4777-8777-777777777777', {
        kind: 'groups',
        groupIds: [GROUP_A],
      }),
    ).resolves.toBeUndefined();
    // 空范围 fail-closed（绝不退化成「不限制」）
    await expect(repository.listForReview({ kind: 'groups', groupIds: [] })).rejects.toThrow(
      /空范围/u,
    );
    // 非法转移不产生任何写入
    await expect(
      repository.saveReviewed(application({ status: ApplicationStatus.Pending }), {
        kind: 'global',
      }),
    ).rejects.toBeInstanceOf(ApplicationReviewConflictError);
  });

  it('配置了数据库但没有执行器工厂：抛错，绝不静默退回内存审核实现', () => {
    expect(() =>
      createApplicationReviewRepository(
        loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
        undefined,
      ),
    ).toThrow(/拒绝退回内存审核仓储/u);
  });

  it('配置了数据库且拿到执行器工厂：换绑到 PostgreSQL adapter，且装配阶段不建连', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const { repository, connect } = repositoryWith(executor);

    // 延迟建连：装配阶段一次都没有调用 connect
    expect(connect).not.toHaveBeenCalled();
    expect(repository).not.toBeInstanceOf(InMemoryApplicationReviewRepository);
    expect(repository.capabilities).toEqual(POSTGRES_APPLICATION_REVIEW_REPOSITORY_CAPABILITIES);
    expect(repository.capabilities.backend).not.toBe('in-memory-baseline');

    // 空范围在**进 SQL 之前**被拒绝 —— 仍然不会调用 connect
    await expect(repository.listForReview({ kind: 'groups', groupIds: [] })).rejects.toThrow(
      /空范围/u,
    );
    expect(connect).not.toHaveBeenCalled();

    // 范围里的非规范小写 UUID 同样在进 SQL 之前被拒绝
    await expect(
      repository.listForReview({
        kind: 'groups',
        groupIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase()],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_IDENTIFIER' });
    expect(connect).not.toHaveBeenCalled();

    // 写入路径先判存储 ID 域（严格记录契约 → INVALID_RECORD），也不建连
    await expect(
      repository.saveReviewed(application({ userId: 'u-student-1' }), { kind: 'global' }),
    ).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('范围隔离在换绑后仍然成立：scope 下推进 SQL，范围取值不进入 SQL 文本', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const { repository, connect } = repositoryWith(executor);

    await expect(
      repository.listForReview({ kind: 'groups', groupIds: [GROUP_A, GROUP_B] }),
    ).resolves.toEqual([]);

    expect(connect).toHaveBeenCalledTimes(1);
    const call = executor.calls[0];
    expect(call?.sql).toContain('WHERE group_id = ANY($1::uuid[])');
    expect(call?.sql).not.toContain(GROUP_A);
    expect(call?.sql).not.toContain(GROUP_B);
    expect(call?.parameters).toEqual([[GROUP_A, GROUP_B]]);
    // 显式列清单，不用 SELECT *
    expect(call?.sql).not.toContain('*');
  });

  it('单条读取把「资源 ID + 范围」一起下推进 SQL', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const { repository } = repositoryWith(executor);

    await expect(
      repository.findForReview(APPLICATION_ID, { kind: 'groups', groupIds: [GROUP_A] }),
    ).resolves.toBeUndefined();

    const call = executor.calls[0];
    expect(call?.sql).toContain('WHERE id = $1::uuid AND group_id = ANY($2::uuid[])');
    expect(call?.parameters).toEqual([APPLICATION_ID, [GROUP_A]]);
  });

  it('条件写入：id + 范围 + 状态前驱三者都在 WHERE 里（并发与越权都写不中）', async () => {
    const stored = reviewedApplication();
    const executor = new RecordingExecutor([{ rows: [databaseRow(stored)], rowCount: 1 }]);
    const { repository } = repositoryWith(executor);

    await expect(
      repository.saveReviewed(stored, { kind: 'groups', groupIds: [GROUP_A] }),
    ).resolves.toEqual(stored);

    const call = executor.calls[0];
    expect(call?.sql).toContain('UPDATE join_applications');
    expect(call?.sql).toContain('WHERE id = $1::uuid AND group_id = $2::uuid');
    expect(call?.sql).toContain('status::text = ANY(');
    expect(call?.sql).not.toContain(GROUP_A);
    const parameters = call?.parameters ?? [];
    expect(parameters[0]).toBe(APPLICATION_ID);
    expect(parameters[1]).toBe(GROUP_A);
    expect(parameters[parameters.length - 1]).toEqual([ApplicationStatus.Pending]);
  });

  it('未验证的执行器工厂（fail-closed 默认绑定）不会被静默接受', async () => {
    const repository = createApplicationReviewRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      createUnavailableSqlConnectionFactory('测试：未引入驱动'),
    );

    // 装配阶段不建连（延迟），因此这里仍是一个 PostgreSQL 端口对象……
    expect(repository.capabilities.backend).toBe('postgres');
    // ……但一旦真的读写，fail-closed 工厂就抛错，绝不返回半可用连接
    await expect(repository.listForReview({ kind: 'global' })).rejects.toThrow(/数据库后端不可用/u);
  });
});

describe('端口登记（生产门禁的事实来源）', () => {
  it('APPLICATION_REVIEW_REPOSITORY 已登记为 business 持久化绑定', () => {
    const descriptor = PERSISTENCE_BINDINGS.find(
      (binding) => binding.token === APPLICATION_REVIEW_REPOSITORY,
    );

    expect(descriptor).toBeDefined();
    expect(descriptor?.module).toBe('memberships');
    expect(descriptor?.role).toBe('business');
    expect(bindingTokenName(APPLICATION_REVIEW_REPOSITORY)).toBe('APPLICATION_REVIEW_REPOSITORY');
  });

  it('审核端令牌与申请人端令牌是两个不同的绑定（不会互相代表）', () => {
    expect(APPLICATION_REVIEW_REPOSITORY).not.toBe(APPLICATION_REPOSITORY);
    expect(bindingTokenName(APPLICATION_REPOSITORY)).toBe('APPLICATION_REPOSITORY');

    const tokens = PERSISTENCE_BINDINGS.map((binding) => binding.token);
    expect(tokens).toContain(APPLICATION_REPOSITORY);
    expect(tokens).toContain(APPLICATION_REVIEW_REPOSITORY);
    // 令牌不得重复登记（重复会让门禁对同一后端重复计数）
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('审核端 adapter 的拒绝错误带有可机器判定的错误码（不是裸 Error）', () => {
    const error = new PostgresApplicationRepositoryError('OUT_OF_SCOPE', 'x');
    expect(error.code).toBe('OUT_OF_SCOPE');
    expect(error.name).toBe('PostgresApplicationRepositoryError');
  });
});
