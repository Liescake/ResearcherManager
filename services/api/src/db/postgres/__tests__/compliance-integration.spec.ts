import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { PostgresExecutorError } from '../postgres-error';
import type { SqlConnection } from '../../ports/sql-executor.port';
import {
  POSTGRES_COMPLIANCE_COLUMNS,
  POSTGRES_COMPLIANCE_TABLE,
  PostgresComplianceRepository,
} from '../../../modules/compliance/compliance.postgres-repository';
import { createComplianceRepository } from '../../../modules/compliance/compliance.module';
import {
  DataRetentionStatus,
  ExportAvailabilityStatus,
  PrivacyConsentStatus,
} from '../../../modules/compliance/compliance.port';

/**
 * 本人合规状态（`user_compliance` 读模型）的**真实 PostgreSQL 集成**（WSL2 / Docker Compose
 * 提供的开发库）。
 *
 * ## 为什么必须显式启用
 * 未提供 `TEST_DATABASE_URL`（或库名含 `test` 的 `DATABASE_URL`）时整个套件**明确 skip**，
 * 绝不伪造通过；提供了但连不上、或目标库名不含 `test` 时**失败**（本套件执行迁移与 DDL）。
 * 与 `postgres-integration.spec.ts` / `audit-integration.spec.ts` / `notifications-integration.spec.ts` /
 * `groups-integration.spec.ts` 同一套启用口径。
 *
 * ## 断言的硬性质（离线 spec 无法证明、必须在真库上闭环的）
 * 1. **schema 由仓库真实迁移建立**：`user_compliance` 由迁移 `0012` 建出，列清单恰好是
 *    「归属列 + 三个状态列 + 三个内部列（id / created_at / updated_at）」；主键是 `id`；
 *    `user_id` 有唯一索引（读模型按主体唯一）；三个状态闭集、归属非空 UUID 与
 *    「导出可用 ⇒ 已同意且未过保留期」在存储层有 CHECK 镜像；
 * 2. **读读闭环**：按主体取数返回与落库行逐字段一致的领域记录，且返回对象**只有**四个字段
 *    （内部列 `id` / `created_at` / `updated_at` 一个都不投影）；
 * 3. **归属隔离**：库里同时存在多个主体时，`findByUserId` 只返回请求主体的那一条，
 *    他人记录既不出库也不回流（真库上验证 `WHERE user_id = $1::uuid` 真的生效）；
 * 4. **存储 ID 域在进 SQL 之前判定**：非 UUID 主体 fail-closed，且**一次数据库连接都不建立**
 *    （`createComplianceRepository` 的延迟建连路径已由 binding spec 覆盖，这里在真库上复核）；
 * 5. **绕过应用层也写不坏**：非法状态 / 空 UUID 归属 / 状态不自洽 / 同一主体两行分别被
 *    CHECK（23514）与唯一索引（23505）拒绝；
 * 6. **模块换绑工厂 + 真实执行器**：`createComplianceRepository` 在真库上直接闭环
 *    （这是「数据库已配置 ⇒ 合规端口走 PostgreSQL 实现」的端到端证据）。
 *
 * ## 为什么需要清理行
 * 与只追加的审计表不同，本表是可变的业务表（且 `user_id` 唯一），因此本套件在 `afterAll` 里按
 * **本次运行写入的主键集合**清理，保证重复运行不会把上一次的行当成夹具。
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
  describe('真实 PostgreSQL 合规状态集成（未启用）', () => {
    it.skip(`未启用：${describeState()}（需要 WSL2 Docker Compose 中的开发库，见 README）`, () => {
      expect.unreachable(
        'reachable only when TEST_DATABASE_URL (or a test DATABASE_URL) is configured',
      );
    });
  });
}

const integrationDescribe = ENABLED ? describe : describe.skip;

let connection: SqlConnection | undefined;

/** 本次运行写入的主键集合：用于 `afterAll` 精确清理（本表可变且 user_id 唯一，不清会污染后续断言） */
const createdIds = new Set<string>();
/** 本次运行使用过的归属主体：唯一索引按 user_id，避免与历史运行冲突 */
const owners = new Set<string>();

