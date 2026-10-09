import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  PersistenceCapabilities,
  SqlExecutor,
  SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import {
  SELF_STATISTICS_FIELDS,
  STATISTICS_COUNT_MAX,
  type SelfStatisticsView,
} from './statistics.contract';
import {
  POSTGRES_STATISTICS_AGGREGATE_COLUMNS,
  POSTGRES_STATISTICS_BACKEND,
  POSTGRES_STATISTICS_FORBIDDEN_SQL_KEYWORDS,
  POSTGRES_STATISTICS_OWNER_COLUMN,
  POSTGRES_STATISTICS_REPOSITORY_CAPABILITIES,
  POSTGRES_STATISTICS_REPOSITORY_VERIFICATION_STEPS,
  POSTGRES_STATISTICS_ROW_COLUMNS,
  POSTGRES_STATISTICS_SELECT_SQL,
  POSTGRES_STATISTICS_VIEW_EXCLUDED_COLUMNS,
  PostgresStatisticsRepository,
  PostgresStatisticsRepositoryError,
  assertPostgresStatisticsColumnsAligned,
  assertPostgresStatisticsReadOnlySql,
  assertPostgresStatisticsRepositoryCapabilities,
  assertPostgresStatisticsRowAligned,
  assertPostgresStatisticsSqlShape,
  findStatisticsViewExclusionLeaks,
  statisticsPlaceholderIndexes,
} from './statistics.postgres-repository';

/**
 * 本人统计 PostgreSQL 聚合读 adapter 的**离线**验收（不连数据库、不引驱动）。
 *
 * 覆盖用户要求与交付边界：
 * - **交付边界**：`persistent = true` / `productionReady = false`（未验证前严禁生产）、
 *   adapter 未装配到 `StatisticsModule` / controller / 端口 / 持久化登记，同步端口未被改成异步，
 *   不引 Nest 装饰器、不引驱动与 ORM；
 * - **固定显式四聚合列 SELECT**：四个 `count(1)::int` 子查询、来源表逐条固定、不使用通配投影，
 *   语句里没有字面量 / 分号 / 注释，执行过的语句只有 `SELECT`；
 * - **`$1::uuid` 参数化**：整条语句只有一个参数位，值只走绑定；注入载荷要么只进参数、要么在进入
 *   SQL 之前被拒绝（拒绝路径一个 SQL 都不执行）；
 * - **strict 非负安全整数行**：负数 / 小数 / NaN / Infinity / 字符串形计数 / 超上限 / 缺列 /
 *   未知列一律 fail-closed，且错误信息只含字段路径，不含字段取值；
 * - **owner 复核**：行归属必须与请求主体逐字节一致（`OWNER_VIOLATION`），大小写差异不被静默修正；
 * - **结果集 fail-closed**：0 行与多行都是 `RESULT_SET_VIOLATION`，0 行绝不被当成「四个 0」；
 * - **四字段公开结果**：返回值恰为 `SELF_STATISTICS_FIELDS` 的四个计数，不含归属；
 * - **异常信息卫生**：驱动异常收敛为不含原始文本与 `cause` 的 `EXECUTOR_FAILURE`。
 */

interface RecordedCall {
  readonly sql: string;
  readonly parameters: readonly unknown[] | undefined;
}

/**
 * 记录型假执行器：只记录 SQL 与参数、按预设顺序返回结果，不连数据库。
 *
 * 能力声明如实写成「postgres + persistent」：adapter 会拒绝非持久后端（内存替身），
 * 因此替身必须声明自己代表的是持久化 PostgreSQL。
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
    const next = (
      this.responses.length > 0 ? this.responses.shift() : { rows: [], rowCount: 0 }
    ) as SqlQueryResult<Row>;
    return Promise.resolve(next);
  }
}

/** 抛出型执行器：用于验证「驱动异常不把原始错误文本带出去」 */
class ThrowingExecutor implements SqlExecutor {
  capabilities: PersistenceCapabilities = {
    backend: 'postgres-test-double',
    persistent: true,
    productionReady: false,
  };

