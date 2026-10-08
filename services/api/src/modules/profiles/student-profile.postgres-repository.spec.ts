import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AvailablePeriod, Grade, ProgrammingLevel } from '@rm/shared';
import type {
  PersistenceCapabilities,
  SqlExecutor,
  SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import {
  FORBIDDEN_PROFILE_FIELDS,
  storedStudentProfileSchema,
  toStudentProfileView,
} from './student-profile.contract';
import type { AsyncProfileRepository, StudentProfile } from './student-profile.port';
import { PROFILE_REPOSITORY_BACKEND_POSTGRES } from './student-profile.port';
import {
  POSTGRES_STUDENT_PROFILE_COLUMNS,
  POSTGRES_STUDENT_PROFILE_COLUMN_FIELDS,
  POSTGRES_STUDENT_PROFILE_IMMUTABLE_COLUMNS,
  POSTGRES_STUDENT_PROFILE_PII_COLUMNS,
  POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES,
  POSTGRES_STUDENT_PROFILE_REPOSITORY_VERIFICATION_STEPS,
  POSTGRES_STUDENT_PROFILE_TABLE,
  POSTGRES_STUDENT_PROFILE_VIEW_EXCLUDED_COLUMNS,
  PostgresStudentProfileRepository,
  PostgresStudentProfileRepositoryError,
  assertPostgresStudentProfileRepositoryCapabilities,
} from './student-profile.postgres-repository';

/**
 * PostgreSQL 学生画像仓储 adapter 的**离线**验收（不连数据库、不引驱动）。
 *
 * 覆盖五类要求：
 * - **repository 契约**：能力声明（persistent=true / productionReady=false）、列 ↔ 读取契约字段
 *   一一对应、未被装配到 `ProfilesModule`、不引驱动/ORM、未转为迁移；
 * - **参数化 SQL**：客户端可控值只出现在参数里，SQL 文本只由模块常量构成；
 * - **SQL 注入**：名称/标签/归属等所有入口的注入载荷要么只进参数、要么在进入 SQL 之前被拒绝；
 * - **未知列 / 非法状态**：未登记列、未知 jsonb 键、非法枚举、坏时间戳、坏形状一律 fail-closed；
 * - **归属泄漏**：他人画像不得回流，归属与生命周期字段不得被改写。
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
const ADAPTER_PATH = resolve(
  process.cwd(),
  'src',
  'modules',
  'profiles',
  'student-profile.postgres-repository.ts',
);
const ADAPTER_CLASS = 'PostgresStudentProfileRepository';
const ADAPTER_MODULE = 'student-profile.postgres-repository';

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
const CREATED_AT = '2026-01-02T03:04:05.000Z';
const UPDATED_AT = '2026-01-03T04:05:06.000Z';

const PROFILE: StudentProfile = {
  userId: OWNER_ID,
  name: '张三',
  studentNo: '2023123456',
  college: '计算机学院',
  major: '软件工程',
  grade: Grade.Junior,
  phone: '13800138000',
  skills: ['TypeScript', 'PostgreSQL'],
  programmingLevel: ProgrammingLevel.Intermediate,
  researchExperience: '参与过数据要素流通课题',
  competitionExperience: '省级程序设计竞赛二等奖',
  availableTime: {
    weeklyHours: 12,
    periods: [AvailablePeriod.Weekend, AvailablePeriod.WeekdayNight],
    note: '周末全天',
  },
  researchInterests: ['数据要素', '隐私计算'],
  strengths: '工程实现能力',
  intendedFields: ['可信数据空间'],
  privacyConsent: { policyVersion: 'v2026-01', consentedAt: '2026-01-02T03:00:00.000Z' },
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

/** 数据库行（snake_case），默认与 PROFILE 等价 */
function rowFromProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: PROFILE.userId,
    name: PROFILE.name,
    student_no: PROFILE.studentNo,
    college: PROFILE.college,
    major: PROFILE.major,
    grade: 'junior',
    phone: PROFILE.phone,
    skills: ['TypeScript', 'PostgreSQL'],
    programming_level: 'intermediate',
    research_experience: '参与过数据要素流通课题',
    competition_experience: '省级程序设计竞赛二等奖',
    available_time: {
      weeklyHours: 12,
      periods: ['weekend', 'weekday_night'],
      note: '周末全天',
    },
    research_interests: ['数据要素', '隐私计算'],
    strengths: '工程实现能力',
    intended_fields: ['可信数据空间'],
    privacy_consent: { policyVersion: 'v2026-01', consentedAt: '2026-01-02T03:00:00.000Z' },
    created_at: new Date(CREATED_AT),
    updated_at: new Date(UPDATED_AT),
    ...overrides,
  };
}

/** 移除某一列，用于「缺列」用例 */
function withoutRowColumn(column: string): Record<string, unknown> {
  const row = rowFromProfile();
  delete row[column];
  return row;
}

async function captureRepoError(
  run: () => Promise<unknown>,
): Promise<PostgresStudentProfileRepositoryError> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresStudentProfileRepositoryError);
  return captured as PostgresStudentProfileRepositoryError;
}

