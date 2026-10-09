import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplicationKind, ApplicationStatus } from '@rm/shared';
import { resolveDatabaseConfig } from '../../config/database-config';
import { loadEnv } from '../../../config/env';
import { runMigrations } from '../../migrations/migration-runner';
import { resolveMigrationsDirectory } from '../../migrations/run-migrations';
import { createPostgresMigrationDatabase } from '../postgres-migration-database';
import {
  createPostgresConnection,
  toPostgresPoolProfile,
  UNATTESTED_POSTGRES_CAPABILITIES,
} from '../postgres-executor';
import type { SqlConnection } from '../../ports/sql-executor.port';
import {
  PostgresApplicationRepository,
  PostgresApplicationReviewRepository,
} from '../../../modules/memberships/applications.postgres-repository';
import { ApplicationReviewConflictError } from '../../../modules/memberships/application-reviews.port';
import type { Application } from '../../../modules/memberships/applications.port';

/**
 * 入组申请**团队审核端**的真实 PostgreSQL 集成（WSL2 / Docker Compose 提供的开发库）。
 *
 * ## 为什么必须显式启用
 * 未提供 `TEST_DATABASE_URL`（或库名含 `test` 的 `DATABASE_URL`）时整个套件**明确 skip**，
 * 绝不伪造通过；提供了但连不上、或目标库名不含 `test` 时**失败**（本套件执行迁移与 DDL）。
 * 与 `postgres-integration.spec.ts` 同一套启用口径。
 *
 * ## 与 `postgres-integration.spec.ts` 的分工
 * 那个套件验证各**申请人/本人**切片；本套件只验证审核端**独有**的性质，即「范围从哪来」与
 * 「范围怎么落到 SQL」。因此它刻意同时使用两个端口：用**申请人端口**向真实表写入他人数据，
 * 再用**审核端口**读/写 —— 这正是审核端与申请人端的真实关系（同一张 `join_applications` 表，
 * 相反的隔离谓词）。
 *
 * ## 断言的四条硬性质（离线 spec 无法证明、必须在真库上闭环的）
 * 1. **范围隔离**：`{ groups: [A] }` 在真实 SQL 上只出 A 组的行，B 组的行既不出库也不可探测
 *    （`findForReview` 对 B 组记录返回 `undefined`，与「不存在」不可区分）；
 * 2. **空范围 fail-closed**：`{ groups: [] }` 抛错，绝不退化成「全表」；
 * 3. **条件写入真的改了库**：审核通过后直接读回数据库行，`status` / `reviewed_by_user_id` /
 *    `reviewed_at` 必须已落库（证明不是「返回了对象就当写成功」）；
 * 4. **并发只有一次生效**：两个审核请求并发执行，恰好一个成功、另一个抛
 *    `ApplicationReviewConflictError`，且库里只留下一次状态变化（条件写入的 `WHERE` 钉住了状态前驱）。
 *
 * ## 运行方式（重要）
 * `runMigrations` 没有跨连接的互斥锁，因此**两个集成 spec 不能并行跑**。请按文件串行执行：
 * `node node_modules/vitest/vitest.mjs run src/db/postgres/__tests__ --pool=threads --no-file-parallelism`
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']?.trim();
const FALLBACK_DATABASE_URL = process.env['DATABASE_URL']?.trim();

function databaseNameOf(url: string): string | undefined {
  try {
    const name = new URL(url).pathname.replace(/^\//u, '');
    return name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}

const FALLBACK_DATABASE_NAME =
  FALLBACK_DATABASE_URL === undefined || FALLBACK_DATABASE_URL === ''
    ? undefined
    : databaseNameOf(FALLBACK_DATABASE_URL);

const RAW_URL =
  TEST_DATABASE_URL !== undefined && TEST_DATABASE_URL !== ''
    ? TEST_DATABASE_URL
    : FALLBACK_DATABASE_NAME?.includes('test') === true
      ? FALLBACK_DATABASE_URL
      : undefined;
const ENABLED = RAW_URL !== undefined;

function describeState(): string {
  if (ENABLED) {
    return RAW_URL === TEST_DATABASE_URL
      ? '已配置 TEST_DATABASE_URL'
      : '已配置 DATABASE_URL（库名含 test）';
  }
  if (FALLBACK_DATABASE_URL !== undefined && FALLBACK_DATABASE_URL !== '') {
    return '未启用：DATABASE_URL 指向的库名不含 test（避免对开发/生产库执行破坏性 DDL）';
  }
  return '未配置 TEST_DATABASE_URL / DATABASE_URL';
}

if (!ENABLED) {
  describe('真实 PostgreSQL 审核端集成（未启用）', () => {
    it.skip(`未启用：${describeState()}（需要 WSL2 Docker Compose 中的开发库，见 README）`, () => {
      expect.unreachable(
        'reachable only when TEST_DATABASE_URL (or a test DATABASE_URL) is configured',
      );
    });
  });
}

const integrationDescribe = ENABLED ? describe : describe.skip;

const GROUP_A = '11111111-1111-4111-8111-111111111111';
const GROUP_B = '22222222-2222-4222-8222-222222222222';
const APPLICANT_A = '44444444-4444-4444-8444-444444444444';
const APPLICANT_B = '44444444-4444-4444-8444-444444444445';
const REVIEWER = '55555555-5555-4555-8555-555555555555';

/** 本测试写入的申请 ID：结束时只删自己写进去的行 */
const createdApplicationIds: string[] = [];