  constructor(private readonly failure: unknown) {}

  query<Row = Record<string, unknown>>(
    _sql: string,
    _parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    return Promise.reject(this.failure);
  }
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
/** 含十六进制字母的归属：用于验证「规范小写形」约束（纯数字 UUID 无法体现大小写差异） */
const HEX_OWNER = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const HEX_OWNER_UPPER = 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** 会话基线的安全 ID 形：合法读取契约形态，但**不在**存储 ID 域内 */
const SESSION_SUBJECT = 'u-student-1';
/** 注入载荷：只允许出现在参数里，绝不允许出现在 SQL 文本或错误信息里 */
const INJECTION = "x'); DROP TABLE education_records; --";
/** 学号：属记录内容，本端点的响应与错误信息里绝不允许出现 */
const STUDENT_NO = '2023010101';
/** 联系方式：同上 */
const PHONE = '13800138000';

const ADAPTER_RELATIVE = 'src/modules/statistics/statistics.postgres-repository.ts';

/** 四个计数的样本值（列名 → 计数）：默认样本行与内存基线的「非全零」形态一致 */
const COUNTS: Readonly<Record<string, number>> = Object.freeze({
  education_records: 3,
  applications: 0,
  achievements: 12,
  matching_requests: 5,
});

/** 数据库行（snake_case）：默认是合法行 */
function rowFromCounts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { [POSTGRES_STATISTICS_OWNER_COLUMN]: OWNER, ...COUNTS, ...overrides };
}

/** 期望的公开结果：由「列 → 字段」映射推导，而不是在测试里另抄一份清单 */
function expectedView(): Record<string, number> {
  const view: Record<string, number> = {};
  for (const entry of POSTGRES_STATISTICS_AGGREGATE_COLUMNS) {
    view[entry.field] = COUNTS[entry.column] ?? 0;
  }
  return view;
}

function rowResult(row: Record<string, unknown>): unknown {
  return { rows: [row], rowCount: 1 };
}

/** 移除某一列，用于「缺列」用例 */
function withoutRowColumn(column: string): Record<string, unknown> {
  const row = rowFromCounts();
  delete row[column];
  return row;
}

/** 用给定响应构造 adapter（响应按调用顺序消费） */
function repoWith(...responses: unknown[]): {
  repository: PostgresStatisticsRepository;
  executor: RecordingExecutor;
} {
  const executor = new RecordingExecutor(responses);
  return { repository: new PostgresStatisticsRepository(executor), executor };
}

async function captureError(
  run: () => Promise<unknown>,
): Promise<PostgresStatisticsRepositoryError> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresStatisticsRepositoryError);
  return captured as PostgresStatisticsRepositoryError;
}

function captureSyncError(run: () => unknown): PostgresStatisticsRepositoryError {
  let captured: unknown;
  try {
    run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresStatisticsRepositoryError);
  return captured as PostgresStatisticsRepositoryError;
}

/**
 * 断言 `issues` 里存在指向某个字段路径的违规。
 * `issues` 的形状是 `字段路径(违规类型)`；归属域约束走 adapter 自有的裸路径，因此同样算命中。
 */
function expectIssueOn(error: PostgresStatisticsRepositoryError, path: string): void {
  expect(error.issues.some((issue) => issue === path || issue.startsWith(`${path}(`))).toBe(true);
}

/** 单词边界命中（避免 `id` 命中 `user_id`、`int` 命中 `count(1)::int` 之类） */
function containsWord(sql: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'u').test(sql);
}

/** 从源码里抽取 import / require 的模块说明符 */
function moduleSpecifiersOf(source: string): string[] {
  return [
    ...source.matchAll(/from\s+['"]([^'"]+)['"]/gu),
    ...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/gu),
  ].map((match) => match[1] ?? '');
}

