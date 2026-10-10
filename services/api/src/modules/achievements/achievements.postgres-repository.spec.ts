import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENT_TYPE_VALUES,
  AchievementType,
  REVIEW_STATUS_VALUES,
  ReviewStatus,
} from '@rm/shared';
import type {
  PersistenceCapabilities,
  SqlExecutor,
  SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import {
  parseStoredAchievement,
  storedAchievementSchema,
  toAchievementView,
} from './achievements.contract';
import type {
  Achievement,
  AchievementRepository,
  AchievementRepositoryCapabilities,
} from './achievements.port';
import {
  ACHIEVEMENT_REPOSITORY_BACKEND_POSTGRES,
  ACHIEVEMENT_REPOSITORY_STORAGE_ID_DOMAIN,
} from './achievements.port';
import {
  POSTGRES_ACHIEVEMENT_COLUMN_FIELDS,
  POSTGRES_ACHIEVEMENT_COLUMNS,
  POSTGRES_ACHIEVEMENT_OWNER_COLUMNS,
  POSTGRES_ACHIEVEMENT_PII_COLUMNS,
  POSTGRES_ACHIEVEMENT_REPOSITORY_CAPABILITIES,
  POSTGRES_ACHIEVEMENT_REPOSITORY_VERIFICATION_STEPS,
  POSTGRES_ACHIEVEMENT_REVIEW_INTERNAL_COLUMNS,
  POSTGRES_ACHIEVEMENT_TABLE,
  POSTGRES_ACHIEVEMENT_VIEW_EXCLUDED_COLUMNS,
  PostgresAchievementRepository,
  PostgresAchievementRepositoryError,
  assertPostgresAchievementRepositoryCapabilities,
  createLazyPostgresAchievementRepository,
} from './achievements.postgres-repository';

/**
 * PostgreSQL 成果仓储 adapter 的**离线**验收（不连数据库、不引驱动）。
 *
 * 覆盖用户要求的五类补充测试与两条交付边界：
 * - **repository 契约**：能力声明（persistent=true / productionReady=false）、列 ↔ 读取契约字段
 *   一一对应、审核内部字段不进列清单、**按「是否配置数据库」绑定到 `AchievementsModule`**
 *   （工厂引用，类名不进 provider）、不引驱动/ORM、`achievements` 由迁移 0004 建表并由 0008
 *   补齐存储层约束；端口是**单一异步契约**（内存基线与本 adapter 同签名）；
 * - **参数化 SQL 与固定标识符**：客户端可控值只出现在参数里，SQL 文本只由模块常量构成；
 * - **SQL 注入**：主体 / 文本字段等所有入口的注入载荷要么只进参数、要么在进入 SQL 之前被拒绝；
 * - **未知列 / 非法审核状态与边界**：未登记列（含审核留痕列）、未知审核态、越界标题、坏时间戳、
 *   坏形状、缺列一律 fail-closed；
 * - **归属隔离与泄漏**：他人记录既不出库（归属下推进 SQL）也不得回流，归属与主键不得被改写，
 *   归属必须是规范小写 UUID；
 * - **分页与结果集边界**：本切片端口无分页窗口 → SQL 不得出现 LIMIT/OFFSET、不得本地截断、
 *   排序键已固定为后续键集分页所需的稳定全序、空结果按空页处理、大批量逐条返回；
 * - **公开视图**：对外视图不含 `userId` 与审核内部字段，失败路径的错误信息不含归属标识、
 *   标题/说明原文与佐证文件 ID。
 */

/** 从当前工作目录向上寻找仓库根（含 pnpm-workspace.yaml） */
function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error('未找到仓库根目录（缺少 pnpm-workspace.yaml）');
}

const REPO_ROOT = findRepoRoot(process.cwd());

/**
 * 内部字段级数据字典：属**内部文档**，不随公开仓库发布。公开归档里该文件不存在，
 * 相关的一致性断言因此无法校验，按设计**显式跳过**（见对应的 `it.skipIf`），
 * 而不是让整个测试文件因为读不到内部文档而报 ENOENT。
 */
const INTERNAL_FIELD_DICTIONARY = join(REPO_ROOT, 'docs', 'P1-字段级数据字典.md');
const ADAPTER_PATH = resolve(
  process.cwd(),
  'src',
  'modules',
  'achievements',
  'achievements.postgres-repository.ts',
);
const PORT_PATH = resolve(process.cwd(), 'src', 'modules', 'achievements', 'achievements.port.ts');
const ADAPTER_CLASS = 'PostgresAchievementRepository';

interface RecordedCall {
  readonly sql: string;
  readonly parameters: readonly unknown[] | undefined;
}

/**
 * 记录型假执行器：只记录 SQL 与参数、按预设顺序返回结果，不连数据库。
 *
 * 能力声明刻意写成「postgres + persistent」：adapter 会拒绝非持久后端（内存替身），
 * 因此替身必须如实声明自己代表的是持久化 PostgreSQL。
 */
class RecordingExecutor implements SqlExecutor {
  capabilities: PersistenceCapabilities = {
    backend: 'postgres-test-double',
    persistent: true,
    productionReady: false,
  };

  readonly calls: RecordedCall[] = [];
  private readonly responses: unknown[];

  constructor(responses: unknown[] = []) {
    this.responses = [...responses];
  }

  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ sql, parameters });
    const next = (this.responses.shift() ?? { rows: [], rowCount: 0 }) as SqlQueryResult<Row>;
    return Promise.resolve(next);
  }
}

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = '22222222-2222-4222-8222-222222222222';
/** 含十六进制字母的归属标识：用于验证「规范小写形」约束（纯数字 UUID 无法体现大小写差异） */
const HEX_OWNER_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const HEX_OWNER_ID_UPPER = 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678';
const HEX_OWNER_ID_MIXED = 'a1b2c3d4-E5F6-4789-8abc-DEF012345678';
const ACHIEVEMENT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ACHIEVEMENT_ID = '44444444-4444-4444-8444-444444444444';
const EVIDENCE_FILE_ID = '55555555-5555-4555-8555-555555555555';
const CREATED_AT = '2026-01-02T03:04:05.000Z';
const UPDATED_AT = '2026-01-03T04:05:06.000Z';
const ACHIEVED_AT = '2026-05-01T00:00:00.000Z';

const ACHIEVEMENT: Achievement = {
  id: ACHIEVEMENT_ID,
  userId: OWNER_ID,
  type: AchievementType.Paper,
  title: '第一作者论文',
  awardLevel: '校级一等奖',
  description: '论文成果说明',
  achievedAt: ACHIEVED_AT,
  evidenceFileId: EVIDENCE_FILE_ID,
  reviewStatus: ReviewStatus.Pending,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

/** 数据库行（snake_case），默认与 ACHIEVEMENT 等价 */
function rowFromRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ACHIEVEMENT.id,
    user_id: ACHIEVEMENT.userId,
    type: 'paper',
    title: ACHIEVEMENT.title,
    award_level: ACHIEVEMENT.awardLevel,
    description: ACHIEVEMENT.description,
    achieved_at: new Date(ACHIEVED_AT),
    evidence_file_id: ACHIEVEMENT.evidenceFileId,
    review_status: 'pending',
    created_at: new Date(CREATED_AT),
    updated_at: new Date(UPDATED_AT),
    ...overrides,
  };
}

/** 移除某一列，用于「缺列」用例 */
function withoutRowColumn(column: string): Record<string, unknown> {
  const row = rowFromRecord();
  delete row[column];
  return row;
}

/** 造一批稳定且唯一的 UUID（版本位 4、变体位 8，满足 uuidSchema） */
function uuidForIndex(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function captureRepoError(
  run: () => Promise<unknown>,
): Promise<PostgresAchievementRepositoryError> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresAchievementRepositoryError);
  return captured as PostgresAchievementRepositoryError;
}

function captureSyncError(run: () => unknown): PostgresAchievementRepositoryError {
  let captured: unknown;
  try {
    run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresAchievementRepositoryError);
  return captured as PostgresAchievementRepositoryError;
}

/** SQL 里出现的占位符序号（去重升序），用于断言「占位符数量 === 参数数量」 */
function placeholderIndexes(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1])))].sort(
    (left, right) => left - right,
  );
}

/** 某一列在写入参数数组里的位置（由列清单派生，避免硬编码下标漂移） */
function parameterAt(call: RecordedCall | undefined, column: string): unknown {
  const index = [...POSTGRES_ACHIEVEMENT_COLUMNS].indexOf(
    column as (typeof POSTGRES_ACHIEVEMENT_COLUMNS)[number],
  );
  expect(index).toBeGreaterThanOrEqual(0);
  return call?.parameters?.[index];
}

/** 从源码里抽取 import / require 的模块说明符 */
function moduleSpecifiersOf(source: string): string[] {
  return [
    ...source.matchAll(/from\s+['"]([^'"]+)['"]/gu),
    ...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/gu),
  ].map((match) => match[1] ?? '');
}

/** 读取仓库内文件（相对 services/api） */
function readApiFile(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8');
}