function captureSyncError(run: () => unknown): PostgresStudentProfileRepositoryError {
  let captured: unknown;
  try {
    run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresStudentProfileRepositoryError);
  return captured as PostgresStudentProfileRepositoryError;
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

describe('PostgreSQL 画像仓储：repository 契约与能力声明', () => {
  it('能力声明恰好是 postgres / persistent=true / productionReady=false，且被冻结', () => {
    expect(POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES).toEqual({
      backend: 'postgres',
      persistent: true,
      productionReady: false,
    });
    expect(PROFILE_REPOSITORY_BACKEND_POSTGRES).toBe('postgres');
    expect(Object.isFrozen(POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES)).toBe(true);
  });

  it('验证清单覆盖「驱动 → 集成 → 草案转迁移 → PII → 异步端口 → UUID 归属 → 才可声明生产」七步', () => {
    expect(POSTGRES_STUDENT_PROFILE_REPOSITORY_VERIFICATION_STEPS).toEqual([
      'driver-dependency-evaluated',
      'integration-tests-against-real-postgres',
      'student-profiles-schema-draft-created-and-promoted-to-migration',
      'pii-storage-decided-for-student-no-and-phone',
      'profile-repository-port-migrated-to-async',
      'session-subject-user-ids-converged-to-uuid',
      'production-ready-capability-flipped-with-evidence',
    ]);
  });

  it('自检放行当前声明，但拒绝「未验证就声称生产可用」', () => {
    expect(() => assertPostgresStudentProfileRepositoryCapabilities()).not.toThrow();

    const promoted = captureSyncError(() =>
      assertPostgresStudentProfileRepositoryCapabilities({
        backend: 'postgres',
        persistent: true,
        productionReady: true,
      }),
    );
    expect(promoted.code).toBe('CAPABILITY_MISDECLARED');
    expect(promoted.issues).toContain('productionReady');

    const nonPersistent = captureSyncError(() =>
      assertPostgresStudentProfileRepositoryCapabilities({
        backend: 'postgres',
        persistent: false,
        productionReady: false,
      }),
    );
    expect(nonPersistent.issues).toContain('persistent');

    for (const backend of ['mysql', 'postgres-draft', 'in-memory-baseline', '']) {
      const misdeclared = captureSyncError(() =>
        assertPostgresStudentProfileRepositoryCapabilities({
          backend,
          persistent: true,
          productionReady: false,
        }),
      );
      expect(misdeclared.issues).toContain('backend');
    }
  });

  it('列清单与读取契约字段一一对应（单一事实来源，无遗漏、无多余）', () => {
    const mappedFields = Object.values(POSTGRES_STUDENT_PROFILE_COLUMN_FIELDS).sort();
    const contractFields = Object.keys(storedStudentProfileSchema.shape).sort();
    expect(mappedFields).toEqual(contractFields);

    // 列自身的卫生：唯一、裸 snake_case 标识符、且列清单与映射表的键集一致
    expect([...POSTGRES_STUDENT_PROFILE_COLUMNS]).toHaveLength(
      new Set(POSTGRES_STUDENT_PROFILE_COLUMNS).size,
    );
    for (const column of POSTGRES_STUDENT_PROFILE_COLUMNS) {
      expect(/^[a-z][a-z0-9_]*$/u.test(column)).toBe(true);
      expect(Object.keys(POSTGRES_STUDENT_PROFILE_COLUMN_FIELDS)).toContain(column);
    }
    expect(Object.keys(POSTGRES_STUDENT_PROFILE_COLUMN_FIELDS).sort()).toEqual(
      [...POSTGRES_STUDENT_PROFILE_COLUMNS].sort(),
    );
  });

  it('表名是字段字典里的 student_profiles，且不承载后续切片/服务端独占的锁定列', () => {
    expect(POSTGRES_STUDENT_PROFILE_TABLE).toBe('student_profiles');

    // 首次提交锁定与管理员代改属于后续切片：这些服务端独占字段既不读写，也不用它们做过滤
    for (const deferred of [
      'profile_submitted_at',
      'profile_locked_at',
      ...FORBIDDEN_PROFILE_FIELDS,
    ]) {
      expect([...POSTGRES_STUDENT_PROFILE_COLUMNS]).not.toContain(deferred);
    }
  });

  it('归属与创建时间是不可覆盖列（ON CONFLICT 的 SET 子句必须排除它们）', () => {
    expect([...POSTGRES_STUDENT_PROFILE_IMMUTABLE_COLUMNS]).toEqual(['user_id', 'created_at']);
  });

  it('实现的是异步仓储契约（Promise 语义），未被绑定为同步端口', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromProfile()], rowCount: 1 }]);
    const repository: AsyncProfileRepository = new PostgresStudentProfileRepository(executor);

    expect(repository.capabilities).toEqual(POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES);
    const saved = repository.save(PROFILE);
    expect(saved).toBeInstanceOf(Promise);
    await expect(saved).resolves.toEqual(PROFILE);
  });
});

