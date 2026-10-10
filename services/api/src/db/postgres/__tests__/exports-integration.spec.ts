import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { PostgresExecutorError } from '../postgres-error';
import type { SqlConnection, SqlExecutor } from '../../ports/sql-executor.port';
import { EXPORTABLE_FIELDS } from '../../../modules/exports/exports.contract';
import { createExportRepository } from '../../../modules/exports/exports.module';
import {
  POSTGRES_EXPORT_COLUMNS,
  POSTGRES_EXPORT_INTERNAL_COLUMNS,
  POSTGRES_EXPORT_TABLE,
  PostgresExportRepository,
} from '../../../modules/exports/exports.postgres-repository';
import {
  ExportResource,
  ExportStatus,
  type ExportRequest,
} from '../../../modules/exports/exports.port';

/**
 * 导出请求（`export_jobs`）的**真实 PostgreSQL 集成**（WSL2 / Docker Compose 提供的开发库）。
 *
 * ## 为什么必须显式启用
 * 未提供 `TEST_DATABASE_URL`（或库名含 `test` 的 `DATABASE_URL`）时整个套件**明确 skip**，
 * 绝不伪造通过；提供了但连不上、或目标库名不含 `test` 时**失败**（本套件执行迁移与 DDL）。
 * 与 `postgres-integration.spec.ts` / `compliance-integration.spec.ts` / `audit-integration.spec.ts` /
 * `notifications-integration.spec.ts` / `groups-integration.spec.ts` 同一套启用口径。
 *
 * ## 断言的硬性质（离线 spec 无法证明、必须在真库上闭环的）
 * 1. **schema 由仓库真实迁移建立**：`export_jobs` 由迁移 `0013` 建出、服务端有效期列 `expires_at`
 *    由迁移 `0015` 补出，列清单**恰好**是 adapter 的 9 个输出列（一个内部列都没有，且
 *    `expires_at` 是 `timestamptz` + **可空**）；主键是 `id`；`(requester_id, created_at, id)`
 *    取数索引、状态闭集 / 归属非空 UUID / 产物与状态自洽 / 「有效期必须晚于创建时间」的 CHECK 齐备；
 * 2. **读写闭环**：`create`（入口恒为 `pending`，服务端有效期随创建落库）→ `save`（推进到
 *    `completed` 并落服务端短引用，**不改写有效期**）→ `listByOwnerId` 逐字段往返，
 *    且返回对象**只有**端口契约的字段（没有任何位置 / 凭据 / 签名）；
 * 3. **服务端有效期的存储语义**：`NULL` 往返为「字段缺省」（下载边界据此 fail-closed），
 *    非空值按 `timestamptz` 与 UTC ISO 无损互转；`expires_at <= created_at` 被存储层 CHECK 拒绝；
 * 4. **迁移可逆**：`0015` 的回滚 DDL（`DROP COLUMN IF EXISTS expires_at`）从迁移文件本身取出，
 *    在真实事务里执行并核对，随后整体回滚（演练不改变真实 schema）；
 * 5. **归属隔离**：库里同时存在多个主体时只返回请求主体的记录；跨主体写回**一行都写不中**
 *    （`NOT_FOUND`，不外泄「该 ID 属于他人」），他人记录既不出库也不回流；
 * 6. **主键冲突**：同 ID 第二次 `create` 抛 `CONFLICT`，不静默覆盖既有导出请求；
 * 7. **条件写入**：重复推进同一请求抛 `TRANSITION_REJECTED`，且**历史结论逐字段不变**
 *    （终态不被覆盖）；
 * 8. **绕过应用层也写不坏**：非法状态 / 非法资源 / 空字段数组 / 空 UUID / 状态与产物短引用不自洽
 *    一律被存储层 CHECK（23514）或 NOT NULL 拒绝；
 * 9. **存储 ID 域在进 SQL 之前判定**：非 UUID 主体 fail-closed（`INVALID_SUBJECT`），
 *    且不产生任何行；
 * 10. **模块换绑工厂 + 真实执行器**：`createExportRepository` 在真库上直接闭环
 *    （这是「数据库已配置 ⇒ 导出端口走 PostgreSQL 实现」的端到端证据）。
 *
 * ## 为什么需要清理行
 * 与只追加的审计表不同，本表是可变的业务表，因此本套件在 `afterAll` 里按**本次运行写入的主键
 * 集合**清理，保证重复运行不会把上一次的行当成夹具。
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
  describe('真实 PostgreSQL 导出请求集成（未启用）', () => {
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

function newOwner(): string {
  return randomUUID();
}

/** 从服务端字段白名单派生，避免把「合法字段」抄成两份真相 */
const FIELDS = EXPORTABLE_FIELDS[ExportResource.Profile].slice(0, 2);