describe('PostgreSQL 成果仓储：repository 契约与能力声明', () => {
  it('能力声明恰好是 postgres / persistent=true / productionReady=false，且被冻结', () => {
    expect(POSTGRES_ACHIEVEMENT_REPOSITORY_CAPABILITIES).toEqual({
      backend: ACHIEVEMENT_REPOSITORY_BACKEND_POSTGRES,
      persistent: true,
      productionReady: false,
    });
    expect(Object.isFrozen(POSTGRES_ACHIEVEMENT_REPOSITORY_CAPABILITIES)).toBe(true);
    // 后端标识与「未验证驱动」的 fail-closed 工厂区分开，避免运维把两者混为一谈
    expect(ACHIEVEMENT_REPOSITORY_BACKEND_POSTGRES).toBe('postgres');
    expect(ACHIEVEMENT_REPOSITORY_STORAGE_ID_DOMAIN).toBe('uuid');
  });

  it('验证清单覆盖「驱动 → 集成 → 草案转迁移 → 异步端口 → UUID 归属 → 才可声明生产」六步', () => {
    expect(POSTGRES_ACHIEVEMENT_REPOSITORY_VERIFICATION_STEPS).toHaveLength(6);
    expect([...POSTGRES_ACHIEVEMENT_REPOSITORY_VERIFICATION_STEPS]).toEqual([
      'driver-dependency-evaluated',
      'integration-tests-against-real-postgres',
      'achievements-schema-draft-created-and-promoted-to-migration',
      'achievement-repository-port-migrated-to-async',
      'session-subject-user-ids-converged-to-uuid',
      'production-ready-capability-flipped-with-evidence',
    ]);
  });

  it('自检放行当前声明，但拒绝「未验证就声称生产可用」', () => {
    expect(() => assertPostgresAchievementRepositoryCapabilities()).not.toThrow();

    for (const declared of [
      { backend: 'postgres', persistent: true, productionReady: true },
      { backend: 'postgres', persistent: false, productionReady: false },
      { backend: 'postgresql-draft', persistent: true, productionReady: false },
    ]) {
      const error = captureSyncError(() =>
        assertPostgresAchievementRepositoryCapabilities(declared),
      );
      expect(error.code).toBe('CAPABILITY_MISDECLARED');
    }
  });

  it('列清单与读取契约字段一一对应（单一事实来源，无遗漏、无多余）', () => {
    const mappedFields = Object.values(POSTGRES_ACHIEVEMENT_COLUMN_FIELDS).sort();
    const contractFields = Object.keys(storedAchievementSchema.shape).sort();
    expect(mappedFields).toEqual(contractFields);

    // 列自身的卫生：唯一、裸 snake_case 标识符、且列清单与映射表的键集一致
    expect([...POSTGRES_ACHIEVEMENT_COLUMNS]).toHaveLength(
      new Set(POSTGRES_ACHIEVEMENT_COLUMNS).size,
    );
    for (const column of POSTGRES_ACHIEVEMENT_COLUMNS) {
      expect(/^[a-z][a-z0-9_]*$/u.test(column)).toBe(true);
      expect(Object.keys(POSTGRES_ACHIEVEMENT_COLUMN_FIELDS)).toContain(column);
    }
    expect(Object.keys(POSTGRES_ACHIEVEMENT_COLUMN_FIELDS).sort()).toEqual(
      [...POSTGRES_ACHIEVEMENT_COLUMNS].sort(),
    );
  });

  it('表名是字段字典里的 achievements，字典列都在列清单里，审核留痕列一律不在', () => {
    expect(POSTGRES_ACHIEVEMENT_TABLE).toBe('achievements');

    // 字段字典为该表登记的字段必须都落在列清单里（否则存储层与数据字典脱节）。
    // 字典正文属内部文档，公开归档不可读；这里断言**公开可校验**的那一半（列清单包含这些字段），
    // 与字典正文逐行比对的另一半放在下面按需跳过的用例里。
    for (const field of ['type', 'title', 'award_level', 'evidence_file_id', 'review_status']) {
      expect([...POSTGRES_ACHIEVEMENT_COLUMNS]).toContain(field);
    }

    // 审核留痕 / 软删除属于后续切片：既不读写，也不用它们做过滤
    for (const deferred of [...POSTGRES_ACHIEVEMENT_REVIEW_INTERNAL_COLUMNS, 'deleted_at']) {
      expect([...POSTGRES_ACHIEVEMENT_COLUMNS]).not.toContain(deferred);
    }

    // description / achieved_at 只由读取契约声明（service 会写入），字段字典暂未登记这两行。
    for (const contractOnly of ['description', 'achieved_at']) {
      expect([...POSTGRES_ACHIEVEMENT_COLUMNS]).toContain(contractOnly);
    }
  });

  // 内部字典不可读时**显式跳过**（输出里可见），不做「静默通过」的降级：
  // 生产安全断言（fail-closed / 列清单边界）不受影响，本用例只对齐文档与列清单。
  it.skipIf(!existsSync(INTERNAL_FIELD_DICTIONARY))(
    '与内部字段级数据字典逐行对齐（需要内部文档；公开归档按设计跳过）',
    () => {
      const dictionary = readFileSync(INTERNAL_FIELD_DICTIONARY, 'utf8');
      for (const field of ['type', 'title', 'award_level', 'evidence_file_id', 'review_status']) {
        expect(dictionary).toContain(`| achievements | ${field} |`);
      }
      // 字典补登这两行后这里会失败，提醒同步核对列清单与迁移
      expect(dictionary).not.toContain('| achievements | description |');
      expect(dictionary).not.toContain('| achievements | achieved_at |');
    },
  );

  it('归属列 / 个人级内容列 / 不进入公开输出的列各有明确清单', () => {
    expect([...POSTGRES_ACHIEVEMENT_OWNER_COLUMNS]).toEqual(['user_id']);
    expect([...POSTGRES_ACHIEVEMENT_PII_COLUMNS]).toEqual([
      'title',
      'description',
      'evidence_file_id',
    ]);
    expect([...POSTGRES_ACHIEVEMENT_VIEW_EXCLUDED_COLUMNS]).toEqual(['user_id']);

    for (const column of POSTGRES_ACHIEVEMENT_OWNER_COLUMNS) {
      expect([...POSTGRES_ACHIEVEMENT_VIEW_EXCLUDED_COLUMNS]).toContain(column);
      expect([...POSTGRES_ACHIEVEMENT_COLUMNS]).toContain(column);
    }
    for (const column of POSTGRES_ACHIEVEMENT_PII_COLUMNS) {
      expect([...POSTGRES_ACHIEVEMENT_COLUMNS]).toContain(column);
    }
    // 审核内部字段与列清单、与对外裁剪清单都不相交
    expect([...POSTGRES_ACHIEVEMENT_REVIEW_INTERNAL_COLUMNS]).toHaveLength(5);
    for (const column of POSTGRES_ACHIEVEMENT_REVIEW_INTERNAL_COLUMNS) {
      expect([...POSTGRES_ACHIEVEMENT_COLUMNS]).not.toContain(column);
      expect([...POSTGRES_ACHIEVEMENT_VIEW_EXCLUDED_COLUMNS]).not.toContain(column);
    }
  });

  it('实现的是异步仓储契约（Promise 语义），并被绑定为 ACHIEVEMENT_REPOSITORY 的数据库实现', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository: AchievementRepository = new PostgresAchievementRepository(executor);

    expect(repository.capabilities).toEqual(POSTGRES_ACHIEVEMENT_REPOSITORY_CAPABILITIES);
    const created = repository.create(ACHIEVEMENT);
    expect(created).toBeInstanceOf(Promise);
    await expect(created).resolves.toEqual(ACHIEVEMENT);

    const listed = repository.listByUserId(OWNER_ID);
    expect(listed).toBeInstanceOf(Promise);
    await expect(listed).resolves.toEqual([]);
  });

  it('adapter 不是 Nest provider：源码不含 @Injectable，装配只经 Module 的工厂引用', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).not.toContain('@Injectable');
    expect(source).not.toContain('@Module');
    expect(source).not.toContain('Inject(');
  });

  it('端口方法集是 create + findById + listByUserId 三个异步方法，且仍无分页窗口（本切片边界）', () => {
    const source = readFileSync(PORT_PATH, 'utf8');
    const portStart = source.indexOf('export interface AchievementRepository {');
    expect(portStart).toBeGreaterThan(-1);
    const portBlock = source.slice(portStart);

    expect(portBlock).toContain('create(achievement: Achievement): Promise<Achievement>;');
    // 单条读取是**资源级取数**：必须同时接收服务端主体，才能把归属下推进 SQL
    // （只按资源 ID 命中会让归属判定退化成取数之后的复核，存在性因此可被探测）
    expect(portBlock).toContain(
      'findById(achievementId: string, ownerUserId: string): Promise<Achievement | undefined>;',
    );
    expect(portBlock).toContain('listByUserId(userId: string): Promise<readonly Achievement[]>;');
    // 列表分页窗口属于后续切片：端口不得预置用不上的参数，
    // 否则 service / 内存基线 / PostgreSQL 实现无法互换，切换存储那一步会被迫一次性改三处
    expect(portBlock).not.toMatch(/\b(?:window|limit|offset|page|cursor)\b/iu);
    // 旧的双契约（同步端口 + 并存的异步契约）已在本切片收敛为单一异步契约
    expect(source).not.toContain('AsyncAchievementRepository');
  });
});