describe('PostgreSQL 画像仓储：构造与调用 fail-closed', () => {
  it('没有执行器 / 执行器缺 query / 缺能力声明 → 构造即拒绝，且不执行任何 SQL', () => {
    for (const broken of [undefined, null, {}, { capabilities: { backend: 'postgres' } }]) {
      const error = captureSyncError(
        () => new PostgresStudentProfileRepository(broken as unknown as SqlExecutor),
      );
      expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
    }

    const executor = new RecordingExecutor([{ rows: [rowFromProfile()], rowCount: 1 }]);
    new PostgresStudentProfileRepository(executor);
    expect(executor.calls).toHaveLength(0);
  });

  it('执行器声明的后端不是 PostgreSQL → 拒绝（不得把 adapter 挂到其他存储上）', () => {
    const error = captureSyncError(
      () =>
        new PostgresStudentProfileRepository({
          query: () => Promise.resolve({ rows: [], rowCount: 0 }),
          capabilities: { backend: 'mysql', persistent: true, productionReady: true },
        }),
    );
    expect(error.code).toBe('EXECUTOR_NOT_POSTGRES');
  });

  it('执行器声明为非持久后端（内存替身）→ 拒绝', () => {
    const error = captureSyncError(
      () =>
        new PostgresStudentProfileRepository({
          query: () => Promise.resolve({ rows: [], rowCount: 0 }),
          capabilities: { backend: 'postgres', persistent: false, productionReady: false },
        }),
    );
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
  });

  it('构造后执行器被降级为非持久 → 下一次调用 fail-closed，且不再访问 SQL', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromProfile()], rowCount: 1 }]);
    const repository = new PostgresStudentProfileRepository(executor);

    executor.capabilities = { backend: 'postgres', persistent: false, productionReady: false };

    const error = await captureRepoError(() => repository.findByUserId(OWNER_ID));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
  });

  it('结果集缺少 rows 数组 → 判驱动缺陷，不伪装成「该主体尚无画像」', async () => {
    for (const broken of [undefined, null, {}, { rows: null }, 'rows']) {
      // 用「原样返回」的执行器，避免替身自身的默认值把 undefined 吞掉
      const rawExecutor: SqlExecutor = {
        capabilities: { backend: 'postgres-raw', persistent: true, productionReady: false },
        query: () => Promise.resolve(broken as unknown as SqlQueryResult<never>),
      };
      const repository = new PostgresStudentProfileRepository(rawExecutor);
      const error = await captureRepoError(() => repository.findByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
    }
  });

  it('未命中返回 undefined（不是空对象、也不是抛错）', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const repository = new PostgresStudentProfileRepository(executor);
    await expect(repository.findByUserId(OWNER_ID)).resolves.toBeUndefined();
  });
});