function newOwner(): string {
  const owner = randomUUID();
  owners.add(owner);
  return owner;
}

const INSERT_SQL = `INSERT INTO user_compliance
  (id, user_id, privacy_consent, data_retention, export_availability, created_at, updated_at)
  VALUES ($1::uuid, $2::uuid, $3, $4, $5, now(), now())`;

/** 直接落一行（本切片没有写入口，因此夹具必须走 SQL：这也让「读路径」被独立验证） */
async function seedRow(
  ownerUserId: string,
  status: {
    readonly privacyConsent?: string;
    readonly dataRetention?: string;
    readonly exportAvailability?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  createdIds.add(id);
  owners.add(ownerUserId);
  await (connection as SqlConnection).query(INSERT_SQL, [
    id,
    ownerUserId,
    status.privacyConsent ?? PrivacyConsentStatus.Granted,
    status.dataRetention ?? DataRetentionStatus.WithinRetention,
    status.exportAvailability ?? ExportAvailabilityStatus.Unavailable,
  ]);
  return id;
}

function repository(): PostgresComplianceRepository {
  return new PostgresComplianceRepository(connection as SqlConnection);
}

async function query<T = Record<string, unknown>>(
  sql: string,
  parameters?: readonly unknown[],
): Promise<readonly T[]> {
  const result = await (connection as SqlConnection).query<T>(sql, parameters);
  return result.rows;
}

integrationDescribe(
  '真实 PostgreSQL 合规状态集成（TEST_DATABASE_URL / 测试库 DATABASE_URL）',
  () => {
    beforeAll(async () => {
      if (!ENABLED || RAW_URL === undefined) {
        return;
      }
      const resolution = resolveDatabaseConfig({
        NODE_ENV: 'test',
        DATABASE_URL: RAW_URL,
        DATABASE_APPLICATION_NAME: 'researcher-manager-compliance-integration',
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
        appliedBy: 'compliance-integration-test',
      });
      if (applied.guard.violations.length > 0) {
        throw new Error('测试前置失败：真实迁移未通过部署守卫');
      }
    }, 90_000);

    afterAll(async () => {
      if (connection !== undefined && createdIds.size > 0) {
        // 只清理本次运行写入的主键：不触碰其它数据，也不做整表截断
        await connection.query('DELETE FROM user_compliance WHERE id = ANY($1::uuid[])', [
          [...createdIds],
        ]);
        await connection.close();
      }
    });

    it('user_compliance 由迁移 0012 建立：列清单、主键、归属唯一索引与存储层 CHECK 齐备', async () => {
      const exists = await query<{ exists: boolean }>(
        'SELECT to_regclass($1::text) IS NOT NULL AS exists',
        [`public.${POSTGRES_COMPLIANCE_TABLE}`],
      );
      expect(exists[0]?.exists).toBe(true);

      const columns = await query<{ column_name: string }>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        ['public', POSTGRES_COMPLIANCE_TABLE],
      );
      // 迁移只建「归属列 + 三个状态列 + 三个内部列」：多列意味着有人把 PII / 原文塞进了存储
      expect(columns.map((row) => row.column_name).sort()).toEqual(
        [
          ...POSTGRES_COMPLIANCE_COLUMNS,
          // 存储侧内部列（见 adapter 的 POSTGRES_COMPLIANCE_INTERNAL_COLUMNS）
          'id',
          'created_at',
          'updated_at',
        ].sort(),
      );
      // 输出列与内部列必须真的不相交（否则「内部列不投影」这个概念就是自欺）
      for (const internal of ['id', 'created_at', 'updated_at']) {
        expect(POSTGRES_COMPLIANCE_COLUMNS as readonly string[]).not.toContain(internal);
      }

      const primaryKey = await query<{ column_name: string }>(
        `SELECT a.attname AS column_name
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'public.user_compliance'::regclass AND i.indisprimary`,
      );
      expect(primaryKey.map((row) => row.column_name)).toEqual(['id']);

      // 读模型按主体唯一：唯一索引是「同一主体两行」在存储层的失败点
      const indexes = await query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
        [POSTGRES_COMPLIANCE_TABLE],
      );
      const uniqueOwner = indexes.find((row) => row.indexname === 'uq_user_compliance_user_id');
      expect(uniqueOwner?.indexdef).toMatch(/UNIQUE/iu);
      expect(uniqueOwner?.indexdef).toMatch(/user_id/iu);

      // 存储层 CHECK 镜像 adapter 契约：状态闭集、状态自洽、非空 UUID
      const constraints = await query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'public.user_compliance'::regclass AND contype = 'c'`,
      );
      const names = constraints.map((row) => row.conname);
      for (const expected of [
        'user_compliance_privacy_consent_check',
        'user_compliance_data_retention_check',
        'user_compliance_export_availability_check',
        'user_compliance_export_requires_active_consent',
        'user_compliance_id_not_nil',
        'user_compliance_user_id_not_nil',
      ]) {
        expect(names).toContain(expected);
      }
    }, 60_000);

    it('按主体取数在真库闭环：逐字段往返，且内部列（id / created_at / updated_at）一个都不投影', async () => {
      const owner = newOwner();
      await seedRow(owner, {
        privacyConsent: PrivacyConsentStatus.Granted,
        dataRetention: DataRetentionStatus.WithinRetention,
        exportAvailability: ExportAvailabilityStatus.Available,
      });

      const record = await repository().findByUserId(owner);
      expect(record).toEqual({
        ownerUserId: owner,
        privacyConsent: PrivacyConsentStatus.Granted,
        dataRetention: DataRetentionStatus.WithinRetention,
        exportAvailability: ExportAvailabilityStatus.Available,
      });
      // 字段闭集：恰好四个字段（内部列绝不随查询外发）
      expect(Object.keys(record as object).sort()).toEqual([
        'dataRetention',
        'exportAvailability',
        'ownerUserId',
        'privacyConsent',
      ]);
      expect(JSON.stringify(record)).not.toContain('created_at');
      expect(JSON.stringify(record)).not.toContain('updated_at');

      // 未落库的主体返回 undefined（与内存基线同语义，由 service 按 fail-closed 处理）
      await expect(repository().findByUserId(newOwner())).resolves.toBeUndefined();
    }, 60_000);

    it('归属隔离：库里同时存在多个主体时只返回请求主体的那一条（他人记录不出库）', async () => {
      const mine = newOwner();
      const other = newOwner();
      await seedRow(mine, { exportAvailability: ExportAvailabilityStatus.Unavailable });
      await seedRow(other, {
        privacyConsent: PrivacyConsentStatus.Withdrawn,
        exportAvailability: ExportAvailabilityStatus.Unavailable,
      });

      const mineRecord = await repository().findByUserId(mine);
      expect(mineRecord?.ownerUserId).toBe(mine);
      const otherRecord = await repository().findByUserId(other);
      expect(otherRecord?.ownerUserId).toBe(other);
      expect(otherRecord?.privacyConsent).toBe(PrivacyConsentStatus.Withdrawn);
      // 序列化后的结果里不得出现对方的归属
      expect(JSON.stringify(mineRecord)).not.toContain(other);
    }, 60_000);

    it('存储 ID 域在进 SQL 之前判定：非 UUID 主体 fail-closed，且不产生任何行', async () => {
      const underTest = repository();
      for (const illegal of ['u-student-1', '', '11111111-1111-4111-8111-11111111111Z', '1;DROP']) {
        await expect(underTest.findByUserId(illegal)).rejects.toMatchObject({
          code: 'INVALID_SUBJECT',
        });
      }
      // 其它注入形态（UUID 合法但带 SQL 片段）不能进入 SQL：它不是合法 UUID，同样被拒绝
      await expect(
        underTest.findByUserId("11111111-1111-4111-8111-111111111111' OR '1'='1"),
      ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
    }, 60_000);

    it('绕过应用层也写不坏：非法状态 / 空 UUID 归属 / 状态不自洽被 CHECK 拒绝，同一主体两行被唯一索引拒绝', async () => {
      const run = (sql: string, parameters: readonly unknown[]): Promise<unknown> =>
        (connection as SqlConnection).query(sql, parameters).then(
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

      // 未登记状态取值
      expect(await run(INSERT_SQL, [id(), owner, 'maybe', 'within-retention', 'unavailable'])).toBe(
        '23514',
      );
      // 未登记保留状态
      expect(await run(INSERT_SQL, [id(), owner, 'granted', 'forever', 'unavailable'])).toBe(
        '23514',
      );
      // 状态不自洽：未生效的同意却声明导出可用
      expect(
        await run(INSERT_SQL, [id(), newOwner(), 'not-recorded', 'within-retention', 'available']),
      ).toBe('23514');
      // 已过保留期却声明导出可用
      expect(await run(INSERT_SQL, [id(), newOwner(), 'granted', 'expired', 'available'])).toBe(
        '23514',
      );
      // 空 UUID 归属
      expect(
        await run(INSERT_SQL, [id(), nilUuid, 'granted', 'within-retention', 'unavailable']),
      ).toBe('23514');
      // 空 UUID 主键
      expect(
        await run(INSERT_SQL, [nilUuid, newOwner(), 'granted', 'within-retention', 'unavailable']),
      ).toBe('23514');

      // 同一主体两行：唯一索引拒绝（读模型按主体唯一）
      const uniqueOwner = newOwner();
      const firstId = id();
      await (connection as SqlConnection).query(INSERT_SQL, [
        firstId,
        uniqueOwner,
        'granted',
        'within-retention',
        'unavailable',
      ]);
      expect(
        await run(INSERT_SQL, [id(), uniqueOwner, 'withdrawn', 'expired', 'unavailable']),
      ).toBe('23505');

      // 六类违规一行都没落库（除了那条合法夹具），且合法夹具逐字段不变
      const stored = await query<{ privacy_consent: string }>(
        'SELECT privacy_consent FROM user_compliance WHERE id = $1::uuid',
        [firstId],
      );
      expect(stored.map((row) => row.privacy_consent)).toEqual(['granted']);
      const rows = await query<{ count: number }>(
        'SELECT count(*)::int AS count FROM user_compliance WHERE user_id = $1::uuid',
        [uniqueOwner],
      );
      expect(rows[0]?.count).toBe(1);
      await expect(repository().findByUserId(uniqueOwner)).resolves.toMatchObject({
        privacyConsent: PrivacyConsentStatus.Granted,
      });
    }, 60_000);

    it('模块换绑工厂 + 真实执行器：合规端口直连真实库闭环，存储 ID 域先判（非法主体不建连）', async () => {
      const owner = newOwner();
      await seedRow(owner);

      let connects = 0;
      const port = createComplianceRepository(
        loadEnv({ NODE_ENV: 'test', DATABASE_URL: RAW_URL }),
        {
          capabilities: { backend: 'postgres', persistent: true, productionReady: false },
          connect: () => {
            connects += 1;
            return Promise.resolve(connection as SqlConnection);
          },
        },
      );

      // 装配阶段不建连；非 UUID 主体在解析执行器之前就被拒绝，因此仍然没有建连
      expect(connects).toBe(0);
      await expect(port.findByUserId('u-student-1')).rejects.toMatchObject({
        code: 'INVALID_SUBJECT',
      });
      expect(connects).toBe(0);

      // 合法请求：建连一次并被复用，真实库上取数闭环
      await expect(port.findByUserId(owner)).resolves.toMatchObject({
        ownerUserId: owner,
        privacyConsent: PrivacyConsentStatus.Granted,
      });
      expect(connects).toBe(1);
      await expect(port.findByUserId(newOwner())).resolves.toBeUndefined();
      expect(connects).toBe(1);
    }, 60_000);
  },
);