describe('PostgreSQL 成果仓储：构造与调用 fail-closed', () => {
  it('没有执行器 / 执行器缺 query / 缺能力声明 → 构造即拒绝，且不执行任何 SQL', () => {
    for (const broken of [undefined, null, {}, { capabilities: { backend: 'postgres' } }]) {
      const error = captureSyncError(
        () => new PostgresAchievementRepository(broken as unknown as SqlExecutor),
      );
      expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
    }

    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    new PostgresAchievementRepository(executor);
    expect(executor.calls).toHaveLength(0);
  });

  it('执行器声明的后端不是 PostgreSQL → 拒绝（不得把 adapter 挂到其他存储上）', () => {
    for (const backend of ['mysql', 'sqlite', 'in-memory-baseline']) {
      const error = captureSyncError(
        () =>
          new PostgresAchievementRepository({
            query: () => Promise.resolve({ rows: [], rowCount: 0 }),
            capabilities: { backend, persistent: true, productionReady: true },
          }),
      );
      expect(error.code).toBe('EXECUTOR_NOT_POSTGRES');
    }
  });

  it('执行器声明为非持久后端（内存替身）→ 拒绝', () => {
    const error = captureSyncError(
      () =>
        new PostgresAchievementRepository({
          query: () => Promise.resolve({ rows: [], rowCount: 0 }),
          capabilities: { backend: 'postgres', persistent: false, productionReady: false },
        }),
    );
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
  });

  it('构造后执行器被降级为非持久 → 下一次调用 fail-closed，且不再访问 SQL', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresAchievementRepository(executor);

    executor.capabilities = { backend: 'postgres', persistent: false, productionReady: false };

    const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
  });

  it('构造后能力声明被改写为「生产可用」→ 每次调用都 fail-closed（自检不被绕过）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresAchievementRepository(executor);

    (repository as { capabilities: AchievementRepositoryCapabilities }).capabilities = {
      backend: 'postgres',
      persistent: true,
      productionReady: true,
    };

    const error = await captureRepoError(() => repository.create(ACHIEVEMENT));
    expect(error.code).toBe('CAPABILITY_MISDECLARED');
    expect(error.issues).toContain('productionReady');
    expect(executor.calls).toHaveLength(0);
  });

  it('结果集缺少 rows 数组 → 判驱动缺陷，不伪装成「该主体尚无成果」', async () => {
    for (const broken of [undefined, null, {}, { rows: null }, 'rows']) {
      // 用「原样返回」的执行器，避免替身自身的默认值把 undefined 吞掉
      const rawExecutor: SqlExecutor = {
        capabilities: { backend: 'postgres-raw', persistent: true, productionReady: false },
        query: () => Promise.resolve(broken as unknown as SqlQueryResult<never>),
      };
      const repository = new PostgresAchievementRepository(rawExecutor);

      const listError = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(listError.code).toBe('INVALID_ROW');

      const createError = await captureRepoError(() => repository.create(ACHIEVEMENT));
      expect(createError.code).toBe('INVALID_ROW');
    }
  });

  it('空列表返回 []（不是抛错、也不是空对象 / undefined）', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const listed = await new PostgresAchievementRepository(executor).listByUserId(OWNER_ID);
    expect(listed).toEqual([]);
    expect(Array.isArray(listed)).toBe(true);
  });
});

describe('PostgreSQL 成果仓储：参数化 SQL 与显式字段映射', () => {
  it('写入使用占位符绑定：SQL 只由常量与 $n 组成，参数按列顺序传入', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresAchievementRepository(executor);

    const stored = await repository.create(ACHIEVEMENT);

    const call = executor.calls[0];
    expect(call?.sql).toContain(`INSERT INTO ${POSTGRES_ACHIEVEMENT_TABLE} (`);
    expect(call?.sql).toContain(
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::timestamptz, $8::uuid, $9, $10::timestamptz, $11::timestamptz)',
    );
    expect(call?.sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(call?.sql).toContain('RETURNING');
    expect(call?.sql).not.toContain('*');
    expect(placeholderIndexes(call?.sql ?? '')).toEqual(
      Array.from({ length: POSTGRES_ACHIEVEMENT_COLUMNS.length }, (_unused, index) => index + 1),
    );
    expect(call?.parameters).toHaveLength(POSTGRES_ACHIEVEMENT_COLUMNS.length);

    // 领域对象的值只出现在参数里；SQL 文本里一个都不出现
    for (const value of [
      ACHIEVEMENT.id,
      ACHIEVEMENT.userId,
      ACHIEVEMENT.title,
      ACHIEVEMENT.description ?? '',
      ACHIEVEMENT.evidenceFileId ?? '',
      ACHIEVEMENT.createdAt,
    ]) {
      expect(call?.sql).not.toContain(value);
    }
    expect(call?.parameters).toEqual([
      ACHIEVEMENT.id,
      ACHIEVEMENT.userId,
      ACHIEVEMENT.type,
      ACHIEVEMENT.title,
      ACHIEVEMENT.awardLevel,
      ACHIEVEMENT.description,
      ACHIEVEMENT.achievedAt,
      ACHIEVEMENT.evidenceFileId,
      ACHIEVEMENT.reviewStatus,
      ACHIEVEMENT.createdAt,
      ACHIEVEMENT.updatedAt,
    ]);
    expect(stored).toEqual(ACHIEVEMENT);
    expect(stored).not.toHaveProperty('user_id');
    expect(stored).not.toHaveProperty('review_status');
  });

  it('写入语句没有 DO UPDATE：创建端口不得顺手改写既有记录（审核/留痕切片之前不存在改写路径）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    await new PostgresAchievementRepository(executor).create(ACHIEVEMENT);

    const sql = executor.calls[0]?.sql ?? '';
    expect(sql).not.toContain('DO UPDATE');
    expect(sql).not.toContain('SET ');
    // 归属与生命周期列只出现在列清单 / 值占位 / RETURNING 里，不会出现在赋值位置
    for (const column of ['user_id', 'created_at']) {
      expect(sql).not.toContain(`${column} = `);
      expect(sql).not.toContain(`${column}=`);
    }
  });

  it('缺失的可选字段写入 null（不是 undefined，也不是省略列）', async () => {
    const {
      awardLevel: _awardLevel,
      description: _description,
      achievedAt: _achievedAt,
      evidenceFileId: _evidenceFileId,
      ...withoutOptional
    } = ACHIEVEMENT;
    const executor = new RecordingExecutor([
      {
        rows: [
          rowFromRecord({
            award_level: null,
            description: null,
            achieved_at: null,
            evidence_file_id: null,
          }),
        ],
        rowCount: 1,
      },
    ]);
    const repository = new PostgresAchievementRepository(executor);

    const stored = await repository.create(withoutOptional);

    const call = executor.calls[0];
    for (const column of ['award_level', 'description', 'achieved_at', 'evidence_file_id']) {
      expect(parameterAt(call, column)).toBeNull();
    }
    // null 列在领域记录里表现为「字段不存在」，而不是 undefined 悬挂
    expect(stored).not.toHaveProperty('awardLevel');
    expect(stored).not.toHaveProperty('description');
    expect(stored).not.toHaveProperty('achievedAt');
    expect(stored).not.toHaveProperty('evidenceFileId');
    expect(stored).toEqual(withoutOptional);
  });

  it('空串在写入前归一为 NULL，读取侧同样归一为「未填写」（避免往返不一致）', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromRecord({ award_level: '', description: '' })], rowCount: 1 },
    ]);
    const repository = new PostgresAchievementRepository(executor);

    const stored = await repository.create({
      ...ACHIEVEMENT,
      awardLevel: '',
      description: '',
    });

    const call = executor.calls[0];
    expect(parameterAt(call, 'award_level')).toBeNull();
    expect(parameterAt(call, 'description')).toBeNull();
    expect(stored).not.toHaveProperty('awardLevel');
    expect(stored).not.toHaveProperty('description');
  });

  it('行 → 记录是逐字段显式映射：每个列的值都落在对应领域字段上', async () => {
    // 列与领域字段一一对应：整行映射后必须逐字节等于同一个领域记录（任何错位/漏映射都会失败）
    const mapped: Achievement = {
      id: OTHER_ACHIEVEMENT_ID,
      userId: HEX_OWNER_ID,
      type: AchievementType.Competition,
      title: '竞赛成果甲',
      awardLevel: '省级二等奖',
      description: '竞赛说明乙',
      achievedAt: '2026-02-03T04:05:06.000Z',
      evidenceFileId: '66666666-6666-4666-8666-666666666666',
      reviewStatus: ReviewStatus.Rejected,
      createdAt: '2026-02-04T05:06:07.000Z',
      updatedAt: '2026-02-05T06:07:08.000Z',
    };
    const executor = new RecordingExecutor([
      {
        rows: [
          rowFromRecord({
            id: mapped.id,
            user_id: mapped.userId,
            type: 'competition',
            title: mapped.title,
            award_level: mapped.awardLevel,
            description: mapped.description,
            achieved_at: new Date('2026-02-03T04:05:06.000Z'),
            evidence_file_id: mapped.evidenceFileId,
            review_status: 'rejected',
            created_at: new Date('2026-02-04T05:06:07.000Z'),
            updated_at: new Date('2026-02-05T06:07:08.000Z'),
          }),
        ],
        rowCount: 1,
      },
    ]);
    const repository = new PostgresAchievementRepository(executor);

    const stored = await repository.create(mapped);

    expect(stored).toEqual(mapped);
  });

  it('列表取数把归属下推进 SQL：只按主体一个占位符，列清单显式（无 SELECT *）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresAchievementRepository(executor);

    const listed = await repository.listByUserId(OWNER_ID);

    const call = executor.calls[0];
    expect(call?.sql).toContain(`SELECT ${[...POSTGRES_ACHIEVEMENT_COLUMNS].join(', ')}`);
    expect(call?.sql).toContain(`FROM ${POSTGRES_ACHIEVEMENT_TABLE}`);
    expect(call?.sql).toContain('WHERE user_id = $1::uuid');
    expect(call?.sql).not.toContain('*');
    expect(call?.sql).not.toContain(OWNER_ID);
    expect(call?.parameters).toEqual([OWNER_ID]);
    expect(listed).toEqual([ACHIEVEMENT]);
  });

  it('表名与列清单只由模块常量构成且都是裸标识符，占位符数量与参数数量一致', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromRecord()], rowCount: 1 },
      { rows: [rowFromRecord()], rowCount: 1 },
    ]);
    const repository = new PostgresAchievementRepository(executor);

    await repository.create(ACHIEVEMENT);
    await repository.listByUserId(OWNER_ID);

    expect(executor.calls).toHaveLength(2);
    for (const call of executor.calls) {
      expect(call.sql).toContain(POSTGRES_ACHIEVEMENT_TABLE);
      expect(call.sql).not.toContain('*');
      expect(call.sql).not.toMatch(/\b(?:DROP|ALTER|TRUNCATE|GRANT|COPY)\b/u);
      expect(placeholderIndexes(call.sql)).toHaveLength(call.parameters?.length ?? 0);
    }
  });
});