describe('PostgreSQL 画像仓储：参数化 SQL 与显式字段映射', () => {
  it('写入使用占位符绑定：SQL 只由常量与 $n 组成，参数按列顺序传入', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromProfile()], rowCount: 1 }]);
    const repository = new PostgresStudentProfileRepository(executor);

    const stored = await repository.save(PROFILE);

    const call = executor.calls[0];
    expect(call?.sql).toContain(`INSERT INTO ${POSTGRES_STUDENT_PROFILE_TABLE} (`);
    expect(call?.sql).toContain('VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10,');
    expect(call?.sql).toContain('$12::jsonb');
    expect(call?.sql).toContain('$16::jsonb');
    expect(call?.sql).toContain('$18::timestamptz)');
    expect(call?.sql).toContain('ON CONFLICT (user_id) DO UPDATE SET');
    expect(call?.sql).toContain('RETURNING');
    expect(call?.sql).not.toContain('SELECT *');
    expect(call?.sql).not.toContain('*');
    expect(placeholderIndexes(call?.sql ?? '')).toEqual(
      Array.from(
        { length: POSTGRES_STUDENT_PROFILE_COLUMNS.length },
        (_unused, index) => index + 1,
      ),
    );
    expect(call?.parameters).toHaveLength(POSTGRES_STUDENT_PROFILE_COLUMNS.length);

    // 领域对象的值只出现在参数里；SQL 文本里一个都不出现
    for (const value of [
      PROFILE.name,
      PROFILE.studentNo,
      PROFILE.phone,
      PROFILE.userId,
      PROFILE.college,
      PROFILE.major,
    ]) {
      expect(call?.sql).not.toContain(String(value));
    }
    expect(call?.parameters).toEqual([
      PROFILE.userId,
      PROFILE.name,
      PROFILE.studentNo,
      PROFILE.college,
      PROFILE.major,
      PROFILE.grade,
      PROFILE.phone,
      ['TypeScript', 'PostgreSQL'],
      PROFILE.programmingLevel,
      PROFILE.researchExperience,
      PROFILE.competitionExperience,
      { weeklyHours: 12, periods: ['weekend', 'weekday_night'], note: '周末全天' },
      ['数据要素', '隐私计算'],
      PROFILE.strengths,
      ['可信数据空间'],
      { policyVersion: 'v2026-01', consentedAt: '2026-01-02T03:00:00.000Z' },
      PROFILE.createdAt,
      PROFILE.updatedAt,
    ]);
    expect(stored).toEqual(PROFILE);
    expect(stored).not.toHaveProperty('user_id');
    expect(stored).not.toHaveProperty('student_no');
  });

  it('ON CONFLICT 的 SET 子句不覆盖归属与创建时间（列级不可变）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromProfile()], rowCount: 1 }]);
    await new PostgresStudentProfileRepository(executor).save(PROFILE);

    const sql = executor.calls[0]?.sql ?? '';
    const setClause = sql.slice(sql.indexOf('DO UPDATE SET'));
    expect(setClause).not.toContain('user_id = EXCLUDED.user_id');
    expect(setClause).not.toContain('created_at = EXCLUDED.created_at');
    for (const column of POSTGRES_STUDENT_PROFILE_IMMUTABLE_COLUMNS) {
      expect(setClause).not.toContain(`${column} = EXCLUDED.${column}`);
    }
    // 其余列必须全部在 SET 子句里（否则「覆盖写入」会静默丢字段）
    for (const column of POSTGRES_STUDENT_PROFILE_COLUMNS) {
      if (POSTGRES_STUDENT_PROFILE_IMMUTABLE_COLUMNS.includes(column)) continue;
      expect(setClause).toContain(`${column} = EXCLUDED.${column}`);
    }
  });

  it('缺失的可选字段写入 null（不是 undefined，也不是省略列）', async () => {
    const {
      researchExperience: _researchExperience,
      competitionExperience: _competitionExperience,
      strengths: _strengths,
      ...withoutOptionals
    } = PROFILE;
    const executor = new RecordingExecutor([
      {
        rows: [
          rowFromProfile({
            research_experience: null,
            competition_experience: null,
            strengths: null,
          }),
        ],
        rowCount: 1,
      },
    ]);
    const repository = new PostgresStudentProfileRepository(executor);

    const stored = await repository.save(withoutOptionals);

    const parameters = executor.calls[0]?.parameters ?? [];
    const columnIndex = (column: string): number =>
      [...POSTGRES_STUDENT_PROFILE_COLUMNS].indexOf(
        column as (typeof POSTGRES_STUDENT_PROFILE_COLUMNS)[number],
      );
    expect(parameters[columnIndex('research_experience')]).toBeNull();
    expect(parameters[columnIndex('competition_experience')]).toBeNull();
    expect(parameters[columnIndex('strengths')]).toBeNull();
    // null 列在领域记录里表现为「字段不存在」，而不是 undefined 悬挂
    expect(stored).not.toHaveProperty('researchExperience');
    expect(stored).not.toHaveProperty('competitionExperience');
    expect(stored).not.toHaveProperty('strengths');
    expect(stored).toEqual(withoutOptionals);
  });

  it('行 → 记录是逐字段显式映射：每个列的值都落在对应领域字段上', async () => {
    // 列与领域字段一一对应：整行映射后必须逐字节等于同一个领域记录（任何错位/漏映射都会失败）
    const mappedProfile: StudentProfile = {
      userId: OWNER_ID,
      name: '甲',
      studentNo: 'SN-1',
      college: '学院甲',
      major: '专业甲',
      grade: Grade.Senior,
      phone: '13900139000',
      skills: ['技能甲'],
      programmingLevel: ProgrammingLevel.Advanced,
      researchExperience: '经历甲',
      competitionExperience: '竞赛甲',
      availableTime: { weeklyHours: 3, periods: [AvailablePeriod.WeekdayDay], note: '备注甲' },
      researchInterests: ['兴趣甲'],
      strengths: '优势甲',
      intendedFields: ['领域甲'],
      privacyConsent: { policyVersion: 'v甲', consentedAt: '2026-02-03T04:05:06.000Z' },
      createdAt: '2026-02-03T04:05:06.000Z',
      updatedAt: '2026-02-04T05:06:07.000Z',
    };
    const driverSkills = ['技能甲'];
    const driverPeriods = ['weekday_day'];
    const executor = new RecordingExecutor([
      {
        rows: [
          rowFromProfile({
            name: '甲',
            student_no: 'SN-1',
            college: '学院甲',
            major: '专业甲',
            grade: 'senior',
            phone: '13900139000',
            skills: driverSkills,
            programming_level: 'advanced',
            research_experience: '经历甲',
            competition_experience: '竞赛甲',
            available_time: { weeklyHours: 3, periods: driverPeriods, note: '备注甲' },
            research_interests: ['兴趣甲'],
            strengths: '优势甲',
            intended_fields: ['领域甲'],
            privacy_consent: {
              policyVersion: 'v甲',
              consentedAt: '2026-02-03T04:05:06.000Z',
            },
            created_at: new Date('2026-02-03T04:05:06.000Z'),
            updated_at: new Date('2026-02-04T05:06:07.000Z'),
          }),
        ],
        rowCount: 1,
      },
    ]);
    const repository = new PostgresStudentProfileRepository(executor);

    const stored = await repository.save(mappedProfile);

    expect(stored).toEqual(mappedProfile);
    // 不把驱动持有的数组交给上层
    expect(stored.skills).not.toBe(driverSkills);
    expect(stored.availableTime.periods).not.toBe(driverPeriods);
    expect(stored.availableTime).not.toBe(mappedProfile.availableTime);
  });

  it('按主体取数只用一个参数绑定归属，且列清单显式（无 SELECT *）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromProfile()], rowCount: 1 }]);
    const repository = new PostgresStudentProfileRepository(executor);

    const found = await repository.findByUserId(OWNER_ID);

    const call = executor.calls[0];
    expect(call?.sql).toContain(`SELECT ${[...POSTGRES_STUDENT_PROFILE_COLUMNS].join(', ')}`);
    expect(call?.sql).toContain(`FROM ${POSTGRES_STUDENT_PROFILE_TABLE}`);
    expect(call?.sql).toContain('WHERE user_id = $1::uuid');
    expect(call?.sql).not.toContain('*');
    expect(call?.sql).not.toContain(OWNER_ID);
    expect(call?.parameters).toEqual([OWNER_ID]);
    expect(found).toEqual(PROFILE);
  });

  it('表名与列清单只由模块常量构成且都是裸标识符，不含任何通配选择', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromProfile()], rowCount: 1 },
      { rows: [rowFromProfile()], rowCount: 1 },
    ]);
    const repository = new PostgresStudentProfileRepository(executor);

    await repository.save(PROFILE);
    await repository.findByUserId(OWNER_ID);

    for (const call of executor.calls) {
      expect(call.sql).toContain(POSTGRES_STUDENT_PROFILE_TABLE);
      expect(call.sql).not.toContain('*');
      expect(placeholderIndexes(call.sql)).toHaveLength(call.parameters?.length ?? 0);
    }
  });
});