let connection: SqlConnection | undefined;

function now(): string {
  return new Date().toISOString();
}

function applicationFixture(overrides: Partial<Application> = {}): Application {
  const stamp = now();
  return {
    id: randomUUID(),
    userId: APPLICANT_A,
    groupId: GROUP_A,
    kind: ApplicationKind.Join,
    note: '集成测试夹具',
    status: ApplicationStatus.Pending,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

integrationDescribe('真实 PostgreSQL 审核端集成（TEST_DATABASE_URL / 测试库 DATABASE_URL）', () => {
  beforeAll(async () => {
    if (!ENABLED || RAW_URL === undefined) {
      return;
    }
    const resolution = resolveDatabaseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: RAW_URL,
      DATABASE_APPLICATION_NAME: 'researcher-manager-reviews-integration',
    });
    if (resolution.status !== 'configured') {
      throw new Error(`测试前置失败：${describeState()} 未解析成可用配置`);
    }
    if (!resolution.config.database.includes('test')) {
      throw new Error(
        `${describeState()} 指向的库名不含 test（${resolution.config.database}）：本套件会执行 DDL，拒绝在非测试库上运行`,
      );
    }

    connection = createPostgresConnection({
      profile: toPostgresPoolProfile(resolution.config),
      capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
    });
    await connection.query('SELECT 1');

    // schema 必须由**仓库真实迁移**建立（而不是测试自己建表），否则验证的是临时表
    const applied = await runMigrations({
      environment: 'test',
      sourceDirectory: resolveMigrationsDirectory(),
      database: createPostgresMigrationDatabase(connection),
      appliedBy: 'reviews-integration-test',
    });
    if (applied.guard.violations.length > 0) {
      throw new Error('测试前置失败：真实迁移未通过部署守卫');
    }
  }, 90_000);

  afterAll(async () => {
    if (connection !== undefined) {
      if (createdApplicationIds.length > 0) {
        await connection
          .query('DELETE FROM join_applications WHERE id = ANY($1::uuid[])', [
            createdApplicationIds,
          ])
          .catch(() => undefined);
      }
      await connection.close();
    }
  });

  /** 通过**申请人端口**写入真实表：审核端要读的正是「他人提交的申请」 */
  async function seedViaApplicantPort(record: Application): Promise<Application> {
    const created = await new PostgresApplicationRepository(connection as SqlConnection).create(
      record,
    );
    createdApplicationIds.push(created.id);
    return created;
  }

  function reviewRepository(): PostgresApplicationReviewRepository {
    return new PostgresApplicationReviewRepository(connection as SqlConnection);
  }

  it('join_applications 由迁移 0003 建立，且审核端依赖的列齐备', async () => {
    const result = await (connection as SqlConnection).query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'join_applications'`,
    );
    const columns = result.rows.map((row) => row.column_name);
    for (const column of [
      'id',
      'user_id',
      'group_id',
      'status',
      'reviewed_by_user_id',
      'review_comment',
      'reviewed_at',
    ]) {
      expect(columns).toContain(column);
    }
  });

  it('范围隔离：只出本组的行，他组记录既不出库也不可探测', async () => {
    const inA = await seedViaApplicantPort(applicationFixture({ groupId: GROUP_A }));
    const inB = await seedViaApplicantPort(
      applicationFixture({ groupId: GROUP_B, userId: APPLICANT_B }),
    );
    const repository = reviewRepository();

    const scoped = await repository.listForReview({ kind: 'groups', groupIds: [GROUP_A] });
    const scopedIds = scoped.map((row) => row.id);
    expect(scopedIds).toContain(inA.id);
    expect(scopedIds).not.toContain(inB.id);

    // 全局审核者能看到两组的行
    const global = await repository.listForReview({ kind: 'global' });
    const globalIds = global.map((row) => row.id);
    expect(globalIds).toContain(inA.id);
    expect(globalIds).toContain(inB.id);

    // 范围内单条读取命中；范围外与「不存在」返回同一种结果
    await expect(
      repository.findForReview(inA.id, { kind: 'groups', groupIds: [GROUP_A] }),
    ).resolves.toMatchObject({ id: inA.id, groupId: GROUP_A });
    await expect(
      repository.findForReview(inB.id, { kind: 'groups', groupIds: [GROUP_A] }),
    ).resolves.toBeUndefined();
    await expect(
      repository.findForReview(randomUUID(), { kind: 'groups', groupIds: [GROUP_A] }),
    ).resolves.toBeUndefined();
  });

  it('空小组范围 fail-closed：抛错且不返回全表', async () => {
    await seedViaApplicantPort(applicationFixture({ groupId: GROUP_A }));

    await expect(
      reviewRepository().listForReview({ kind: 'groups', groupIds: [] }),
    ).rejects.toThrow(/空范围/u);
    await expect(
      reviewRepository().findForReview(randomUUID(), { kind: 'groups', groupIds: [] }),
    ).rejects.toThrow(/空范围/u);
  });

  it('条件写入真的落库：审核通过后直接读回数据库行', async () => {
    const pending = await seedViaApplicantPort(applicationFixture({ groupId: GROUP_A }));
    const repository = reviewRepository();
    const approvedAt = now();

    const saved = await repository.saveReviewed(
      {
        ...pending,
        status: ApplicationStatus.Approved,
        reviewedByUserId: REVIEWER,
        reviewedAt: approvedAt,
        updatedAt: approvedAt,
      },
      { kind: 'groups', groupIds: [GROUP_A] },
    );
    expect(saved.status).toBe(ApplicationStatus.Approved);

    // 绕过 adapter，直接查库：证明状态确实写进了存储（而不是只改了返回对象）
    const raw = await (connection as SqlConnection).query<{
      status: string;
      reviewed_by_user_id: string;
      reviewed_at: Date;
    }>(
      'SELECT status, reviewed_by_user_id, reviewed_at FROM join_applications WHERE id = $1::uuid',
      [pending.id],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]?.status).toBe(ApplicationStatus.Approved);
    expect(raw.rows[0]?.reviewed_by_user_id).toBe(REVIEWER);
    expect(raw.rows[0]?.reviewed_at).toBeInstanceOf(Date);

    // 已被终态化：再次审核不再命中条件写入（状态谓词拦下）
    await expect(
      repository.saveReviewed(
        {
          ...pending,
          status: ApplicationStatus.Rejected,
          reviewedByUserId: REVIEWER,
          reviewedAt: now(),
          updatedAt: now(),
        },
        { kind: 'groups', groupIds: [GROUP_A] },
      ),
    ).rejects.toBeInstanceOf(ApplicationReviewConflictError);

    const after = await (connection as SqlConnection).query<{ status: string }>(
      'SELECT status FROM join_applications WHERE id = $1::uuid',
      [pending.id],
    );
    expect(after.rows[0]?.status).toBe(ApplicationStatus.Approved);
  });

  it('并发两次审核只有一次生效（条件写入钉住状态前驱）', async () => {
    const pending = await seedViaApplicantPort(applicationFixture({ groupId: GROUP_A }));
    const repository = reviewRepository();
    const scope = { kind: 'groups', groupIds: [GROUP_A] } as const;

    const approve = {
      ...pending,
      status: ApplicationStatus.Approved,
      reviewedByUserId: REVIEWER,
      reviewedAt: now(),
      updatedAt: now(),
    };
    const reject = {
      ...pending,
      status: ApplicationStatus.Rejected,
      reviewedByUserId: REVIEWER,
      reviewComment: '并发测试',
      reviewedAt: now(),
      updatedAt: now(),
    };

    const settled = await Promise.allSettled([
      repository.saveReviewed(approve, scope),
      repository.saveReviewed(reject, scope),
    ]);

    const fulfilled = settled.filter((item) => item.status === 'fulfilled');
    const rejected = settled.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ApplicationReviewConflictError);

    // 库里只留下一次状态变化：两次并发不会都写成功，也不会互相覆盖
    const after = await (connection as SqlConnection).query<{
      status: string;
      review_comment: string | null;
    }>('SELECT status, review_comment FROM join_applications WHERE id = $1::uuid', [pending.id]);
    const finalStatus = after.rows[0]?.status;
    expect([ApplicationStatus.Approved, ApplicationStatus.Rejected]).toContain(finalStatus);
    // 与最终状态一致：通过则无审核意见，驳回则恰好是驳回意见
    expect(after.rows[0]?.review_comment ?? null).toBe(
      finalStatus === ApplicationStatus.Rejected ? '并发测试' : null,
    );
  });

  it('存储 ID 域在进入 SQL 之前判定：非 UUID 归属不写库', async () => {
    const record = applicationFixture({ userId: 'u-student-1', groupId: GROUP_A });
    await expect(reviewRepository().saveReviewed(record, { kind: 'global' })).rejects.toMatchObject(
      { code: 'INVALID_RECORD' },
    );

    const found = await (connection as SqlConnection).query(
      'SELECT 1 FROM join_applications WHERE id = $1::uuid',
      [record.id],
    );
    expect(found.rows).toHaveLength(0);
  });

  it('模块换绑工厂 + 真实执行器：审核端端口直连真实库闭环', async () => {
    const { createApplicationReviewRepository } =
      await import('../../../modules/memberships/memberships.module');
    const pending = await seedViaApplicantPort(applicationFixture({ groupId: GROUP_B }));

    const port = createApplicationReviewRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: RAW_URL }),
      {
        capabilities: { backend: 'postgres', persistent: true, productionReady: true },
        connect: () => Promise.resolve(connection as SqlConnection),
      },
    );

    await expect(
      port.findForReview(pending.id, { kind: 'groups', groupIds: [GROUP_B] }),
    ).resolves.toMatchObject({ id: pending.id });
    // 换绑后的端口同样守住范围：他组读不到
    await expect(
      port.findForReview(pending.id, { kind: 'groups', groupIds: [GROUP_A] }),
    ).resolves.toBeUndefined();
  });
});