describe('PostgreSQL 成果仓储：SQL 注入防线', () => {
  const INJECTION = "x'); DROP TABLE achievements; --";

  it('文本字段里的注入载荷只进参数，SQL 文本与正常输入逐字节相同', async () => {
    const benign = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const malicious = new RecordingExecutor([
      {
        rows: [
          rowFromRecord({
            title: INJECTION,
            award_level: INJECTION,
            description: INJECTION,
            evidence_file_id: EVIDENCE_FILE_ID,
          }),
        ],
        rowCount: 1,
      },
    ]);

    await new PostgresAchievementRepository(benign).create(ACHIEVEMENT);
    const stored = await new PostgresAchievementRepository(malicious).create({
      ...ACHIEVEMENT,
      title: INJECTION,
      awardLevel: INJECTION,
      description: INJECTION,
    });

    const maliciousCall = malicious.calls[0];
    expect(maliciousCall?.sql).toEqual(benign.calls[0]?.sql);
    expect(maliciousCall?.sql).not.toContain('DROP TABLE');
    expect(maliciousCall?.sql).not.toContain('--');
    expect(parameterAt(maliciousCall, 'title')).toBe(INJECTION);
    expect(parameterAt(maliciousCall, 'award_level')).toBe(INJECTION);
    expect(parameterAt(maliciousCall, 'description')).toBe(INJECTION);
    // 载荷只是文本：按读取契约原样承载（说明它从未参与 SQL 拼接）
    expect(stored.title).toBe(INJECTION);
    expect(stored.description).toBe(INJECTION);
  });

  it('归属不是合法 UUID / 非规范小写形 / 空 UUID 时在进入 SQL 之前就被拒绝，且不访问数据库', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresAchievementRepository(executor);

    const rejectedSubjects = [
      `${OWNER_ID}' OR 1=1 --`,
      "1' OR '1'='1",
      '${OWNER_ID}',
      HEX_OWNER_ID_UPPER,
      HEX_OWNER_ID_MIXED,
      OWNER_ID.replace(/-/gu, ''),
      '',
      'u-student-1',
      '00000000-0000-0000-0000-000000000000',
      '../../../etc/passwd',
    ];

    for (const userId of rejectedSubjects) {
      const listError = await captureRepoError(() => repository.listByUserId(userId));
      expect(listError.code).toBe('INVALID_SUBJECT');
      expect(listError.issues).toContain('userId');
      // 错误信息不得回显主体标识或注入载荷
      expect(listError.message).not.toContain(userId === '' ? 'x' : userId);

      const writeError = await captureRepoError(() =>
        repository.create({ ...ACHIEVEMENT, userId } as unknown as Achievement),
      );
      expect(writeError.code).toBe('INVALID_RECORD');
      expect(writeError.message).not.toContain(userId === '' ? 'x' : userId);
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('行契约的枚举列不接受大写 / 未登记 / 注入式取值，且错误信息不回显取值', async () => {
    for (const override of [
      { type: "paper' OR '1'='1" },
      { type: 'PAPER' },
      { type: 'thesis' },
      { review_status: "pending' OR '1'='1" },
      { review_status: 'PENDING' },
      { review_status: 'pending_review' },
      { id: `${ACHIEVEMENT_ID}' OR '1'='1` },
    ]) {
      const executor = new RecordingExecutor([{ rows: [rowFromRecord(override)], rowCount: 1 }]);
      const error = await captureRepoError(() =>
        new PostgresAchievementRepository(executor).listByUserId(OWNER_ID),
      );
      expect(error.code).toBe('INVALID_ROW');
      for (const value of Object.values(override)) {
        expect(error.message).not.toContain(value);
        expect(JSON.stringify(error.issues)).not.toContain(value);
      }
    }
  });

  it('SQL 文本里没有任何字面量注入面：语句只由模板串 + 模块常量派生', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).toMatch(/const INSERT_SQL = `INSERT INTO \$\{TABLE_IDENTIFIER\}/u);
    expect(source).toMatch(/const SELECT_BY_OWNER_SQL = `SELECT \$\{COLUMN_LIST\}/u);
    // 执行器调用不得用字符串拼接构造 SQL（值只能作为参数数组传入）
    expect(source).not.toMatch(/executor\.query\([^\n`]*\+/u);
  });
});

describe('PostgreSQL 成果仓储：未知列与字段污染', () => {
  it('数据库返回未登记列（含审核留痕列与 PII 别名）→ 整行拒绝（不静默丢弃）', async () => {
    for (const extra of [
      { deleted_at: null },
      { reviewer_user_id: OTHER_OWNER_ID },
      { reviewed_by_user_id: OTHER_OWNER_ID },
      { review_comment: '材料存疑，需人工复核' },
      { reviewed_at: new Date(CREATED_AT) },
      { audit_event_id: OTHER_ACHIEVEMENT_ID },
      { owner_user_id: OTHER_OWNER_ID },
      { user_id_alias: OTHER_OWNER_ID },
      { wechat_open_id: 'o-openid-secret' },
      { id_card: '110101199003071234' },
      { internal_note: '内部备注：疑似违规' },
    ]) {
      const executor = new RecordingExecutor([{ rows: [rowFromRecord(extra)], rowCount: 1 }]);
      const repository = new PostgresAchievementRepository(executor);

      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      expect(error.issues.join(',')).toContain('unrecognized_keys');
      // 错误信息只带字段路径，不回显被污染的取值
      for (const value of Object.values(extra)) {
        if (typeof value === 'string' && value.length > 5) {
          expect(error.message).not.toContain(value);
        }
      }
    }
  });

  it('列表取数同样拒绝未登记列（不因为「只多几列」就放行整页）', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [
          rowFromRecord(),
          rowFromRecord({ id: OTHER_ACHIEVEMENT_ID, internal_note: '内部备注' }),
        ],
        rowCount: 2,
      },
    ]);
    const error = await captureRepoError(() =>
      new PostgresAchievementRepository(executor).listByUserId(OWNER_ID),
    );
    expect(error.code).toBe('INVALID_ROW');
    expect(error.issues.join(',')).toContain('unrecognized_keys');
  });

  it('写路径字段污染（服务端独占字段 / 归属别名 / 审核内部字段 / 权限字段）→ INVALID_RECORD，且不写库', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresAchievementRepository(executor);

    for (const polluted of [
      { ...ACHIEVEMENT, ownerUserId: OTHER_OWNER_ID },
      { ...ACHIEVEMENT, owner_user_id: OTHER_OWNER_ID },
      { ...ACHIEVEMENT, user_id: OTHER_OWNER_ID },
      { ...ACHIEVEMENT, reviewerUserId: OTHER_OWNER_ID },
      { ...ACHIEVEMENT, reviewComment: '管理员代审' },
      { ...ACHIEVEMENT, reviewedAt: CREATED_AT },
      { ...ACHIEVEMENT, auditEventId: OTHER_ACHIEVEMENT_ID },
      { ...ACHIEVEMENT, roles: ['super_admin'] },
      { ...ACHIEVEMENT, scope: 'global' },
      { ...ACHIEVEMENT, groupId: 'g-1' },
      { ...ACHIEVEMENT, createdAt: CREATED_AT, created_at: CREATED_AT },
    ]) {
      const error = await captureRepoError(() =>
        repository.create(polluted as unknown as Achievement),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(error.issues.join(',')).toContain('unrecognized_keys');
    }
    expect(executor.calls).toHaveLength(0);
  });
});

describe('PostgreSQL 成果仓储：非法审核状态与状态边界', () => {
  it('未知审核态 / 非法枚举 / 坏时间戳 / 坏形状 / 缺列 一律拒绝（未知状态不得当作合法值）', async () => {
    const poisoned: Record<string, unknown>[] = [
      rowFromRecord({ review_status: 'unknown_status' }),
      rowFromRecord({ review_status: 'in_review' }),
      rowFromRecord({ review_status: 'approved_by_admin' }),
      rowFromRecord({ review_status: null }),
      rowFromRecord({ review_status: 1 }),
      rowFromRecord({ type: 'unknown_type' }),
      rowFromRecord({ type: null }),
      rowFromRecord({ title: 42 }),
      rowFromRecord({ title: null }),
      rowFromRecord({ title: '' }),
      rowFromRecord({ achieved_at: 'not-a-timestamp' }),
      rowFromRecord({ created_at: 'nah' }),
      rowFromRecord({ updated_at: '2026-13-45T00:00:00.000Z' }),
      rowFromRecord({ user_id: 'u-student-1' }),
      rowFromRecord({ id: 'not-a-uuid' }),
      rowFromRecord({ evidence_file_id: 'not-a-uuid' }),
      rowFromRecord({ evidence_file_id: '' }),
      rowFromRecord({ review_status: { $ne: null } }),
      rowFromRecord({ title: ['第一作者论文'] }),
      withoutRowColumn('title'),
      withoutRowColumn('review_status'),
      withoutRowColumn('user_id'),
      withoutRowColumn('created_at'),
    ];

    for (const row of poisoned) {
      const executor = new RecordingExecutor([{ rows: [row], rowCount: 1 }]);
      const error = await captureRepoError(() =>
        new PostgresAchievementRepository(executor).listByUserId(OWNER_ID),
      );
      expect(error.code).toBe('INVALID_ROW');
    }
  });

  it('审核态闭集内的全部取值都能往返（不因取值不同被静默改写或过滤）', async () => {
    for (const reviewStatus of REVIEW_STATUS_VALUES) {
      const executor = new RecordingExecutor([
        { rows: [rowFromRecord({ review_status: reviewStatus })], rowCount: 1 },
      ]);
      const listed = await new PostgresAchievementRepository(executor).listByUserId(OWNER_ID);

      expect(listed).toHaveLength(1);
      expect(listed[0]?.reviewStatus).toBe(reviewStatus);
    }

    // approved / rejected 不会被当成「内部状态」而过滤掉：同一主体的三种审核态一起返回
    const executor = new RecordingExecutor([
      {
        rows: REVIEW_STATUS_VALUES.map((reviewStatus, index) =>
          rowFromRecord({
            id: uuidForIndex(index + 1),
            review_status: reviewStatus,
            created_at: new Date(Date.UTC(2026, 0, 2, 3, 4, index)),
          }),
        ),
        rowCount: REVIEW_STATUS_VALUES.length,
      },
    ]);
    const listed = await new PostgresAchievementRepository(executor).listByUserId(OWNER_ID);
    expect(listed.map((record) => record.reviewStatus)).toEqual([...REVIEW_STATUS_VALUES]);
  });

  it('成果类型闭集内的全部取值都能往返（未知类型不得被当作合法值）', async () => {
    for (const type of ACHIEVEMENT_TYPE_VALUES) {
      const executor = new RecordingExecutor([{ rows: [rowFromRecord({ type })], rowCount: 1 }]);
      const listed = await new PostgresAchievementRepository(executor).listByUserId(OWNER_ID);
      expect(listed[0]?.type).toBe(type);
    }
  });

  it('标题长度边界：300 字符放行、301 字符拒绝、空白标题拒绝，且错误信息不回显原文', async () => {
    const title300 = '标'.repeat(300);
    const title301 = '题'.repeat(301);

    const ok = new RecordingExecutor([{ rows: [rowFromRecord({ title: title300 })], rowCount: 1 }]);
    const stored = await new PostgresAchievementRepository(ok).listByUserId(OWNER_ID);
    expect(stored[0]?.title).toBe(title300);

    for (const title of [title301, '   ']) {
      const executor = new RecordingExecutor([{ rows: [rowFromRecord({ title })], rowCount: 1 }]);
      const error = await captureRepoError(() =>
        new PostgresAchievementRepository(executor).listByUserId(OWNER_ID),
      );
      expect(error.code).toBe('INVALID_ROW');
      expect(error.message).not.toContain(title);
      expect(JSON.stringify(error.issues)).not.toContain(title);
    }
  });

  it('内容安全由读取契约兜底：身份证号 / 密钥样式 / 控制字符一律拒绝且不回显原文', async () => {
    const idCard = '110101199003071234';
    const secret = 'api_key: sk-live-0123456789abcdef';
    // 控制字符直接以字面量投递（不是正则字面量，因此不触发 no-control-regex）
    const control = '说明\u0007带响铃';

    for (const description of [idCard, secret, control]) {
      const executor = new RecordingExecutor([
        { rows: [rowFromRecord({ description })], rowCount: 1 },
      ]);
      const error = await captureRepoError(() =>
        new PostgresAchievementRepository(executor).listByUserId(OWNER_ID),
      );
      expect(error.code).toBe('INVALID_ROW');
      expect(error.message).not.toContain(description);
      expect(JSON.stringify(error.issues)).not.toContain(description);
    }
  });

  it('带时区偏移的时间戳统一映射为 UTC ISO 字符串；文本空白由读取契约归一', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [
          rowFromRecord({
            achieved_at: '2026-05-01T08:00:00+08:00',
            created_at: '2026-01-02T11:04:05+08:00',
            updated_at: new Date(UPDATED_AT),
            title: '  空格包裹的成果标题  ',
            award_level: '  校级一等奖  ',
          }),
        ],
        rowCount: 1,
      },
    ]);
    const listed = await new PostgresAchievementRepository(executor).listByUserId(OWNER_ID);

    expect(listed[0]?.achievedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(listed[0]?.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(listed[0]?.updatedAt).toBe(UPDATED_AT);
    expect(listed[0]?.title).toBe('空格包裹的成果标题');
    expect(listed[0]?.awardLevel).toBe('校级一等奖');
  });

  it('映射结果必须能通过读取契约：字段齐全、枚举闭集、ISO 时间都在', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const listed = await new PostgresAchievementRepository(executor).listByUserId(OWNER_ID);
    const stored = listed[0];

    expect(stored).toBeDefined();
    const parsed = parseStoredAchievement(stored);
    expect(parsed.ok).toBe(true);
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      Object.keys(storedAchievementSchema.shape).sort(),
    );
    const view = toAchievementView(parsed.ok ? parsed.value : ({} as never));
    expect(view.reviewStatus).toBe('pending');
    expect(view.createdAt).toBe(CREATED_AT);
  });
});

describe('PostgreSQL 成果仓储：归属隔离（他人记录既不出库也不回流）', () => {
  it('列表 SQL 必须带归属谓词：去掉 WHERE user_id 就不再是「按主体取数」', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    await new PostgresAchievementRepository(executor).listByUserId(OWNER_ID);

    const sql = executor.calls[0]?.sql ?? '';
    expect(sql).toContain('WHERE user_id = $1::uuid');
    expect(executor.calls[0]?.parameters).toEqual([OWNER_ID]);
  });

  it('单条取数 SQL 必须同时带资源 ID 与归属谓词：只按 ID 命中就是「他人记录可探测」', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    await new PostgresAchievementRepository(executor).findById(ACHIEVEMENT_ID, OWNER_ID);

    const sql = executor.calls[0]?.sql ?? '';
    expect(sql).toContain('WHERE id = $1::uuid AND user_id = $2::uuid');
    expect(sql).not.toContain('*');
    expect(executor.calls[0]?.parameters).toEqual([ACHIEVEMENT_ID, OWNER_ID]);
  });

  it('单条取数未命中（不存在或不属于该主体）→ 返回 undefined，不抛错', async () => {
    const missing = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    await expect(
      new PostgresAchievementRepository(missing).findById(ACHIEVEMENT_ID, OWNER_ID),
    ).resolves.toBeUndefined();

    // 「存在但不属于该主体」在 SQL 层同样只是「没有行」：两种情形不可区分
    const notMine = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    await expect(
      new PostgresAchievementRepository(notMine).findById(OTHER_ACHIEVEMENT_ID, OWNER_ID),
    ).resolves.toBeUndefined();
  });

  it('单条取数回流出他人归属 / 他人主键 → 分别 OWNER_VIOLATION / IDENTITY_MISMATCH', async () => {
    const wrongOwner = new RecordingExecutor([
      { rows: [rowFromRecord({ user_id: OTHER_OWNER_ID })], rowCount: 1 },
    ]);
    const ownerError = await captureRepoError(() =>
      new PostgresAchievementRepository(wrongOwner).findById(ACHIEVEMENT_ID, OWNER_ID),
    );
    expect(ownerError.code).toBe('OWNER_VIOLATION');
    expect(ownerError.issues).toEqual(['user_id']);
    for (const value of [OWNER_ID, OTHER_OWNER_ID, ACHIEVEMENT.title]) {
      expect(ownerError.message).not.toContain(value);
    }

    const wrongId = new RecordingExecutor([
      { rows: [rowFromRecord({ id: OTHER_ACHIEVEMENT_ID })], rowCount: 1 },
    ]);
    const identityError = await captureRepoError(() =>
      new PostgresAchievementRepository(wrongId).findById(ACHIEVEMENT_ID, OWNER_ID),
    );
    expect(identityError.code).toBe('IDENTITY_MISMATCH');
    expect(identityError.issues).toEqual(['id']);
    expect(identityError.message).not.toContain(OTHER_ACHIEVEMENT_ID);
    expect(identityError.message).not.toContain(ACHIEVEMENT_ID);
  });

  it('单条取数返回多行 → RESULT_SET_VIOLATION（主键唯一性被破坏，不得任选一行）', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromRecord(), rowFromRecord()], rowCount: 2 },
    ]);
    const error = await captureRepoError(() =>
      new PostgresAchievementRepository(executor).findById(ACHIEVEMENT_ID, OWNER_ID),
    );

    expect(error.code).toBe('RESULT_SET_VIOLATION');
    expect(error.issues).toEqual(['id']);
  });

  it('单条取数的资源 ID 与主体都必须在存储 ID 域内，非法取值在进入 SQL 之前被拒绝', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresAchievementRepository(executor);

    for (const [label, achievementId] of [
      ['缺失', undefined],
      ['空串', ''],
      ['空 UUID', '00000000-0000-0000-0000-000000000000'],
      ['非 UUID', 'a-1'],
      ['大写规范形', HEX_OWNER_ID_UPPER],
      ['混合大小写', HEX_OWNER_ID_MIXED],
      ['注入载荷', `${ACHIEVEMENT_ID}' OR 1=1 --`],
    ] as const) {
      const error = await captureRepoError(() =>
        repository.findById(achievementId as string, OWNER_ID),
      );
      expect(error.code, label).toBe('INVALID_RECORD_ID');
      expect(error.issues, label).toEqual(['achievementId']);
      // 错误信息不得回显非法取值本身
      if (achievementId) expect(error.message).not.toContain(achievementId);
    }

    for (const [label, userId] of [
      ['空 UUID', '00000000-0000-0000-0000-000000000000'],
      ['非 UUID', 'u-student-1'],
      ['大写规范形', HEX_OWNER_ID_UPPER],
      ['注入载荷', `${OWNER_ID}' OR 1=1 --`],
    ] as const) {
      const error = await captureRepoError(() => repository.findById(ACHIEVEMENT_ID, userId));
      expect(error.code, label).toBe('INVALID_SUBJECT');
      expect(error.issues, label).toEqual(['userId']);
      expect(error.message).not.toContain(userId);
    }

    // 非法取值一次数据库访问都没有产生（fail-closed 发生在建连 / 发 SQL 之前）
    expect(executor.calls).toHaveLength(0);
  });

  it('规范小写 UUID 的资源 ID 与主体可以正常单条取数（大小写约束不是「拒绝一切」）', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromRecord({ id: ACHIEVEMENT_ID, user_id: HEX_OWNER_ID })], rowCount: 1 },
    ]);
    const found = await new PostgresAchievementRepository(executor).findById(
      ACHIEVEMENT_ID,
      HEX_OWNER_ID,
    );

    expect(found?.id).toBe(ACHIEVEMENT_ID);
    expect(executor.calls[0]?.parameters).toEqual([ACHIEVEMENT_ID, HEX_OWNER_ID]);
  });

  it('延迟建连实现先判存储 ID 域、再建连：非法资源 ID 不会触发任何数据库连接', async () => {
    let connects = 0;
    const repository = createLazyPostgresAchievementRepository(async () => {
      connects += 1;
      return new RecordingExecutor();
    });

    const error = await captureRepoError(() => repository.findById('a-1', OWNER_ID));

    expect(error.code).toBe('INVALID_RECORD_ID');
    expect(connects).toBe(0);
  });

  it('列表里混入他人记录 → OWNER_VIOLATION（整批 fail-closed，不静默过滤也不返回）', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [
          rowFromRecord(),
          rowFromRecord({ id: OTHER_ACHIEVEMENT_ID, user_id: OTHER_OWNER_ID }),
        ],
        rowCount: 2,
      },
    ]);
    const error = await captureRepoError(() =>
      new PostgresAchievementRepository(executor).listByUserId(OWNER_ID),
    );

    expect(error.code).toBe('OWNER_VIOLATION');
    expect(error.issues).toEqual(['user_id']);
    // 错误信息不得回显任何主体标识 / 他人成果内容
    for (const value of [OWNER_ID, OTHER_OWNER_ID, ACHIEVEMENT.title, CREATED_AT]) {
      expect(error.message).not.toContain(value);
      expect(JSON.stringify(error.issues)).not.toContain(value);
    }
  });

  it('列表出现重复主键 → RESULT_SET_VIOLATION（同一记录不得在列表里出现两次）', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [rowFromRecord(), rowFromRecord({ title: '重复主键的第二行' })],
        rowCount: 2,
      },
    ]);
    const error = await captureRepoError(() =>
      new PostgresAchievementRepository(executor).listByUserId(OWNER_ID),
    );

    expect(error.code).toBe('RESULT_SET_VIOLATION');
    expect(error.issues).toEqual(['id']);
  });

  it('写入返回他人归属 / 他人主键 → 分别 OWNER_VIOLATION / IDENTITY_MISMATCH', async () => {
    const wrongOwner = new RecordingExecutor([
      { rows: [rowFromRecord({ user_id: OTHER_OWNER_ID })], rowCount: 1 },
    ]);
    const ownerError = await captureRepoError(() =>
      new PostgresAchievementRepository(wrongOwner).create(ACHIEVEMENT),
    );
    expect(ownerError.code).toBe('OWNER_VIOLATION');
    expect(ownerError.message).not.toContain(OTHER_OWNER_ID);

    const wrongId = new RecordingExecutor([
      { rows: [rowFromRecord({ id: OTHER_ACHIEVEMENT_ID })], rowCount: 1 },
    ]);
    const identityError = await captureRepoError(() =>
      new PostgresAchievementRepository(wrongId).create(ACHIEVEMENT),
    );
    expect(identityError.code).toBe('IDENTITY_MISMATCH');
    expect(identityError.message).not.toContain(OTHER_ACHIEVEMENT_ID);
  });

  it('写入未返回行 → CONFLICT（与内存基线「ID 冲突」同语义）；返回多行 → RESULT_SET_VIOLATION', async () => {
    const conflict = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const conflictError = await captureRepoError(() =>
      new PostgresAchievementRepository(conflict).create(ACHIEVEMENT),
    );
    expect(conflictError.code).toBe('CONFLICT');
    expect(conflictError.issues).toEqual(['id']);

    const duplicated = new RecordingExecutor([
      { rows: [rowFromRecord(), rowFromRecord()], rowCount: 2 },
    ]);
    const duplicatedError = await captureRepoError(() =>
      new PostgresAchievementRepository(duplicated).create(ACHIEVEMENT),
    );
    expect(duplicatedError.code).toBe('RESULT_SET_VIOLATION');
  });

  it('归属缺失 / 空 UUID / 非 UUID / 非规范小写形的写记录 → INVALID_RECORD，且不写库', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresAchievementRepository(executor);

    for (const [label, userId] of [
      ['缺失', undefined],
      ['空串', ''],
      ['空 UUID', '00000000-0000-0000-0000-000000000000'],
      ['非 UUID', 'u-student-1'],
      ['大写规范形', HEX_OWNER_ID_UPPER],
      ['混合大小写', HEX_OWNER_ID_MIXED],
      ['注入载荷', `${OWNER_ID}' OR 1=1 --`],
    ] as const) {
      const record: Record<string, unknown> = { ...ACHIEVEMENT };
      if (userId === undefined) {
        delete record.userId;
      } else {
        record.userId = userId;
      }

      const error = await captureRepoError(() =>
        repository.create(record as unknown as Achievement),
      );
      expect(error.code, label).toBe('INVALID_RECORD');
      // 缺失归属由读取契约的严格版本拦下（invalid_type），其余由存储 ID 域约束拦下（userId）
      expect(error.issues.join(','), label).toContain('userId');
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('规范小写 UUID 归属可以正常取数（大小写约束不是「拒绝一切」）', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromRecord({ user_id: HEX_OWNER_ID })], rowCount: 1 },
    ]);
    const listed = await new PostgresAchievementRepository(executor).listByUserId(HEX_OWNER_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.userId).toBe(HEX_OWNER_ID);
  });
});

