import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../db/ports/sql-executor.port';
import { ApplicationKind, ApplicationStatus } from '@rm/shared';
import {
  ApplicationReviewConflictError,
  type ApplicationReviewScope,
} from './application-reviews.port';
import {
  POSTGRES_APPLICATION_REVIEW_REPOSITORY_CAPABILITIES,
  PostgresApplicationRepositoryError,
  PostgresApplicationReviewRepository,
  assertPostgresApplicationReviewRepositoryCapabilities,
  createLazyPostgresApplicationReviewRepository,
} from './applications.postgres-repository';
import type { Application } from './applications.port';

/**
 * 审核端 PostgreSQL adapter 的**离线契约**回归（不连数据库）。
 *
 * 断言集中在审核端独有、且一旦写错就是越权的四件事：
 * 1. **范围下推**：`scope` 必须变成 `WHERE` 谓词，绝不出现在 SQL 文本里（值走占位符）；
 * 2. **空范围 fail-closed**：`groups` 且空数组 ⇒ 抛错且**一条 SQL 都不发**（不得退化成全表）；
 * 3. **存储 ID 域先判**：非规范小写 UUID 的范围/主体在连数据库之前就被拒绝；
 * 4. **条件写入**：`UPDATE` 的 `WHERE` 同时钉住 id、范围与状态前驱；0 行 ⇒ 冲突而非静默成功。
 */

const GROUP_A = '11111111-1111-4111-8111-111111111111';
const GROUP_B = '22222222-2222-4222-8222-222222222222';
const APPLICANT = '44444444-4444-4444-8444-444444444444';
const REVIEWER = '55555555-5555-4555-8555-555555555555';
const APPLICATION_ID = '66666666-6666-4666-8666-666666666666';

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

const NOW = '2026-05-01T00:00:00.000Z';

function databaseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APPLICATION_ID,
    user_id: APPLICANT,
    group_id: GROUP_A,
    kind: ApplicationKind.Join,
    note: '希望加入',
    status: ApplicationStatus.Pending,
    reviewed_by_user_id: null,
    review_comment: null,
    reviewed_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: APPLICATION_ID,
    userId: APPLICANT,
    groupId: GROUP_A,
    kind: ApplicationKind.Join,
    note: '希望加入',
    status: ApplicationStatus.Approved,
    reviewedByUserId: REVIEWER,
    reviewedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function repositoryWith(executor: RecordingExecutor): PostgresApplicationReviewRepository {
  return new PostgresApplicationReviewRepository(executor);
}

async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出异常，但没有');
}

describe('能力自检与执行器准入', () => {
  it('未完成验证就声称生产可用的声明被拒绝', () => {
    expect(() =>
      assertPostgresApplicationReviewRepositoryCapabilities({
        ...POSTGRES_APPLICATION_REVIEW_REPOSITORY_CAPABILITIES,
        productionReady: true,
      }),
    ).toThrow(PostgresApplicationRepositoryError);
  });

  it('默认能力声明：持久但未验证（productionReady=false）', () => {
    expect(POSTGRES_APPLICATION_REVIEW_REPOSITORY_CAPABILITIES).toEqual({
      backend: 'postgres',
      persistent: true,
      productionReady: false,
    });
  });

  it('非 PostgreSQL / 非持久执行器被拒绝（不得把 adapter 挂到内存替身）', () => {
    const memory = {
      capabilities: { backend: 'in-memory', persistent: false, productionReady: false },
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    } as unknown as SqlExecutor;
    expect(() => repositoryWith(memory as unknown as RecordingExecutor)).toThrow(
      /不是 PostgreSQL/u,
    );

    const notPersistent = {
      capabilities: { backend: 'postgres-x', persistent: false, productionReady: false },
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    } as unknown as SqlExecutor;
    expect(() => repositoryWith(notPersistent as unknown as RecordingExecutor)).toThrow(
      /非持久后端/u,
    );
  });
});