/** 读取 services/api 下的文件 */
function readApiFile(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8');
}

/** 绝不导入的驱动 / ORM / 数据库包（本切片只依赖驱动无关的 SqlExecutor 端口） */
const FORBIDDEN_DEPENDENCIES = [
  'pg',
  'pg-pool',
  'pg-native',
  'postgres',
  'prisma',
  '@prisma/client',
  'typeorm',
  'sequelize',
  'knex',
  'kysely',
  'mysql',
  'mysql2',
  'better-sqlite3',
  'mongodb',
  'redis',
] as const;

describe('能力声明与交付边界', () => {
  it('能力声明为 postgres + persistent=true + productionReady=false', () => {
    expect(POSTGRES_STATISTICS_REPOSITORY_CAPABILITIES).toEqual({
      backend: POSTGRES_STATISTICS_BACKEND,
      persistent: true,
      productionReady: false,
    });
    expect(POSTGRES_STATISTICS_BACKEND).toBe('postgres');
  });

  it('能力自检拒绝「非持久后端」「未验证就声称生产可用」与错后端', () => {
    expect(() =>
      assertPostgresStatisticsRepositoryCapabilities(POSTGRES_STATISTICS_REPOSITORY_CAPABILITIES),
    ).not.toThrow();

    const notPersistent = captureSyncError(() =>
      assertPostgresStatisticsRepositoryCapabilities({
        backend: 'postgres',
        persistent: false,
        productionReady: false,
      }),
    );
    expect(notPersistent.code).toBe('CAPABILITY_MISDECLARED');
    expect(notPersistent.issues).toContain('persistent');

    const tooReady = captureSyncError(() =>
      assertPostgresStatisticsRepositoryCapabilities({
        backend: 'postgres',
        persistent: true,
        productionReady: true,
      }),
    );
    expect(tooReady.code).toBe('CAPABILITY_MISDECLARED');
    expect(tooReady.issues).toContain('productionReady');

    const wrongBackend = captureSyncError(() =>
      assertPostgresStatisticsRepositoryCapabilities({
        backend: 'in-memory-baseline',
        persistent: true,
        productionReady: false,
      }),
    );
    expect(wrongBackend.code).toBe('CAPABILITY_MISDECLARED');
    expect(wrongBackend.issues).toContain('backend');
  });

  it('验证清单非空，且「翻成生产可用」是最后一项（必须先完成集成验证）', () => {
    expect(POSTGRES_STATISTICS_REPOSITORY_VERIFICATION_STEPS.length).toBeGreaterThanOrEqual(5);
    expect(POSTGRES_STATISTICS_REPOSITORY_VERIFICATION_STEPS).toContain(
      'integration-tests-against-real-postgres',
    );
    expect(
      POSTGRES_STATISTICS_REPOSITORY_VERIFICATION_STEPS[
        POSTGRES_STATISTICS_REPOSITORY_VERIFICATION_STEPS.length - 1
      ],
    ).toBe('production-ready-capability-flipped-with-evidence');
  });

  it('adapter 未装配到模块 / 控制器 / 端口 / 持久化登记', () => {
    const moduleSource = readApiFile('src/modules/statistics/statistics.module.ts');
    expect(moduleSource).not.toContain('PostgresStatisticsRepository');
    expect(moduleSource).not.toContain('statistics.postgres-repository');

    const controllerSource = readApiFile('src/modules/statistics/statistics.controller.ts');
    expect(controllerSource).not.toContain('PostgresStatisticsRepository');

    // 端口不依赖 adapter，且仍是**同步**端口（异步迁移属于「启用数据库」那一步）
    const portSource = readApiFile('src/modules/statistics/statistics.port.ts');
    expect(portSource).not.toContain('PostgresStatisticsRepository');
    expect(portSource).not.toMatch(/Promise</u);
    expect(portSource).toContain('countByUserId(userId: string): number');

    // 持久化登记表仍只登记四个内存令牌，没有引用本 adapter
    const bindingsSource = readApiFile('src/db/persistence-bindings.ts');
    expect(bindingsSource).not.toContain('PostgresStatisticsRepository');
    expect(bindingsSource).toContain('EDUCATION_STATISTICS_REPOSITORY');
    expect(bindingsSource).toContain('MATCHING_STATISTICS_REPOSITORY');
  });

  it('adapter 不是 Nest provider（无装饰器），且不引驱动 / ORM / Nest 包', () => {
    const source = readApiFile(ADAPTER_RELATIVE);
    expect(source).not.toMatch(/@(Injectable|Inject|Module|Controller|Optional|Global)\s*\(/u);

    const specifiers = moduleSpecifiersOf(source);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const forbidden of FORBIDDEN_DEPENDENCIES) {
      expect(specifiers).not.toContain(forbidden);
    }
    for (const specifier of specifiers) {
      expect(specifier.startsWith('@nestjs/')).toBe(false);
    }
    // 只依赖驱动无关的 SQL 端口、读取契约与两个基础包
    expect(specifiers).toEqual(
      expect.arrayContaining([
        'zod',
        '@rm/shared',
        '../../db/ports/sql-executor.port',
        './statistics.contract',
      ]),
    );
  });
});