describe('PostgreSQL 画像仓储：SQL 注入防线', () => {
  const INJECTION = "x'); DROP TABLE student_profiles; --";

  it('文本/标签里的注入载荷只进参数，SQL 文本与正常输入逐字节相同', async () => {
    const benign = new RecordingExecutor([{ rows: [rowFromProfile()], rowCount: 1 }]);
    const malicious = new RecordingExecutor([{ rows: [rowFromProfile()], rowCount: 1 }]);

    await new PostgresStudentProfileRepository(benign).save(PROFILE);
    await new PostgresStudentProfileRepository(malicious).save({
      ...PROFILE,
      name: INJECTION,
      college: INJECTION,
      major: INJECTION,
      skills: [INJECTION],
      strengths: INJECTION,
      intendedFields: [INJECTION],
      availableTime: { ...PROFILE.availableTime, note: INJECTION },
    });

    const maliciousCall = malicious.calls[0];
    expect(maliciousCall?.sql).toEqual(benign.calls[0]?.sql);
    expect(maliciousCall?.sql).not.toContain('DROP TABLE');
    expect(maliciousCall?.sql).not.toContain('--');
    expect(maliciousCall?.parameters?.[1]).toBe(INJECTION);
    expect(maliciousCall?.parameters?.[7]).toEqual([INJECTION]);
    expect(maliciousCall?.parameters?.[11]).toMatchObject({ note: INJECTION });
  });

  it('归属（userId）不是合法 UUID 时在进入 SQL 之前就被拒绝，且不访问数据库', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromProfile()], rowCount: 1 }]);
    const repository = new PostgresStudentProfileRepository(executor);

    const injectedIds = [
      `${OWNER_ID}' OR 1=1 --`,
      "1' OR '1'='1",
      '${OWNER_ID}',
      HEX_OWNER_ID_UPPER,
      OWNER_ID.replace(/-/gu, ''),
      '',
      'u-student-1',
      '00000000-0000-0000-0000-000000000000',
      '../../../etc/passwd',
    ];

    for (const userId of injectedIds) {
      const readError = await captureRepoError(() => repository.findByUserId(userId));
      expect(readError.code).toBe('INVALID_SUBJECT');
      expect(readError.issues).toContain('userId');
      // 错误信息不得回显主体标识或注入载荷
      expect(readError.message).not.toContain(userId === '' ? 'x' : userId);

      const writeError = await captureRepoError(() =>
        repository.save({ ...PROFILE, userId } as unknown as StudentProfile),
      );
      expect(writeError.code).toBe('INVALID_RECORD');
      expect(writeError.message).not.toContain(userId === '' ? 'x' : userId);
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('行契约的枚举列不接受大写/未登记/注入式取值', async () => {
    for (const override of [
      { grade: "junior' OR '1'='1" },
      { grade: 'JUNIOR' },
      { programming_level: 'Advanced' },
      { programming_level: 'expert' },
    ]) {
      const executor = new RecordingExecutor([{ rows: [rowFromProfile(override)], rowCount: 1 }]);
      const error = await captureRepoError(() =>
        new PostgresStudentProfileRepository(executor).findByUserId(OWNER_ID),
      );
      expect(error.code).toBe('INVALID_ROW');
      for (const value of Object.values(override)) {
        expect(error.message).not.toContain(value);
      }
    }
  });
});

describe('PostgreSQL 画像仓储：未知列与字段污染', () => {
  it('数据库返回未登记列 → 整行拒绝（不静默丢弃，也不带进结果）', async () => {
    for (const extra of [
      { deleted_at: null },
      { profile_locked_at: '2026-01-02T03:04:05.000Z' },
      { profile_submitted_at: '2026-01-02T03:04:05.000Z' },
      { wechat_open_id: 'o-openid-secret' },
      { internal_note: '内部备注：疑似违规' },
      { password_hash: 'argon2-hash-value' },
    ]) {
      const executor = new RecordingExecutor([{ rows: [rowFromProfile(extra)], rowCount: 1 }]);
      const repository = new PostgresStudentProfileRepository(executor);

      const error = await captureRepoError(() => repository.findByUserId(OWNER_ID));
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

  it('jsonb 列出现未登记键或错误形状 → 拒绝', async () => {
    const poisonedConsents: unknown[] = [
      { policyVersion: 'v2026-01', consentedAt: '2026-01-02T03:00:00.000Z', agreed: true },
      { policyVersion: 'v2026-01', consentedAt: '2026-01-02T03:00:00.000Z', internalNote: 'x' },
      { policyVersion: 'v2026-01' },
      { policyVersion: 'v2026-01', consentedAt: 1735786800000 },
      '{"policyVersion":"v2026-01","consentedAt":"2026-01-02T03:00:00.000Z"}',
      ['v2026-01'],
      null,
    ];
    for (const privacyConsent of poisonedConsents) {
      const executor = new RecordingExecutor([
        { rows: [rowFromProfile({ privacy_consent: privacyConsent })], rowCount: 1 },
      ]);
      const error = await captureRepoError(() =>
        new PostgresStudentProfileRepository(executor).findByUserId(OWNER_ID),
      );
      expect(error.code).toBe('INVALID_ROW');
    }

    const poisonedAvailableTimes: unknown[] = [
      { weeklyHours: 12, periods: ['weekend'], internalNote: 'x' },
      { weeklyHours: 12 },
      { weeklyHours: 12, periods: 'weekend' },
      '{"weeklyHours":12,"periods":["weekend"]}',
      [],
      null,
    ];
    for (const availableTime of poisonedAvailableTimes) {
      const executor = new RecordingExecutor([
        { rows: [rowFromProfile({ available_time: availableTime })], rowCount: 1 },
      ]);
      const error = await captureRepoError(() =>
        new PostgresStudentProfileRepository(executor).findByUserId(OWNER_ID),
      );
      expect(error.code).toBe('INVALID_ROW');
    }
  });

  it('隐私同意的门禁字段 agreed 不是状态：出现在存储行即判脏数据', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [
          rowFromProfile({
            privacy_consent: {
              policyVersion: 'v2026-01',
              consentedAt: '2026-01-02T03:00:00.000Z',
              agreed: true,
            },
          }),
        ],
        rowCount: 1,
      },
    ]);
    const error = await captureRepoError(() =>
      new PostgresStudentProfileRepository(executor).findByUserId(OWNER_ID),
    );
    expect(error.code).toBe('INVALID_ROW');
    expect(error.message).toContain('privacy_consent');
  });

  it('写路径字段污染（服务端独占字段/归属别名）→ INVALID_RECORD，且不写库', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromProfile()], rowCount: 1 }]);
    const repository = new PostgresStudentProfileRepository(executor);

    for (const polluted of [
      { ...PROFILE, ownerUserId: OTHER_OWNER_ID },
      { ...PROFILE, id: OTHER_OWNER_ID },
      { ...PROFILE, profileLockedAt: CREATED_AT },
      { ...PROFILE, profileSubmittedAt: CREATED_AT },
      { ...PROFILE, roles: ['admin'] },
      { ...PROFILE, scope: 'all' },
      { ...PROFILE, reviewStatus: 'approved' },
      { ...PROFILE, deletedAt: CREATED_AT },
    ]) {
      const error = await captureRepoError(() =>
        repository.save(polluted as unknown as StudentProfile),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(error.issues.join(',')).toContain('unrecognized_keys');
    }
    expect(executor.calls).toHaveLength(0);
  });
});

