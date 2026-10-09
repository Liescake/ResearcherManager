import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EDUCATION_STATUS_VALUES,
  EDUCATION_TYPE_VALUES,
  EducationStatus,
  EducationType,
  REVIEW_STATUS_VALUES,
  ReviewStatus,
} from '@rm/shared';
import type {
  PersistenceCapabilities,
  SqlExecutor,
  SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import {
  POSTGRES_ADAPTER_REGISTRY,
  POSTGRES_BOUND_SLICE_REGISTRY,
} from '../../db/persistence/postgres-adapter-registry';
import {
  parseStoredEducationRecord,
  storedEducationRecordSchema,
} from './education-records.contract';
import { toEducationRecordView } from './education-records.contract';
import type {
  EducationRecord,
  EducationRecordRepository,
  EducationRecordRepositoryCapabilities,
} from './education-records.port';
import { EDUCATION_RECORD_REPOSITORY_BACKEND_POSTGRES } from './education-records.port';
import {
  POSTGRES_EDUCATION_RECORD_COLUMN_FIELDS,
  POSTGRES_EDUCATION_RECORD_COLUMNS,
  POSTGRES_EDUCATION_RECORD_OWNER_COLUMNS,
  POSTGRES_EDUCATION_RECORD_PERSONAL_COLUMNS,
  POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES,
  POSTGRES_EDUCATION_RECORD_REPOSITORY_VERIFICATION_STEPS,
  POSTGRES_EDUCATION_RECORD_TABLE,
  POSTGRES_EDUCATION_RECORD_VIEW_EXCLUDED_COLUMNS,
  PostgresEducationRecordRepository,
  PostgresEducationRecordRepositoryError,
  assertPostgresEducationRecordRepositoryCapabilities,
} from './education-records.postgres-repository';

/**
 * PostgreSQL 升学记录仓储 adapter 的**离线**验收（不连数据库、不引驱动）。
 *
 * 覆盖六类要求：
 * - **repository 契约**：能力声明（persistent=true / productionReady=false）、列 ↔ 读取契约字段
 *   一一对应、adapter 自身不是 Nest provider（装配经 `education.module.ts` 的工厂）、不引驱动/ORM、
 *   `education_records` 已由迁移 0002 建立；
 * - **参数化 SQL 与固定标识符**：客户端可控值只出现在参数里，SQL 文本只由模块常量构成；
 * - **SQL 注入**：主体 / 资源 ID / 文本字段等所有入口的注入载荷要么只进参数、要么在进入 SQL
 *   之前被拒绝；
 * - **未知列 / 非法状态与边界**：未登记列、未知枚举、越界年份、坏时间戳、坏形状一律 fail-closed；
 * - **归属隔离与泄漏**：他人记录既不出库（归属下推进 SQL）也不得回流，归属与创建时间不得被改写；
 * - **公开视图**：对外视图不含 `userId`，失败路径的错误信息不含归属标识与「院校或去向」原文。
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
  'education',
  'education-records.postgres-repository.ts',
);
const ADAPTER_CLASS = 'PostgresEducationRecordRepository';

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
const RECORD_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_RECORD_ID = '44444444-4444-4444-8444-444444444444';
const CREATED_AT = '2026-01-02T03:04:05.000Z';
const UPDATED_AT = '2026-01-03T04:05:06.000Z';

const RECORD: EducationRecord = {
  id: RECORD_ID,
  userId: OWNER_ID,
  year: 2026,
  type: EducationType.Postgraduate,
  status: EducationStatus.Admitted,
  institutionOrDestination: '示例大学',
  reviewStatus: ReviewStatus.Approved,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

/** 数据库行（snake_case），默认与 RECORD 等价 */
function rowFromRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RECORD.id,
    user_id: RECORD.userId,
    year: 2026,
    type: 'postgraduate',
    status: 'admitted',
    institution_or_destination: '示例大学',
    review_status: 'approved',
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

async function captureRepoError(
  run: () => Promise<unknown>,
): Promise<PostgresEducationRecordRepositoryError> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresEducationRecordRepositoryError);
  return captured as PostgresEducationRecordRepositoryError;
}

function captureSyncError(run: () => unknown): PostgresEducationRecordRepositoryError {
  let captured: unknown;
  try {
    run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresEducationRecordRepositoryError);
  return captured as PostgresEducationRecordRepositoryError;
}

/** SQL 里出现的占位符序号（去重升序），用于断言「占位符数量 === 参数数量」 */
function placeholderIndexes(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1])))].sort(
    (left, right) => left - right,
  );
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