describe('固定显式四聚合列 SELECT 与单一参数位', () => {
  it('语句以 SELECT 开头，含恰好四个 count(1)::int 聚合列与固定来源表', () => {
    expect(POSTGRES_STATISTICS_SELECT_SQL.startsWith('SELECT ')).toBe(true);
    const aggregates = [...POSTGRES_STATISTICS_SELECT_SQL.matchAll(/count\(1\)::int/gu)];
    expect(aggregates).toHaveLength(POSTGRES_STATISTICS_AGGREGATE_COLUMNS.length);
    expect(aggregates).toHaveLength(4);

    for (const entry of POSTGRES_STATISTICS_AGGREGATE_COLUMNS) {
      expect(POSTGRES_STATISTICS_SELECT_SQL).toContain(
        `(SELECT count(1)::int FROM ${entry.table} WHERE ${POSTGRES_STATISTICS_OWNER_COLUMN} = $1::uuid) AS ${entry.column}`,
      );
    }
    expect(POSTGRES_STATISTICS_SELECT_SQL).toContain(
      `SELECT $1::uuid AS ${POSTGRES_STATISTICS_OWNER_COLUMN}`,
    );
  });

  it('不使用通配投影：语句里没有 `*`，也没有字面量 / 分号 / 注释 / 被禁关键字', () => {
    const sql = POSTGRES_STATISTICS_SELECT_SQL;
    expect(sql).not.toContain('*');
    expect(sql).not.toContain("'");
    expect(sql).not.toContain('"');
    expect(sql).not.toContain(';');
    expect(sql).not.toContain('--');
    expect(sql).not.toContain('/*');
    const upper = sql.toUpperCase();
    for (const keyword of POSTGRES_STATISTICS_FORBIDDEN_SQL_KEYWORDS) {
      expect(containsWord(upper, keyword)).toBe(false);
    }
  });

  it('单一 $1::uuid 参数位：占位符序号恰为 [1]，四个子查询共用同一个参数', () => {
    expect(statisticsPlaceholderIndexes(POSTGRES_STATISTICS_SELECT_SQL)).toEqual([1]);
    const occurrences = [...POSTGRES_STATISTICS_SELECT_SQL.matchAll(/\$1::uuid/gu)].length;
    expect(occurrences).toBe(POSTGRES_STATISTICS_AGGREGATE_COLUMNS.length + 1);
  });

  it('只读语句门禁：接受本语句，拒绝写操作 / DDL / 注释 / 通配 / 字面量', () => {
    expect(() => assertPostgresStatisticsReadOnlySql(POSTGRES_STATISTICS_SELECT_SQL)).not.toThrow();

    const withWrite = captureSyncError(() =>
      assertPostgresStatisticsReadOnlySql(
        `${POSTGRES_STATISTICS_SELECT_SQL}; DROP TABLE education_records`,
      ),
    );
    expect(withWrite.code).toBe('SQL_VIOLATION');

    const withWildcard = captureSyncError(() =>
      assertPostgresStatisticsReadOnlySql('SELECT * FROM education_records'),
    );
    expect(withWildcard.code).toBe('SQL_VIOLATION');
    expect(withWildcard.issues).toContain('wildcard');

    const withLiteral = captureSyncError(() =>
      assertPostgresStatisticsReadOnlySql("SELECT 1 FROM education_records WHERE user_id = 'x'"),
    );
    expect(withLiteral.code).toBe('SQL_VIOLATION');
    expect(withLiteral.issues).toContain('literal');
  });

  it('语句形状自检能发现被篡改的语句（多参数 / 换表 / 少聚合列）', () => {
    expect(() => assertPostgresStatisticsSqlShape(POSTGRES_STATISTICS_SELECT_SQL)).not.toThrow();

    const extraParameter = captureSyncError(() =>
      assertPostgresStatisticsSqlShape(
        POSTGRES_STATISTICS_SELECT_SQL.replace(
          `SELECT $1::uuid AS ${POSTGRES_STATISTICS_OWNER_COLUMN}`,
          `SELECT $2::uuid AS ${POSTGRES_STATISTICS_OWNER_COLUMN}`,
        ),
      ),
    );
    expect(extraParameter.code).toBe('SQL_VIOLATION');

    const otherTable = captureSyncError(() =>
      assertPostgresStatisticsSqlShape(
        POSTGRES_STATISTICS_SELECT_SQL.replace('FROM achievements', 'FROM other_table'),
      ),
    );
    expect(otherTable.code).toBe('SQL_VIOLATION');
  });

  it('列清单与公开白名单一一对应，行契约的键与列清单逐字逐序一致', () => {
    expect(() => assertPostgresStatisticsColumnsAligned()).not.toThrow();
    expect(() => assertPostgresStatisticsRowAligned()).not.toThrow();
    expect(POSTGRES_STATISTICS_AGGREGATE_COLUMNS.map((entry) => entry.field)).toEqual([
      ...SELF_STATISTICS_FIELDS,
    ]);
    expect([...POSTGRES_STATISTICS_ROW_COLUMNS]).toEqual([
      POSTGRES_STATISTICS_OWNER_COLUMN,
      ...POSTGRES_STATISTICS_AGGREGATE_COLUMNS.map((entry) => entry.column),
    ]);
  });

  it('运行期只执行这一条语句、只带一个主体参数', async () => {
    const { repository, executor } = repoWith(rowResult(rowFromCounts()));

    const view = await repository.readCountsByUserId(OWNER);

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.sql).toBe(POSTGRES_STATISTICS_SELECT_SQL);
    expect(executor.calls[0]?.parameters).toEqual([OWNER]);
    expect(view).toEqual(expectedView());
  });
});