describe('PostgreSQL 成果仓储：分页与结果集边界（本切片无分页窗口）', () => {
  it('列表语句不含 LIMIT / OFFSET / FETCH，参数只有主体一个（adapter 不得自行截断）', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    await new PostgresAchievementRepository(executor).listByUserId(OWNER_ID);

    const call = executor.calls[0];
    expect(call?.sql).not.toMatch(/\b(?:LIMIT|OFFSET|FETCH|ROWS\s+ONLY)\b/iu);
    expect(call?.sql).not.toMatch(/\b(?:page|pageSize|cursor|window)\b/iu);
    // 分页参数一旦进入端口，就会出现在参数数组里：这里固定「只有归属一个参数」
    expect(call?.parameters).toHaveLength(1);
    expect(call?.parameters).toEqual([OWNER_ID]);
  });

  it('排序键下推为 created_at ASC, id ASC：后续键集分页所需的稳定全序', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    await new PostgresAchievementRepository(executor).listByUserId(OWNER_ID);

    const sql = executor.calls[0]?.sql ?? '';
    expect(sql).toContain('ORDER BY created_at ASC, id ASC');
    // 排序键必须在列清单内（否则数据库会因未知列直接报错，属配置漂移）
    expect([...POSTGRES_ACHIEVEMENT_COLUMNS]).toContain('created_at');
    expect([...POSTGRES_ACHIEVEMENT_COLUMNS]).toContain('id');
  });

  it('空结果按「空页」处理：返回 [] 且不抛错（不是 undefined / 不是 null）', async () => {
    for (const empty of [
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 7 },
    ]) {
      const executor = new RecordingExecutor([empty]);
      const listed = await new PostgresAchievementRepository(executor).listByUserId(OWNER_ID);
      expect(listed).toEqual([]);
      expect(listed).not.toBeUndefined();
    }
  });

  it('大批量（500 条）完整返回、不截断：顺序与数据库返回顺序逐一一致', async () => {
    const rows = Array.from({ length: 500 }, (_unused, index) =>
      rowFromRecord({
        id: uuidForIndex(index + 1),
        title: `成果-${index}`,
        created_at: new Date(Date.UTC(2026, 0, 2, 3, 4, index)),
      }),
    );
    const executor = new RecordingExecutor([{ rows, rowCount: rows.length }]);

    const listed = await new PostgresAchievementRepository(executor).listByUserId(OWNER_ID);

    expect(listed).toHaveLength(500);
    expect(listed.map((record) => record.id)).toEqual(rows.map((row) => row.id));
    expect(listed[0]?.title).toBe('成果-0');
    expect(listed[499]?.title).toBe('成果-499');
    // 一次取数只发一条 SQL：不得用「取一页再取下一页」的本地循环冒充全量取数
    expect(executor.calls).toHaveLength(1);
  });

  it('端口（单一异步契约）没有分页参数（一旦加入分页窗口，本 spec 与 adapter 必须同步改）', () => {
    const source = readFileSync(PORT_PATH, 'utf8');
    const portBlock = source.slice(
      source.indexOf('export interface AchievementRepository {'),
      source.indexOf('export const ACHIEVEMENT_REPOSITORY_BACKEND_POSTGRES'),
    );
    expect(portBlock).toContain('listByUserId(userId: string): Promise<readonly Achievement[]>;');
    expect(portBlock).not.toMatch(/\b(?:window|limit|offset|page|cursor|Page)\b/iu);
  });
});