describe('范围下推与参数化', () => {
  it('global：不加小组谓词，且不绑定任何参数', async () => {
    const executor = new RecordingExecutor([{ rows: [databaseRow()], rowCount: 1 }]);
    const rows = await repositoryWith(executor).listForReview({ kind: 'global' });

    expect(rows).toHaveLength(1);
    expect(executor.calls).toHaveLength(1);
    // global 范围：完全没有 WHERE 子句，也不做任何范围绑定
    // （`group_id` 作为**被选中的列**当然出现在列清单里，所以断言的是「没有谓词」而不是「没有这个词」）
    expect(executor.calls[0]?.sql).not.toContain('WHERE');
    expect(executor.calls[0]?.sql).not.toContain('ANY(');
    expect(executor.calls[0]?.parameters).toBeUndefined();
  });

  it('groups：小组集合走 = ANY($1::uuid[]) 占位符，值不进入 SQL 文本', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    await repositoryWith(executor).listForReview({ kind: 'groups', groupIds: [GROUP_A, GROUP_B] });

    const call = executor.calls[0];
    expect(call?.sql).toContain('group_id = ANY($1::uuid[])');
    expect(call?.sql).not.toContain(GROUP_A);
    expect(call?.sql).not.toContain(GROUP_B);
    expect(call?.parameters).toEqual([[GROUP_A, GROUP_B]]);
  });

  it('空小组范围 → 抛错，且**一条 SQL 都不发**（绝不退化成全表）', async () => {
    const executor = new RecordingExecutor([{ rows: [databaseRow()], rowCount: 1 }]);
    const error = await rejectionOf(() =>
      repositoryWith(executor).listForReview({ kind: 'groups', groupIds: [] }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/空范围/u);
    expect(executor.calls).toEqual([]);
  });

  it('范围里的非规范小写/非 UUID 小组 → INVALID_IDENTIFIER，且不发 SQL', async () => {
    const executor = new RecordingExecutor();
    // 该 UUID 含字母，因此 `toUpperCase()` 确实产生非规范小写形
    const withLetters = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const error = await rejectionOf(() =>
      repositoryWith(executor).listForReview({
        kind: 'groups',
        groupIds: [withLetters.toUpperCase()],
      }),
    );

    expect(error).toBeInstanceOf(PostgresApplicationRepositoryError);
    expect((error as PostgresApplicationRepositoryError).code).toBe('INVALID_IDENTIFIER');
    expect(executor.calls).toEqual([]);
  });
});

describe('范围内单条读取', () => {
  it('groups：id 与小组范围都在 WHERE 里', async () => {
    const executor = new RecordingExecutor([
      { rows: [databaseRow({ status: ApplicationStatus.Pending })], rowCount: 1 },
    ]);
    const record = await repositoryWith(executor).findForReview(APPLICATION_ID, {
      kind: 'groups',
      groupIds: [GROUP_A],
    });

    expect(record?.id).toBe(APPLICATION_ID);
    const call = executor.calls[0];
    expect(call?.sql).toContain('WHERE id = $1::uuid AND group_id = ANY($2::uuid[])');
    expect(call?.parameters).toEqual([APPLICATION_ID, [GROUP_A]]);
  });

  it('域外资源 ID → undefined（确定结论），且不发 SQL', async () => {
    const executor = new RecordingExecutor();
    const record = await repositoryWith(executor).findForReview('not-a-uuid', { kind: 'global' });

    expect(record).toBeUndefined();
    expect(executor.calls).toEqual([]);
  });

  it('0 行 → undefined（范围外与不存在不可区分）', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const record = await repositoryWith(executor).findForReview(APPLICATION_ID, { kind: 'global' });

    expect(record).toBeUndefined();
  });

  it('范围外记录被仓储异常返回 → OUT_OF_SCOPE（纵深防御）', async () => {
    const executor = new RecordingExecutor([
      { rows: [databaseRow({ group_id: GROUP_B })], rowCount: 1 },
    ]);
    const error = await rejectionOf(() =>
      repositoryWith(executor).findForReview(APPLICATION_ID, {
        kind: 'groups',
        groupIds: [GROUP_A],
      }),
    );

    expect(error).toBeInstanceOf(PostgresApplicationRepositoryError);
    expect((error as PostgresApplicationRepositoryError).code).toBe('OUT_OF_SCOPE');
  });
});