describe('strict 非负安全整数行契约', () => {
  it('合法行映射为恰好四个字段的公开结果，且不含归属', async () => {
    const { repository } = repoWith(rowResult(rowFromCounts()));

    const view = await repository.readCountsByUserId(OWNER);

    expect(Object.keys(view)).toHaveLength(4);
    expect([...Object.keys(view)].sort()).toEqual([...SELF_STATISTICS_FIELDS].sort());
    expect(view).toEqual(expectedView());
    expect(JSON.stringify(view)).not.toContain(POSTGRES_STATISTICS_OWNER_COLUMN);
    expect(view).not.toHaveProperty('userId');
  });

  it('每次调用都新建结果对象，不把数据库行或内部引用交给调用方', async () => {
    const { repository } = repoWith(
      rowResult(rowFromCounts()),
      rowResult(rowFromCounts({ education_records: 7 })),
    );

    const first = await repository.readCountsByUserId(OWNER);
    const second = await repository.readCountsByUserId(OWNER);

    expect(first).not.toBe(second);
    expect(first.educationRecords).toBe(3);
    expect(second.educationRecords).toBe(7);

    // 结果不是数据库行本身：私有字段（归属）与行对象都不外泄
    const row = rowFromCounts();
    const isolated = repoWith(rowResult(row));
    const view = await isolated.repository.readCountsByUserId(OWNER);
    expect(view).not.toBe(row);
    expect(Object.keys(view)).not.toContain(POSTGRES_STATISTICS_OWNER_COLUMN);
  });

  it('计数必须是非负安全整数：负数 / 小数 / NaN / Infinity / 字符串 / 布尔 / null / 超上限', async () => {
    const invalidCounts: readonly unknown[] = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '3',
      true,
      null,
      STATISTICS_COUNT_MAX + 1,
    ];
    expect(Number.isSafeInteger(STATISTICS_COUNT_MAX)).toBe(true);

    for (const invalid of invalidCounts) {
      const { repository } = repoWith(rowResult(rowFromCounts({ education_records: invalid })));
      const error = await captureError(() => repository.readCountsByUserId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, 'education_records');
      expect(error.message).not.toContain(String(invalid));
    }
  });

  it('计数上限内的边界值与 0 都被接受（空数据是合法的 0）', async () => {
    const { repository } = repoWith(
      rowResult({
        [POSTGRES_STATISTICS_OWNER_COLUMN]: OWNER,
        education_records: STATISTICS_COUNT_MAX,
        applications: 0,
        achievements: 0,
        matching_requests: 0,
      }),
    );

    const view = await repository.readCountsByUserId(OWNER);

    expect(view.educationRecords).toBe(STATISTICS_COUNT_MAX);
    expect(view.applications).toBe(0);
  });

  it('缺列 fail-closed（归属列与四个聚合列逐列固定）', async () => {
    for (const column of POSTGRES_STATISTICS_ROW_COLUMNS) {
      const { repository } = repoWith(rowResult(withoutRowColumn(column)));
      const error = await captureError(() => repository.readCountsByUserId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, column);
    }
  });

  it('未知列 fail-closed（字段污染不被静默剥离），且未知列取值不进错误信息', async () => {
    const extraColumns: readonly (readonly [string, unknown])[] = [
      ['student_no', STUDENT_NO],
      ['phone', PHONE],
      ['name', '张三'],
      ['created_at', '2026-01-01T00:00:00.000Z'],
      ['internal_note', '存储侧内部列'],
      ['matching_request', 1],
    ];

    for (const [column, value] of extraColumns) {
      const { repository } = repoWith(rowResult(rowFromCounts({ [column]: value })));
      const error = await captureError(() => repository.readCountsByUserId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, column);
      const rendered = [error.message, ...error.issues].join(' ');
      expect(rendered).not.toContain(String(value));
    }
  });
});