describe('PostgreSQL 画像仓储：非法状态与非法形状', () => {
  it('非法枚举 / 非数组标签 / 坏时间戳 / 缺列 一律拒绝（未知状态不得当作合法值）', async () => {
    const poisoned: Record<string, unknown>[] = [
      rowFromProfile({ grade: 'freshman2' }),
      rowFromProfile({ grade: '' }),
      rowFromProfile({ programming_level: 'god' }),
      rowFromProfile({ skills: 'TypeScript' }),
      rowFromProfile({ skills: [] }),
      rowFromProfile({ skills: null }),
      rowFromProfile({ skills: [42] }),
      rowFromProfile({ research_interests: '数据要素' }),
      rowFromProfile({ intended_fields: {} }),
      rowFromProfile({ student_no: 'x' }),
      rowFromProfile({ student_no: '学号带中文' }),
      rowFromProfile({ user_id: 'nope' }),
      rowFromProfile({ created_at: 'not-a-date' }),
      rowFromProfile({ created_at: '2026-13-45T99:99:99Z' }),
      rowFromProfile({ updated_at: null }),
      withoutRowColumn('name'),
      withoutRowColumn('phone'),
      withoutRowColumn('college'),
    ];

    for (const row of poisoned) {
      const executor = new RecordingExecutor([{ rows: [row], rowCount: 1 }]);
      const error = await captureRepoError(() =>
        new PostgresStudentProfileRepository(executor).findByUserId(OWNER_ID),
      );
      expect(error.code).toBe('INVALID_ROW');
    }
  });

  it('空余时间的小时数与时段超出契约范围 → 拒绝', async () => {
    for (const availableTime of [
      { weeklyHours: -1, periods: ['weekend'] },
      { weeklyHours: 81, periods: ['weekend'] },
      { weeklyHours: 1.5, periods: ['weekend'] },
      { weeklyHours: '12', periods: ['weekend'] },
      { weeklyHours: 12, periods: [] },
      { weeklyHours: 12, periods: ['weekday_morning'] },
      { weeklyHours: 12, periods: ['weekend', 'weekend', 'weekday_day', 'weekday_night'] },
      { weeklyHours: 12, periods: ['weekend'], note: 'x'.repeat(201) },
    ]) {
      const executor = new RecordingExecutor([
        { rows: [rowFromProfile({ available_time: availableTime })], rowCount: 1 },
      ]);
      const error = await captureRepoError(() =>
        new PostgresStudentProfileRepository(executor).findByUserId(OWNER_ID),
      );
      expect(error.code).toBe('INVALID_ROW');
    }
  });

  it('长文本的「内容安全」由读取契约兜底：疑似证件号/长数字标识一律拒绝', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [
          rowFromProfile({
            research_experience: '我的证件号是 110101199003071234 ，请保密',
          }),
        ],
        rowCount: 1,
      },
    ]);
    const error = await captureRepoError(() =>
      new PostgresStudentProfileRepository(executor).findByUserId(OWNER_ID),
    );
    expect(error.code).toBe('INVALID_ROW');
    expect(error.issues.join(',')).toContain('researchExperience');
    // 错误信息不得回显被判定为高敏感的原文
    expect(error.message).not.toContain('110101199003071234');
    expect(error.message).not.toContain('请保密');
  });

  it('带时区偏移的时间戳统一映射为 UTC ISO 字符串', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [
          rowFromProfile({
            created_at: '2026-01-02T11:04:05.000+08:00',
            privacy_consent: {
              policyVersion: 'v2026-01',
              consentedAt: '2026-01-02T11:00:00.000+08:00',
            },
          }),
        ],
        rowCount: 1,
      },
    ]);
    const found = await new PostgresStudentProfileRepository(executor).findByUserId(OWNER_ID);

    expect(found?.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(found?.privacyConsent.consentedAt).toBe('2026-01-02T03:00:00.000Z');
  });

  it('文本列里的空串归一为「未填写」，与内存基线语义一致', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [rowFromProfile({ research_experience: '', strengths: '' })],
        rowCount: 1,
      },
    ]);
    const found = await new PostgresStudentProfileRepository(executor).findByUserId(OWNER_ID);

    expect(found).not.toHaveProperty('researchExperience');
    expect(found).not.toHaveProperty('strengths');
  });
});