describe('行契约（严格）', () => {
  it('未知列 → INVALID_ROW', async () => {
    const executor = new RecordingExecutor([
      { rows: [databaseRow({ audit_event_id: 'x' })], rowCount: 1 },
    ]);
    const error = await rejectionOf(() =>
      repositoryWith(executor).listForReview({ kind: 'global' }),
    );

    expect((error as PostgresApplicationRepositoryError).code).toBe('INVALID_ROW');
  });

  it('未知状态枚举 → INVALID_ROW（不得当作合法值返回）', async () => {
    const executor = new RecordingExecutor([
      { rows: [databaseRow({ status: 'unknown-status' })], rowCount: 1 },
    ]);
    const error = await rejectionOf(() =>
      repositoryWith(executor).listForReview({ kind: 'global' }),
    );

    expect((error as PostgresApplicationRepositoryError).code).toBe('INVALID_ROW');
  });

  it('错误信息只含字段路径/违规类型，不含字段取值', async () => {
    const executor = new RecordingExecutor([
      { rows: [databaseRow({ status: 'unknown-status' })], rowCount: 1 },
    ]);
    const error = (await rejectionOf(() =>
      repositoryWith(executor).listForReview({ kind: 'global' }),
    )) as PostgresApplicationRepositoryError;

    expect(error.issues.join(',')).toContain('status');
    expect(error.message).not.toContain('希望加入');
    expect(error.message).not.toContain(APPLICANT);
  });
});