describe('PostgreSQL 成果仓储：公开视图与错误信息（不泄露归属 / 审核内部字段 / 个人级内容）', () => {
  it('存储记录承载归属（不静默丢弃），但对外视图必须完全不含 userId', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const listed = await new PostgresAchievementRepository(executor).listByUserId(OWNER_ID);
    const stored = listed[0];

    expect(stored?.userId).toBe(OWNER_ID);

    const parsed = parseStoredAchievement(stored);
    expect(parsed.ok).toBe(true);
    const view = toAchievementView(parsed.ok ? parsed.value : ({} as never));

    expect(Object.keys(view)).not.toContain('userId');
    expect(JSON.stringify(view)).not.toContain(OWNER_ID);
    expect(JSON.stringify(view)).not.toContain('user_id');
  });

  it('对外视图不含审核内部字段（审核人 / 审核意见 / 审核时间 / 审计事件 ID）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const listed = await new PostgresAchievementRepository(executor).listByUserId(OWNER_ID);
    const parsed = parseStoredAchievement(listed[0]);
    const view = toAchievementView(parsed.ok ? parsed.value : ({} as never)) as unknown as Record<
      string,
      unknown
    >;

    for (const internal of [
      ...POSTGRES_ACHIEVEMENT_REVIEW_INTERNAL_COLUMNS,
      'reviewerId',
      'reviewComment',
      'reviewedByUserId',
      'reviewedAt',
      'auditEventId',
    ]) {
      expect(Object.keys(view)).not.toContain(internal);
    }
    // 视图键集 = 读取契约字段去掉归属（审核内部字段根本不在契约里，因此不可能出现）
    const expectedKeys = Object.keys(storedAchievementSchema.shape)
      .filter((key) => key !== 'userId')
      .sort();
    expect(Object.keys(view).sort()).toEqual(expectedKeys);
  });

  it('成功路径的返回记录里不出现任何 snake_case 列名（列名只存在于 SQL 与行契约）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const stored = (await new PostgresAchievementRepository(executor).create(
      ACHIEVEMENT,
    )) as unknown as Record<string, unknown>;

    for (const key of Object.keys(stored)) {
      expect(key.includes('_')).toBe(false);
    }
    for (const column of ['user_id', 'review_status', 'evidence_file_id', 'created_at']) {
      expect(stored).not.toHaveProperty(column);
    }
  });

  it('任何失败路径的错误信息与 issues 都不含归属标识、成果原文与佐证文件 ID', async () => {
    const longTitle = '超长标题'.repeat(80);
    const scenarios: readonly (() => Promise<unknown>)[] = [
      // 归属不符（他人记录回流）
      () =>
        new PostgresAchievementRepository(
          new RecordingExecutor([
            {
              rows: [rowFromRecord({ id: OTHER_ACHIEVEMENT_ID, user_id: OTHER_OWNER_ID })],
              rowCount: 1,
            },
          ]),
        ).listByUserId(OWNER_ID),
      // 未登记列（含审核内部列与注入载荷）
      () =>
        new PostgresAchievementRepository(
          new RecordingExecutor([
            {
              rows: [rowFromRecord({ review_comment: `${ACHIEVEMENT.description} DROP TABLE` })],
              rowCount: 1,
            },
          ]),
        ).listByUserId(OWNER_ID),
      // 未知审核态
      () =>
        new PostgresAchievementRepository(
          new RecordingExecutor([
            { rows: [rowFromRecord({ review_status: 'unknown_status' })], rowCount: 1 },
          ]),
        ).listByUserId(OWNER_ID),
      // 标题越界
      () =>
        new PostgresAchievementRepository(
          new RecordingExecutor([{ rows: [rowFromRecord({ title: longTitle })], rowCount: 1 }]),
        ).listByUserId(OWNER_ID),
      // 写路径字段污染
      () =>
        new PostgresAchievementRepository(
          new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]),
        ).create({ ...ACHIEVEMENT, reviewerUserId: OTHER_OWNER_ID } as unknown as Achievement),
      // 主体非法（注入载荷）
      () =>
        new PostgresAchievementRepository(
          new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]),
        ).listByUserId(`${OWNER_ID}' OR 1=1 --`),
      // 单条读取：回流出他人归属
      () =>
        new PostgresAchievementRepository(
          new RecordingExecutor([
            { rows: [rowFromRecord({ user_id: OTHER_OWNER_ID })], rowCount: 1 },
          ]),
        ).findById(ACHIEVEMENT_ID, OWNER_ID),
      // 单条读取：资源 ID 非法（注入载荷）
      () =>
        new PostgresAchievementRepository(
          new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]),
        ).findById(`${ACHIEVEMENT_ID}' OR 1=1 --`, OWNER_ID),
    ];

    const secrets = [
      OWNER_ID,
      OTHER_OWNER_ID,
      ACHIEVEMENT_ID,
      OTHER_ACHIEVEMENT_ID,
      ACHIEVEMENT.title,
      ACHIEVEMENT.description ?? '',
      ACHIEVEMENT.awardLevel ?? '',
      ACHIEVEMENT.evidenceFileId ?? '',
      longTitle,
      `${OWNER_ID}' OR 1=1 --`,
      `${ACHIEVEMENT_ID}' OR 1=1 --`,
      'DROP TABLE',
    ];

    for (const scenario of scenarios) {
      const error = await captureRepoError(scenario);
      const serialized = `${error.message} ${error.code} ${JSON.stringify(error.issues)}`;
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }
      // 错误只带字段路径与违规类型，不带字段取值
      expect(error.issues.every((issue) => !issue.includes(':'))).toBe(true);
    }
  });
});