describe('PostgreSQL 升学记录仓储：repository 契约与能力声明', () => {
  it('能力声明恰好是 postgres / persistent=true / productionReady=false，且被冻结', () => {
    expect(POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES).toEqual({
      backend: 'postgres',
      persistent: true,
      productionReady: false,
    });
    expect(EDUCATION_RECORD_REPOSITORY_BACKEND_POSTGRES).toBe('postgres');
    expect(Object.isFrozen(POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES)).toBe(true);
  });

  it('验证清单覆盖「驱动 → 集成 → 草案转迁移 → 异步端口 → UUID 归属 → 才可声明生产」六步', () => {
    expect(POSTGRES_EDUCATION_RECORD_REPOSITORY_VERIFICATION_STEPS).toEqual([
      'driver-dependency-evaluated',
      'integration-tests-against-real-postgres',
      'education-records-schema-draft-created-and-promoted-to-migration',
      'education-record-repository-port-migrated-to-async',
      'session-subject-user-ids-converged-to-uuid',
      'production-ready-capability-flipped-with-evidence',
    ]);
  });

  it('自检放行当前声明，但拒绝「未验证就声称生产可用」', () => {
    expect(() => assertPostgresEducationRecordRepositoryCapabilities()).not.toThrow();

    const promoted = captureSyncError(() =>
      assertPostgresEducationRecordRepositoryCapabilities({
        backend: 'postgres',
        persistent: true,
        productionReady: true,
      }),
    );
    expect(promoted.code).toBe('CAPABILITY_MISDECLARED');
    expect(promoted.issues).toContain('productionReady');

    const nonPersistent = captureSyncError(() =>
      assertPostgresEducationRecordRepositoryCapabilities({
        backend: 'postgres',
        persistent: false,
        productionReady: false,
      }),
    );
    expect(nonPersistent.issues).toContain('persistent');

    for (const backend of ['mysql', 'postgres-draft', 'in-memory-baseline', '']) {
      const misdeclared = captureSyncError(() =>
        assertPostgresEducationRecordRepositoryCapabilities({
          backend,
          persistent: true,
          productionReady: false,
        }),
      );
      expect(misdeclared.issues).toContain('backend');
    }
  });

  it('列清单与读取契约字段一一对应（单一事实来源，无遗漏、无多余）', () => {
    const mappedFields = Object.values(POSTGRES_EDUCATION_RECORD_COLUMN_FIELDS).sort();
    const contractFields = Object.keys(storedEducationRecordSchema.shape).sort();
    expect(mappedFields).toEqual(contractFields);

    // 列自身的卫生：唯一、裸 snake_case 标识符、且列清单与映射表的键集一致
    expect([...POSTGRES_EDUCATION_RECORD_COLUMNS]).toHaveLength(
      new Set(POSTGRES_EDUCATION_RECORD_COLUMNS).size,
    );
    for (const column of POSTGRES_EDUCATION_RECORD_COLUMNS) {
      expect(/^[a-z][a-z0-9_]*$/u.test(column)).toBe(true);
      expect(Object.keys(POSTGRES_EDUCATION_RECORD_COLUMN_FIELDS)).toContain(column);
    }
    expect(Object.keys(POSTGRES_EDUCATION_RECORD_COLUMN_FIELDS).sort()).toEqual(
      [...POSTGRES_EDUCATION_RECORD_COLUMNS].sort(),
    );
  });

  it('表名是字段字典里的 education_records，且列清单不出字段字典闭集', () => {
    expect(POSTGRES_EDUCATION_RECORD_TABLE).toBe('education_records');

    // 字段字典为该表登记的字段必须都落在列清单里（否则存储层与数据字典脱节）。
    // 字典正文属内部文档，公开归档不可读；这里断言**公开可校验**的那一半（列清单包含这些字段），
    // 与字典正文逐行比对的另一半放在下面按需跳过的用例里。
    for (const field of ['year', 'type', 'status', 'institution_or_destination', 'review_status']) {
      expect([...POSTGRES_EDUCATION_RECORD_COLUMNS]).toContain(field);
    }
    // 审核留痕 / 软删除属于后续切片：既不读写，也不用它们做过滤
    for (const deferred of [
      'deleted_at',
      'reviewer_user_id',
      'review_reason',
      'before_value',
      'after_value',
    ]) {
      expect([...POSTGRES_EDUCATION_RECORD_COLUMNS]).not.toContain(deferred);
    }
  });

  // 内部字典不可读时**显式跳过**（输出里可见），不做「静默通过」的降级：
  // 生产安全断言（fail-closed / 列清单边界）不受影响，本用例只对齐文档与列清单。
  it.skipIf(!existsSync(INTERNAL_FIELD_DICTIONARY))(
    '与内部字段级数据字典逐行对齐（需要内部文档；公开归档按设计跳过）',
    () => {
      const dictionary = readFileSync(INTERNAL_FIELD_DICTIONARY, 'utf8');
      for (const field of [
        'year',
        'type',
        'status',
        'institution_or_destination',
        'review_status',
      ]) {
        expect(dictionary).toContain(`| education_records | ${field} |`);
      }
    },
  );

  it('归属列 / 个人级内容列 / 不进入公开输出的列各有明确清单', () => {
    expect([...POSTGRES_EDUCATION_RECORD_OWNER_COLUMNS]).toEqual(['user_id']);
    expect([...POSTGRES_EDUCATION_RECORD_PERSONAL_COLUMNS]).toEqual(['institution_or_destination']);
    expect([...POSTGRES_EDUCATION_RECORD_VIEW_EXCLUDED_COLUMNS]).toEqual(['user_id']);

    for (const column of POSTGRES_EDUCATION_RECORD_OWNER_COLUMNS) {
      expect([...POSTGRES_EDUCATION_RECORD_VIEW_EXCLUDED_COLUMNS]).toContain(column);
      expect([...POSTGRES_EDUCATION_RECORD_COLUMNS]).toContain(column);
    }
    for (const column of POSTGRES_EDUCATION_RECORD_PERSONAL_COLUMNS) {
      expect([...POSTGRES_EDUCATION_RECORD_COLUMNS]).toContain(column);
    }
  });

  it('实现的是异步端口契约（Promise 语义）：内存基线与 PostgreSQL 实现同一份接口', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository: EducationRecordRepository = new PostgresEducationRecordRepository(executor);

    expect(repository.capabilities).toEqual(POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES);
    const created = repository.create(RECORD);
    expect(created).toBeInstanceOf(Promise);
    await expect(created).resolves.toEqual(RECORD);

    const listed = repository.listByUserId(OWNER_ID);
    expect(listed).toBeInstanceOf(Promise);
    await expect(listed).resolves.toEqual([]);
  });

  it('adapter 不是 Nest provider：源码不含 @Injectable，也不在模块 provider 列表里', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).not.toContain('@Injectable');
    expect(source).not.toContain('@Module');
    expect(source).not.toContain('Inject(');
  });
});

describe('PostgreSQL 升学记录仓储：构造与调用 fail-closed', () => {
  it('没有执行器 / 执行器缺 query / 缺能力声明 → 构造即拒绝，且不执行任何 SQL', () => {
    for (const broken of [undefined, null, {}, { capabilities: { backend: 'postgres' } }]) {
      const error = captureSyncError(
        () => new PostgresEducationRecordRepository(broken as unknown as SqlExecutor),
      );
      expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
    }

    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    new PostgresEducationRecordRepository(executor);
    expect(executor.calls).toHaveLength(0);
  });

  it('执行器声明的后端不是 PostgreSQL → 拒绝（不得把 adapter 挂到其他存储上）', () => {
    for (const backend of ['mysql', 'sqlite', 'in-memory-baseline']) {
      const error = captureSyncError(
        () =>
          new PostgresEducationRecordRepository({
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
        new PostgresEducationRecordRepository({
          query: () => Promise.resolve({ rows: [], rowCount: 0 }),
          capabilities: { backend: 'postgres', persistent: false, productionReady: false },
        }),
    );
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
  });

  it('构造后执行器被降级为非持久 → 下一次调用 fail-closed，且不再访问 SQL', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresEducationRecordRepository(executor);

    executor.capabilities = { backend: 'postgres', persistent: false, productionReady: false };

    const error = await captureRepoError(() => repository.findById(RECORD_ID, OWNER_ID));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
  });

  it('构造后能力声明被改写为「生产可用」→ 每次调用都 fail-closed（自检不被绕过）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresEducationRecordRepository(executor);

    (repository as { capabilities: EducationRecordRepositoryCapabilities }).capabilities = {
      backend: 'postgres',
      persistent: true,
      productionReady: true,
    };

    const error = await captureRepoError(() => repository.create(RECORD));
    expect(error.code).toBe('CAPABILITY_MISDECLARED');
    expect(error.issues).toContain('productionReady');
    expect(executor.calls).toHaveLength(0);
  });

  it('结果集缺少 rows 数组 → 判驱动缺陷，不伪装成「该主体尚无升学记录」', async () => {
    for (const broken of [undefined, null, {}, { rows: null }, 'rows']) {
      // 用「原样返回」的执行器，避免替身自身的默认值把 undefined 吞掉
      const rawExecutor: SqlExecutor = {
        capabilities: { backend: 'postgres-raw', persistent: true, productionReady: false },
        query: () => Promise.resolve(broken as unknown as SqlQueryResult<never>),
      };
      const repository = new PostgresEducationRecordRepository(rawExecutor);
      for (const run of [
        () => repository.findById(RECORD_ID, OWNER_ID),
        () => repository.listByUserId(OWNER_ID),
        () => repository.create(RECORD),
      ]) {
        const error = await captureRepoError(run);
        expect(error.code).toBe('INVALID_ROW');
      }
    }
  });

  it('未命中返回 undefined、空列表返回 []（不是抛错、也不是空对象）', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const repository = new PostgresEducationRecordRepository(executor);

    await expect(repository.findById(RECORD_ID, OWNER_ID)).resolves.toBeUndefined();
    await expect(repository.listByUserId(OWNER_ID)).resolves.toEqual([]);
  });
});