describe('范围内的条件写入', () => {
  it('groups：WHERE 同时钉住 id、范围与状态前驱（前驱来自共享状态机）', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [
          databaseRow({
            status: ApplicationStatus.Approved,
            reviewed_by_user_id: REVIEWER,
            reviewed_at: NOW,
            updated_at: NOW,
          }),
        ],
        rowCount: 1,
      },
    ]);
    await repositoryWith(executor).saveReviewed(application(), {
      kind: 'groups',
      groupIds: [GROUP_A],
    });

    const call = executor.calls[0];
    expect(call?.sql).toContain(
      'WHERE id = $1::uuid AND group_id = $2::uuid AND status::text = ANY(',
    );
    expect(call?.sql).not.toContain(GROUP_A);
    const parameters = call?.parameters ?? [];
    expect(parameters[0]).toBe(APPLICATION_ID);
    expect(parameters[1]).toBe(GROUP_A);
    // 最后一个参数是状态前驱集合：approved 的前驱只有 pending
    expect(parameters[parameters.length - 1]).toEqual([ApplicationStatus.Pending]);
  });

  it('global：WHERE 只钉住 id 与状态前驱', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [
          databaseRow({
            status: ApplicationStatus.Rejected,
            reviewed_by_user_id: REVIEWER,
            review_comment: '不行',
            reviewed_at: NOW,
            updated_at: NOW,
          }),
        ],
        rowCount: 1,
      },
    ]);
    await repositoryWith(executor).saveReviewed(
      application({ status: ApplicationStatus.Rejected, reviewComment: '不行' }),
      { kind: 'global' },
    );

    const call = executor.calls[0];
    expect(call?.sql).not.toContain('group_id = $2');
    expect(call?.parameters?.[0]).toBe(APPLICATION_ID);
    expect(call?.parameters?.[call.parameters.length - 1]).toEqual([ApplicationStatus.Pending]);
  });

  it('0 行 → 并发冲突（不是静默成功，也不是 500）', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const error = await rejectionOf(() =>
      repositoryWith(executor).saveReviewed(application(), {
        kind: 'groups',
        groupIds: [GROUP_A],
      }),
    );

    expect(error).toBeInstanceOf(ApplicationReviewConflictError);
  });

  it('目标状态不是任何合法前驱的后继（如改回 pending）→ 拒绝写入', async () => {
    const executor = new RecordingExecutor();
    const error = await rejectionOf(() =>
      repositoryWith(executor).saveReviewed(application({ status: ApplicationStatus.Pending }), {
        kind: 'global',
      }),
    );

    expect(error).toBeInstanceOf(PostgresApplicationRepositoryError);
    expect(executor.calls).toEqual([]);
  });

  it('写入往返不一致（归属被改写）→ OWNER_VIOLATION', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [
          databaseRow({
            user_id: GROUP_B,
            status: ApplicationStatus.Approved,
            reviewed_by_user_id: REVIEWER,
            reviewed_at: NOW,
            updated_at: NOW,
          }),
        ],
        rowCount: 1,
      },
    ]);
    const error = await rejectionOf(() =>
      repositoryWith(executor).saveReviewed(application(), { kind: 'global' }),
    );

    expect(error).toBeInstanceOf(PostgresApplicationRepositoryError);
    expect((error as PostgresApplicationRepositoryError).code).toBe('OWNER_VIOLATION');
  });

  it('待写记录的归属不在存储 ID 域 → INVALID_RECORD，且不发 SQL', async () => {
    const executor = new RecordingExecutor();
    const error = await rejectionOf(() =>
      repositoryWith(executor).saveReviewed(application({ userId: 'u-student-1' }), {
        kind: 'global',
      }),
    );

    expect(error).toBeInstanceOf(PostgresApplicationRepositoryError);
    expect((error as PostgresApplicationRepositoryError).code).toBe('INVALID_RECORD');
    expect(executor.calls).toEqual([]);
  });

  it('审核人不在存储 ID 域 → INVALID_RECORD，且不发 SQL', async () => {
    const executor = new RecordingExecutor();
    const error = await rejectionOf(() =>
      repositoryWith(executor).saveReviewed(application({ reviewedByUserId: 'u-leader-1' }), {
        kind: 'global',
      }),
    );

    expect(error).toBeInstanceOf(PostgresApplicationRepositoryError);
    // 与申请人端共用同一份严格写入契约：`reviewed_by_user_id` 落在存储 ID 域之外即 INVALID_RECORD
    expect((error as PostgresApplicationRepositoryError).code).toBe('INVALID_RECORD');
    expect((error as PostgresApplicationRepositoryError).issues).toContain('reviewed_by_user_id');
    expect(executor.calls).toEqual([]);
  });
});

describe('延迟建连工厂', () => {
  it('装配阶段不建连；首次调用才建连并复用', async () => {
    let connects = 0;
    const executor = new RecordingExecutor([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const port = createLazyPostgresApplicationReviewRepository(() => {
      connects += 1;
      return Promise.resolve(executor);
    });

    expect(connects).toBe(0);
    await port.listForReview({ kind: 'global' });
    expect(connects).toBe(1);
    await port.listForReview({ kind: 'global' });
    expect(connects).toBe(1);
  });

  it('非法范围在**建连之前**被拒绝（不触发连接）', async () => {
    let connects = 0;
    const port = createLazyPostgresApplicationReviewRepository(() => {
      connects += 1;
      return Promise.resolve(new RecordingExecutor());
    });

    const empty: ApplicationReviewScope = { kind: 'groups', groupIds: [] };
    await rejectionOf(() => port.listForReview(empty));
    expect(connects).toBe(0);
  });

  it('默认能力声明不满足生产可用时，工厂自身 fail-closed', () => {
    expect(() =>
      createLazyPostgresApplicationReviewRepository(
        () => Promise.resolve(new RecordingExecutor()),
        {
          backend: 'postgres',
          persistent: true,
          productionReady: true,
        },
      ),
    ).toThrow(PostgresApplicationRepositoryError);
  });
});