/**
 * 服务端有效期样本（UTC 绝对时刻，**晚于**下面的 `createdAt`）：与迁移 `0015` 的
 * `expires_at > created_at` 不变式一致。刻意用固定值而不是「当前时刻 + 1 小时」：
 * 本套件的 `createdAt` 是固定值，两者的相对关系必须与真实时钟无关（否则用例会随运行时间漂移）。
 */
const EXPIRES_AT = '2026-10-10T04:00:00.000Z';

/** 基础 INSERT（**不带** expires_at）：该列留空 ⇒ 存储 NULL，用于「历史行 / 未签发有效期」的分支 */
const INSERT_SQL = `INSERT INTO export_jobs
  (id, requester_id, resource, fields, status, artifact_id, created_at, updated_at)
  VALUES ($1::uuid, $2::uuid, $3, $4::text[], $5, $6::uuid, now(), now())`;

/**
 * 带服务端有效期的 INSERT：`created_at`（`$8`）与 `updated_at`（`$9`）都显式给定，
 * 因此「有效期与创建时间的先后关系」可以被精确构造（用于正向往返与 CHECK 反例）。
 * 两个时间列**各自占一个占位符**（不复用 `$8`）：执行器把「同一序号出现两次」判为
 * `PARAMETER_SLOT_DUPLICATE` 并拒绝执行，这里遵守同一口径。
 */
const INSERT_WITH_EXPIRY_SQL = `INSERT INTO export_jobs
  (id, requester_id, resource, fields, status, artifact_id, expires_at, created_at, updated_at)
  VALUES ($1::uuid, $2::uuid, $3, $4::text[], $5, $6::uuid, $7::timestamptz, $8::timestamptz, $9::timestamptz)`;

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
  options: {
    readonly status?: ExportStatus;
    readonly artifactId?: string | null;
    readonly resource?: ExportResource;
  } = {},
): Promise<string> {
  const id = randomUUID();
  createdIds.add(id);
  await (connection as SqlConnection).query(INSERT_SQL, [
    id,
    ownerUserId,
    options.resource ?? ExportResource.Profile,
    [...FIELDS],
    options.status ?? ExportStatus.Pending,
    options.artifactId ?? null,
  ]);
  return id;
}

function repository(): PostgresExportRepository {
  return new PostgresExportRepository(connection as SqlConnection);
}

/** 领域记录夹具：与 adapter 的输出形态逐字段一致 */
function recordFor(
  id: string,
  ownerUserId: string,
  overrides: Partial<ExportRequest> = {},
): ExportRequest {
  return {
    id,
    ownerUserId,
    resource: ExportResource.Profile,
    fields: [...FIELDS],
    status: ExportStatus.Pending,
    expiresAt: EXPIRES_AT,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    ...overrides,
  };
}