describe('归属复核（owner）', () => {
  it('行归属与请求主体不一致 → OWNER_VIOLATION，不返回任何计数', async () => {
    const { repository } = repoWith(
      rowResult(rowFromCounts({ [POSTGRES_STATISTICS_OWNER_COLUMN]: OTHER_OWNER })),
    );

    const error = await captureError(() => repository.readCountsByUserId(OWNER));

    expect(error.code).toBe('OWNER_VIOLATION');
    expectIssueOn(error, POSTGRES_STATISTICS_OWNER_COLUMN);
    expect([error.message, ...error.issues].join(' ')).not.toContain(OTHER_OWNER);
  });

  it('行归属不是规范小写 UUID → INVALID_ROW（nil / 大写 / 会话主体形 / 注入载荷）', async () => {
    const invalidOwners: readonly unknown[] = [
      NIL_UUID,
      HEX_OWNER_UPPER,
      SESSION_SUBJECT,
      INJECTION,
      '',
      42,
    ];

    for (const owner of invalidOwners) {
      const { repository } = repoWith(
        rowResult(rowFromCounts({ [POSTGRES_STATISTICS_OWNER_COLUMN]: owner })),
      );
      const error = await captureError(() => repository.readCountsByUserId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, POSTGRES_STATISTICS_OWNER_COLUMN);
      const rendered = [error.message, ...error.issues].join(' ');
      const supplied = String(owner);
      if (supplied !== '') {
        expect(rendered).not.toContain(supplied);
      }
    }
  });

  it('大小写差异不被静默修正：含十六进制字母的规范小写归属才被接受', async () => {
    const ok = repoWith(
      rowResult(rowFromCounts({ [POSTGRES_STATISTICS_OWNER_COLUMN]: HEX_OWNER })),
    );
    const view = await ok.repository.readCountsByUserId(HEX_OWNER);
    expect(view).toEqual(expectedView());
    expect(ok.executor.calls[0]?.parameters).toEqual([HEX_OWNER]);

    const upper = repoWith(
      rowResult(rowFromCounts({ [POSTGRES_STATISTICS_OWNER_COLUMN]: HEX_OWNER_UPPER })),
    );
    const error = await captureError(() => upper.repository.readCountsByUserId(HEX_OWNER_UPPER));
    // 大写形主体在进入 SQL 之前就被拒绝（存储 ID 域要求规范小写）
    expect(error.code).toBe('INVALID_SUBJECT');
    expect(upper.executor.calls).toHaveLength(0);
  });
});