describe('PostgreSQL 成果仓储：按配置绑定、无驱动依赖、与 schema 边界对齐', () => {
  it('AchievementsModule 通过工厂按「是否配置数据库」绑定（引用工厂导出名，不引用 adapter 类名）', () => {
    const moduleFile = resolve(
      process.cwd(),
      'src',
      'modules',
      'achievements',
      'achievements.module.ts',
    );
    const content = readFileSync(moduleFile, 'utf8');

    // 绑定事实：登记表要求模块里出现「端口令牌 + 工厂导出名」
    expect(content).toContain('ACHIEVEMENT_REPOSITORY');
    expect(content).toContain('createLazyPostgresAchievementRepository');
    expect(content).toContain('InMemoryAchievementRepository');
    // 装配只经工厂：模块不得自行 new 出 adapter，也不得带 Nest 装饰器
    // （注意工厂名 `createLazyPostgresAchievementRepository` 含类名子串，因此断言的是「不得实例化」）
    expect(content).not.toMatch(/new\s+PostgresAchievementRepository/u);
    expect(content).not.toContain('@Injectable');
    // 分流口径与 auth / profiles 完全一致：同一份纯函数 + 可选注入的执行器工厂
    expect(content).toContain('resolveAppDatabaseConfig');
    expect(content).toContain('SQL_CONNECTION_FACTORY');
    expect(content).toContain('optional: true');
  });

  it('持久化登记与数据库模块都不直接引用本 adapter（端口登记表仍按令牌判定）', () => {
    for (const relative of [
      join('src', 'db', 'persistence-bindings.ts'),
      join('src', 'db', 'database.module.ts'),
      join('src', 'db', 'ports', 'sql-executor.port.ts'),
      join('src', 'modules', 'achievements', 'achievements.port.ts'),
      join('src', 'app.module.ts'),
    ]) {
      const content = readApiFile(relative);
      // 端口文件只在注释里以「示例路径」提到 adapter，这不构成装配；任何 import / provider
      // 引用（类名或模块路径）都必须为零
      expect(content).not.toContain(ADAPTER_CLASS);
      expect(content).not.toMatch(
        /(?:from\s+['"][^'"]*achievements\.postgres-repository['"]|require\(\s*['"][^'"]*achievements\.postgres-repository['"]\s*\))/u,
      );
    }
    // `startup-assembly.spec.ts` 与 `achievements.module.ts` 是**允许**引用 adapter 模块的两处：
    // 前者观察「配置了数据库 ⇒ 端口换绑」这一运行期事实（与画像切片同构），后者只引用工厂导出名。
    for (const relative of [
      join('src', 'startup-assembly.spec.ts'),
      join('src', 'modules', 'achievements', 'achievements.module.ts'),
    ]) {
      const content = readApiFile(relative);
      expect(content).toContain('achievements.postgres-repository');
      expect(content).not.toMatch(/new\s+PostgresAchievementRepository/u);
    }
  });

  it('adapter 不引入任何数据库驱动 / ORM 依赖', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    const forbidden = new Set([
      'pg',
      'pg-pool',
      'pg-promise',
      'node-postgres',
      'postgres',
      'postgres.js',
      'slonik',
      'prisma',
      '@prisma/client',
      'typeorm',
      'kysely',
      'drizzle-orm',
      'drizzle-kit',
      'sequelize',
      '@mikro-orm/core',
    ]);
    const specifiers = moduleSpecifiersOf(source);

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(forbidden.has(specifier)).toBe(false);
    }
    expect(new Set(specifiers)).toEqual(
      new Set([
        'zod',
        '@rm/shared',
        '../../db/ports/sql-executor.port',
        './achievements.contract',
        './achievements.port',
      ]),
    );
  });

  it('工作区依赖里没有未授权的 pg 族 / ORM 包（官方 pg 驱动已授权，仅限驱动层）', () => {
    for (const relative of [join('services', 'api', 'package.json'), 'package.json']) {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, relative), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ];
      for (const name of names) {
        expect(
          /^(?:pg-pool|pg-native|pg-promise|postgres|slonik|prisma|@prisma\/client|typeorm|kysely|drizzle-orm|drizzle-kit|sequelize|@mikro-orm\/core)$/u.test(
            name,
          ),
        ).toBe(false);
      }
    }
  });

  it('achievements 由迁移 0004 建表并由 0008 补齐存储层约束（productionReady 保持 false）', () => {
    const migrations = readdirSync(join(REPO_ROOT, 'db', 'migrations'));
    expect(migrations).toContain('0004_achievements.sql');
    expect(migrations).toContain('0008_achievements_constraints.sql');

    const sql = readFileSync(join(REPO_ROOT, 'db', 'migrations', '0004_achievements.sql'), 'utf8');
    // 建表语句必须真的存在，而不是只在注释里登记
    expect(sql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+achievements\s*\(/iu);
    // 列清单里的每一列都必须在迁移里有定义（列清单 ↔ schema 单向核对）
    for (const column of POSTGRES_ACHIEVEMENT_COLUMNS) {
      expect(sql).toMatch(
        new RegExp(
          `\\b${column}\\s+(?:uuid|smallint|integer|varchar|timestamptz|jsonb|boolean)\\b`,
          'u',
        ),
      );
    }
    // 统计聚合读按归属过滤：user_id 必须被索引
    expect(sql).toMatch(/CREATE\s+INDEX[\s\S]*?\(\s*user_id/iu);

    // 0008：本切片把 adapter 契约里「标题非空且不超长」「归属不得为空 UUID」两条规则下沉到存储层
    const constraints = readFileSync(
      join(REPO_ROOT, 'db', 'migrations', '0008_achievements_constraints.sql'),
      'utf8',
    );
    expect(constraints).toMatch(/ALTER\s+TABLE\s+achievements\b/iu);
    expect(constraints).toContain('ADD CONSTRAINT achievements_title_length');
    expect(constraints).toContain('ADD CONSTRAINT achievements_owner_not_nil');
    // 口径：不重复建表、不建索引（0004 的 (user_id, created_at, id) 已覆盖本切片两条取数路径）
    expect(constraints).not.toMatch(/CREATE\s+TABLE\b/iu);
    expect(constraints).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu);

    // 草案目录里仍然没有 achievements（本切片直接落迁移，不落草案）
    const drafts = readdirSync(join(REPO_ROOT, 'db', 'schema-drafts'));
    expect(drafts.some((file) => file.includes('achievement'))).toBe(false);

    expect(POSTGRES_ACHIEVEMENT_REPOSITORY_CAPABILITIES.productionReady).toBe(false);
    expect(POSTGRES_ACHIEVEMENT_REPOSITORY_VERIFICATION_STEPS).toContain(
      'achievements-schema-draft-created-and-promoted-to-migration',
    );
  });

  it('内存基线实现同一异步端口（本切片与 adapter 逐字同签名）', () => {
    const source = readApiFile(
      join('src', 'modules', 'achievements', 'achievements.in-memory-repository.ts'),
    );
    expect(source).toContain('implements AchievementRepository');
    expect(source).not.toContain(ADAPTER_CLASS);
    expect(source).toContain('persistent: false');
    expect(source).toContain('productionReady: false');
    expect(source).toContain('async create(achievement: Achievement): Promise<Achievement>');
    expect(source).toContain(
      'async findById(achievementId: string, ownerUserId: string): Promise<Achievement | undefined>',
    );
    expect(source).toContain('async listByUserId(userId: string): Promise<readonly Achievement[]>');
  });

  it('端口契约是单一异步契约（本切片完成的跨模块契约变更，无并存的同步端口）', () => {
    const source = readApiFile(join('src', 'modules', 'achievements', 'achievements.port.ts'));
    expect(source).toContain('export interface AchievementRepository {');
    expect(source).toContain('create(achievement: Achievement): Promise<Achievement>;');
    expect(source).toContain(
      'findById(achievementId: string, ownerUserId: string): Promise<Achievement | undefined>;',
    );
    expect(source).toContain('listByUserId(userId: string): Promise<readonly Achievement[]>;');
    // 旧的「同步端口」与并存的 `AsyncAchievementRepository` 已收敛：只允许一个端口声明
    expect(source).not.toContain('AsyncAchievementRepository');
    expect(source).not.toContain('create(achievement: Achievement): Achievement;');
    expect(source).not.toContain('findById(achievementId: string): Achievement | undefined;');
    expect(source).not.toContain('listByUserId(userId: string): readonly Achievement[];');
  });
});