integrationDescribe(
  '真实 PostgreSQL 导出请求集成（TEST_DATABASE_URL / 测试库 DATABASE_URL）',
  () => {
    beforeAll(async () => {
      if (!ENABLED || RAW_URL === undefined) {
        return;
      }
      const resolution = resolveDatabaseConfig({
        NODE_ENV: 'test',
        DATABASE_URL: RAW_URL,
        DATABASE_APPLICATION_NAME: 'researcher-manager-exports-integration',
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
        appliedBy: 'exports-integration-test',
      });
      if (applied.guard.violations.length > 0) {
        throw new Error('测试前置失败：真实迁移未通过部署守卫');
      }
    }, 90_000);

    afterAll(async () => {
      if (connection !== undefined && createdIds.size > 0) {
        // 只清理本次运行写入的主键：不触碰其它数据，也不做整表截断
        await connection.query('DELETE FROM export_jobs WHERE id = ANY($1::uuid[])', [
          [...createdIds],
        ]);
      }
      if (connection !== undefined) {
        await connection.close();
      }
    });

    it('export_jobs 由迁移 0013 + 0015 建立：列清单恰好是 adapter 的 9 列，且一个内部列都没有', async () => {
      const exists = await query<{ exists: boolean }>(
        'SELECT to_regclass($1::text) IS NOT NULL AS exists',
        [`public.${POSTGRES_EXPORT_TABLE}`],
      );
      expect(exists[0]?.exists).toBe(true);

      const columns = await query<{ column_name: string; data_type: string; is_nullable: string }>(
        'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        ['public', POSTGRES_EXPORT_TABLE],
      );
      const names = columns.map((row) => row.column_name).sort();
      // 表列清单与 adapter 的输出列清单**必须完全相等**：
      // 多一列就意味着有人把路径 / 凭据 / 签名 / 原始 PII 塞进了存储
      expect(names).toEqual([...POSTGRES_EXPORT_COLUMNS].sort());
      // 显式复核：全部内部列（产物位置 / 文件体 / 内部资源 / 筛选 / 原始错误 / 簿记）一列都不存在
      for (const internal of POSTGRES_EXPORT_INTERNAL_COLUMNS) {
        expect(names).not.toContain(internal);
      }
      for (const pii of ['phone', 'id_card', 'student_no', 'email', 'name']) {
        expect(names).not.toContain(pii);
      }

      // 服务端有效期列由迁移 0015 补出：必须是 `timestamptz`（绝对时刻，无时区歧义）且**可空**
      // —— 可空是 fail-closed 语义的一部分（NULL = 没有服务端有效期 ⇒ 下载边界拒绝），
      // 而不是「忘了加 NOT NULL」。
      const expiry = columns.find((row) => row.column_name === 'expires_at');
      expect(expiry).toBeDefined();
      expect(expiry?.data_type).toBe('timestamp with time zone');
      expect(expiry?.is_nullable).toBe('YES');

      const primaryKey = await query<{ column_name: string }>(
        `SELECT a.attname AS column_name
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'public.export_jobs'::regclass AND i.indisprimary`,
      );
      expect(primaryKey.map((row) => row.column_name)).toEqual(['id']);

      // 取数索引覆盖 adapter 的 ORDER_BY（created_at ASC, id ASC）与归属谓词
      const indexes = await query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
        [POSTGRES_EXPORT_TABLE],
      );
      const ownerIndex = indexes.find(
        (row) => row.indexname === 'idx_export_jobs_requester_created',
      );
      expect(ownerIndex?.indexdef).toMatch(/requester_id/iu);
      expect(ownerIndex?.indexdef).toMatch(/created_at/iu);

      // 存储层 CHECK 镜像 adapter 契约：状态 / 资源闭集、产物与状态自洽、非空 UUID、字段非空，
      // 以及 0015 补出的「有效期必须在创建时间之后」（NULL 放行）
      const constraints = await query<{ conname: string; definition: string | null }>(
        `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
           FROM pg_constraint c
          WHERE c.conrelid = 'public.export_jobs'::regclass AND c.contype = 'c'`,
      );
      const constraintNames = constraints.map((row) => row.conname);
      for (const expected of [
        'export_jobs_resource_check',
        'export_jobs_status_check',
        'export_jobs_artifact_matches_status',
        'export_jobs_fields_not_empty',
        'export_jobs_id_not_nil',
        'export_jobs_requester_id_not_nil',
        'export_jobs_artifact_id_not_nil',
        'export_jobs_expires_at_after_created_at',
      ]) {
        expect(constraintNames).toContain(expected);
      }
      const expiryCheck = constraints.find(
        (row) => row.conname === 'export_jobs_expires_at_after_created_at',
      );
      // NULL 必须放行（fail-closed 的合法存储形态），因此约束定义里必须有 IS NULL 分支
      expect(expiryCheck?.definition).toMatch(/expires_at IS NULL/iu);
      expect(expiryCheck?.definition).toMatch(/expires_at > created_at/iu);
    }, 60_000);

    it('读写闭环：create（入口 pending）→ save（推进 completed + 服务端短引用）→ 按主体取数逐字段往返', async () => {
      const owner = newOwner();
      const id = randomUUID();
      createdIds.add(id);

      const entry = await repository().create(recordFor(id, owner));
      expect(entry.status).toBe(ExportStatus.Pending);
      expect(entry.artifactId).toBeUndefined();
      expect(entry.ownerUserId).toBe(owner);
      // 服务端有效期随创建写入并如实读回（UTC ISO 形态）
      expect(entry.expiresAt).toBe(EXPIRES_AT);

      // 库里确实只有一条 pending，且没有产物短引用，有效期已经落库
      const stored = await query<{ status: string; artifact_id: string | null; expires_at: Date }>(
        'SELECT status, artifact_id, expires_at FROM export_jobs WHERE id = $1::uuid',
        [id],
      );
      expect(stored[0]?.status).toBe(ExportStatus.Pending);
      expect(stored[0]?.artifact_id).toBeNull();
      expect(stored[0]?.expires_at.toISOString()).toBe(EXPIRES_AT);

      const artifactId = randomUUID();
      const completed = await repository().save({
        ...entry,
        status: ExportStatus.Completed,
        artifactId,
        updatedAt: '2026-10-10T00:00:01.000Z',
      });
      expect(completed.status).toBe(ExportStatus.Completed);
      expect(completed.artifactId).toBe(artifactId);
      // 写回不得改写服务端有效期（不可变列）
      expect(completed.expiresAt).toBe(EXPIRES_AT);

      // 按主体取数：逐字段往返，且返回对象**只有**端口契约的字段
      const mine = await repository().listByOwnerId(owner);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toEqual(completed);
      expect(Object.keys(mine[0] ?? {}).sort()).toEqual([
        'artifactId',
        'createdAt',
        'expiresAt',
        'fields',
        'id',
        'ownerUserId',
        'resource',
        'status',
        'updatedAt',
      ]);
      // 位置 / 凭据 / 签名 / 原始 PII 字段名一个都不在返回对象上
      // （`expiresAt` **在**返回对象上：它是服务端有效期，下载边界需要它做判定；
      //   它只是不进入公开视图，因此它在上面的字段清单里、不在这份禁止清单里）
      for (const forbidden of [
        'fileName',
        'filePath',
        'downloadUrl',
        'signedUrl',
        'storageKey',
        'objectKey',
        'storageHandle',
        'content',
        'checksum',
        'resourceSnapshot',
        'filters',
        'errorMessage',
        'downloadedAt',
        'idempotencyKey',
        'phone',
        'idCard',
      ]) {
        expect(mine[0]).not.toHaveProperty(forbidden);
      }
      // 时间取服务端时钟（save 改写了 updatedAt），且是 ISO 形态
      expect(mine[0]?.updatedAt).toBe('2026-10-10T00:00:01.000Z');
    }, 60_000);

    it('服务端有效期：NULL 往返为「字段缺省」，且「有效期必须晚于创建时间」由存储层强制', async () => {
      const owner = newOwner();

      // 1) 没有服务端有效期（绕过 adapter 直接落 NULL，模拟 0015 之前的历史行）：
      //    读回来是**字段缺省**，而不是空串 / 哨兵值 —— 下载边界据此 fail-closed
      const legacyId = await seedRow(owner, {
        status: ExportStatus.Completed,
        artifactId: randomUUID(),
      });
      const legacy = await repository().findByIdForOwner(legacyId, owner);
      expect(legacy).toBeDefined();
      expect(legacy).not.toHaveProperty('expiresAt');
      const legacyRow = await query<{ expires_at: Date | null }>(
        'SELECT expires_at FROM export_jobs WHERE id = $1::uuid',
        [legacyId],
      );
      expect(legacyRow[0]?.expires_at).toBeNull();

      // 2) 有服务端有效期：写入 → 读出逐字节往返（`timestamptz` 与 ISO UTC 互为无损形态）
      const withExpiryId = randomUUID();
      createdIds.add(withExpiryId);
      const created = await repository().create(recordFor(withExpiryId, owner));
      expect(created.expiresAt).toBe(EXPIRES_AT);
      const readBack = await repository().findByIdForOwner(withExpiryId, owner);
      expect(readBack?.expiresAt).toBe(EXPIRES_AT);

      // 3) 存储层不变式：有效期**必须晚于创建时间**（NULL 放行）。
      //    `expires_at <= created_at` 是「一出生就过期」的写坏数据，必须被 CHECK 拒绝（23514）。
      const expectConstraintViolation = async (parameters: readonly unknown[]): Promise<string> => {
        try {
          await (connection as SqlConnection).query(INSERT_WITH_EXPIRY_SQL, parameters);
        } catch (error) {
          expect(error).toBeInstanceOf(PostgresExecutorError);
          return (error as PostgresExecutorError).issues[0]?.code ?? '';
        }
        throw new Error('存储层没有拒绝违规写入：CHECK 失效');
      };
      const baseCreatedAt = new Date('2026-10-10T00:00:00.000Z');
      const equalId = (): string => {
        const value = randomUUID();
        createdIds.add(value);
        return value;
      };
      /** `created_at` = `updated_at` = 给定时刻；`expires_at` 由调用方给出 */
      const insertWithExpiry = (
        id: string,
        expiresAt: Date,
        createdAt: Date,
      ): readonly unknown[] => [
        id,
        owner,
        ExportResource.Profile,
        [...FIELDS],
        ExportStatus.Pending,
        null,
        expiresAt.toISOString(),
        createdAt.toISOString(),
        createdAt.toISOString(),
      ];
      // 有效期恰好等于创建时间
      expect(
        await expectConstraintViolation(insertWithExpiry(equalId(), baseCreatedAt, baseCreatedAt)),
      ).toBe('23514');
      // 有效期早于创建时间
      expect(
        await expectConstraintViolation(
          insertWithExpiry(equalId(), new Date(baseCreatedAt.getTime() - 3_600_000), baseCreatedAt),
        ),
      ).toBe('23514');
      // 反向对照：有效期晚于创建时间是合法写入（证明上面的拒绝来自不变式，而不是「一律拒绝」）
      const validId = equalId();
      await (connection as SqlConnection).query(
        INSERT_WITH_EXPIRY_SQL,
        insertWithExpiry(validId, new Date(baseCreatedAt.getTime() + 3_600_000), baseCreatedAt),
      );
      const validRow = await query<{ expires_at: Date }>(
        'SELECT expires_at FROM export_jobs WHERE id = $1::uuid',
        [validId],
      );
      expect(validRow[0]?.expires_at.toISOString()).toBe('2026-10-10T01:00:00.000Z');
    }, 60_000);

    it('迁移 0015 可逆：回滚 DDL 能真的把 expires_at 卸掉（在事务里演练，不动真实 schema）', async () => {
      // 「可回滚」不是注释里的一句话：本用例把迁移头部登记的**回滚 DDL** 取出来，
      // 在一次真实事务里执行并核对效果，然后整体 ROLLBACK —— 因此演练完 schema 逐列不变。
      const migrationPath = resolveMigrationsDirectory();
      const source = readFileSync(join(migrationPath, '0015_export_jobs_expiry.sql'), 'utf8');

      // 回滚 DDL 必须真的写在迁移里（提取而不是另抄一份，避免两份真相漂移）
      const rollbackMatch =
        /ALTER\s+TABLE\s+export_jobs\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+expires_at/iu.exec(source);
      expect(rollbackMatch?.[0]).toBeDefined();

      const columnExists = async (executor: SqlExecutor): Promise<boolean> => {
        const rows = await executor.query<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'expires_at'
           ) AS present`,
          [POSTGRES_EXPORT_TABLE],
        );
        return rows.rows[0]?.present === true;
      };

      // 演练必须**整体回滚**：`transaction()` 只在回调抛错时才 ROLLBACK，因此这里刻意抛出一个
      // 哨兵错误 —— 若回调正常返回，事务会 COMMIT，回滚 DDL 就会被真的提交（把真实 schema 改坏）。
      // 这也是「回滚 DDL 只能用于降级演练、不能顺手提交」这条纪律的可执行形态。
      const ROLLBACK_SENTINEL = 'RM_EXPORT_0015_ROLLBACK_DRILL';
      await expect(
        (connection as SqlConnection).transaction(async (executor) => {
          expect(await columnExists(executor)).toBe(true);
          // 回滚语句由迁移文件本身给出（正则大小写不敏感，这里按文件原文执行）
          await executor.query(rollbackMatch?.[0] ?? '');
          expect(await columnExists(executor)).toBe(false);
          throw new Error(ROLLBACK_SENTINEL);
        }),
      ).rejects.toThrow(ROLLBACK_SENTINEL);
      // 事务已回滚：真实 schema 仍然有该列（演练不产生持久影响）
      expect(await columnExists(connection as SqlConnection)).toBe(true);
    }, 60_000);

    it('归属隔离：多个主体同表时只返回请求主体的记录；跨主体写回一行都写不中，他人记录不出库', async () => {
      const mine = newOwner();
      const other = newOwner();
      const mineId = await seedRow(mine);
      const otherId = await seedRow(other, {
        status: ExportStatus.Completed,
        artifactId: randomUUID(),
      });

      const mineRecords = await repository().listByOwnerId(mine);
      expect(mineRecords.map((record) => record.id)).toEqual([mineId]);
      const otherRecords = await repository().listByOwnerId(other);
      expect(otherRecords.map((record) => record.id)).toEqual([otherId]);
      // 序列化后的结果里不得出现对方的归属或主键
      expect(JSON.stringify(mineRecords)).not.toContain(other);
      expect(JSON.stringify(mineRecords)).not.toContain(otherId);

      // 拿他人的作业 ID 写回：`WHERE id = $1 AND requester_id = $2` 双重限定 ⇒ 0 行 ⇒ NOT_FOUND，
      // 且**不外泄**「该 ID 属于他人」这一事实（与内存基线「不存在时拒绝写入」同语义）
      let captured: unknown;
      try {
        await repository().save(
          recordFor(otherId, mine, { status: ExportStatus.Completed, artifactId: randomUUID() }),
        );
      } catch (error) {
        captured = error;
      }
      expect(captured).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(captured, Object.getOwnPropertyNames(captured ?? {}))).not.toContain(
        other,
      );

      // 他人记录逐字段未被改动
      const untouched = await query<{ status: string; artifact_id: string | null }>(
        'SELECT status, artifact_id FROM export_jobs WHERE id = $1::uuid',
        [otherId],
      );
      expect(untouched[0]?.status).toBe(ExportStatus.Completed);
    }, 60_000);

    it('主键冲突：同 ID 再次 create 抛 CONFLICT，既有记录逐字段不被覆盖', async () => {
      const owner = newOwner();
      const id = randomUUID();
      createdIds.add(id);
      await repository().create(recordFor(id, owner));

      let captured: unknown;
      try {
        await repository().create(recordFor(id, owner, { fields: [...FIELDS].reverse() }));
      } catch (error) {
        captured = error;
      }
      expect(captured).toMatchObject({ code: 'CONFLICT' });

      const rows = await query<{ count: number }>(
        'SELECT count(*)::int AS count FROM export_jobs WHERE id = $1::uuid',
        [id],
      );
      expect(rows[0]?.count).toBe(1);
      const kept = await query<{ fields: string[] }>(
        'SELECT fields FROM export_jobs WHERE id = $1::uuid',
        [id],
      );
      expect(kept[0]?.fields).toEqual(FIELDS);
    }, 60_000);

    it('条件写入：重复推进终态抛 TRANSITION_REJECTED，历史结论逐字段不变（绝不覆盖）', async () => {
      const owner = newOwner();
      const artifactId = randomUUID();
      const id = await seedRow(owner, { status: ExportStatus.Completed, artifactId });

      const before = await query<Record<string, unknown>>(
        'SELECT * FROM export_jobs WHERE id = $1::uuid',
        [id],
      );

      let captured: unknown;
      try {
        await repository().save(
          recordFor(id, owner, {
            status: ExportStatus.Failed,
            updatedAt: new Date().toISOString(),
          }),
        );
      } catch (error) {
        captured = error;
      }
      expect(captured).toMatchObject({ code: 'TRANSITION_REJECTED' });

      const after = await query<Record<string, unknown>>(
        'SELECT * FROM export_jobs WHERE id = $1::uuid',
        [id],
      );
      // 终态与产物短引用都没有被改写（重复处理绝不静默改写历史结论）
      expect(after).toEqual(before);
      expect(after[0]?.['status']).toBe(ExportStatus.Completed);
      expect(after[0]?.['artifact_id']).toBe(artifactId);
    }, 60_000);

    it('存储 ID 域在进 SQL 之前判定：非 UUID 主体 / 非 UUID 主键一律 fail-closed，且不产生任何行', async () => {
      const underTest = repository();
      const countRows = async (): Promise<number> => {
        const rows = await query<{ count: number }>(
          'SELECT count(*)::int AS count FROM export_jobs',
        );
        return rows[0]?.count ?? -1;
      };
      const before = await countRows();

      for (const illegal of [
        'u-student-1',
        '',
        '11111111-1111-4111-8111-11111111111Z',
        '1;DROP',
        "11111111-1111-4111-8111-111111111111' OR '1'='1",
      ]) {
        // 取数路径的主体域断言：`INVALID_SUBJECT`
        await expect(underTest.listByOwnerId(illegal)).rejects.toMatchObject({
          code: 'INVALID_SUBJECT',
        });
        // 写入路径由**严格记录契约**先看到同一个非法归属（`INVALID_RECORD`）：两条入口都在
        // **进 SQL 之前**拒绝，只是错误码按各自的契约边界给出（运行时绑定走的延迟工厂会先判
        // 主体域 ⇒ `INVALID_SUBJECT`，见下一条用例）
        await expect(underTest.create(recordFor(randomUUID(), illegal))).rejects.toMatchObject({
          code: 'INVALID_RECORD',
        });
      }
      // 归属合法但主键不在存储 ID 域：同样在进 SQL 之前被拒绝
      const owner = newOwner();
      await expect(underTest.create(recordFor('not-a-uuid', owner))).rejects.toMatchObject({
        code: 'INVALID_RECORD',
      });

      // 全部拒绝路径**一行都没有落库**（不是「先写进去再回滚」）
      expect(await countRows()).toBe(before);
    }, 60_000);

    it('绕过应用层也写不坏：非法状态 / 资源 / 空字段 / 空 UUID / 状态与短引用不自洽被存储层拒绝', async () => {
      const run = (parameters: readonly unknown[]): Promise<unknown> =>
        (connection as SqlConnection).query(INSERT_SQL, parameters).then(
          () => {
            throw new Error('存储层没有拒绝违规写入：约束失效');
          },
          (error: unknown) => {
            expect(error).toBeInstanceOf(PostgresExecutorError);
            return (error as PostgresExecutorError).issues[0]?.code;
          },
        );

      const owner = newOwner();
      const id = (): string => {
        const value = randomUUID();
        createdIds.add(value);
        return value;
      };
      const nilUuid = '00000000-0000-0000-0000-000000000000';
      const artifact = randomUUID();

      // 非法状态取值（闭集之外）
      expect(await run([id(), owner, 'profile', [...FIELDS], 'maybe', null])).toBe('23514');
      // 非法资源取值（闭集之外）
      expect(await run([id(), owner, 'bogus', [...FIELDS], 'pending', null])).toBe('23514');
      // 空字段数组
      expect(await run([id(), owner, 'profile', [], 'pending', null])).toBe('23514');
      // 状态与产物短引用不自洽：completed 无句柄
      expect(await run([id(), owner, 'profile', [...FIELDS], 'completed', null])).toBe('23514');
      // 状态与产物短引用不自洽：pending 带句柄
      expect(await run([id(), owner, 'profile', [...FIELDS], 'pending', artifact])).toBe('23514');
      // failed 带句柄
      expect(await run([id(), owner, 'profile', [...FIELDS], 'failed', artifact])).toBe('23514');
      // 空 UUID 归属
      expect(await run([id(), nilUuid, 'profile', [...FIELDS], 'pending', null])).toBe('23514');
      // 空 UUID 主键
      expect(await run([nilUuid, owner, 'profile', [...FIELDS], 'pending', null])).toBe('23514');
      // 空 UUID 产物短引用（completed 但句柄是空 UUID）
      expect(await run([id(), owner, 'profile', [...FIELDS], 'completed', nilUuid])).toBe('23514');
    }, 60_000);

    it('模块换绑工厂 + 真实执行器：导出端口直连真实库闭环，存储 ID 域先判（非法主体不建连）', async () => {
      const owner = newOwner();
      const id = randomUUID();
      createdIds.add(id);

      let connects = 0;
      const port = createExportRepository(loadEnv({ NODE_ENV: 'test', DATABASE_URL: RAW_URL }), {
        capabilities: { backend: 'postgres', persistent: true, productionReady: false },
        connect: () => {
          connects += 1;
          return Promise.resolve(connection as SqlConnection);
        },
      });

      // 装配阶段不建连；非 UUID 主体在解析执行器之前就被拒绝，因此**仍然**没有建连
      expect(connects).toBe(0);
      await expect(port.listByOwnerId('u-student-1')).rejects.toMatchObject({
        code: 'INVALID_SUBJECT',
      });
      await expect(port.create(recordFor(randomUUID(), 'u-student-1'))).rejects.toMatchObject({
        code: 'INVALID_SUBJECT',
      });
      expect(connects).toBe(0);

      // 合法请求：建连一次并被复用，真实库上完成「创建 → 完成 → 读取」闭环
      const entry = await port.create(recordFor(id, owner));
      expect(connects).toBe(1);
      expect(entry.status).toBe(ExportStatus.Pending);

      const artifactId = randomUUID();
      const completed = await port.save({
        ...entry,
        status: ExportStatus.Completed,
        artifactId,
        updatedAt: '2026-10-10T00:00:02.000Z',
      });
      expect(completed.artifactId).toBe(artifactId);
      await expect(port.listByOwnerId(owner)).resolves.toEqual([completed]);
      expect(connects).toBe(1);

      // 另一个主体仍然看不到它（归属下推进 SQL）
      await expect(port.listByOwnerId(newOwner())).resolves.toEqual([]);
      expect(connects).toBe(1);
    }, 60_000);

    it('状态条件推进：入口态可推进到两个终态；目标为「无合法前驱」时一个 SQL 都不执行且不改写既有行', async () => {
      // 1) 前向边之一：pending -> failed（另一条 pending -> completed 已由读写闭环用例覆盖）
      const failedOwner = newOwner();
      const failedId = randomUUID();
      createdIds.add(failedId);
      // 经 create 落库，使 `created_at` 与请求记录逐字节一致（不可变列由 adapter 钉住）
      const failedEntry = await repository().create(recordFor(failedId, failedOwner));
      expect(failedEntry.status).toBe(ExportStatus.Pending);

      const failed = await repository().save({
        ...failedEntry,
        status: ExportStatus.Failed,
        updatedAt: '2026-10-10T00:00:03.000Z',
      });
      expect(failed.status).toBe(ExportStatus.Failed);
      // failed 是终态：不得携带产物短引用（与存储层 CHECK 自洽）
      expect(failed.artifactId).toBeUndefined();
      const failedRow = await query<{ status: string; artifact_id: string | null }>(
        'SELECT status, artifact_id FROM export_jobs WHERE id = $1::uuid',
        [failedId],
      );
      expect(failedRow[0]?.status).toBe(ExportStatus.Failed);
      expect(failedRow[0]?.artifact_id).toBeNull();

      // 2) 目标状态没有合法前驱（入口状态 pending）：在**访问数据库之前** fail-closed。
      //    用代理执行器记录真实执行的语句：拒绝路径必须一个 SQL 都不下发（不是「先查再拒」）
      const statements: string[] = [];
      const spy: SqlExecutor = {
        capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
        query: (sql, parameters) => {
          statements.push(sql.trim().split(/\s+/u)[0]?.toUpperCase() ?? '');
          return (connection as SqlConnection).query(sql, parameters);
        },
      };
      const pendingOwner = newOwner();
      const pendingId = randomUUID();
      createdIds.add(pendingId);
      const pendingEntry = await repository().create(recordFor(pendingId, pendingOwner));
      const before = await query<Record<string, unknown>>(
        'SELECT * FROM export_jobs WHERE id = $1::uuid',
        [pendingId],
      );

      await expect(
        new PostgresExportRepository(spy).save({
          ...pendingEntry,
          updatedAt: '2026-10-10T00:00:04.000Z',
        }),
      ).rejects.toMatchObject({ code: 'TRANSITION_REJECTED' });
      expect(statements).toEqual([]);

      // 既有行逐字段未被改写（不是「抛错但已覆盖」），也没有产生新行
      const after = await query<Record<string, unknown>>(
        'SELECT * FROM export_jobs WHERE id = $1::uuid',
        [pendingId],
      );
      expect(after).toEqual(before);
      expect(after[0]?.['status']).toBe(ExportStatus.Pending);
      expect(after[0]?.['updated_at']).toEqual(before[0]?.['updated_at']);
    }, 60_000);
  },
);