describe('结果集 fail-closed', () => {
  it('0 行 → RESULT_SET_VIOLATION，绝不被当成「四个 0」', async () => {
    const { repository } = repoWith({ rows: [], rowCount: 0 });

    const error = await captureError(() => repository.readCountsByUserId(OWNER));

    expect(error.code).toBe('RESULT_SET_VIOLATION');
    expect(error.message).toContain('一行');
  });

  it('多行 → RESULT_SET_VIOLATION，不静默取首行', async () => {
    const { repository } = repoWith({
      rows: [rowFromCounts(), rowFromCounts({ education_records: 99 })],
      rowCount: 2,
    });

    const error = await captureError(() => repository.readCountsByUserId(OWNER));

    expect(error.code).toBe('RESULT_SET_VIOLATION');
  });

  it('执行结果不是对象 / 缺 rows 数组 → INVALID_ROW（驱动或替身缺陷不得当成空结果）', async () => {
    for (const response of [null, 'rows', { rowCount: 0 }]) {
      const { repository } = repoWith(response);
      const error = await captureError(() => repository.readCountsByUserId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
    }
  });
});

describe('入口主体受存储 ID 域约束', () => {
  it('非存储 ID 域的主体一律 INVALID_SUBJECT，且一个 SQL 都不执行', async () => {
    const invalidSubjects: readonly unknown[] = [
      SESSION_SUBJECT,
      '',
      'not-a-uuid',
      NIL_UUID,
      HEX_OWNER_UPPER,
      INJECTION,
      42,
    ];

    for (const subject of invalidSubjects) {
      const { repository, executor } = repoWith(rowResult(rowFromCounts()));
      const error = await captureError(() =>
        repository.readCountsByUserId(subject as unknown as string),
      );
      expect(error.code).toBe('INVALID_SUBJECT');
      expectIssueOn(error, 'ownerUserId');
      expect(executor.calls).toHaveLength(0);
      const rendered = [error.message, ...error.issues].join(' ');
      const supplied = String(subject);
      if (supplied !== '') {
        expect(rendered).not.toContain(supplied);
      }
    }
  });
});

describe('执行器边界与异常信息卫生', () => {
  it('构造期拒绝不可用 / 非 postgres / 非持久执行器', () => {
    expect(
      captureSyncError(() => new PostgresStatisticsRepository(undefined as unknown as SqlExecutor))
        .code,
    ).toBe('EXECUTOR_UNAVAILABLE');

    const missingQuery = {
      capabilities: { backend: 'postgres', persistent: true, productionReady: false },
    };
    expect(
      captureSyncError(
        () => new PostgresStatisticsRepository(missingQuery as unknown as SqlExecutor),
      ).code,
    ).toBe('EXECUTOR_UNAVAILABLE');

    const missingCapabilities = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) };
    expect(
      captureSyncError(
        () => new PostgresStatisticsRepository(missingCapabilities as unknown as SqlExecutor),
      ).code,
    ).toBe('EXECUTOR_UNAVAILABLE');

    const notPostgres = new RecordingExecutor([]);
    notPostgres.capabilities = {
      backend: 'in-memory-baseline',
      persistent: true,
      productionReady: false,
    };
    expect(captureSyncError(() => new PostgresStatisticsRepository(notPostgres)).code).toBe(
      'EXECUTOR_NOT_POSTGRES',
    );

    const notPersistent = new RecordingExecutor([]);
    notPersistent.capabilities = { backend: 'postgres', persistent: false, productionReady: false };
    expect(captureSyncError(() => new PostgresStatisticsRepository(notPersistent)).code).toBe(
      'EXECUTOR_NOT_PERSISTENT',
    );
  });

  it('构造后被降级为非持久执行器 → 调用前 fail-closed，且不执行 SQL', async () => {
    const { repository, executor } = repoWith(rowResult(rowFromCounts()));
    executor.capabilities = { backend: 'postgres', persistent: false, productionReady: false };

    const error = await captureError(() => repository.readCountsByUserId(OWNER));

    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
  });

  it('执行器异常收敛为不含原始文本与 cause 的 EXECUTOR_FAILURE', async () => {
    const secret =
      'password=abcdefgh1234 host=db.internal user_id=11111111-1111-4111-8111-111111111111';
    const repository = new PostgresStatisticsRepository(new ThrowingExecutor(new Error(secret)));

    const error = await captureError(() => repository.readCountsByUserId(OWNER));

    expect(error.code).toBe('EXECUTOR_FAILURE');
    expect(error.cause).toBeUndefined();
    const rendered = [error.message, ...error.issues].join(' ');
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain('abcdefgh1234');
    expect(rendered).not.toContain('db.internal');
  });
});

