import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiErrorCode, createMockProvider, type MatchFeatureBundle } from '@rm/ai-adapter';
import {
  AvailablePeriod,
  Grade,
  GroupStatus,
  MatchingRequestStatus,
  ProgrammingLevel,
  Role,
} from '@rm/shared';
import { loadEnv } from '../../../config/env';
import { resolveDatabaseConfig } from '../../config/database-config';
import { runMigrations } from '../../migrations/migration-runner';
import { resolveMigrationsDirectory } from '../../migrations/run-migrations';
import { createPostgresMigrationDatabase } from '../postgres-migration-database';
import {
  createPostgresConnection,
  toPostgresPoolProfile,
  UNATTESTED_POSTGRES_CAPABILITIES,
} from '../postgres-executor';
import type {
  SqlConnection,
  SqlConnectionFactory,
  SqlExecutor,
} from '../../ports/sql-executor.port';
import { AuthorizationGuard } from '../../../modules/access-control/authorization-guard';
import { AuthorizationPolicy } from '../../../modules/access-control/authorization-policy';
import { BaselineRuoYiAuthzAdapter } from '../../../modules/ruoyi-adapter/ruoyi-adapter.baseline';
import { InMemoryMatchingFeatureSource } from '../../../modules/matching/matching.feature-source.in-memory';
import { MatchingService } from '../../../modules/matching/matching.service';
import { createMatchingRepository } from '../../../modules/matching/matching.module';
import {
  POSTGRES_MATCHING_COLUMNS,
  POSTGRES_MATCHING_INTERNAL_COLUMNS,
  POSTGRES_MATCHING_TABLE,
  PostgresMatchingRepository,
} from '../../../modules/matching/matching.postgres-repository';
import {
  MATCHING_REPOSITORY_BACKEND_POSTGRES,
  type MatchingAccessScope,
  type MatchingRepository,
  type MatchingRequest,
} from '../../../modules/matching/matching.port';

/**
 * 匹配记录（`ai_match_records`）的**真实 PostgreSQL 集成**（WSL2 / Docker Compose 提供的开发库）。
 *
 * ## 为什么必须显式启用
 * 未提供 `TEST_DATABASE_URL`（或库名含 `test` 的 `DATABASE_URL`）时整个套件**明确 skip**，
 * 绝不伪造通过；提供了但连不上、或目标库名不含 `test` 时**失败**（本套件执行迁移与 DDL）。
 * 与 `postgres-integration.spec.ts` / `exports-integration.spec.ts` / `compliance-integration.spec.ts`
 * 同一套启用口径。
 *
 * ## 断言的硬性质（离线 spec 无法证明、必须在真库上闭环的）
 * 1. **schema 由仓库真实迁移建立**：`ai_match_records` 由迁移 `0005` 建出，列清单**恰好**是
 *    adapter 的 12 个输出列（原始 AI 输入 / 提示词 / 模型 payload / PII / 内部评分 / 审核 /
 *    簿记列一列都没有）；主键是 `id`；`(user_id, created_at, id)` 取数索引与状态 / 降级码 /
 *    摘要形状的 CHECK 齐备；
 * 2. **读写闭环**：`create`（入口恒为 `pending`）→ `save`（推进到 `completed` 并落推荐结果）
 *    → `listByUserId` / `findById` 逐字段往返，且返回对象**只有**端口契约的字段；
 * 3. **归属隔离**：库里同时存在多个主体时只返回请求主体的记录；跨主体覆盖写入**一行都写不中**
 *    （`UPDATE_MISSING`，不外泄「该 ID 属于他人」）；`findById` 他人记录返回 `undefined`；
 * 4. **主键冲突**：同 ID 第二次 `create` 抛 `CONFLICT`，不静默覆盖既有匹配记录；
 * 5. **存储 ID 域在进 SQL 之前判定**：非 UUID 主体 / 记录 ID / 小组标识 fail-closed
 *    （`INVALID_SUBJECT` / `INVALID_RECORD` / `INVALID_SCOPE`），且库里不产生任何行；
 * 6. **小组授权边界**：库中记录若含未授权小组，读取路径 `GROUP_SCOPE_VIOLATION` fail-closed
 *    （不静默过滤）；
 * 7. **绕过应用层也写不坏**：非法状态 / 坏摘要 / 未知降级码 / 空 UUID 归属被存储层
 *    CHECK（23514）或 NOT NULL 拒绝；
 * 8. **模块换绑工厂 + 真实执行器**：`createMatchingRepository` 在真库上直接闭环
 *    （这是「数据库已配置 ⇒ 匹配端口走 PostgreSQL 实现」的端到端证据）。
 *
 * ## 运行方式（重要）
 * `runMigrations` 没有跨连接的互斥锁，因此**各集成 spec 不能并行跑**。请按文件串行执行：
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
  describe('真实 PostgreSQL 匹配记录集成（未启用）', () => {
    it.skip(`未启用：${describeState()}（需要 WSL2 Docker Compose 中的开发库，见 README）`, () => {
      expect.unreachable(
        'reachable only when TEST_DATABASE_URL (or a test DATABASE_URL) is configured',
      );
    });
  });
}

const integrationDescribe = ENABLED ? describe : describe.skip;

let connection: SqlConnection | undefined;

/** 本次运行写入的主键集合：用于 `afterAll` 精确清理 */
const createdIds = new Set<string>();