describe('PostgreSQL 升学记录仓储：参数化 SQL 与显式字段映射', () => {
  it('写入使用占位符绑定：SQL 只由常量与 $n 组成，参数按列顺序传入', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresEducationRecordRepository(executor);

    const stored = await repository.create(RECORD);

    const call = executor.calls[0];
    expect(call?.sql).toContain(`INSERT INTO ${POSTGRES_EDUCATION_RECORD_TABLE} (`);
    expect(call?.sql).toContain(
      'VALUES ($1::uuid, $2::uuid, $3::smallint, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)',
    );
    expect(call?.sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(call?.sql).toContain('RETURNING');
    expect(call?.sql).not.toContain('SELECT *');
    expect(call?.sql).not.toContain('*');
    expect(placeholderIndexes(call?.sql ?? '')).toEqual(
      Array.from(
        { length: POSTGRES_EDUCATION_RECORD_COLUMNS.length },
        (_unused, index) => index + 1,
      ),
    );
    expect(call?.parameters).toHaveLength(POSTGRES_EDUCATION_RECORD_COLUMNS.length);

    // 领域对象的值只出现在参数里；SQL 文本里一个都不出现
    for (const value of [
      RECORD.id,
      RECORD.userId,
      RECORD.institutionOrDestination,
      String(RECORD.year),
      RECORD.createdAt,
    ]) {
      expect(call?.sql).not.toContain(String(value));
    }
    expect(call?.parameters).toEqual([
      RECORD.id,
      RECORD.userId,
      RECORD.year,
      RECORD.type,
      RECORD.status,
      RECORD.institutionOrDestination,
      RECORD.reviewStatus,
      RECORD.createdAt,
      RECORD.updatedAt,
    ]);
    expect(stored).toEqual(RECORD);
    expect(stored).not.toHaveProperty('user_id');
    expect(stored).not.toHaveProperty('institution_or_destination');
  });

  it('写入语句没有 DO UPDATE：创建端口不得顺手改写既有记录（审核/留痕切片之前不存在改写路径）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    await new PostgresEducationRecordRepository(executor).create(RECORD);

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
    const { institutionOrDestination: _institutionOrDestination, ...withoutOptional } = RECORD;
    const executor = new RecordingExecutor([
      { rows: [rowFromRecord({ institution_or_destination: null })], rowCount: 1 },
    ]);
    const repository = new PostgresEducationRecordRepository(executor);

    const stored = await repository.create(withoutOptional);

    const parameters = executor.calls[0]?.parameters ?? [];
    const columnIndex = (column: string): number =>
      [...POSTGRES_EDUCATION_RECORD_COLUMNS].indexOf(
        column as (typeof POSTGRES_EDUCATION_RECORD_COLUMNS)[number],
      );
    expect(parameters[columnIndex('institution_or_destination')]).toBeNull();
    // null 列在领域记录里表现为「字段不存在」，而不是 undefined 悬挂
    expect(stored).not.toHaveProperty('institutionOrDestination');
    expect(stored).toEqual(withoutOptional);
  });

  it('空串在写入前归一为 NULL，读取侧同样归一为「未填写」（避免往返不一致）', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromRecord({ institution_or_destination: '' })], rowCount: 1 },
    ]);
    const repository = new PostgresEducationRecordRepository(executor);

    const stored = await repository.create({ ...RECORD, institutionOrDestination: '' });

    const parameters = executor.calls[0]?.parameters ?? [];
    const columnIndex = [...POSTGRES_EDUCATION_RECORD_COLUMNS].indexOf(
      'institution_or_destination' as (typeof POSTGRES_EDUCATION_RECORD_COLUMNS)[number],
    );
    expect(parameters[columnIndex]).toBeNull();
    expect(stored).not.toHaveProperty('institutionOrDestination');
  });

  it('行 → 记录是逐字段显式映射：每个列的值都落在对应领域字段上', async () => {
    // 列与领域字段一一对应：整行映射后必须逐字节等于同一个领域记录（任何错位/漏映射都会失败）
    const mappedRecord: EducationRecord = {
      id: '55555555-5555-4555-8555-555555555555',
      userId: HEX_OWNER_ID,
      year: 2000,
      type: EducationType.DirectDoctorate,
      status: EducationStatus.NotAdmitted,
      institutionOrDestination: '去向甲',
      reviewStatus: ReviewStatus.Rejected,
      createdAt: '2026-02-03T04:05:06.000Z',
      updatedAt: '2026-02-04T05:06:07.000Z',
    };
    const executor = new RecordingExecutor([
      {
        rows: [
          rowFromRecord({
            id: mappedRecord.id,
            user_id: mappedRecord.userId,
            year: 2000,
            type: 'direct_doctorate',
            status: 'not_admitted',
            institution_or_destination: '去向甲',
            review_status: 'rejected',
            created_at: new Date('2026-02-03T04:05:06.000Z'),
            updated_at: new Date('2026-02-04T05:06:07.000Z'),
          }),
        ],
        rowCount: 1,
      },
    ]);
    const repository = new PostgresEducationRecordRepository(executor);

    const stored = await repository.create(mappedRecord);

    expect(stored).toEqual(mappedRecord);
  });

  it('单条取数把归属下推进 SQL：资源 ID 与主体各一个占位符，且列清单显式（无 SELECT *）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresEducationRecordRepository(executor);

    const found = await repository.findById(RECORD_ID, OWNER_ID);

    const call = executor.calls[0];
    expect(call?.sql).toContain(`SELECT ${[...POSTGRES_EDUCATION_RECORD_COLUMNS].join(', ')}`);
    expect(call?.sql).toContain(`FROM ${POSTGRES_EDUCATION_RECORD_TABLE}`);
    expect(call?.sql).toContain('WHERE id = $1::uuid AND user_id = $2::uuid');
    expect(call?.sql).not.toContain('*');
    expect(call?.sql).not.toContain(RECORD_ID);
    expect(call?.sql).not.toContain(OWNER_ID);
    expect(call?.parameters).toEqual([RECORD_ID, OWNER_ID]);
    expect(found).toEqual(RECORD);
  });

  it('列表取数只按主体绑定，且排序下推（created_at, id）保证顺序稳定可复现', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresEducationRecordRepository(executor);

    const found = await repository.listByUserId(OWNER_ID);

    const call = executor.calls[0];
    expect(call?.sql).toContain(`SELECT ${[...POSTGRES_EDUCATION_RECORD_COLUMNS].join(', ')}`);
    expect(call?.sql).toContain('WHERE user_id = $1::uuid');
    expect(call?.sql).toContain('ORDER BY created_at ASC, id ASC');
    expect(call?.sql).not.toContain('*');
    expect(call?.sql).not.toContain(OWNER_ID);
    expect(call?.parameters).toEqual([OWNER_ID]);
    expect(found).toEqual([RECORD]);
  });

  it('表名与列清单只由模块常量构成且都是裸标识符，占位符数量与参数数量一致', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromRecord()], rowCount: 1 },
      { rows: [rowFromRecord()], rowCount: 1 },
      { rows: [rowFromRecord()], rowCount: 1 },
    ]);
    const repository = new PostgresEducationRecordRepository(executor);

    await repository.create(RECORD);
    await repository.findById(RECORD_ID, OWNER_ID);
    await repository.listByUserId(OWNER_ID);

    expect(executor.calls).toHaveLength(3);
    for (const call of executor.calls) {
      expect(call.sql).toContain(POSTGRES_EDUCATION_RECORD_TABLE);
      expect(call.sql).not.toContain('*');
      expect(call.sql).not.toMatch(/\b(?:DROP|ALTER|TRUNCATE|GRANT|COPY)\b/u);
      expect(placeholderIndexes(call.sql)).toHaveLength(call.parameters?.length ?? 0);
    }
  });
});