describe('PostgreSQL 画像仓储：归属边界（他人画像不得回流）', () => {
  it('取数返回的归属与请求主体不一致 → OWNER_VIOLATION，且错误信息不回显任何主体标识', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromProfile({ user_id: OTHER_OWNER_ID })], rowCount: 1 },
    ]);
    const repository = new PostgresStudentProfileRepository(executor);

    const error = await captureRepoError(() => repository.findByUserId(OWNER_ID));
    expect(error.code).toBe('OWNER_VIOLATION');
    expect(error.issues).toContain('user_id');
    expect(error.message).not.toContain(OTHER_OWNER_ID);
    expect(error.message).not.toContain(OWNER_ID);
  });

  it('按主体取数返回多行（归属主键唯一性被破坏）→ RESULT_SET_VIOLATION', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromProfile(), rowFromProfile()], rowCount: 2 },
    ]);
    const error = await captureRepoError(() =>
      new PostgresStudentProfileRepository(executor).findByUserId(OWNER_ID),
    );
    expect(error.code).toBe('RESULT_SET_VIOLATION');
  });

  it('写入返回他人归属 → OWNER_VIOLATION（他人归属不得作为写入结果回流）', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromProfile({ user_id: OTHER_OWNER_ID })], rowCount: 1 },
    ]);
    const repository = new PostgresStudentProfileRepository(executor);

    const error = await captureRepoError(() => repository.save(PROFILE));
    expect(error.code).toBe('OWNER_VIOLATION');
    expect(error.issues).toContain('user_id');
    expect(error.message).not.toContain(OTHER_OWNER_ID);
    expect(error.message).not.toContain(OWNER_ID);
  });

  it('写入未返回行 / 返回多行 → RESULT_SET_VIOLATION（upsert 必须恰好一行）', async () => {
    for (const response of [
      { rows: [], rowCount: 0 },
      { rows: [rowFromProfile(), rowFromProfile()], rowCount: 2 },
    ]) {
      const executor = new RecordingExecutor([response]);
      const error = await captureRepoError(() =>
        new PostgresStudentProfileRepository(executor).save(PROFILE),
      );
      expect(error.code).toBe('RESULT_SET_VIOLATION');
    }
  });

  it('创建时间被改写 → LIFECYCLE_MISMATCH（生命周期字段属于服务端，不得被覆盖）', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromProfile({ created_at: new Date('2020-01-01T00:00:00.000Z') })], rowCount: 1 },
    ]);
    const error = await captureRepoError(() =>
      new PostgresStudentProfileRepository(executor).save(PROFILE),
    );
    expect(error.code).toBe('LIFECYCLE_MISMATCH');
    expect(error.issues).toContain('created_at');
    expect(error.message).not.toContain('2020-01-01T00:00:00.000Z');
  });

  it('归属缺失或为非法形状的写记录 → INVALID_RECORD，且不写库', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromProfile()], rowCount: 1 }]);
    const repository = new PostgresStudentProfileRepository(executor);

    for (const userId of ['', 'u-student-1', '00000000-0000-0000-0000-000000000000']) {
      const error = await captureRepoError(() =>
        repository.save({ ...PROFILE, userId } as unknown as StudentProfile),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(error.issues.join(',')).toContain('userId');
    }
    const { userId: _userId, ...withoutOwner } = PROFILE;
    const missing = await captureRepoError(() =>
      repository.save(withoutOwner as unknown as StudentProfile),
    );
    expect(missing.code).toBe('INVALID_RECORD');
    expect(executor.calls).toHaveLength(0);
  });

  it('归属必须是 UUID 的规范小写形：大写等非规范形 fail-closed（不让大小写差异掩盖归属改动）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromProfile()], rowCount: 1 }]);
    const repository = new PostgresStudentProfileRepository(executor);

    for (const userId of [
      HEX_OWNER_ID_UPPER,
      HEX_OWNER_ID_MIXED,
      `{${OWNER_ID}}`,
      `urn:uuid:${OWNER_ID}`,
    ]) {
      const readError = await captureRepoError(() => repository.findByUserId(userId));
      expect(readError.code).toBe('INVALID_SUBJECT');
      expect(readError.issues).toContain('userId');
      expect(readError.message).not.toContain(userId);

      const writeError = await captureRepoError(() =>
        repository.save({ ...PROFILE, userId } as unknown as StudentProfile),
      );
      expect(writeError.code).toBe('INVALID_RECORD');
      expect(writeError.message).not.toContain(userId);
    }
    expect(executor.calls).toHaveLength(0);

    // 规范小写形本身是合法的：确认上面拒绝的是「非规范形」，而不是这个十六进制字符集
    const canonical = new RecordingExecutor([
      { rows: [rowFromProfile({ user_id: HEX_OWNER_ID })], rowCount: 1 },
    ]);
    await expect(
      new PostgresStudentProfileRepository(canonical).findByUserId(HEX_OWNER_ID),
    ).resolves.toMatchObject({ userId: HEX_OWNER_ID });
  });
});