describe('公开白名单：归属不外发', () => {
  it('归属列及其驼峰形都不在公开白名单里（模块加载期已自检）', () => {
    expect([...POSTGRES_STATISTICS_VIEW_EXCLUDED_COLUMNS]).toEqual([
      POSTGRES_STATISTICS_OWNER_COLUMN,
    ]);
    expect(findStatisticsViewExclusionLeaks(SELF_STATISTICS_FIELDS)).toEqual([]);

    expect(findStatisticsViewExclusionLeaks(['user_id'])).toEqual([
      POSTGRES_STATISTICS_OWNER_COLUMN,
    ]);
    expect(findStatisticsViewExclusionLeaks(['userId'])).toEqual([
      POSTGRES_STATISTICS_OWNER_COLUMN,
    ]);
    expect(findStatisticsViewExclusionLeaks(['educationRecords', 'userId'])).toEqual([
      POSTGRES_STATISTICS_OWNER_COLUMN,
    ]);
  });

  it('返回结果只有四个计数：不含归属、不含记录内容与 PII', async () => {
    const { repository } = repoWith(
      rowResult(rowFromCounts({ [POSTGRES_STATISTICS_OWNER_COLUMN]: OWNER })),
    );

    const view: SelfStatisticsView = await repository.readCountsByUserId(OWNER);
    const serialized = JSON.stringify(view);

    expect(Object.keys(view).sort()).toEqual([...SELF_STATISTICS_FIELDS].sort());
    expect(serialized).not.toMatch(/user_id|userId|student_no|phone|name/iu);
    expect(String(view.educationRecords)).toBe(String(COUNTS.education_records));
  });
});