describe('PostgreSQL 升学记录仓储：SQL 注入防线', () => {
  const INJECTION = "x'); DROP TABLE education_records; --";

  it('文本字段里的注入载荷只进参数，SQL 文本与正常输入逐字节相同', async () => {
    const benign = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const malicious = new RecordingExecutor([
      { rows: [rowFromRecord({ institution_or_destination: INJECTION })], rowCount: 1 },
    ]);

    await new PostgresEducationRecordRepository(benign).create(RECORD);
    const stored = await new PostgresEducationRecordRepository(malicious).create({
      ...RECORD,
      institutionOrDestination: INJECTION,
    });

    const maliciousCall = malicious.calls[0];
    expect(maliciousCall?.sql).toEqual(benign.calls[0]?.sql);
    expect(maliciousCall?.sql).not.toContain('DROP TABLE');
    expect(maliciousCall?.sql).not.toContain('--');
    expect(maliciousCall?.parameters?.[5]).toBe(INJECTION);
    // 载荷只是文本：按读取契约原样承载（说明它从未参与 SQL 拼接）
    expect(stored.institutionOrDestination).toBe(INJECTION);
  });

  it('资源 ID / 归属不是合法 UUID 时在进入 SQL 之前就被拒绝，且不访问数据库', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresEducationRecordRepository(executor);

    const injectedIds = [
      `${RECORD_ID}' OR 1=1 --`,
      "1' OR '1'='1",
      '${RECORD_ID}',
      HEX_OWNER_ID_UPPER,
      RECORD_ID.replace(/-/gu, ''),
      '',
      'u-student-1',
      '00000000-0000-0000-0000-000000000000',
      '../../../etc/passwd',
    ];

    for (const recordId of injectedIds) {
      const error = await captureRepoError(() => repository.findById(recordId, OWNER_ID));
      expect(error.code).toBe('INVALID_RECORD_ID');
      expect(error.issues).toContain('recordId');
      // 错误信息不得回显资源标识或注入载荷
      expect(error.message).not.toContain(recordId === '' ? 'x' : recordId);
    }
    for (const userId of injectedIds) {
      const readError = await captureRepoError(() => repository.findById(RECORD_ID, userId));
      expect(readError.code).toBe('INVALID_SUBJECT');
      expect(readError.issues).toContain('userId');
      expect(readError.message).not.toContain(userId === '' ? 'x' : userId);

      const listError = await captureRepoError(() => repository.listByUserId(userId));
      expect(listError.code).toBe('INVALID_SUBJECT');

      const writeError = await captureRepoError(() =>
        repository.create({ ...RECORD, userId } as unknown as EducationRecord),
      );
      expect(writeError.code).toBe('INVALID_RECORD');
      expect(writeError.message).not.toContain(userId === '' ? 'x' : userId);
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('行契约的枚举列不接受大写 / 未登记 / 注入式取值，且错误信息不回显取值', async () => {
    for (const override of [
      { type: "postgraduate' OR '1'='1" },
      { type: 'POSTGRADUATE' },
      { type: 'phd' },
      { status: "admitted' OR '1'='1" },
      { status: 'ADMITTED' },
      { status: 'fully_admitted' },
      { review_status: 'APPROVED' },
      { review_status: 'pending_review' },
    ]) {
      const executor = new RecordingExecutor([{ rows: [rowFromRecord(override)], rowCount: 1 }]);
      const error = await captureRepoError(() =>
        new PostgresEducationRecordRepository(executor).findById(RECORD_ID, OWNER_ID),
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
    expect(source).toMatch(/const SELECT_BY_ID_FOR_OWNER_SQL = `SELECT \$\{COLUMN_LIST\}/u);
    expect(source).toMatch(/const SELECT_BY_OWNER_SQL = `SELECT \$\{COLUMN_LIST\}/u);
    // 执行器调用不得用字符串拼接构造 SQL（值只能作为参数数组传入）
    expect(source).not.toMatch(/executor\.query\([^\n`]*\+/u);
  });
});

describe('PostgreSQL 升学记录仓储：未知列与字段污染', () => {
  it('数据库返回未登记列 → 整行拒绝（不静默丢弃，也不带进结果）', async () => {
    for (const extra of [
      { deleted_at: null },
      { reviewer_user_id: OTHER_OWNER_ID },
      { review_reason: '材料存疑，需人工复核' },
      { before_value: '{"status":"preparing"}' },
      { after_value: '{"status":"admitted"}' },
      { internal_note: '内部备注：疑似违规' },
      { wechat_open_id: 'o-openid-secret' },
      { password_hash: 'argon2-hash-value' },
      { owner_user_id: OTHER_OWNER_ID },
    ]) {
      const executor = new RecordingExecutor([{ rows: [rowFromRecord(extra)], rowCount: 1 }]);
      const repository = new PostgresEducationRecordRepository(executor);

      const error = await captureRepoError(() => repository.findById(RECORD_ID, OWNER_ID));
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
      { rows: [rowFromRecord({ internal_note: '内部备注' })], rowCount: 1 },
    ]);
    const error = await captureRepoError(() =>
      new PostgresEducationRecordRepository(executor).listByUserId(OWNER_ID),
    );
    expect(error.code).toBe('INVALID_ROW');
    expect(error.issues.join(',')).toContain('unrecognized_keys');
  });

  it('写路径字段污染（服务端独占字段 / 归属别名 / 权限字段）→ INVALID_RECORD，且不写库', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresEducationRecordRepository(executor);

    for (const polluted of [
      { ...RECORD, ownerUserId: OTHER_OWNER_ID },
      { ...RECORD, owner_user_id: OTHER_OWNER_ID },
      { ...RECORD, deletedAt: CREATED_AT },
      { ...RECORD, reviewerUserId: OTHER_OWNER_ID },
      { ...RECORD, reviewReason: '管理员代改' },
      { ...RECORD, beforeValue: '{"status":"preparing"}' },
      { ...RECORD, roles: ['super_admin'] },
      { ...RECORD, scope: 'global' },
      { ...RECORD, groupId: 'g-1' },
      { ...RECORD, createdAt: CREATED_AT, created_at: CREATED_AT },
    ]) {
      const error = await captureRepoError(() =>
        repository.create(polluted as unknown as EducationRecord),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(error.issues.join(',')).toContain('unrecognized_keys');
    }
    expect(executor.calls).toHaveLength(0);
  });
});

describe('PostgreSQL 升学记录仓储：非法状态与状态边界', () => {
  it('非法枚举 / 坏时间戳 / 坏形状 / 缺列 一律拒绝（未知状态不得当作合法值）', async () => {
    const poisoned: Record<string, unknown>[] = [
      rowFromRecord({ type: 'unknown_type' }),
      rowFromRecord({ type: '' }),
      rowFromRecord({ status: 'unknown_status' }),
      rowFromRecord({ review_status: 'unknown_review' }),
      rowFromRecord({ year: '2026' }),
      rowFromRecord({ year: null }),
      rowFromRecord({ year: 2026.5 }),
      rowFromRecord({ institution_or_destination: 123 }),
      rowFromRecord({ user_id: 'nope' }),
      rowFromRecord({ id: 'nope' }),
      rowFromRecord({ created_at: 'not-a-date' }),
      rowFromRecord({ created_at: '2026-13-45T99:99:99Z' }),
      rowFromRecord({ updated_at: null }),
      withoutRowColumn('id'),
      withoutRowColumn('user_id'),
      withoutRowColumn('year'),
      withoutRowColumn('type'),
      withoutRowColumn('status'),
      withoutRowColumn('institution_or_destination'),
      withoutRowColumn('review_status'),
      withoutRowColumn('created_at'),
      withoutRowColumn('updated_at'),
    ];

    for (const row of poisoned) {
      const executor = new RecordingExecutor([{ rows: [row], rowCount: 1 }]);
      const error = await captureRepoError(() =>
        new PostgresEducationRecordRepository(executor).findById(RECORD_ID, OWNER_ID),
      );
      expect(error.code).toBe('INVALID_ROW');
    }
  });

  it('年份闭集边界：2000 / 2100 放行，越界与非整数拒绝', async () => {
    for (const year of [2000, 2100]) {
      const executor = new RecordingExecutor([
        {
          rows: [rowFromRecord({ year, created_at: CREATED_AT, updated_at: UPDATED_AT })],
          rowCount: 1,
        },
      ]);
      const found = await new PostgresEducationRecordRepository(executor).findById(
        RECORD_ID,
        OWNER_ID,
      );
      expect(found?.year).toBe(year);
    }

    for (const year of [1999, 2101, 0, -1, 2026.5, Number.NaN, Number.POSITIVE_INFINITY, '2026']) {
      const executor = new RecordingExecutor([{ rows: [rowFromRecord({ year })], rowCount: 1 }]);
      const error = await captureRepoError(() =>
        new PostgresEducationRecordRepository(executor).findById(RECORD_ID, OWNER_ID),
      );
      expect(error.code).toBe('INVALID_ROW');
    }
  });

  it('枚举闭集内的全部取值都能往返（升学状态不因取值不同被静默改写或丢弃）', async () => {
    for (const type of EDUCATION_TYPE_VALUES) {
      for (const status of EDUCATION_STATUS_VALUES) {
        for (const reviewStatus of REVIEW_STATUS_VALUES) {
          const executor = new RecordingExecutor([
            { rows: [rowFromRecord({ type, status, review_status: reviewStatus })], rowCount: 1 },
          ]);
          const found = await new PostgresEducationRecordRepository(executor).findById(
            RECORD_ID,
            OWNER_ID,
          );
          // 状态只做承载：备考中 / 已录取 / 未上岸 与审核态都原样返回，不做口径折算
          expect(found).toMatchObject({ type, status, reviewStatus });
        }
      }
    }
  });

  it('「未上岸 / 备考中 / 已驳回」不会被当成空结果或损坏记录：逐条返回，不做过滤', async () => {
    const rows = [
      rowFromRecord({ id: RECORD_ID, status: 'not_admitted', review_status: 'approved' }),
      rowFromRecord({
        id: OTHER_RECORD_ID,
        status: 'preparing',
        review_status: 'pending',
        institution_or_destination: null,
      }),
      rowFromRecord({
        id: '66666666-6666-4666-8666-666666666666',
        status: 'admitted',
        review_status: 'rejected',
      }),
    ];
    const executor = new RecordingExecutor([{ rows, rowCount: rows.length }]);
    const found = await new PostgresEducationRecordRepository(executor).listByUserId(OWNER_ID);

    expect(found).toHaveLength(3);
    expect(found.map((record) => record.status)).toEqual([
      EducationStatus.NotAdmitted,
      EducationStatus.Preparing,
      EducationStatus.Admitted,
    ]);
    expect(found.map((record) => record.reviewStatus)).toEqual([
      ReviewStatus.Approved,
      ReviewStatus.Pending,
      ReviewStatus.Rejected,
    ]);
    expect(found[1]).not.toHaveProperty('institutionOrDestination');
  });

  it('院校或去向长度边界：200 字符放行、201 字符拒绝，且错误信息不回显原文', async () => {
    const exactly200 = '甲'.repeat(200);
    const accepted = new RecordingExecutor([
      { rows: [rowFromRecord({ institution_or_destination: exactly200 })], rowCount: 1 },
    ]);
    const found = await new PostgresEducationRecordRepository(accepted).findById(
      RECORD_ID,
      OWNER_ID,
    );
    expect(found?.institutionOrDestination).toBe(exactly200);

    for (const value of ['甲'.repeat(201), '乙'.repeat(5000)]) {
      const executor = new RecordingExecutor([
        { rows: [rowFromRecord({ institution_or_destination: value })], rowCount: 1 },
      ]);
      const error = await captureRepoError(() =>
        new PostgresEducationRecordRepository(executor).findById(RECORD_ID, OWNER_ID),
      );
      expect(error.code).toBe('INVALID_ROW');
      expect(error.message).not.toContain(value);
    }
  });

  it('内容安全由读取契约兜底：控制字符等非法文本一律拒绝', async () => {
    const poisoned = `示例大学${String.fromCharCode(7)}注水`;
    const executor = new RecordingExecutor([
      { rows: [rowFromRecord({ institution_or_destination: poisoned })], rowCount: 1 },
    ]);
    const error = await captureRepoError(() =>
      new PostgresEducationRecordRepository(executor).findById(RECORD_ID, OWNER_ID),
    );
    expect(error.code).toBe('INVALID_ROW');
    expect(error.issues.join(',')).toContain('institutionOrDestination');
    expect(error.message).not.toContain('示例大学');
  });

  it('带时区偏移的时间戳统一映射为 UTC ISO 字符串；文本空白由读取契约归一', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [
          rowFromRecord({
            created_at: '2026-01-02T11:04:05.000+08:00',
            updated_at: '2026-01-03T12:05:06.000+08:00',
            institution_or_destination: '  示例大学  ',
          }),
        ],
        rowCount: 1,
      },
    ]);
    const found = await new PostgresEducationRecordRepository(executor).findById(
      RECORD_ID,
      OWNER_ID,
    );

    expect(found?.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(found?.updatedAt).toBe('2026-01-03T04:05:06.000Z');
    expect(found?.institutionOrDestination).toBe('示例大学');
  });

  it('映射结果必须能通过读取契约：字段齐全、枚举闭集、ISO 时间都在', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const found = await new PostgresEducationRecordRepository(executor).findById(
      RECORD_ID,
      OWNER_ID,
    );

    const parsed = parseStoredEducationRecord(found);
    expect(parsed.ok).toBe(true);
  });
});

describe('PostgreSQL 升学记录仓储：归属隔离（他人记录既不出库也不回流）', () => {
  it('单条取数返回的归属与请求主体不一致 → OWNER_VIOLATION，且错误信息不回显任何主体标识', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromRecord({ user_id: OTHER_OWNER_ID })], rowCount: 1 },
    ]);
    const repository = new PostgresEducationRecordRepository(executor);

    const error = await captureRepoError(() => repository.findById(RECORD_ID, OWNER_ID));
    expect(error.code).toBe('OWNER_VIOLATION');
    expect(error.issues).toContain('user_id');
    expect(error.message).not.toContain(OTHER_OWNER_ID);
    expect(error.message).not.toContain(OWNER_ID);
  });

  it('单条取数返回的主键与请求资源不一致 → IDENTITY_MISMATCH（他人记录不得冒充命中）', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromRecord({ id: OTHER_RECORD_ID })], rowCount: 1 },
    ]);
    const error = await captureRepoError(() =>
      new PostgresEducationRecordRepository(executor).findById(RECORD_ID, OWNER_ID),
    );
    expect(error.code).toBe('IDENTITY_MISMATCH');
    expect(error.issues).toContain('id');
    expect(error.message).not.toContain(OTHER_RECORD_ID);
    expect(error.message).not.toContain(RECORD_ID);
  });

  it('单条取数返回多行（主键唯一性被破坏）→ RESULT_SET_VIOLATION', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromRecord(), rowFromRecord()], rowCount: 2 },
    ]);
    const error = await captureRepoError(() =>
      new PostgresEducationRecordRepository(executor).findById(RECORD_ID, OWNER_ID),
    );
    expect(error.code).toBe('RESULT_SET_VIOLATION');
  });

  it('列表里混入他人记录 → OWNER_VIOLATION（整批 fail-closed，不静默过滤也不返回）', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [
          rowFromRecord(),
          rowFromRecord({
            id: OTHER_RECORD_ID,
            user_id: OTHER_OWNER_ID,
            institution_or_destination: '他人大学',
          }),
        ],
        rowCount: 2,
      },
    ]);
    const error = await captureRepoError(() =>
      new PostgresEducationRecordRepository(executor).listByUserId(OWNER_ID),
    );
    expect(error.code).toBe('OWNER_VIOLATION');
    expect(error.issues).toContain('user_id');
    expect(error.message).not.toContain('他人大学');
    expect(error.message).not.toContain(OTHER_OWNER_ID);
  });

  it('列表出现重复主键 → RESULT_SET_VIOLATION（同一记录不得在列表里出现两次）', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromRecord(), rowFromRecord()], rowCount: 2 },
    ]);
    const error = await captureRepoError(() =>
      new PostgresEducationRecordRepository(executor).listByUserId(OWNER_ID),
    );
    expect(error.code).toBe('RESULT_SET_VIOLATION');
  });

  it('写入返回他人归属 / 他人主键 → 分别 OWNER_VIOLATION / IDENTITY_MISMATCH', async () => {
    const foreignOwner = new RecordingExecutor([
      { rows: [rowFromRecord({ user_id: OTHER_OWNER_ID })], rowCount: 1 },
    ]);
    const ownerError = await captureRepoError(() =>
      new PostgresEducationRecordRepository(foreignOwner).create(RECORD),
    );
    expect(ownerError.code).toBe('OWNER_VIOLATION');
    expect(ownerError.issues).toContain('user_id');
    expect(ownerError.message).not.toContain(OTHER_OWNER_ID);

    const foreignId = new RecordingExecutor([
      { rows: [rowFromRecord({ id: OTHER_RECORD_ID })], rowCount: 1 },
    ]);
    const idError = await captureRepoError(() =>
      new PostgresEducationRecordRepository(foreignId).create(RECORD),
    );
    expect(idError.code).toBe('IDENTITY_MISMATCH');
    expect(idError.issues).toContain('id');
    expect(idError.message).not.toContain(OTHER_RECORD_ID);
  });

  it('写入未返回行 → CONFLICT（与内存基线「ID 冲突」同语义）；返回多行 → RESULT_SET_VIOLATION', async () => {
    const conflict = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const conflictError = await captureRepoError(() =>
      new PostgresEducationRecordRepository(conflict).create(RECORD),
    );
    expect(conflictError.code).toBe('CONFLICT');
    expect(conflictError.issues).toContain('id');

    const multi = new RecordingExecutor([
      { rows: [rowFromRecord(), rowFromRecord()], rowCount: 2 },
    ]);
    const multiError = await captureRepoError(() =>
      new PostgresEducationRecordRepository(multi).create(RECORD),
    );
    expect(multiError.code).toBe('RESULT_SET_VIOLATION');
  });

  it('归属缺失 / 空 UUID / 非 UUID 的写记录 → INVALID_RECORD，且不写库', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresEducationRecordRepository(executor);

    for (const userId of ['', 'u-student-1', '00000000-0000-0000-0000-000000000000', 'nope']) {
      const error = await captureRepoError(() =>
        repository.create({ ...RECORD, userId } as unknown as EducationRecord),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(error.issues.join(',')).toContain('userId');
    }
    const { userId: _userId, ...withoutOwner } = RECORD;
    const missing = await captureRepoError(() =>
      repository.create(withoutOwner as unknown as EducationRecord),
    );
    expect(missing.code).toBe('INVALID_RECORD');
    expect(executor.calls).toHaveLength(0);
  });

  it('归属必须是 UUID 的规范小写形：大写等非规范形 fail-closed（不让大小写差异掩盖归属改动）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresEducationRecordRepository(executor);

    for (const userId of [
      HEX_OWNER_ID_UPPER,
      HEX_OWNER_ID_MIXED,
      `{${OWNER_ID}}`,
      `urn:uuid:${OWNER_ID}`,
    ]) {
      const readError = await captureRepoError(() => repository.findById(RECORD_ID, userId));
      expect(readError.code).toBe('INVALID_SUBJECT');
      expect(readError.issues).toContain('userId');
      expect(readError.message).not.toContain(userId);

      const writeError = await captureRepoError(() =>
        repository.create({ ...RECORD, userId } as unknown as EducationRecord),
      );
      expect(writeError.code).toBe('INVALID_RECORD');
      expect(writeError.message).not.toContain(userId);
    }
    expect(executor.calls).toHaveLength(0);

    // 规范小写形本身是合法的：确认上面拒绝的是「非规范形」，而不是这个十六进制字符集
    const canonical = new RecordingExecutor([
      { rows: [rowFromRecord({ user_id: HEX_OWNER_ID })], rowCount: 1 },
    ]);
    await expect(
      new PostgresEducationRecordRepository(canonical).findById(RECORD_ID, HEX_OWNER_ID),
    ).resolves.toMatchObject({ userId: HEX_OWNER_ID });
  });

  it('写路径的资源 ID 同样必须落在存储 ID 域内：非规范形 / 空 UUID 在进 SQL 前拒绝', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresEducationRecordRepository(executor);

    for (const id of [
      HEX_OWNER_ID_UPPER,
      HEX_OWNER_ID_MIXED,
      HEX_OWNER_ID.replace(/-/gu, ''),
      '00000000-0000-0000-0000-000000000000',
      'nope',
      '',
    ]) {
      const error = await captureRepoError(() =>
        repository.create({ ...RECORD, id } as unknown as EducationRecord),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(error.issues.join(',')).toContain('id');
      if (id.length > 0) {
        expect(error.message).not.toContain(id);
      }
    }
    // 关键：全部在**无副作用**状态下失败——一次 SQL 都没发出去，因此不可能留下已写入的行
    // （否则非规范形 ID 会先落库、再被规范形回读判成 IDENTITY_MISMATCH）
    expect(executor.calls).toHaveLength(0);

    // 规范小写形本身合法：写入照常发生，且回读主键与请求一致
    const canonicalId = new RecordingExecutor([
      { rows: [rowFromRecord({ id: HEX_OWNER_ID, user_id: HEX_OWNER_ID })], rowCount: 1 },
    ]);
    await expect(
      new PostgresEducationRecordRepository(canonicalId).create({
        ...RECORD,
        id: HEX_OWNER_ID,
        userId: HEX_OWNER_ID,
      }),
    ).resolves.toMatchObject({ id: HEX_OWNER_ID });
    expect(canonicalId.calls).toHaveLength(1);
  });

  it('写入不改动调用方传入的记录对象（无共享可变状态：入参可冻结）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresEducationRecordRepository(executor);
    const frozen = Object.freeze({ ...RECORD });

    await expect(repository.create(frozen)).resolves.toEqual(RECORD);
    expect(frozen).toEqual(RECORD);
    expect(Object.isFrozen(frozen)).toBe(true);
  });
});

describe('PostgreSQL 升学记录仓储：公开视图与错误信息（不泄露归属与个人级内容）', () => {
  it('存储记录承载归属（不静默丢弃），但对外视图必须完全不含 userId', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const stored = await new PostgresEducationRecordRepository(executor).findById(
      RECORD_ID,
      OWNER_ID,
    );

    // 存储记录承载归属（否则归属复核就无从谈起）
    expect(stored?.userId).toBe(OWNER_ID);

    const parsed = parseStoredEducationRecord(stored);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const view = toEducationRecordView(parsed.value);

    expect(Object.keys(view).sort()).toEqual([
      'createdAt',
      'id',
      'institutionOrDestination',
      'reviewStatus',
      'status',
      'type',
      'updatedAt',
      'year',
    ]);
    expect(Object.keys(view)).not.toContain('userId');
    expect(view).not.toHaveProperty('userId');

    // 公开输出的序列化结果里不得出现归属标识
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(OWNER_ID);
    expect(serialized).not.toContain('userId');
    expect(serialized).not.toContain('user_id');
  });

  it('成功路径的返回记录里不出现任何 snake_case 列名（列名只存在于 SQL 与行契约）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const stored = await new PostgresEducationRecordRepository(executor).findById(
      RECORD_ID,
      OWNER_ID,
    );

    for (const column of POSTGRES_EDUCATION_RECORD_COLUMNS) {
      // `id` / `year` 的列名与字段名同名，属于领域字段本身；其余列名一律不得出现在领域对象上
      if (POSTGRES_EDUCATION_RECORD_COLUMN_FIELDS[column] === column) continue;
      expect(stored).not.toHaveProperty(column);
    }
  });

  it('任何失败路径的错误信息与 issues 都不含归属标识与「院校或去向」原文', async () => {
    const secrets = {
      owner: OTHER_OWNER_ID,
      destination: '敏感去向大学（不应出现在错误里）',
      recordId: OTHER_RECORD_ID,
    };

    const failingRuns: (() => Promise<unknown>)[] = [
      // 归属不一致
      async () =>
        new PostgresEducationRecordRepository(
          new RecordingExecutor([
            {
              rows: [
                rowFromRecord({
                  user_id: secrets.owner,
                  id: secrets.recordId,
                  institution_or_destination: secrets.destination,
                }),
              ],
              rowCount: 1,
            },
          ]),
        ).findById(RECORD_ID, OWNER_ID),
      // 未登记列 + 非法枚举 + 携带个人级内容的整行
      async () =>
        new PostgresEducationRecordRepository(
          new RecordingExecutor([
            {
              rows: [
                rowFromRecord({
                  status: 'unknown_status',
                  institution_or_destination: secrets.destination,
                  internal_note: secrets.destination,
                }),
              ],
              rowCount: 1,
            },
          ]),
        ).listByUserId(OWNER_ID),
      // 写入被拒（携带个人级内容的记录 + 未登记字段）
      async () =>
        new PostgresEducationRecordRepository(
          new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]),
        ).create({
          ...RECORD,
          institutionOrDestination: secrets.destination,
          roles: ['super_admin'],
        } as unknown as EducationRecord),
    ];

    for (const run of failingRuns) {
      const error = await captureRepoError(run);
      for (const secret of Object.values(secrets)) {
        expect(error.message).not.toContain(secret);
        expect(JSON.stringify(error.issues)).not.toContain(secret);
      }
    }
  });
});

describe('PostgreSQL 升学记录仓储：装配、无驱动依赖、与 schema 边界对齐', () => {
  it('EducationModule 经工厂换绑（令牌 + 工厂导出名），adapter 类名不作为 provider 出现', () => {
    const moduleFile = resolve(process.cwd(), 'src', 'modules', 'education', 'education.module.ts');
    const content = readFileSync(moduleFile, 'utf8');

    // adapter 类本身不是 provider：装配只经工厂，类名不得作为 import 绑定 / provider 出现
    // （工厂名里含 "PostgresEducationRecordRepository" 子串，因此这里判「作为独立标识符引用」）
    expect(content).not.toMatch(/[{,]\s*PostgresEducationRecordRepository\s*(?:[,}]|as\b)/u);
    expect(content).not.toMatch(/\bnew\s+PostgresEducationRecordRepository\b/u);
    expect(content).not.toContain('useClass');
    // 换绑点：端口令牌 + 工厂导出名 + 模块路径（登记表按这三个事实判定绑定成立）
    expect(content).toContain('EDUCATION_RECORD_REPOSITORY');
    expect(content).toContain('createLazyPostgresEducationRecordRepository');
    expect(content).toContain("from './education-records.postgres-repository'");
    // 未配置数据库时的分支仍是内存基线，且分流用同一份纯函数
    expect(content).toContain('InMemoryEducationRecordRepository');
    expect(content).toContain('resolveAppDatabaseConfig');
    // 旧的「useExisting 直绑内存基线」必须已经不存在（否则换绑点失去意义）
    expect(content).not.toContain('useExisting: InMemoryEducationRecordRepository');
  });

  it('持久化登记表 / 数据库模块 / 端口 / app 模块都不直接引用 adapter 文件', () => {
    for (const relative of [
      join('src', 'db', 'persistence-bindings.ts'),
      join('src', 'db', 'database.module.ts'),
      join('src', 'db', 'ports', 'sql-executor.port.ts'),
      join('src', 'modules', 'education', 'education-records.port.ts'),
      join('src', 'app.module.ts'),
    ]) {
      const content = readApiFile(relative);
      // 端口文件只在注释里以「示例路径」提到 adapter，这不构成装配；任何 import / provider
      // 引用（类名或模块路径）都必须为零
      expect(content).not.toContain(ADAPTER_CLASS);
      expect(content).not.toMatch(
        /(?:from\s+['"][^'"]*education-records\.postgres-repository['"]|require\(\s*['"][^'"]*education-records\.postgres-repository['"]\s*\))/u,
      );
    }
  });

  it('边界登记表把 education 登记为**已绑定切片**（令牌 + 工厂导出名，且不在未装配组）', () => {
    const bound = POSTGRES_BOUND_SLICE_REGISTRY.filter((item) => item.id === 'education');
    expect(bound).toHaveLength(1);
    expect(bound[0]?.token).toBe('EDUCATION_RECORD_REPOSITORY');
    expect(bound[0]?.factoryExport).toBe('createLazyPostgresEducationRecordRepository');
    expect(bound[0]?.moduleFile).toBe('modules/education/education.module.ts');
    // 两组互斥：同一个 adapter 不得同时留在「未装配」登记表里
    expect(POSTGRES_ADAPTER_REGISTRY.some((item) => item.id === 'education')).toBe(false);
    expect(POSTGRES_ADAPTER_REGISTRY).not.toContainEqual(
      expect.objectContaining({ file: bound[0]?.file }),
    );
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
        './education-records.contract',
        './education-records.port',
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

  it('education_records 复用迁移 0002（不重复造 schema），productionReady 仍为 false', () => {
    const migrations = readdirSync(join(REPO_ROOT, 'db', 'migrations'));
    expect(migrations).toContain('0002_education_records.sql');

    const sql = readFileSync(
      join(REPO_ROOT, 'db', 'migrations', '0002_education_records.sql'),
      'utf8',
    );
    // 建表语句必须真的存在，而不是像 bootstrap 那样只在注释里登记
    expect(sql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+education_records\s*\(/iu);
    // 列清单里的每一列都必须在迁移里有定义（列清单 ↔ schema 单向核对）
    for (const column of POSTGRES_EDUCATION_RECORD_COLUMNS) {
      expect(sql).toMatch(
        new RegExp(
          `\\b${column}\\s+(?:uuid|smallint|integer|varchar|timestamptz|jsonb|boolean)\\b`,
          'u',
        ),
      );
    }
    // 统计聚合读按归属过滤：user_id 必须被索引
    expect(sql).toMatch(/CREATE\s+INDEX[\s\S]*?\(\s*user_id/iu);

    // 表已建 ≠ 可声明生产可用：能力声明仍不得声称生产可用
    expect(POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES.productionReady).toBe(false);
    expect(POSTGRES_EDUCATION_RECORD_REPOSITORY_VERIFICATION_STEPS).toContain(
      'education-records-schema-draft-created-and-promoted-to-migration',
    );
  });

  it('内存基线实现的是**同一份**异步契约，且归属命中与 PostgreSQL 实现一致', () => {
    const source = readApiFile(
      join('src', 'modules', 'education', 'education-records.in-memory-repository.ts'),
    );
    expect(source).toContain('implements EducationRecordRepository');
    expect(source).not.toContain(ADAPTER_CLASS);
    expect(source).toContain('persistent: false');
    expect(source).toContain('productionReady: false');
    // 归属命中（而不是只按资源 ID 命中）：两种实现的 404 语义因此一致
    expect(source).toContain('findById(recordId: string, ownerUserId: string)');
    expect(source).toContain('record.userId !== ownerUserId');
  });

  it('端口契约已收敛为**异步唯一契约**（同步版与并存异步版都不再存在）', () => {
    const source = readApiFile(join('src', 'modules', 'education', 'education-records.port.ts'));
    expect(source).toContain('export interface EducationRecordRepository {');
    expect(source).toContain('create(record: EducationRecord): Promise<EducationRecord>;');
    expect(source).toContain(
      'findById(recordId: string, ownerUserId: string): Promise<EducationRecord | undefined>;',
    );
    expect(source).toContain('listByUserId(userId: string): Promise<readonly EducationRecord[]>;');
    // 并存的第二份契约必须已被删除：单一契约才能保证「内存 ⇄ PostgreSQL」整步换绑
    expect(source).not.toContain('AsyncEducationRecordRepository');
  });
});