describe('PostgreSQL 画像仓储：PII 边界（只写不投影）', () => {
  it('高敏感列清单是 student_no / phone，且都落在「不进入公开输出」的列清单里', () => {
    expect([...POSTGRES_STUDENT_PROFILE_PII_COLUMNS]).toEqual(['student_no', 'phone']);
    expect([...POSTGRES_STUDENT_PROFILE_VIEW_EXCLUDED_COLUMNS]).toEqual([
      'user_id',
      'student_no',
      'phone',
      'privacy_consent',
    ]);
    for (const column of POSTGRES_STUDENT_PROFILE_PII_COLUMNS) {
      expect([...POSTGRES_STUDENT_PROFILE_VIEW_EXCLUDED_COLUMNS]).toContain(column);
      expect([...POSTGRES_STUDENT_PROFILE_COLUMNS]).toContain(column);
    }
  });

  it('高敏感字段按内部存储契约原样承载（不静默丢弃），但对外视图必须完全不含它们', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromProfile()], rowCount: 1 }]);
    const stored = await new PostgresStudentProfileRepository(executor).findByUserId(OWNER_ID);

    // 存储记录承载 PII（否则就是静默数据丢失）
    expect(stored?.studentNo).toBe(PROFILE.studentNo);
    expect(stored?.phone).toBe(PROFILE.phone);
    expect(stored?.privacyConsent).toEqual(PROFILE.privacyConsent);

    const view = toStudentProfileView(storedStudentProfileSchema.parse(stored));
    expect(Object.keys(view).sort()).not.toContain('userId');
    expect(Object.keys(view).sort()).not.toContain('studentNo');
    expect(Object.keys(view).sort()).not.toContain('phone');
    expect(Object.keys(view).sort()).not.toContain('privacyConsent');

    // 公开输出的序列化结果里不得出现任何 PII 明文或归属标识
    const serialized = JSON.stringify(view);
    for (const secret of [
      PROFILE.studentNo,
      PROFILE.phone,
      PROFILE.userId,
      PROFILE.privacyConsent.policyVersion,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('任何失败路径的错误信息都不含 PII 明文', async () => {
    const poison = {
      student_no: '2023123456',
      phone: '13800138000',
    };
    // 让行在「通过行契约之后」失败：非法枚举 + 携带 PII 的整行
    const executor = new RecordingExecutor([
      { rows: [rowFromProfile({ grade: 'unknown_grade', ...poison })], rowCount: 1 },
    ]);
    const error = await captureRepoError(() =>
      new PostgresStudentProfileRepository(executor).findByUserId(OWNER_ID),
    );
    expect(error.code).toBe('INVALID_ROW');
    expect(error.message).not.toContain(poison.student_no);
    expect(error.message).not.toContain(poison.phone);
    expect(JSON.stringify(error.issues)).not.toContain(poison.student_no);
    expect(JSON.stringify(error.issues)).not.toContain(poison.phone);
  });
});

describe('PostgreSQL 画像仓储：未装配、无驱动依赖、与 schema 边界对齐', () => {
  it('ProfilesModule 仍只绑定内存基线（本 adapter 未被装配）', () => {
    const moduleFile = resolve(process.cwd(), 'src', 'modules', 'profiles', 'profiles.module.ts');
    const content = readFileSync(moduleFile, 'utf8');

    expect(content).not.toContain(ADAPTER_CLASS);
    expect(content).not.toContain(ADAPTER_MODULE);
    expect(content).toContain('InMemoryProfileRepository');
    expect(content).toContain(
      '{ provide: PROFILE_REPOSITORY, useExisting: InMemoryProfileRepository }',
    );
  });

  it('持久化登记与数据库模块都不引用本 adapter（端口登记表仍按令牌判定）', () => {
    for (const relative of [
      join('src', 'db', 'persistence-bindings.ts'),
      join('src', 'db', 'database.module.ts'),
      join('src', 'db', 'ports', 'sql-executor.port.ts'),
      join('src', 'modules', 'profiles', 'student-profile.port.ts'),
    ]) {
      const content = readApiFile(relative);
      // 端口文件只在注释里以「示例路径」提到 adapter，这不构成装配；任何 import / provider
      // 引用（类名或模块路径）都必须为零
      expect(content).not.toContain(ADAPTER_CLASS);
      expect(content).not.toMatch(
        /(?:from\s+['"][^'"]*student-profile\.postgres-repository['"]|require\(\s*['"][^'"]*student-profile\.postgres-repository['"]\s*\))/u,
      );
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
        './student-profile.contract',
        './student-profile.port',
      ]),
    );
  });

  it('工作区依赖里没有 pg / ORM 包', () => {
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
          /^(?:pg|pg-pool|pg-promise|postgres|prisma|@prisma\/client|typeorm|kysely|drizzle-orm|sequelize|@mikro-orm\/core)$/u.test(
            name,
          ),
        ).toBe(false);
      }
    }
  });

  it('学生画像表尚未转为迁移（配对 productionReady=false 与验证清单的第 3 项）', () => {
    const migrations = readdirSync(join(REPO_ROOT, 'db', 'migrations'));
    expect(migrations.some((file) => file.includes('student_profiles'))).toBe(false);
    expect(POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES.productionReady).toBe(false);
    expect(POSTGRES_STUDENT_PROFILE_REPOSITORY_VERIFICATION_STEPS).toContain(
      'student-profiles-schema-draft-created-and-promoted-to-migration',
    );
  });

  it('内存基线仍是同步契约的实现者（本切片不改动它）', () => {
    const source = readApiFile(
      join('src', 'modules', 'profiles', 'student-profile.in-memory-repository.ts'),
    );
    expect(source).toContain('implements ProfileRepository');
    expect(source).not.toContain(ADAPTER_CLASS);
    expect(source).toContain('persistent: false');
    expect(source).toContain('productionReady: false');
  });
});