const GROUP = '11111111-1111-4111-8111-111111111111';
const OTHER_GROUP = '22222222-2222-4222-8222-222222222222';
const HASH = 'a1'.repeat(32);
const TIMESTAMP = '2026-10-10T00:00:00.000Z';

/**
 * 敏感内容哨兵：提示词正文 / 模型原始输出 / 个人标识。
 *
 * 它们只以「非法 AI 产物」的形式出现在输入侧，`ai_match_records` 的任何位置都不允许出现这些取值
 * —— 包括整张表（含 `jsonb` 的文本表示）。用哨兵而不是「检查列名」是因为列名闭集挡不住
 * 「白名单列里塞进敏感取值」这类泄漏。
 */
const PROMPT_SENTINEL = 'SYSTEM-PROMPT-正文-不得落库';
const MODEL_PAYLOAD_SENTINEL = 'RAW-MODEL-PAYLOAD-不得落库';
const PII_SENTINEL = '13800138000';

/** 在整张表上扫描某个取值（`candidate::text` 覆盖全部列，含 `jsonb` 文本表示）：返回命中行数 */
async function countRowsMentioning(needle: string): Promise<string> {
  const rows = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${POSTGRES_MATCHING_TABLE} AS candidate WHERE candidate::text LIKE $1`,
    [`%${needle}%`],
  );
  return rows[0]?.count ?? '-1';
}

async function query<T = Record<string, unknown>>(
  sql: string,
  parameters?: readonly unknown[],
): Promise<readonly T[]> {
  const result = await (connection as SqlConnection).query<T>(sql, parameters);
  return result.rows;
}

/** 直接落一行（绕过 adapter，用于独立验证读路径与存储层约束） */
async function seedRow(
  ownerUserId: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  createdIds.add(id);
  const row = {
    id,
    user_id: ownerUserId,
    status: MatchingRequestStatus.Pending,
    profile_version: null,
    input_snapshot_hash: HASH,
    recommendations: JSON.stringify([]),
    model_version: 'rule-fallback-v1',
    prompt_version: 'match-prompt-v1',
    fallback_used: true,
    degradation_code: null,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    ...overrides,
  };
  await (connection as SqlConnection).query(
    `INSERT INTO ${POSTGRES_MATCHING_TABLE}
       (id, user_id, status, profile_version, input_snapshot_hash, recommendations,
        model_version, prompt_version, fallback_used, degradation_code, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4::integer, $5, $6::jsonb, $7, $8, $9, $10, $11::timestamptz, $12::timestamptz)`,
    [
      row.id,
      row.user_id,
      row.status,
      row.profile_version,
      row.input_snapshot_hash,
      row.recommendations,
      row.model_version,
      row.prompt_version,
      row.fallback_used,
      row.degradation_code,
      row.created_at,
      row.updated_at,
    ],
  );
}

function repository(): PostgresMatchingRepository {
  return new PostgresMatchingRepository(connection as SqlConnection);
}

function scopeFor(ownerUserId: string, groups: readonly string[] = [GROUP]): MatchingAccessScope {
  return { ownerUserId, authorizedGroupIds: [...groups] };
}

/** 入口记录（`pending`，推荐为空） */
function entryFor(id: string, ownerUserId: string): MatchingRequest {
  return {
    id,
    userId: ownerUserId,
    status: MatchingRequestStatus.Pending,
    inputSnapshotHash: HASH,
    recommendations: [],
    modelVersion: 'rule-fallback-v1',
    promptVersion: 'match-prompt-v1',
    fallbackUsed: true,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

/** 终态记录（`completed`，一条推荐） */
function completedFor(id: string, ownerUserId: string, groupId: string = GROUP): MatchingRequest {
  return {
    ...entryFor(id, ownerUserId),
    status: MatchingRequestStatus.Completed,
    recommendations: [
      { groupId, score: 88, reason: '方向一致，技能基本匹配', advice: '建议补齐缺失技能' },
    ],
    degradationCode: AiErrorCode.Disabled,
    updatedAt: '2026-10-10T01:00:00.000Z',
  };
}

integrationDescribe(
  '真实 PostgreSQL 匹配记录集成（TEST_DATABASE_URL / 测试库 DATABASE_URL）',
  () => {
    beforeAll(async () => {
      if (!ENABLED || RAW_URL === undefined) {
        return;
      }
      const resolution = resolveDatabaseConfig({
        NODE_ENV: 'test',
        DATABASE_URL: RAW_URL,
        DATABASE_APPLICATION_NAME: 'researcher-manager-matching-integration',
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
        appliedBy: 'matching-integration-test',
      });
      if (applied.guard.violations.length > 0) {
        throw new Error('测试前置失败：真实迁移未通过部署守卫');
      }
    }, 90_000);

    afterAll(async () => {
      if (connection !== undefined && createdIds.size > 0) {
        // 只清理本次运行写入的主键：不触碰其它数据，也不做整表截断
        await connection.query(
          `DELETE FROM ${POSTGRES_MATCHING_TABLE} WHERE id = ANY($1::uuid[])`,
          [[...createdIds]],
        );
      }
      if (connection !== undefined) {
        await connection.close();
      }
    });

    it('ai_match_records 由迁移 0005 建立：列清单恰好是 adapter 的 12 列，且一个内部列都没有', async () => {
      const exists = await query<{ exists: boolean }>(
        'SELECT to_regclass($1::text) IS NOT NULL AS exists',
        [`public.${POSTGRES_MATCHING_TABLE}`],
      );
      expect(exists[0]?.exists).toBe(true);

      const columns = await query<{ column_name: string }>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        ['public', POSTGRES_MATCHING_TABLE],
      );
      const names = columns.map((row) => row.column_name).sort();
      // 表列清单与 adapter 的输出列清单**必须完全相等**：多一列就意味着有人把原始 AI 输入、
      // 特征原文、提示词、模型 payload、PII、内部评分或审核字段塞进了存储
      expect(names).toEqual([...POSTGRES_MATCHING_COLUMNS].sort());
      for (const internal of POSTGRES_MATCHING_INTERNAL_COLUMNS) {
        expect(names).not.toContain(internal);
      }
      for (const pii of ['name', 'student_no', 'phone', 'email', 'id_card', 'openid']) {
        expect(names).not.toContain(pii);
      }

      const primaryKey = await query<{ column_name: string }>(
        `SELECT a.attname AS column_name
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'public.ai_match_records'::regclass AND i.indisprimary`,
      );
      expect(primaryKey.map((row) => row.column_name)).toEqual(['id']);

      // 取数索引覆盖 adapter 的 ORDER_BY（created_at ASC, id ASC）与归属谓词
      const indexes = await query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
        [POSTGRES_MATCHING_TABLE],
      );
      const ownerIndex = indexes.find(
        (row) => row.indexname === 'idx_ai_match_records_user_created_at',
      );
      expect(ownerIndex?.indexdef).toMatch(/user_id/iu);
      expect(ownerIndex?.indexdef).toMatch(/created_at/iu);
      expect(ownerIndex?.indexdef).toMatch(/id/iu);

      // 存储层 CHECK 镜像 adapter 契约：状态闭集 / 降级码闭集 / 摘要形状 / 版本长度 / 版本区间
      const constraints = await query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'public.ai_match_records'::regclass AND contype = 'c'`,
      );
      const constraintNames = constraints.map((row) => row.conname);
      for (const expected of [
        'ai_match_records_status_check',
        'ai_match_records_degradation_code_check',
        'ai_match_records_snapshot_hash_shape',
        'ai_match_records_model_version_shape',
        'ai_match_records_prompt_version_shape',
        'ai_match_records_profile_version_range',
        // 迁移 0014 补齐的存储层守卫：存储 ID 域非空 + 结果行必须是数组且条数上界
        'ai_match_records_id_not_nil',
        'ai_match_records_user_id_not_nil',
        'ai_match_records_recommendations_is_array',
        'ai_match_records_recommendations_max_items',
      ]) {
        expect(constraintNames).toContain(expected);
      }
      // NOT NULL：归属与业务必填列不得可空（NULL 归属会让归属隔离失效）
      const notNull = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND is_nullable = 'NO'`,
        [POSTGRES_MATCHING_TABLE],
      );
      const notNullNames = notNull.map((row) => row.column_name);
      for (const column of ['id', 'user_id', 'status', 'input_snapshot_hash', 'recommendations']) {
        expect(notNullNames).toContain(column);
      }
    }, 60_000);

    it('读写闭环：create（入口 pending）→ save（推进 completed）→ 按主体取数 / 单条取数逐字段往返', async () => {
      const owner = randomUUID();
      const id = randomUUID();
      createdIds.add(id);

      const created = await repository().create(entryFor(id, owner), scopeFor(owner));
      expect(created.status).toBe(MatchingRequestStatus.Pending);
      expect(created.recommendations).toEqual([]);
      expect(created.userId).toBe(owner);

      const saved = await repository().save(completedFor(id, owner), scopeFor(owner));
      expect(saved.status).toBe(MatchingRequestStatus.Completed);
      expect(saved.recommendations).toHaveLength(1);
      expect(saved.recommendations[0]?.groupId).toBe(GROUP);
      expect(saved.createdAt).toBe(created.createdAt);

      const listed = await repository().listByUserId(scopeFor(owner));
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(saved);
      // 返回对象只有端口契约的字段（没有位置、凭据、原始 AI 输入或内部评分）
      expect(Object.keys(listed[0] ?? {}).sort()).toEqual(
        [
          'createdAt',
          'degradationCode',
          'fallbackUsed',
          'id',
          'inputSnapshotHash',
          'modelVersion',
          'promptVersion',
          'recommendations',
          'status',
          'updatedAt',
          'userId',
        ].sort(),
      );

      const found = await repository().findById(id, scopeFor(owner));
      expect(found).toEqual(saved);
    }, 60_000);

    it('归属隔离：只返回请求主体的记录；跨主体覆盖写入一行都写不中，他人记录不可探测', async () => {
      const ownerA = randomUUID();
      const ownerB = randomUUID();
      const idA = randomUUID();
      const idB = randomUUID();
      createdIds.add(idA);
      createdIds.add(idB);

      await repository().create(entryFor(idA, ownerA), scopeFor(ownerA, []));
      await repository().create(entryFor(idB, ownerB), scopeFor(ownerB, []));

      const mine = await repository().listByUserId(scopeFor(ownerA, []));
      expect(mine.map((record) => record.id)).toEqual([idA]);
      const theirs = await repository().listByUserId(scopeFor(ownerB, []));
      expect(theirs.map((record) => record.id)).toEqual([idB]);

      // 覆盖写入以 id + 归属双重限定：他人的记录一行都写不中，且错误码不区分「不存在」与「属于他人」
      await expect(
        repository().save(completedFor(idB, ownerA), scopeFor(ownerA)),
      ).rejects.toMatchObject({ code: 'UPDATE_MISSING' });
      // 他人记录既未出库也未被改写
      await expect(repository().findById(idB, scopeFor(ownerA))).resolves.toBeUndefined();
      expect((await repository().findById(idB, scopeFor(ownerB)))?.status).toBe(
        MatchingRequestStatus.Pending,
      );
    }, 60_000);

    it('升级路径：不存在的记录 / 他人记录都不退化成插入，也不产生新行', async () => {
      const ownerA = randomUUID();
      const ownerB = randomUUID();
      const idB = randomUUID();
      createdIds.add(idB);
      await repository().create(entryFor(idB, ownerB), scopeFor(ownerB));

      const missingId = randomUUID();
      await expect(
        repository().save(completedFor(missingId, ownerA), scopeFor(ownerA)),
      ).rejects.toMatchObject({ code: 'UPDATE_MISSING' });

      const all = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${POSTGRES_MATCHING_TABLE} WHERE id IN ($1::uuid, $2::uuid)`,
        [missingId, idB],
      );
      expect(all[0]?.count).toBe('1');
    }, 60_000);

    it('主键冲突：同 ID 第二次 create 抛 CONFLICT，且不覆盖既有记录', async () => {
      const owner = randomUUID();
      const id = randomUUID();
      createdIds.add(id);

      await repository().create(entryFor(id, owner), scopeFor(owner, []));
      // 同 ID 再写入入口记录：主键冲突必须显式暴露（`ON CONFLICT DO NOTHING` 无返回行）
      await expect(
        repository().create(entryFor(id, owner), scopeFor(owner, [])),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      const stored = await repository().findById(id, scopeFor(owner, []));
      expect(stored?.status).toBe(MatchingRequestStatus.Pending);
      expect(stored?.recommendations).toEqual([]);
    }, 60_000);

    it('存储 ID 域在进 SQL 之前判定：非 UUID 主体 / 记录 / 小组 fail-closed，且不产生任何行', async () => {
      const owner = randomUUID();
      const id = randomUUID();
      const before = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${POSTGRES_MATCHING_TABLE}`,
      );

      // 会话基线形状的主体（`u-student-1`）不是存储 ID 域内的标识
      await expect(
        repository().listByUserId({ ownerUserId: 'u-student-1', authorizedGroupIds: [] }),
      ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
      await expect(
        repository().create(entryFor(randomUUID(), 'u-student-1'), {
          ownerUserId: 'u-student-1',
          authorizedGroupIds: [],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
      // 非 UUID 的记录 ID 与小组标识同样属于服务端缺陷
      await expect(
        repository().create(entryFor('not-a-uuid', owner), scopeFor(owner)),
      ).rejects.toMatchObject({ code: 'INVALID_RECORD' });
      await expect(repository().listByUserId(scopeFor(owner, ['g-1']))).rejects.toMatchObject({
        code: 'INVALID_SCOPE',
      });

      const after = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${POSTGRES_MATCHING_TABLE}`,
      );
      expect(after[0]?.count).toBe(before[0]?.count);
      void id;
    }, 60_000);

    it('小组授权边界：库中记录含未授权小组时 fail-closed（不静默过滤）', async () => {
      const owner = randomUUID();
      const id = randomUUID();
      await seedRow(owner, id, {
        status: MatchingRequestStatus.Completed,
        recommendations: JSON.stringify([
          { groupId: OTHER_GROUP, score: 70, reason: '方向一致', advice: '补齐技能' },
        ]),
        degradation_code: AiErrorCode.Disabled,
      });

      let captured: unknown;
      try {
        await repository().listByUserId(scopeFor(owner, [GROUP]));
      } catch (error) {
        captured = error;
      }
      expect(captured).toMatchObject({ code: 'GROUP_SCOPE_VIOLATION' });
      const serialized = JSON.stringify(captured, Object.getOwnPropertyNames(captured ?? {}));
      expect(serialized).not.toContain(OTHER_GROUP);

      // 把该小组纳入授权集合后可以正常读出（证明上面的拒绝来自授权边界，而不是「一律拒绝」）
      const listed = await repository().listByUserId(scopeFor(owner, [GROUP, OTHER_GROUP]));
      expect(listed.map((record) => record.id)).toEqual([id]);
      expect(listed[0]?.recommendations[0]?.groupId).toBe(OTHER_GROUP);
    }, 60_000);

    it('绕过应用层也写不坏：非法状态 / 坏摘要 / 未知降级码 / 空 UUID 归属被存储层拒绝', async () => {
      const owner = randomUUID();
      const cases: readonly Record<string, unknown>[] = [
        { status: 'unknown_status' },
        { input_snapshot_hash: 'plain' },
        { degradation_code: 'AI_NOT_REGISTERED' },
        { model_version: '' },
        { profile_version: 0 },
        { user_id: '00000000-0000-0000-0000-000000000000' },
        // 迁移 0014 的四条守卫：主键非空、结果行必须是 jsonb 数组、条数上界（MATCHING_MAX_RECOMMENDATIONS=3）
        { id: '00000000-0000-0000-0000-000000000000' },
        { recommendations: JSON.stringify({ groupId: GROUP, score: 80 }) },
        {
          recommendations: JSON.stringify(
            Array.from({ length: 4 }, (_unused, index) => ({
              groupId: GROUP,
              score: 80,
              reason: `规则理由 ${index}`,
              advice: `规则建议 ${index}`,
            })),
          ),
        },
      ];

      for (const overrides of cases) {
        const id = randomUUID();
        // 失败的行不应留下记录：只有成功插入才登记进清理集合
        let inserted = false;
        let sqlState: string | undefined;
        try {
          await seedRow(owner, id, overrides);
          inserted = true;
        } catch (error) {
          // 执行器错误只外发**可外发的诊断事实**（SQLSTATE），不回显 SQL / 取值
          sqlState = (error as { issues?: readonly { code?: string }[] }).issues?.[0]?.code;
        }
        expect(inserted, JSON.stringify(overrides)).toBe(false);
        // 23514 = CHECK 违约，23502 = NOT NULL 违约，22P02 = 非法文本表示（UUID 形状）
        expect(sqlState ?? '', JSON.stringify(overrides)).toMatch(/^(?:23514|23502|22P02)$/u);
      }

      // 合法行可以写入（证明上面的拒绝来自存储层约束，而不是「谁都写不进」）
      const okId = randomUUID();
      await seedRow(owner, okId);
      await expect(repository().findById(okId, scopeFor(owner, []))).resolves.toMatchObject({
        id: okId,
      });
    }, 60_000);

    it('模块换绑工厂 + 真实执行器：createMatchingRepository 在真库上端到端闭环', async () => {
      const owner = randomUUID();
      const id = randomUUID();
      createdIds.add(id);

      const factory: SqlConnectionFactory = {
        capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
        connect: (): Promise<SqlConnection> => Promise.resolve(connection as SqlConnection),
      };
      const repositoryFromModule = createMatchingRepository(
        loadEnv({ NODE_ENV: 'test', DATABASE_URL: RAW_URL as string }),
        factory,
      );

      expect(repositoryFromModule.capabilities).toMatchObject({
        backend: MATCHING_REPOSITORY_BACKEND_POSTGRES,
        persistent: true,
        productionReady: false,
      });

      // 延迟建连 + 真实读写：入口记录 → 终态推进 → 按主体取数
      await expect(
        repositoryFromModule.create(entryFor(id, owner), scopeFor(owner)),
      ).resolves.toMatchObject({ id, status: MatchingRequestStatus.Pending });
      await expect(
        repositoryFromModule.save(completedFor(id, owner), scopeFor(owner)),
      ).resolves.toMatchObject({ id, status: MatchingRequestStatus.Completed });
      const listed = await repositoryFromModule.listByUserId(scopeFor(owner));
      expect(listed.map((record) => record.id)).toEqual([id]);

      // 存储 ID 域先判：非 UUID 主体在**解析执行器之前**就被拒绝（不建立任何连接）
      let connects = 0;
      const countingFactory: SqlConnectionFactory = {
        capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
        connect: (): Promise<SqlConnection> => {
          connects += 1;
          return Promise.resolve(connection as SqlConnection);
        },
      };
      const guarded = createMatchingRepository(
        loadEnv({ NODE_ENV: 'test', DATABASE_URL: RAW_URL as string }),
        countingFactory,
      );
      await expect(
        guarded.listByUserId({ ownerUserId: 'u-student-1', authorizedGroupIds: [] }),
      ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
      expect(connects).toBe(0);
    }, 90_000);

    it('执行器形态契约：adapter 只依赖 SqlExecutor（真库里不出现 DDL / 删除语句）', async () => {
      // 通过代理执行器记录真实执行的语句：本切片的 SQL 只能是 INSERT / UPDATE / SELECT
      const statements: string[] = [];
      const spy: SqlExecutor = {
        capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
        query: (sql, parameters) => {
          statements.push(sql.trim().split(/\s+/u)[0]?.toUpperCase() ?? '');
          return (connection as SqlConnection).query(sql, parameters);
        },
      };
      const owner = randomUUID();
      const id = randomUUID();
      createdIds.add(id);

      const spyRepository = new PostgresMatchingRepository(spy);
      await spyRepository.create(entryFor(id, owner), scopeFor(owner, []));
      await spyRepository.save(completedFor(id, owner), scopeFor(owner));
      await spyRepository.listByUserId(scopeFor(owner));

      // create + save + listByUserId 三条真实语句，且全部属于 INSERT / UPDATE / SELECT
      expect(statements.length).toBeGreaterThanOrEqual(3);
      expect([...new Set(statements)]).toEqual(['INSERT', 'UPDATE', 'SELECT']);
    }, 60_000);

    it('状态 / 结果行契约：结果行恰好是白名单四字段；状态与条数不自洽、结果含未登记键都在进 SQL 之前被拒且不留行', async () => {
      const owner = randomUUID();
      const id = randomUUID();
      createdIds.add(id);

      // 1) 真实落库的结果行：行键集合恰好是 adapter 的 12 个输出列，结果条目恰好是白名单四字段
      await repository().create(entryFor(id, owner), scopeFor(owner));
      await repository().save(completedFor(id, owner), scopeFor(owner));

      const rows = await query<Record<string, unknown>>(
        `SELECT * FROM ${POSTGRES_MATCHING_TABLE} WHERE id = $1::uuid`,
        [id],
      );
      expect(rows).toHaveLength(1);
      const row = rows[0] ?? {};
      // 真实行的键集合与 adapter 的列清单**完全相等**：原始 AI 输入 / 提示词 / 模型 payload /
      // PII / 内部评分 / 审核 / 簿记列在结构上就不可能出现在结果行里
      expect(Object.keys(row).sort()).toEqual([...POSTGRES_MATCHING_COLUMNS].sort());
      expect(row['status']).toBe(MatchingRequestStatus.Completed);
      expect(row['fallback_used']).toBe(true);

      const storedItems = row['recommendations'] as readonly Record<string, unknown>[];
      expect(Array.isArray(storedItems)).toBe(true);
      expect(storedItems).toHaveLength(1);
      // 落库的条目键恰好是 groupId / score / reason / advice：模型原始 payload 与内部评分明细
      // 既不进 SELECT / INSERT / RETURNING，也不会以未登记键的形式写进 jsonb
      expect(Object.keys(storedItems[0] ?? {}).sort()).toEqual([
        'advice',
        'groupId',
        'reason',
        'score',
      ]);

      // 2) 记录级不自洽：进 SQL 之前 fail-closed（`INVALID_RECORD`），一行都不留
      const countAll = async (): Promise<string> => {
        const counted = await query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${POSTGRES_MATCHING_TABLE}`,
        );
        return counted[0]?.count ?? '-1';
      };
      const before = await countAll();
      const illegalId = randomUUID();
      const completed = completedFor(illegalId, owner);
      const inconsistent = [
        // completed 却没有任何推荐结果（状态与条数矛盾）
        { ...completed, recommendations: [] },
        // 入口态却携带推荐结果（绕过状态机）
        { ...entryFor(illegalId, owner), recommendations: completed.recommendations },
        // 声明未降级却携带降级原因码
        { ...completed, fallbackUsed: false },
      ] as readonly MatchingRequest[];
      for (const record of inconsistent) {
        await expect(
          repository().save(record, scopeFor(owner)),
          JSON.stringify(record.recommendations.length),
        ).rejects.toMatchObject({ code: 'INVALID_RECORD' });
      }

      // 3) 模型原始输出混进推荐条目（未登记键）：整条记录 fail-closed，而不是静默丢弃后照常落库
      const polluted = {
        ...completed,
        recommendations: [
          {
            groupId: GROUP,
            score: 88,
            reason: '方向一致，技能基本匹配',
            advice: '建议补齐缺失技能',
            rawModelOutput: MODEL_PAYLOAD_SENTINEL,
          },
        ],
      } as unknown as MatchingRequest;
      await expect(repository().save(polluted, scopeFor(owner))).rejects.toMatchObject({
        code: 'INVALID_RECORD',
      });

      // 全部拒绝路径都没有产生新行，且被拒的模型原文在整张表里一次都不出现
      expect(await countAll()).toBe(before);
      expect(await countRowsMentioning(MODEL_PAYLOAD_SENTINEL)).toBe('0');
    }, 60_000);

    it('AI 禁用 / 输出非法时不落敏感内容：真实 service + 真实仓储只留下规则结果与稳定降级码', async () => {
      const guard = new AuthorizationGuard(
        new BaselineRuoYiAuthzAdapter(new AuthorizationPolicy()),
      );

      /** 已脱敏的最小召回快照：候选小组 ID 必须落在存储 ID 域内（UUID），否则仓储 fail-closed */
      const bundleFor = (groupId: string): MatchFeatureBundle => ({
        student: {
          grade: Grade.Junior,
          major: '软件工程',
          skills: ['TypeScript', 'PostgreSQL'],
          programmingLevel: ProgrammingLevel.Intermediate,
          researchInterests: ['机器学习'],
          intendedFields: ['人工智能'],
          weeklyHours: 12,
          availablePeriods: [AvailablePeriod.Weekend],
        },
        candidates: [
          {
            groupId,
            name: '机器学习小组',
            researchDirections: ['机器学习'],
            requiredSkills: ['TypeScript'],
            grades: [Grade.Junior, Grade.Senior],
            minWeeklyHours: 8,
            headcount: 6,
            memberCount: 3,
            status: GroupStatus.Open,
          },
        ],
      });

      /**
       * 用**真实 service** 跑一次「发起本人匹配请求」：真实授权守卫 + 真实 PostgreSQL 仓储
       * （`PostgresMatchingRepository`）+ 真实 AI 适配层（`@rm/ai-adapter` 的调用与降级逻辑）。
       * 归属是 UUID（存储 ID 域内），因此这条路径真的会落库，而不是被适配器挡在 SQL 之前。
       */
      const runThroughService = async (
        owner: string,
        aiEnabled: boolean,
        providerResult?: unknown,
      ): Promise<{
        id: string;
        fallbackUsed: boolean;
        degradationCode?: string;
        payload: string;
      }> => {
        const env = loadEnv({
          NODE_ENV: 'test',
          AI_MATCHING_ENABLED: aiEnabled ? 'true' : 'false',
          AI_PROVIDER: 'mock',
          AI_MODEL: 'test-model',
        });
        const features = new InMemoryMatchingFeatureSource(env);
        features.seed(owner, bundleFor(GROUP));
        const service = new MatchingService(
          guard,
          repository() as MatchingRepository,
          features,
          createMockProvider(providerResult === undefined ? {} : { result: providerResult }),
          env,
        );
        const view = await service.createMyMatchingRequest(
          { userId: owner, roles: [Role.Student] },
          {},
        );
        return {
          id: view.id,
          fallbackUsed: view.fallbackUsed,
          ...(view.degradationCode !== undefined ? { degradationCode: view.degradationCode } : {}),
          payload: JSON.stringify(view),
        };
      };

      // 1) AI 明确关闭：适配层不调用模型，规则结果 + 稳定降级码，且降级原因来自登记在案的闭集
      const disabledRun = await runThroughService(randomUUID(), false);
      createdIds.add(disabledRun.id);
      expect(disabledRun.fallbackUsed).toBe(true);
      expect(disabledRun.degradationCode).toBe(AiErrorCode.Disabled);

      // 2) 模型输出非法（理由里含个人标识手机号，且条目带模型原始输出与提示词正文的未登记键）：
      //    模型结果被整体丢弃并按规则重算，原文既不出现在结果里，也不随降级路径回传
      const illegalRun = await runThroughService(randomUUID(), true, {
        recommendations: [
          {
            groupId: GROUP,
            score: 99,
            reason: `参照手机号 ${PII_SENTINEL} 直接推荐`,
            advice: '建议联系负责人',
            rawModelOutput: MODEL_PAYLOAD_SENTINEL,
            systemPrompt: PROMPT_SENTINEL,
          },
        ],
      });
      createdIds.add(illegalRun.id);
      expect(illegalRun.fallbackUsed).toBe(true);
      expect(Object.values(AiErrorCode)).toContain(illegalRun.degradationCode);

      for (const sentinel of [PII_SENTINEL, MODEL_PAYLOAD_SENTINEL, PROMPT_SENTINEL]) {
        expect(illegalRun.payload).not.toContain(sentinel);
      }

      // 3) 真库复核：两条记录的行键集合恰好是 12 个输出列（没有任何内部列），
      //    且提示词正文 / 模型原始输出 / 个人标识在**整张表**里一次都不出现
      for (const id of [disabledRun.id, illegalRun.id]) {
        const rows = await query<Record<string, unknown>>(
          `SELECT * FROM ${POSTGRES_MATCHING_TABLE} WHERE id = $1::uuid`,
          [id],
        );
        expect(rows).toHaveLength(1);
        const row = rows[0] ?? {};
        expect(Object.keys(row).sort()).toEqual([...POSTGRES_MATCHING_COLUMNS].sort());
        for (const internal of POSTGRES_MATCHING_INTERNAL_COLUMNS) {
          expect(row).not.toHaveProperty(internal);
        }
        // 降级路径同样写的是闭集状态与降级码
        expect(row['fallback_used']).toBe(true);
        expect([MatchingRequestStatus.Completed, MatchingRequestStatus.NoCandidate]).toContain(
          row['status'],
        );
      }
      for (const sentinel of [PII_SENTINEL, MODEL_PAYLOAD_SENTINEL, PROMPT_SENTINEL]) {
        expect(await countRowsMentioning(sentinel)).toBe('0');
      }
    }, 90_000);
  },
);
