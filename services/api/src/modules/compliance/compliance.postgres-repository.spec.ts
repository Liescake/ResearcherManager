import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  PersistenceCapabilities,
  SqlExecutor,
  SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import {
  COMPLIANCE_STATUS_VIEW_FIELDS,
  parseStoredComplianceRecord,
  toComplianceStatusView,
} from './compliance.contract';
import { InMemoryComplianceRepository } from './compliance.in-memory-repository';
import {
  COMPLIANCE_REPOSITORY_BACKEND_POSTGRES,
  COMPLIANCE_REPOSITORY_STORAGE_ID_DOMAIN,
  DATA_RETENTION_STATUS_VALUES,
  EXPORT_AVAILABILITY_STATUS_VALUES,
  PRIVACY_CONSENT_STATUS_VALUES,
} from './compliance.port';
import type {
  AsyncComplianceRepository,
  ComplianceRecord,
  ComplianceRepository,
  ComplianceRepositoryCapabilities,
} from './compliance.port';
import {
  POSTGRES_COMPLIANCE_COLUMN_FIELDS,
  POSTGRES_COMPLIANCE_COLUMNS,
  POSTGRES_COMPLIANCE_FIELD_COLUMNS,
  POSTGRES_COMPLIANCE_FORBIDDEN_METHODS,
  POSTGRES_COMPLIANCE_FORBIDDEN_SQL_KEYWORDS,
  POSTGRES_COMPLIANCE_INTERNAL_COLUMNS,
  POSTGRES_COMPLIANCE_OWNER_COLUMNS,
  POSTGRES_COMPLIANCE_PII_COLUMNS,
  POSTGRES_COMPLIANCE_READ_ONLY_STATEMENTS,
  POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES,
  POSTGRES_COMPLIANCE_REPOSITORY_VERIFICATION_STEPS,
  POSTGRES_COMPLIANCE_TABLE,
  POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS,
  PostgresComplianceRepository,
  PostgresComplianceRepositoryError,
  assertComplianceInternalColumnsAbsent,
  assertComplianceReadOnlySql,
  assertComplianceViewExclusion,
  assertPostgresComplianceRepositoryCapabilities,
  findComplianceInternalColumnOverlaps,
  findComplianceViewExclusionLeaks,
} from './compliance.postgres-repository';

/**
 * 合规状态（`user_compliance` 读模型）的 PostgreSQL 仓储 adapter 的**离线**验收
 * （不连数据库、不引驱动）。
 *
 * 覆盖用户要求的补充安全契约测试与交付边界：
 * - **能力与交付边界**：`persistent = true` / `productionReady = false`（未取得封存声明与验证证据前
 *   严禁生产）、列清单与读取契约字段双射、`user_compliance` 由迁移 `0012` 建立（且草案已转写）、
 *   adapter 已装配到 `ComplianceModule`（按「是否配置 DATABASE_URL」分流且延迟建连）、
 *   不引驱动 / ORM、运行时端口收敛为异步唯一契约、内存 provider 只在未配置数据库时绑定；
 * - **参数化 SQL 与固定标识符**：值只出现在参数里，SQL 文本只由模块常量构成（语句里没有任何
 *   引号 / 分号 / 注释符 / 通配符，因此不存在字面量注入面）；执行过的 SQL 只有 `SELECT`；
 * - **SQL 注入**：主体等入口的注入载荷要么只进参数、要么在进入 SQL 之前被拒绝
 *   （拒绝路径**一个 SQL 都不执行**）；
 * - **未知列 / 严格行契约 / 字段污染**：未登记列（同意原文与政策正文、联系方式与身份 PII、
 *   审核与证据字段、内部时间戳、路径 / URL / 存储 key / 产物句柄、原始错误、簿记列）、
 *   缺列一律 fail-closed；
 * - **非法状态 / 状态不自洽**：三个状态只接受闭集；`available` 必须由「已生效的同意」与
 *   「仍在保留期内」支撑，否则 500 级 fail-closed；
 * - **按服务端 subject owner 隔离**：他人合规状态既不出库（归属下推进 SQL）也不得回流；
 * - **多行结果**：本读模型按主体唯一，返回多行即判结果集违约（不静默取首行）；
 * - **公开视图只有 privacy / retention / export 三个闭集状态**：不泄露 userId、同意原文、
 *   手机号、审核 / 证据字段、内部时间戳、路径 / URL / 存储 key 或 PII；
 *   所有失败路径的错误信息与 `issues` 只含字段路径与违规类型，不含任何取值；
 *   执行器异常收敛为不含原始文本的 `EXECUTOR_FAILURE`；
 * - **与内存基线同语义**：无记录返回 `undefined`、返回新对象而不是内部可变引用。
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
const COMPLIANCE_DIR = resolve(process.cwd(), 'src', 'modules', 'compliance');
const ADAPTER_PATH = resolve(COMPLIANCE_DIR, 'compliance.postgres-repository.ts');
const PORT_PATH = resolve(COMPLIANCE_DIR, 'compliance.port.ts');
const MODULE_PATH = resolve(COMPLIANCE_DIR, 'compliance.module.ts');
const IN_MEMORY_PATH = resolve(COMPLIANCE_DIR, 'compliance.in-memory-repository.ts');
const ADAPTER_CLASS = 'PostgresComplianceRepository';

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
const HEX_OWNER_MIXED = 'a1b2c3d4-E5F6-4789-8abc-DEF012345678';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** 会话基线的安全 ID 形：合法读取契约形态，但**不在**存储 ID 域内 */
const SESSION_SUBJECT = 'u-student-1';
/** 注入载荷：只允许出现在参数里，绝不允许出现在 SQL 文本或错误信息里 */
const INJECTION = "x'); DROP TABLE user_compliance; --";
/** 同意原文（含疑似密钥）：本端点的响应里绝不允许出现 */
const CONSENT_TEXT = 'consent-body-secret-abcdefgh1234';
/** 政策正文与版本：绝不允许外发 */
const POLICY_TEXT = 'privacy-policy-full-text';
const POLICY_VERSION = 'v3.2.1';
/** 联系方式与身份 PII：绝不允许外发 */
const PHONE = '13800138000';
const ID_CARD = '11010119900307123X';
const STUDENT_NO = '2023010101';
const FULL_NAME = '张三';
/** 审核与证据字段：属内部流程，绝不允许外发 */
const REVIEW_NOTE = '内部审核意见：材料存疑，需复核';
const EVIDENCE_ID = 'evidence-9f3c1b2a';
/** 路径 / URL / 存储 key：位置即能力，绝不允许外发 */
const FORGED_PATH = 'D:\\compliance\\private\\consent-v3.txt';
const FORGED_URL = 'https://storage.example.com/private/signed?token=abcdefgh1234';
const STORAGE_KEY = 'compliance/private/consent-v3.txt';
/** 疑似密钥：绝不允许出现在错误信息里 */
const SECRET = 'abcdefgh1234';

/** 主体样本记录：三个状态都取「强断言」形态（导出可用必须由同意与保留期支撑） */
const OWNER_RECORD: ComplianceRecord = {
  ownerUserId: OWNER,
  privacyConsent: 'granted',
  dataRetention: 'within-retention',
  exportAvailability: 'available',
};

/** 他人名下的记录样本：本人取数路径里绝不能出现 */
const OTHER_OWNER_RECORD: ComplianceRecord = {
  ...OWNER_RECORD,
  ownerUserId: OTHER_OWNER,
};

/** 数据库行（snake_case）：默认与给定记录等价 */
function rowFromRecord(
  record: ComplianceRecord,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    user_id: record.ownerUserId,
    privacy_consent: record.privacyConsent,
    data_retention: record.dataRetention,
    export_availability: record.exportAvailability,
    ...overrides,
  };
}

/** 移除某一列，用于「缺列」用例 */
function withoutRowColumn(record: ComplianceRecord, column: string): Record<string, unknown> {
  const row = rowFromRecord(record);
  delete row[column];
  return row;
}

/** 用给定响应构造 adapter（响应按调用顺序消费） */
function repoWith(...responses: unknown[]): {
  repository: PostgresComplianceRepository;
  executor: RecordingExecutor;
} {
  const executor = new RecordingExecutor(responses);
  return { repository: new PostgresComplianceRepository(executor), executor };
}

async function captureRepoError(
  run: () => Promise<unknown>,
): Promise<PostgresComplianceRepositoryError> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresComplianceRepositoryError);
  return captured as PostgresComplianceRepositoryError;
}

function captureSyncError(run: () => unknown): PostgresComplianceRepositoryError {
  let captured: unknown;
  try {
    run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresComplianceRepositoryError);
  return captured as PostgresComplianceRepositoryError;
}

/**
 * 断言 `issues` 里存在指向某个字段路径的违规。
 *
 * `issues` 的形状是 `字段路径(违规类型)`（例如 `privacy_consent(invalid_enum_value)`），
 * 违规类型取决于 zod 的 issue code，因此只固定「指向哪个字段」，不把违规类型写死
 * （那属于实现细节）。存储 ID 域约束走的是 adapter 自有的 `requireSubject`，
 * 它只给出裸字段路径（例如 `ownerUserId`），因此裸路径同样算命中。
 */
function expectIssueOn(error: PostgresComplianceRepositoryError, path: string): void {
  expect(error.issues.some((issue) => issue === path || issue.startsWith(`${path}(`))).toBe(true);
}

/** SQL 里出现的占位符序号（去重升序），用于断言「占位符数量 === 参数数量」 */
function placeholderIndexes(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1])))].sort(
    (left, right) => left - right,
  );
}

/** 投一次调用并拿到它记录的 SQL / 参数（调用序列里第 n 条） */
function callAt(executor: RecordingExecutor, index: number): RecordedCall | undefined {
  return executor.calls[index];
}

/** 单词边界命中（避免 `id` 命中 `user_id`、`name` 命中 `user_name` 之类） */
function containsWord(sql: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'u').test(sql);
}

/**
 * 语句卫生：只由模块常量与 `$n` 占位符构成。
 *
 * 没有任何引号 ⇒ 语句里不存在字符串字面量（因此没有「值 → SQL 文本」的注入面）；
 * 没有分号 / `--` / `*` ⇒ 不存在语句拼接、注释截断与通配投影面。
 * 与写侧切片的差异：本切片是**只读**端口，因此连 `UPDATE` 都不允许，只有 `SELECT`。
 */
function expectParameterizedSql(sql: string): void {
  expect(sql).not.toMatch(/['";]/u);
  expect(sql).not.toContain('--');
  expect(sql).not.toContain('*');
  for (const keyword of POSTGRES_COMPLIANCE_FORBIDDEN_SQL_KEYWORDS) {
    expect(containsWord(sql, keyword)).toBe(false);
  }
  const placeholders = placeholderIndexes(sql);
  for (const [offset, value] of placeholders.entries()) {
    expect(value).toBe(offset + 1);
  }
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

/** 共享读取契约声明的**全部**领域字段（由契约本身推导，而不是在测试里另抄一份清单） */
function readContractFields(): readonly string[] {
  const parsed = parseStoredComplianceRecord(OWNER_RECORD);
  if (!parsed.ok) {
    throw new Error('样本记录未通过共享读取契约');
  }
  return Object.keys(parsed.value).sort();
}

/** camelCase 期望值：用于证明「列 → 字段」只有 `user_id → ownerUserId` 一处非同名映射 */
function camelCase(column: string): string {
  return column.replace(/_([a-z0-9])/gu, (_match, char: string) => char.toUpperCase());
}

/** 失败路径的信息卫生断言：错误信息与 issues 都不含任何取值 */
function expectNoValueLeak(error: PostgresComplianceRepositoryError): void {
  const text = `${error.message} ${error.issues.join(' ')}`;
  for (const forbidden of [
    OWNER,
    OTHER_OWNER,
    HEX_OWNER,
    HEX_OWNER_UPPER,
    HEX_OWNER_MIXED,
    NIL_UUID,
    INJECTION,
    CONSENT_TEXT,
    POLICY_TEXT,
    POLICY_VERSION,
    PHONE,
    ID_CARD,
    STUDENT_NO,
    FULL_NAME,
    REVIEW_NOTE,
    EVIDENCE_ID,
    FORGED_PATH,
    FORGED_URL,
    STORAGE_KEY,
    SECRET,
  ]) {
    expect(text).not.toContain(forbidden);
  }
  // 冒号与引号意味着「键=值」形态的回显（issues 只允许 `字段路径(违规类型)`）
  expect(error.issues.every((issue) => !issue.includes(':') && !issue.includes('='))).toBe(true);
}

/** 断言「执行过的 SQL 只有 SELECT」，并返回全部 SQL 文本 */
function expectReadOnlySql(executor: RecordingExecutor): readonly string[] {
  const statements = executor.calls.map((call) => call.sql);
  expect(statements.length).toBeGreaterThan(0);
  for (const sql of statements) {
    expect(sql).toMatch(/\bSELECT\b/u);
    for (const keyword of POSTGRES_COMPLIANCE_FORBIDDEN_SQL_KEYWORDS) {
      expect(containsWord(sql, keyword)).toBe(false);
    }
  }
  return statements;
}

/** 全部状态组合（3 × 2 × 2）与「按读取契约是否自洽」的期望，供往返与拒绝用例共用 */
const STATUS_COMBINATIONS: readonly {
  readonly privacyConsent: ComplianceRecord['privacyConsent'];
  readonly dataRetention: ComplianceRecord['dataRetention'];
  readonly exportAvailability: ComplianceRecord['exportAvailability'];
  readonly valid: boolean;
}[] = PRIVACY_CONSENT_STATUS_VALUES.flatMap((privacyConsent) =>
  DATA_RETENTION_STATUS_VALUES.flatMap((dataRetention) =>
    EXPORT_AVAILABILITY_STATUS_VALUES.map((exportAvailability) => ({
      privacyConsent,
      dataRetention,
      exportAvailability,
      valid:
        exportAvailability !== 'available' ||
        (privacyConsent === 'granted' && dataRetention === 'within-retention'),
    })),
  ),
);

describe('PostgreSQL 合规仓储：能力声明与交付边界', () => {
  it('能力声明恰好是 postgres / persistent=true / productionReady=false，且被冻结', () => {
    expect(POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES).toEqual({
      backend: COMPLIANCE_REPOSITORY_BACKEND_POSTGRES,
      persistent: true,
      productionReady: false,
    });
    expect(COMPLIANCE_REPOSITORY_BACKEND_POSTGRES).toBe('postgres');
    expect(COMPLIANCE_REPOSITORY_STORAGE_ID_DOMAIN).toBe('uuid');
    expect(Object.isFrozen(POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES)).toBe(true);
    // 「未真实驱动验证前严禁生产」必须写在源码里，且能力自检必须存在
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).toContain('productionReady: false');
    expect(source).toContain('不得声称生产可用');
  });

  it('能力自检对合法声明放行，对「非持久 / 后端不符 / 声称生产可用」逐项 fail-closed', () => {
    expect(() => assertPostgresComplianceRepositoryCapabilities()).not.toThrow();
    expect(() =>
      assertPostgresComplianceRepositoryCapabilities(POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES),
    ).not.toThrow();

    const cases: readonly (readonly [ComplianceRepositoryCapabilities, string])[] = [
      [{ backend: 'postgres', persistent: false, productionReady: false }, 'persistent'],
      [{ backend: 'postgres', persistent: true, productionReady: true }, 'productionReady'],
      [{ backend: 'sqlite', persistent: true, productionReady: false }, 'backend'],
    ];
    for (const [capabilities, issue] of cases) {
      const error = captureSyncError(() =>
        assertPostgresComplianceRepositoryCapabilities(capabilities),
      );
      expect(error.code).toBe('CAPABILITY_MISDECLARED');
      expect(error.issues).toContain(issue);
      expect(error.message).toContain('不得声称生产可用');
      expectNoValueLeak(error);
    }
  });

  it('验证清单覆盖「未验证不得生产」的全部前置（含 schema 草案、表名对齐、派生口径与视图复核）', () => {
    for (const step of [
      'driver-dependency-evaluated',
      'integration-tests-against-real-postgres',
      'user-compliance-schema-draft-created-and-promoted-to-migration',
      'user-compliance-table-name-aligned-with-bootstrap-placeholder-list',
      'retention-and-export-availability-derivation-defined',
      'compliance-repository-port-migrated-to-async',
      'session-subject-owner-ids-converged-to-uuid',
      'internal-columns-not-projected-verified-against-real-queries',
      'production-ready-capability-flipped-with-evidence',
    ]) {
      expect(POSTGRES_COMPLIANCE_REPOSITORY_VERIFICATION_STEPS).toContain(step);
    }
    expect(POSTGRES_COMPLIANCE_REPOSITORY_VERIFICATION_STEPS).toHaveLength(9);
    // 清单本身不得声称「已生产可用」
    expect([...POSTGRES_COMPLIANCE_REPOSITORY_VERIFICATION_STEPS].join(' ')).not.toContain(
      'production-ready-verified',
    );
  });

  it('列清单与读取契约字段构成双射，且只有 user_id → ownerUserId 一处非同名映射', () => {
    const columns = [...POSTGRES_COMPLIANCE_COLUMNS];
    const fields = readContractFields();

    expect(columns).toEqual([
      'user_id',
      'privacy_consent',
      'data_retention',
      'export_availability',
    ]);
    expect(Object.keys(POSTGRES_COMPLIANCE_COLUMN_FIELDS)).toEqual(columns);
    expect(Object.keys(POSTGRES_COMPLIANCE_FIELD_COLUMNS).sort()).toEqual(fields);
    for (const column of columns) {
      const field = POSTGRES_COMPLIANCE_COLUMN_FIELDS[column];
      expect(
        POSTGRES_COMPLIANCE_FIELD_COLUMNS[field as keyof typeof POSTGRES_COMPLIANCE_FIELD_COLUMNS],
      ).toBe(column);
    }
    // 双向都是单射（无列映射到同一字段，也无字段映射到同一列）
    expect(new Set(Object.values(POSTGRES_COMPLIANCE_COLUMN_FIELDS)).size).toBe(columns.length);
    expect(new Set(Object.values(POSTGRES_COMPLIANCE_FIELD_COLUMNS)).size).toBe(columns.length);
    // 唯一的**真正重命名**是 user_id → ownerUserId；其余只是 snake_case → camelCase 约定
    expect(
      columns.filter((column) => POSTGRES_COMPLIANCE_COLUMN_FIELDS[column] !== camelCase(column)),
    ).toEqual(['user_id']);
  });

  it('归属列落在列清单内，且列清单里没有 id / 内部时间戳 / 任何内部列', () => {
    expect([...POSTGRES_COMPLIANCE_OWNER_COLUMNS]).toEqual(['user_id']);
    for (const column of POSTGRES_COMPLIANCE_OWNER_COLUMNS) {
      expect(POSTGRES_COMPLIANCE_COLUMNS).toContain(column);
    }
    // 读取契约里没有时间字段与代理主键，因此它们不得被投影
    for (const forbidden of [
      'id',
      'created_at',
      'updated_at',
      'deleted_at',
      'expires_at',
      'retention_until',
      'consented_at',
      'withdrawn_at',
      'reviewed_at',
      'phone',
      'consent_text',
      'file_path',
      'download_url',
      'storage_key',
    ]) {
      expect(POSTGRES_COMPLIANCE_COLUMNS).not.toContain(forbidden);
      expect(POSTGRES_COMPLIANCE_INTERNAL_COLUMNS).toContain(forbidden);
    }
  });

  it('PII 与公开输出裁剪列覆盖归属与全部内部列，且不含公开视图字段', () => {
    expect([...POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS]).toEqual([
      'user_id',
      ...POSTGRES_COMPLIANCE_INTERNAL_COLUMNS,
    ]);
    // 归属映射（user_id → ownerUserId）与**全部**内部列都必须同时被裁剪清单与高敏清单覆盖，
    // 且每列恰好登记一次（重复登记会让「子集」判定出现假象）
    const covered = ['user_id', ...POSTGRES_COMPLIANCE_INTERNAL_COLUMNS];
    for (const column of covered) {
      expect(POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS).toContain(column);
      expect(POSTGRES_COMPLIANCE_PII_COLUMNS).toContain(column);
      expect(
        POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS.filter((item) => item === column),
      ).toHaveLength(1);
      expect(POSTGRES_COMPLIANCE_PII_COLUMNS.filter((item) => item === column)).toHaveLength(1);
    }
    // 高敏清单必须覆盖归属、同意原文、联系方式与 PII、审核 / 证据与存储位置
    for (const column of [
      'user_id',
      'consent_text',
      'consent_body',
      'policy_text',
      'policy_body',
      'name',
      'student_no',
      'student_number',
      'phone',
      'mobile',
      'email',
      'id_card',
      'id_number',
      'wechat_openid',
      'wechat_unionid',
      'review_note',
      'review_comment',
      'reviewer_id',
      'evidence_file_id',
      'evidence_id',
      'evidence_url',
      'file_path',
      'download_url',
      'signed_url',
      'storage_key',
      'object_key',
      'artifact_handle',
      'error_message',
      'failure_reason',
      'stack_trace',
    ]) {
      expect(POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS).toContain(column);
      expect(POSTGRES_COMPLIANCE_PII_COLUMNS).toContain(column);
    }
    // 高敏清单是裁剪清单的子集：任何被标为高敏的列都不得进入公开视图
    for (const column of POSTGRES_COMPLIANCE_PII_COLUMNS) {
      expect(POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS).toContain(column);
    }
    // 公开视图字段一个都不在裁剪清单里（否则「裁剪」会连公开状态一起裁掉）
    for (const field of COMPLIANCE_STATUS_VIEW_FIELDS) {
      expect(POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS).not.toContain(field);
      expect(POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS).not.toContain(camelCase(field));
    }
  });

  it('表名与 db schema 边界一致：占位清单里仍是原始同意表，读模型由迁移 0012 建立（草案已转写）', () => {
    expect(POSTGRES_COMPLIANCE_TABLE).toBe('user_compliance');

    const bootstrap = readFileSync(
      join(REPO_ROOT, 'db', 'migrations', '0001_bootstrap.sql'),
      'utf8',
    );
    // 边界事实：占位清单登记的是原始同意表 privacy_consents，且该迁移**已应用、不可改写**
    // （校验和），因此本切片不改它，而是在迁移 0012 里显式建出派生读模型。
    expect(bootstrap).toContain('privacy_consents');
    expect(bootstrap).not.toContain('user_compliance');
    expect(bootstrap).not.toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?user_compliance/iu);

    // 迁移 0012 必须显式建表，且把「来源（privacy_consents）→ 派生读模型（user_compliance）」
    // 的关系写在头部/注释里，避免同一概念在存储侧出现两份真相。
    const migrationPath = join(REPO_ROOT, 'db', 'migrations', '0012_user_compliance.sql');
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+user_compliance\s*\(/iu);
    expect(migration).toContain('-- migration: 0012_user_compliance');
    expect(migration).toContain('privacy_consents');
    // 存储层把「状态自洽」与「归属唯一」下沉为约束/索引，而不是只靠应用层
    expect(migration).toContain('user_compliance_export_requires_active_consent');
    expect(migration).toContain('uq_user_compliance_user_id');
    // 只落三个状态列 + 归属列：建表语句体内不得出现任何 PII / 同意原文 / 审核证据列
    // （列清单的说明注释里会列举「刻意不建」的列名，因此这里只判定 DDL 本体）
    const tableDdl = migration.slice(
      migration.indexOf('CREATE TABLE IF NOT EXISTS user_compliance'),
      migration.indexOf('COMMENT ON TABLE user_compliance'),
    );
    expect(tableDdl).not.toBe('');
    for (const column of [
      'consent_text',
      'policy_text',
      'policy_version',
      'phone',
      'email',
      'id_card',
      'student_no',
      'reviewer_id',
      'evidence_url',
      'storage_key',
      'download_url',
    ]) {
      expect(tableDdl).not.toContain(column);
    }
    // 表定义里恰好只有：归属列 + 三个状态列 + 三个内部列（id / created_at / updated_at）
    for (const column of [
      'id',
      'user_id',
      'privacy_consent',
      'data_retention',
      'export_availability',
      'created_at',
      'updated_at',
    ]) {
      expect(tableDdl).toContain(column);
    }

    // 草案已按 db/schema-drafts/README.md 的规范转写（保留留痕），且草案与迁移是同一张表
    const draftPath = join(REPO_ROOT, 'db', 'schema-drafts', '0002_user_compliance.draft.sql');
    expect(existsSync(draftPath)).toBe(true);
    const draft = readFileSync(draftPath, 'utf8');
    expect(draft).toContain('-- target-table: user_compliance');
    expect(draft).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+user_compliance\s*\(/iu);

    // 命名与派生口径的偏差必须被登记（不能只写声明）：本切片后只剩派生口径一项未定稿
    expect([...POSTGRES_COMPLIANCE_REPOSITORY_VERIFICATION_STEPS]).toContain(
      'user-compliance-schema-draft-created-and-promoted-to-migration',
    );
    expect([...POSTGRES_COMPLIANCE_REPOSITORY_VERIFICATION_STEPS]).toContain(
      'retention-and-export-availability-derivation-defined',
    );
  });

  it('端口收敛为异步唯一契约并保留后端标识，且端口上不存在任何写入 / 删除 / 覆盖插入入口', () => {
    const source = readFileSync(PORT_PATH, 'utf8');
    expect(source).toContain('export interface ComplianceRepository {');
    // 运行时唯一契约是 Promise：内存基线与数据库实现实现同一个接口
    expect(source).toContain(
      'findByUserId(ownerUserId: string): Promise<ComplianceRecord | undefined>;',
    );
    // 兼容别名仍然导出，但它必须真的是「同一个接口」的别名，而不是第二份契约
    expect(source).toContain('export type AsyncComplianceRepository = ComplianceRepository;');
    expect(source).not.toContain('export interface AsyncComplianceRepository {');
    expect(source).toContain('export const COMPLIANCE_REPOSITORY_BACKEND_POSTGRES');
    expect(source).toContain('export const COMPLIANCE_REPOSITORY_STORAGE_ID_DOMAIN');
    expect(source).toContain(
      "export const COMPLIANCE_REPOSITORY = Symbol('COMPLIANCE_REPOSITORY');",
    );
    // 端口上不存在任何写入 / 删除 / 覆盖插入契约
    expect(source).not.toMatch(
      /\b(?:create|save|insert|update|delete|remove|archive|purge|truncate|upsert)\s*\(/u,
    );
  });

  it('adapter 声明实现了异步端口，且本切片不新增任何写入 / 删除 / 覆盖插入入口', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).toContain(`export class ${ADAPTER_CLASS} implements AsyncComplianceRepository`);
    const { repository } = repoWith();
    const surface = repository as unknown as Record<string, unknown>;
    for (const method of POSTGRES_COMPLIANCE_FORBIDDEN_METHODS) {
      expect(surface[method]).toBeUndefined();
    }
    // 公开面必须有 findByUserId，且原型上不得出现任何写入 / 删除 / 覆盖插入方法名
    expect(typeof surface.findByUserId).toBe('function');
    const prototypeNames = Object.getOwnPropertyNames(Object.getPrototypeOf(repository));
    expect(prototypeNames).toContain('findByUserId');
    for (const method of POSTGRES_COMPLIANCE_FORBIDDEN_METHODS) {
      expect(prototypeNames).not.toContain(method);
    }
  });

  it('只读语句门禁：SELECT 放行，写入 / DDL / 权限 / 非 SELECT 语句一律 fail-closed', () => {
    expect([...POSTGRES_COMPLIANCE_READ_ONLY_STATEMENTS]).toEqual(['SELECT']);
    expect(() => assertComplianceReadOnlySql('SELECT user_id FROM user_compliance')).not.toThrow();

    for (const sql of [
      'INSERT INTO user_compliance (user_id) VALUES ($1)',
      'UPDATE user_compliance SET phone = $1',
      'DELETE FROM user_compliance',
      'TRUNCATE user_compliance',
      'ALTER TABLE user_compliance ADD COLUMN x text',
      'DROP TABLE user_compliance',
      'GRANT SELECT ON user_compliance TO app',
      'REVOKE SELECT ON user_compliance FROM app',
      'COPY user_compliance TO STDOUT',
      'CREATE TABLE user_compliance (id uuid)',
      'VACUUM user_compliance',
    ]) {
      const error = captureSyncError(() => assertComplianceReadOnlySql(sql));
      expect(error.code).toBe('INVALID_CONFIGURATION');
      expect(error.message).toContain('只读切片');
      expectNoValueLeak(error);
    }
  });
});

describe('PostgreSQL 合规仓储：执行器 fail-closed', () => {
  it('没有执行器 / 执行器缺 query / 缺能力声明 → 构造即拒绝，且不执行任何 SQL', () => {
    const cases: readonly unknown[] = [
      undefined,
      null,
      'postgres://user:pass@host/db',
      {},
      { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
      { query: () => Promise.resolve({ rows: [], rowCount: 0 }), capabilities: null },
      { query: () => Promise.resolve({ rows: [], rowCount: 0 }), capabilities: {} },
    ];
    for (const executor of cases) {
      const error = captureSyncError(
        () => new PostgresComplianceRepository(executor as unknown as SqlExecutor),
      );
      expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
      expectNoValueLeak(error);
    }
  });

  it('执行器声明的后端不是 PostgreSQL → 拒绝（不得把 adapter 挂到其他存储上）', () => {
    for (const backend of ['sqlite', 'in-memory-baseline', 'mysql', 'sqlserver']) {
      const executor = new RecordingExecutor();
      executor.capabilities = { backend, persistent: true, productionReady: true };
      const error = captureSyncError(() => new PostgresComplianceRepository(executor));
      expect(error.code).toBe('EXECUTOR_NOT_POSTGRES');
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
  });

  it('执行器声明为非持久后端（内存替身）→ 拒绝', () => {
    const executor = new RecordingExecutor();
    executor.capabilities = {
      backend: 'postgres-test-double',
      persistent: false,
      productionReady: false,
    };
    const error = captureSyncError(() => new PostgresComplianceRepository(executor));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
    expectNoValueLeak(error);
  });

  it('构造后执行器被降级为非持久 → 下一次调用 fail-closed，且不再访问 SQL', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromRecord(OWNER_RECORD)], rowCount: 1 });
    executor.capabilities = {
      backend: 'postgres-test-double',
      persistent: false,
      productionReady: false,
    };
    const error = await captureRepoError(() => repository.findByUserId(OWNER));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
    expectNoValueLeak(error);
  });

  it('构造后能力声明被改写为「生产可用」→ 每次调用都 fail-closed（自检不被绕过）', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromRecord(OWNER_RECORD)], rowCount: 1 });
    (repository as { capabilities: ComplianceRepositoryCapabilities }).capabilities = {
      backend: 'postgres',
      persistent: true,
      productionReady: true,
    };

    const error = await captureRepoError(() => repository.findByUserId(OWNER));
    expect(error.code).toBe('CAPABILITY_MISDECLARED');
    expect(error.message).toContain('不得声称生产可用');
    // 自检发生在任何 SQL 之前
    expect(executor.calls).toHaveLength(0);
    expectNoValueLeak(error);
  });

  it('执行结果形状非法（非对象 / 缺 rows 数组）→ INVALID_ROW，不静默当成「无记录」', async () => {
    for (const response of [null, 'rows', { rowCount: 0 }, { rows: null }, { rows: {} }]) {
      const { repository } = repoWith(response);
      const error = await captureRepoError(() => repository.findByUserId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });
});

describe('PostgreSQL 合规仓储：参数化 SQL 与固定标识符', () => {
  it('取数语句只由模块常量与 $n 占位符构成，且只有一条语句', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromRecord(OWNER_RECORD)], rowCount: 1 });
    const record = await repository.findByUserId(OWNER);

    expect(record).toEqual(OWNER_RECORD);
    const statements = expectReadOnlySql(executor);
    expect(statements).toHaveLength(1);
    for (const sql of statements) {
      expectParameterizedSql(sql);
    }
  });

  it('主体值绝不进入 SQL 文本：归属只出现在参数里', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromRecord(OWNER_RECORD)], rowCount: 1 });
    await repository.findByUserId(OWNER);

    const call = callAt(executor, 0);
    const sql = call?.sql ?? '';
    expect(sql).not.toContain(OWNER);
    expect(sql).not.toContain(HEX_OWNER);
    expect(sql).toContain('$1::uuid');
    expect(call?.parameters).toEqual([OWNER]);
    expect(placeholderIndexes(sql)).toEqual([1]);
  });

  it('SQL 文本里不出现任何存储侧内部列（含内部时间戳 / 同意原文 / 联系方式 / 审核与证据 / 路径 / URL / 存储 key）', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromRecord(OWNER_RECORD)], rowCount: 1 });
    await repository.findByUserId(OWNER);

    const sql = callAt(executor, 0)?.sql ?? '';
    for (const internal of POSTGRES_COMPLIANCE_INTERNAL_COLUMNS) {
      expect(containsWord(sql, internal)).toBe(false);
    }
    // 显式列清单而不是 SELECT *
    expect(sql).not.toContain('*');
    expect(sql).toContain(POSTGRES_COMPLIANCE_COLUMNS.join(', '));
  });

  it('语句不含排序 / 分页本地截断（单主体至多一行，唯一性由 adapter 复核）', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromRecord(OWNER_RECORD)], rowCount: 1 });
    await repository.findByUserId(OWNER);

    const sql = callAt(executor, 0)?.sql ?? '';
    expect(sql).not.toMatch(/\bORDER\s+BY\b/iu);
    expect(sql).not.toMatch(/\bLIMIT\b/iu);
    expect(sql).not.toMatch(/\bOFFSET\b/iu);
    // 归属谓词是唯一的主体入口
    expect(sql).toMatch(/WHERE\s+user_id\s*=\s*\$1::uuid/u);
  });

  it('表名与列名都是裸小写标识符（杜绝用标识符夹带 SQL 片段）', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).toContain('const SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/u;');
    expect(source).toContain('assertSqlIdentifier(POSTGRES_COMPLIANCE_TABLE');
    for (const identifier of [POSTGRES_COMPLIANCE_TABLE, ...POSTGRES_COMPLIANCE_COLUMNS]) {
      expect(identifier).toMatch(/^[a-z][a-z0-9_]*$/u);
    }
  });

  it('注入载荷只进参数或被拒绝：被拒绝的入口一个 SQL 都不执行', async () => {
    const injectedSubjects = [
      INJECTION,
      `' OR 1=1 --`,
      '11111111-1111-4111-8111-11111111111Z',
      HEX_OWNER_UPPER,
      HEX_OWNER_MIXED,
      NIL_UUID,
      SESSION_SUBJECT,
      '',
      '   ',
    ];
    for (const subject of injectedSubjects) {
      const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
      const error = await captureRepoError(() => repository.findByUserId(subject));
      expect(error.code).toBe('INVALID_SUBJECT');
      expect(error.issues).toEqual(['ownerUserId']);
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
  });
});

describe('PostgreSQL 合规仓储：严格行契约与未知列', () => {
  it('未登记列（同意原文 / 政策 / 联系方式 / 审核 / 证据 / 时间戳 / 路径 / URL / 存储 key / 错误 / 簿记）一律 fail-closed 且不回显取值', async () => {
    const overrides: readonly Record<string, unknown>[] = [
      { consent_text: CONSENT_TEXT },
      { policy_text: POLICY_TEXT },
      { policy_version: POLICY_VERSION },
      { consented_at: new Date('2026-01-02T03:04:05.000Z') },
      { withdrawn_at: new Date('2026-01-03T04:05:06.000Z') },
      { created_at: new Date('2026-01-02T03:04:05.000Z') },
      { updated_at: new Date('2026-01-03T04:05:06.000Z') },
      { retention_until: new Date('2030-01-02T03:04:05.000Z') },
      { phone: PHONE },
      { mobile: PHONE },
      { id_card: ID_CARD },
      { student_no: STUDENT_NO },
      { name: FULL_NAME },
      { wechat_openid: 'oX-abcdefgh1234' },
      { review_status: 'pending' },
      { review_note: REVIEW_NOTE },
      { reviewer_id: OTHER_OWNER },
      { evidence_file_id: EVIDENCE_ID },
      { evidence_url: FORGED_URL },
      { file_path: FORGED_PATH },
      { download_url: FORGED_URL },
      { storage_key: STORAGE_KEY },
      { object_key: STORAGE_KEY },
      { artifact_handle: EVIDENCE_ID },
      { error_message: SECRET },
      { stack_trace: SECRET },
      { id: OTHER_OWNER },
      { idempotency_key: SECRET },
    ];
    for (const override of overrides) {
      const column = Object.keys(override)[0] ?? '';
      const { repository } = repoWith({
        rows: [rowFromRecord(OWNER_RECORD, override)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.findByUserId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, column);
      expectNoValueLeak(error);
    }
  });

  it('缺列同样 fail-closed（PG 对 SELECT 列表中的列一定返回键，缺键说明驱动或 SQL 被改动）', async () => {
    for (const column of POSTGRES_COMPLIANCE_COLUMNS) {
      const { repository } = repoWith({
        rows: [withoutRowColumn(OWNER_RECORD, column)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.findByUserId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, column);
      expectNoValueLeak(error);
    }
  });

  it('未知状态取值 → INVALID_ROW（闭集外一律不当作合法值外发）', async () => {
    const cases: readonly Record<string, unknown>[] = [
      { privacy_consent: 'unknown' },
      { privacy_consent: INJECTION },
      { privacy_consent: '' },
      { privacy_consent: null },
      { data_retention: 'forever' },
      { data_retention: 'WITHIN-RETENTION' },
      { data_retention: 0 },
      { export_availability: 'maybe' },
      { export_availability: 'AVAILABLE' },
      { export_availability: true },
    ];
    for (const override of cases) {
      const column = Object.keys(override)[0] ?? '';
      const { repository } = repoWith({
        rows: [rowFromRecord(OWNER_RECORD, override)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.findByUserId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, column);
      expectNoValueLeak(error);
    }
  });

  it('状态不自洽（未生效的同意 / 已过的保留期却声明导出可用）→ INVALID_ROW', async () => {
    const inconsistent: readonly Record<string, unknown>[] = [
      { privacy_consent: 'withdrawn', export_availability: 'available' },
      { privacy_consent: 'not-recorded', export_availability: 'available' },
      { data_retention: 'expired', export_availability: 'available' },
    ];
    for (const override of inconsistent) {
      const { repository } = repoWith({
        rows: [rowFromRecord(OWNER_RECORD, override)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.findByUserId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, 'exportAvailability');
      expectNoValueLeak(error);
    }
  });

  it('行内的归属必须落在存储 ID 域（规范小写、非空 UUID）', async () => {
    for (const subject of [
      HEX_OWNER_UPPER,
      HEX_OWNER_MIXED,
      NIL_UUID,
      SESSION_SUBJECT,
      INJECTION,
      '',
      null,
      12345,
    ]) {
      const { repository } = repoWith({
        rows: [rowFromRecord(OWNER_RECORD, { user_id: subject })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.findByUserId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, 'user_id');
      expectNoValueLeak(error);
    }
  });

  it('结果集返回多行 → RESULT_SET_VIOLATION（本读模型按主体唯一，不静默取首行）', async () => {
    const duplicated = repoWith({
      rows: [rowFromRecord(OWNER_RECORD), rowFromRecord(OWNER_RECORD)],
      rowCount: 2,
    });
    const error = await captureRepoError(() => duplicated.repository.findByUserId(OWNER));
    expect(error.code).toBe('RESULT_SET_VIOLATION');
    expectIssueOn(error, 'user_id');
    expectNoValueLeak(error);

    // 多行里哪怕第一行是本人记录、第二行是他人记录，也必须整批 fail-closed
    const mixed = repoWith({
      rows: [rowFromRecord(OWNER_RECORD), rowFromRecord(OTHER_OWNER_RECORD)],
      rowCount: 2,
    });
    const mixedError = await captureRepoError(() => mixed.repository.findByUserId(OWNER));
    expect(mixedError.code).toBe('RESULT_SET_VIOLATION');
    expectNoValueLeak(mixedError);
  });

  it('返回他人记录 → OWNER_VIOLATION（仓储过滤不作为安全边界，他人记录不得回流）', async () => {
    const { repository } = repoWith({ rows: [rowFromRecord(OTHER_OWNER_RECORD)], rowCount: 1 });
    const error = await captureRepoError(() => repository.findByUserId(OWNER));
    expect(error.code).toBe('OWNER_VIOLATION');
    expectIssueOn(error, 'user_id');
    expectNoValueLeak(error);
  });
});

describe('PostgreSQL 合规仓储：subject owner 隔离与闭集往返', () => {
  it('无记录返回 undefined（不是 null、不抛错），且只投一次 SELECT', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
    await expect(repository.findByUserId(OWNER)).resolves.toBeUndefined();
    expect(executor.calls).toHaveLength(1);
    expectReadOnlySql(executor);
  });

  it('本人记录逐字段返回，且键名全是驼峰形（不含任何 snake_case 列名）', async () => {
    const { repository } = repoWith({ rows: [rowFromRecord(OWNER_RECORD)], rowCount: 1 });
    const record = await repository.findByUserId(OWNER);
    expect(record).toEqual(OWNER_RECORD);
    for (const key of Object.keys(record ?? {})) {
      expect(key).not.toContain('_');
      expect(POSTGRES_COMPLIANCE_INTERNAL_COLUMNS).not.toContain(key);
    }
  });

  it('每次调用都返回新对象（不把数据库行或内部可变引用交给调用方）', async () => {
    // 三次响应刻意复用**同一个行对象**：即便执行器每次返回同一引用，adapter 也必须逐次新构造记录，
    // 否则调用方改一次返回值就会污染后续读取（同引用 / 契约问题）
    const sharedRow = rowFromRecord(OWNER_RECORD);
    const { repository } = repoWith(
      { rows: [sharedRow], rowCount: 1 },
      { rows: [sharedRow], rowCount: 1 },
      { rows: [sharedRow], rowCount: 1 },
    );
    const first = await repository.findByUserId(OWNER);
    const second = await repository.findByUserId(OWNER);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    // 返回的不是数据库行本身，也不是被复用的内部引用
    expect(first).not.toBe(sharedRow);
    expect(second).not.toBe(sharedRow);
    // 修改返回值不影响后续读取（不是共享引用）
    (first as { privacyConsent: string }).privacyConsent = 'withdrawn';
    expect(sharedRow.privacy_consent).toBe('granted');
    const third = await repository.findByUserId(OWNER);
    expect(third).toEqual(OWNER_RECORD);
    expect(third).not.toBe(first);
    expect(third).not.toBe(sharedRow);
  });

  it('三个状态闭集全组合可往返：自洽组合放行、不自洽组合 fail-closed（不臆造额外收紧）', async () => {
    expect(STATUS_COMBINATIONS).toHaveLength(12);
    expect(STATUS_COMBINATIONS.filter((combination) => combination.valid)).toHaveLength(7);

    for (const combination of STATUS_COMBINATIONS) {
      const record: ComplianceRecord = {
        ownerUserId: OWNER,
        privacyConsent: combination.privacyConsent,
        dataRetention: combination.dataRetention,
        exportAvailability: combination.exportAvailability,
      };
      const { repository } = repoWith({ rows: [rowFromRecord(record)], rowCount: 1 });
      if (combination.valid) {
        await expect(repository.findByUserId(OWNER)).resolves.toEqual(record);
      } else {
        const error = await captureRepoError(() => repository.findByUserId(OWNER));
        expect(error.code).toBe('INVALID_ROW');
        expectNoValueLeak(error);
      }
    }
  });

  it('规范小写形（含十六进制字母）的归属可往返，大写 / 混合形一律拒绝', async () => {
    const hexRecord: ComplianceRecord = { ...OWNER_RECORD, ownerUserId: HEX_OWNER };
    const accepted = repoWith({ rows: [rowFromRecord(hexRecord)], rowCount: 1 });
    await expect(accepted.repository.findByUserId(HEX_OWNER)).resolves.toEqual(hexRecord);
    expect(callAt(accepted.executor, 0)?.parameters).toEqual([HEX_OWNER]);

    for (const subject of [HEX_OWNER_UPPER, HEX_OWNER_MIXED]) {
      const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
      const error = await captureRepoError(() => repository.findByUserId(subject));
      expect(error.code).toBe('INVALID_SUBJECT');
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
  });

  it('取数主体与会话基线的安全 ID 形不兼容：存储 ID 域由 adapter fail-closed 强制', () => {
    // 读取契约允许 u-student-1，但存储 ID 域更严；两者并存是刻意设计（登记在验证清单第 7 项）
    expect(parseStoredComplianceRecord({ ...OWNER_RECORD, ownerUserId: SESSION_SUBJECT }).ok).toBe(
      true,
    );
    expect(COMPLIANCE_REPOSITORY_STORAGE_ID_DOMAIN).toBe('uuid');
    expect([...POSTGRES_COMPLIANCE_REPOSITORY_VERIFICATION_STEPS]).toContain(
      'session-subject-owner-ids-converged-to-uuid',
    );
  });
});

describe('PostgreSQL 合规仓储：公开视图与失败路径信息卫生', () => {
  it('存储记录承载归属（不静默丢弃），但公开视图恰好是三个闭集状态', () => {
    const parsed = parseStoredComplianceRecord(OWNER_RECORD);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.ownerUserId).toBe(OWNER);

    expect([...COMPLIANCE_STATUS_VIEW_FIELDS]).toEqual([
      'privacyConsent',
      'dataRetention',
      'exportAvailability',
    ]);
    const view = toComplianceStatusView(parsed.value);
    expect(Object.keys(view).sort()).toEqual([...COMPLIANCE_STATUS_VIEW_FIELDS].sort());
    for (const forbidden of [
      'ownerUserId',
      'ownerId',
      'userId',
      'user_id',
      'consentText',
      'consentBody',
      'policyText',
      'policyVersion',
      'consentedAt',
      'withdrawnAt',
      'phone',
      'mobile',
      'name',
      'studentNo',
      'idCard',
      'reviewStatus',
      'reviewNote',
      'reviewComment',
      'reviewerId',
      'reviewedAt',
      'evidenceFileId',
      'evidenceId',
      'evidenceUrl',
      'createdAt',
      'updatedAt',
      'expiresAt',
      'retentionUntil',
      'purgedAt',
      'filePath',
      'downloadUrl',
      'signedUrl',
      'url',
      'storageKey',
      'objectKey',
      'artifactHandle',
      'exportJobId',
      'errorMessage',
      'failureReason',
      'stackTrace',
      'idempotencyKey',
    ]) {
      expect(Object.keys(view)).not.toContain(forbidden);
      expect(JSON.stringify(view)).not.toContain(forbidden);
    }
  });

  it('裁剪清单与公开视图白名单无交集：模块加载期自检对真实白名单放行、对泄漏白名单 fail-closed', () => {
    expect(findComplianceViewExclusionLeaks(COMPLIANCE_STATUS_VIEW_FIELDS)).toEqual([]);
    expect(() => assertComplianceViewExclusion(COMPLIANCE_STATUS_VIEW_FIELDS)).not.toThrow();

    // 逐项探针：列名本身或其驼峰形一旦出现在视图白名单里，必须被判为泄漏
    for (const column of POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS) {
      for (const candidate of [column, camelCase(column)]) {
        const leaked = [...COMPLIANCE_STATUS_VIEW_FIELDS, candidate];
        expect(findComplianceViewExclusionLeaks(leaked)).toContain(candidate);

        const error = captureSyncError(() => assertComplianceViewExclusion(leaked));
        expect(error.code).toBe('CAPABILITY_MISDECLARED');
        expect(error.issues).toContain(candidate);
        expectNoValueLeak(error);
      }
    }
    // 字段名方向的探针（user_id → ownerUserId 等）
    for (const field of [
      'ownerUserId',
      'userId',
      'consentText',
      'policyText',
      'phone',
      'idCard',
      'reviewNote',
      'evidenceFileId',
      'createdAt',
      'retentionUntil',
      'filePath',
      'storageKey',
      'errorMessage',
    ]) {
      const leaked = [...COMPLIANCE_STATUS_VIEW_FIELDS, field];
      expect(findComplianceViewExclusionLeaks(leaked)).toContain(field);
      expect(() => assertComplianceViewExclusion(leaked)).toThrow(
        PostgresComplianceRepositoryError,
      );
    }
  });

  it('内部列与列清单零交集：探针一旦重叠即 fail-closed', () => {
    expect(findComplianceInternalColumnOverlaps()).toEqual([]);
    expect(() => assertComplianceInternalColumnsAbsent()).not.toThrow();
    // 真实列清单必须被同一个探针放行（显式传参，避免「只有默认参数才放行」的假象）
    expect(findComplianceInternalColumnOverlaps([...POSTGRES_COMPLIANCE_COLUMNS])).toEqual([]);
    expect(() =>
      assertComplianceInternalColumnsAbsent([...POSTGRES_COMPLIANCE_COLUMNS]),
    ).not.toThrow();

    for (const internal of POSTGRES_COMPLIANCE_INTERNAL_COLUMNS) {
      const overlapped = [...POSTGRES_COMPLIANCE_COLUMNS, internal];
      expect(findComplianceInternalColumnOverlaps(overlapped)).toContain(internal);

      const error = captureSyncError(() => assertComplianceInternalColumnsAbsent(overlapped));
      expect(error.code).toBe('CAPABILITY_MISDECLARED');
      expect(error.issues).toContain(internal);
      expectNoValueLeak(error);
    }
    // 任何投影列一旦被误登记为内部列，必须被发现（否则会被从 SELECT 里悄悄摘掉）
    for (const publicColumn of POSTGRES_COMPLIANCE_COLUMNS) {
      expect(POSTGRES_COMPLIANCE_INTERNAL_COLUMNS).not.toContain(publicColumn);
    }
    // 三个公开状态列一旦被误登记为裁剪列 / 高敏列，同样必须被发现（避免「把公开状态裁掉」）
    for (const statusColumn of ['privacy_consent', 'data_retention', 'export_availability']) {
      expect(POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS).not.toContain(statusColumn);
      expect(POSTGRES_COMPLIANCE_PII_COLUMNS).not.toContain(statusColumn);
    }
  });

  it('成功路径的返回记录与公开视图都不含任何内部列、PII、内部时间戳或存储位置', async () => {
    const { repository } = repoWith({ rows: [rowFromRecord(OWNER_RECORD)], rowCount: 1 });
    const record = await repository.findByUserId(OWNER);
    expect(record).toBeDefined();
    if (record === undefined) return;

    const view = toComplianceStatusView(record);
    const serialized = `${JSON.stringify(record)} ${JSON.stringify(view)}`;
    for (const internal of POSTGRES_COMPLIANCE_INTERNAL_COLUMNS) {
      expect(Object.keys(record)).not.toContain(internal);
      expect(Object.keys(view)).not.toContain(internal);
      expect(containsWord(serialized, internal)).toBe(false);
    }
    for (const value of [
      CONSENT_TEXT,
      POLICY_TEXT,
      POLICY_VERSION,
      PHONE,
      ID_CARD,
      STUDENT_NO,
      FULL_NAME,
      REVIEW_NOTE,
      EVIDENCE_ID,
      FORGED_PATH,
      FORGED_URL,
      STORAGE_KEY,
      SECRET,
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  it('任何失败路径的错误信息与 issues 都不含归属、状态取值、同意原文、联系方式、审核 / 证据与存储位置', async () => {
    const failures: readonly (() => Promise<unknown>)[] = [
      () =>
        repoWith({
          rows: [rowFromRecord(OWNER_RECORD, { phone: PHONE })],
          rowCount: 1,
        }).repository.findByUserId(OWNER),
      () =>
        repoWith({
          rows: [rowFromRecord(OWNER_RECORD, { consent_text: CONSENT_TEXT })],
          rowCount: 1,
        }).repository.findByUserId(OWNER),
      () =>
        repoWith({
          rows: [rowFromRecord(OWNER_RECORD, { file_path: FORGED_PATH })],
          rowCount: 1,
        }).repository.findByUserId(OWNER),
      () =>
        repoWith({
          rows: [rowFromRecord(OWNER_RECORD, { download_url: FORGED_URL })],
          rowCount: 1,
        }).repository.findByUserId(OWNER),
      () =>
        repoWith({
          rows: [rowFromRecord(OWNER_RECORD, { review_note: REVIEW_NOTE })],
          rowCount: 1,
        }).repository.findByUserId(OWNER),
      () =>
        repoWith({
          rows: [rowFromRecord(OWNER_RECORD, { evidence_file_id: EVIDENCE_ID })],
          rowCount: 1,
        }).repository.findByUserId(OWNER),
      () =>
        repoWith({
          rows: [rowFromRecord(OWNER_RECORD, { created_at: new Date() })],
          rowCount: 1,
        }).repository.findByUserId(OWNER),
      () =>
        repoWith({
          rows: [rowFromRecord(OTHER_OWNER_RECORD)],
          rowCount: 1,
        }).repository.findByUserId(OWNER),
      () =>
        repoWith({
          rows: [rowFromRecord(OWNER_RECORD), rowFromRecord(OWNER_RECORD)],
          rowCount: 2,
        }).repository.findByUserId(OWNER),
      () =>
        repoWith({
          rows: [rowFromRecord(OWNER_RECORD, { privacy_consent: INJECTION })],
          rowCount: 1,
        }).repository.findByUserId(OWNER),
      () =>
        repoWith({
          rows: [
            rowFromRecord(OWNER_RECORD, {
              export_availability: 'available',
              privacy_consent: 'withdrawn',
            }),
          ],
          rowCount: 1,
        }).repository.findByUserId(OWNER),
      () => repoWith({ rows: [], rowCount: 0 }).repository.findByUserId(INJECTION),
      () => repoWith({ rows: [], rowCount: 0 }).repository.findByUserId(SESSION_SUBJECT),
      () => repoWith({ rows: [], rowCount: 0 }).repository.findByUserId(NIL_UUID),
    ];

    for (const run of failures) {
      let captured: unknown;
      try {
        await run();
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(PostgresComplianceRepositoryError);
      expectNoValueLeak(captured as PostgresComplianceRepositoryError);
    }
  });

  it('执行器异常收敛为 EXECUTOR_FAILURE：原始错误文本、SQL 与连接信息都不外发', async () => {
    const raw = new Error(
      `connect ECONNREFUSED 10.0.0.9:5432 (${FORGED_PATH}) ${FORGED_URL} ${SECRET} ${PHONE}`,
    );
    const repository = new PostgresComplianceRepository(new ThrowingExecutor(raw));

    const error = await captureRepoError(() => repository.findByUserId(OWNER));
    expect(error.code).toBe('EXECUTOR_FAILURE');
    expect(error.issues).toEqual(['executor']);
    expect(error.message).not.toContain('ECONNREFUSED');
    expect(error.message).not.toContain('5432');
    expect(error.message).not.toContain(FORGED_PATH);
    expect(error.message).not.toContain(FORGED_URL);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(PHONE);
    // 原始错误对象本身不得被挂到公开错误上（cause 会被日志与序列化带出去）
    expect(error.cause).toBeUndefined();
    expectNoValueLeak(error);
  });

  it('同步抛出的驱动异常同样被收敛（不把原始文本带出去）', async () => {
    const executor = new RecordingExecutor();
    const throwing: SqlExecutor = {
      capabilities: executor.capabilities,
      query: () => {
        throw new Error(`原始驱动错误 ${FORGED_PATH} ${ID_CARD}`);
      },
    };
    const repository = new PostgresComplianceRepository(throwing);
    const error = await captureRepoError(() => repository.findByUserId(OWNER));
    expect(error.code).toBe('EXECUTOR_FAILURE');
    expect(error.message).not.toContain(FORGED_PATH);
    expect(error.message).not.toContain(ID_CARD);
    expect(error.cause).toBeUndefined();
    expectNoValueLeak(error);
  });
});

describe('PostgreSQL 合规仓储：已接入运行时、无驱动依赖、与 schema 边界对齐', () => {
  it('ComplianceModule 按「是否配置数据库」换绑：内存基线不再是独立 provider，adapter 只能经工厂进入', () => {
    const content = readFileSync(MODULE_PATH, 'utf8');

    // 换绑点：模块必须引用端口令牌与延迟建连工厂（登记表按这两个名字做机器比对）
    expect(content).toContain('COMPLIANCE_REPOSITORY');
    expect(content).toContain('createLazyPostgresComplianceRepository');
    expect(content).toContain('resolveAppDatabaseConfig');
    expect(content).toContain('SQL_CONNECTION_FACTORY');
    expect(content).toContain('InMemoryComplianceRepository');
    // 「未配置数据库」路径仍是内存基线，「配置了但没有执行器工厂」仍是 fail-closed 抛错
    expect(content).toContain('createComplianceRepository');
    expect(content).toMatch(/拒绝退回内存合规仓储/u);
    // 内存基线**不再是**独立 provider（否则容器里会出现两份状态）
    expect(content).not.toContain('useExisting: InMemoryComplianceRepository');
    expect(content).not.toMatch(/providers:\s*\[[^\]]*InMemoryComplianceRepository/u);
    // adapter 类仍然不被直接绑定：进入容器的是工厂返回的端口实现
    expect(content).not.toContain(`new ${ADAPTER_CLASS}(`);
  });

  it('持久化登记表把本切片登记为「已绑定」，且不再把 adapter 挂在未装配组', () => {
    const registry = readApiFile(join('src', 'db', 'persistence', 'postgres-adapter-registry.ts'));
    // 已绑定组必须登记本切片的令牌 + 工厂导出名（换绑与登记表必须同时更新）
    expect(registry).toContain("id: 'compliance'");
    expect(registry).toContain("token: 'COMPLIANCE_REPOSITORY'");
    expect(registry).toContain("factoryExport: 'createLazyPostgresComplianceRepository'");
    expect(registry).toContain('POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES');
    // 未装配组的**数组内容**里不得再出现合规 adapter（按 `];` 精确切出数组，避免把下面的
    // 「已绑定」文档注释误纳入判定范围）
    const unboundStart = registry.indexOf('export const POSTGRES_ADAPTER_REGISTRY');
    const unboundEnd = registry.indexOf('];', unboundStart);
    const unboundGroup = registry.slice(unboundStart, unboundEnd);
    expect(unboundGroup).not.toBe('');
    expect(unboundGroup).not.toContain(ADAPTER_CLASS);
    expect(unboundGroup).not.toContain('modules/compliance/');

    // 端口登记表里合规端口仍按令牌登记（持久化职责不变）
    const bindings = readApiFile(join('src', 'db', 'persistence-bindings.ts'));
    expect(bindings).toContain('COMPLIANCE_REPOSITORY');
    expect(bindings).toContain('合规/隐私同意记录存储');
  });

  it('内存基线实现异步唯一契约、能力如实、且没有任何写入 / 删除入口', async () => {
    const source = readFileSync(IN_MEMORY_PATH, 'utf8');
    expect(source).toContain('implements ComplianceRepository');
    expect(source).not.toContain(ADAPTER_CLASS);
    expect(source).toContain('persistent: false');
    expect(source).toContain('productionReady: false');
    // 内存基线也没有任何写入 / 删除 / 覆盖插入入口
    for (const forbidden of POSTGRES_COMPLIANCE_FORBIDDEN_METHODS) {
      expect(source).not.toMatch(new RegExp(`\\b${forbidden}\\s*\\(`, 'u'));
    }
    // 端口收敛后内存基线返回 Promise（与数据库实现同一契约），未 seed 时任何主体都查不到记录
    const memory: ComplianceRepository = new InMemoryComplianceRepository({
      NODE_ENV: 'test',
    } as unknown as ConstructorParameters<typeof InMemoryComplianceRepository>[0]);
    expect(memory.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    await expect(memory.findByUserId(OWNER)).resolves.toBeUndefined();
  });

  it('内存基线与数据库实现满足同一个端口类型（换绑不需要第二个并存契约）', () => {
    const adapter: ComplianceRepository = new PostgresComplianceRepository(new RecordingExecutor());
    const memory: ComplianceRepository = new InMemoryComplianceRepository({
      NODE_ENV: 'test',
    } as unknown as ConstructorParameters<typeof InMemoryComplianceRepository>[0]);
    // 两者都必须能被同一个端口类型接收（异步唯一契约），且各自如实声明能力
    expect(adapter.capabilities.persistent).toBe(true);
    expect(adapter.capabilities.productionReady).toBe(false);
    expect(memory.capabilities.persistent).toBe(false);
    expect(memory.capabilities.productionReady).toBe(false);
  });

  it('adapter 的公开面覆盖能力、验证清单、列清单、内部列与裁剪事实（供上层与运维机器判定）', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    for (const exported of [
      'POSTGRES_COMPLIANCE_TABLE',
      'POSTGRES_COMPLIANCE_COLUMNS',
      'POSTGRES_COMPLIANCE_COLUMN_FIELDS',
      'POSTGRES_COMPLIANCE_FIELD_COLUMNS',
      'POSTGRES_COMPLIANCE_OWNER_COLUMNS',
      'POSTGRES_COMPLIANCE_INTERNAL_COLUMNS',
      'POSTGRES_COMPLIANCE_PII_COLUMNS',
      'POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS',
      'POSTGRES_COMPLIANCE_FORBIDDEN_METHODS',
      'POSTGRES_COMPLIANCE_READ_ONLY_STATEMENTS',
      'POSTGRES_COMPLIANCE_FORBIDDEN_SQL_KEYWORDS',
      'POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES',
      'POSTGRES_COMPLIANCE_REPOSITORY_VERIFICATION_STEPS',
    ]) {
      expect(source).toContain(`export const ${exported}`);
    }
    expect(source).toContain(`export class ${ADAPTER_CLASS}`);
    expect(source).toContain(`export class ${ADAPTER_CLASS}Error`);
    expect(source).toContain('export function assertPostgresComplianceRepositoryCapabilities');
    expect(source).toContain('export function findComplianceViewExclusionLeaks');
    expect(source).toContain('export function assertComplianceViewExclusion');
    expect(source).toContain('export function findComplianceInternalColumnOverlaps');
    expect(source).toContain('export function assertComplianceInternalColumnsAbsent');
    expect(source).toContain('export function assertComplianceReadOnlySql');
    // 换绑面：DI 工厂 + 延迟建连工厂 + 「存储 ID 域先判、再建连」的公开断言
    expect(source).toContain('export function createPostgresComplianceRepository');
    expect(source).toContain('export function createLazyPostgresComplianceRepository');
    expect(source).toContain('export function assertPostgresComplianceSubject');
    expect(source).toContain('export type PostgresComplianceRepositoryErrorCode');
    // 语句模板：有且只有一条取数语句（模板常量名与首个关键字都必须是 SELECT）
    const templates = [...source.matchAll(/const (\w+_SQL) = `(\w+)/gu)].map(
      (match) => `${match[1] ?? ''}:${match[2] ?? ''}`,
    );
    expect(templates).toEqual(['SELECT_BY_USER_SQL:SELECT']);
    // 源文本里不得出现「反引号 + 被禁写关键字」：注释 / 常量解释也不例外
    // （只读切片却在源码里用反引号包着 INSERT / UPDATE 之类，会误导后续改动人）
    for (const keyword of POSTGRES_COMPLIANCE_FORBIDDEN_SQL_KEYWORDS) {
      expect(source).not.toMatch(new RegExp('`' + keyword + '\\b', 'u'));
    }
    // 反引号里的 SQL 文本（真正会被执行的内容）更不得出现任何被禁写关键字
    const sqlTexts = [...source.matchAll(/const \w+_SQL = `([^`]*)`/gu)].map(
      (match) => match[1] ?? '',
    );
    expect(sqlTexts).toHaveLength(1);
    for (const sql of sqlTexts) {
      expect(containsWord(sql, 'SELECT')).toBe(true);
      for (const keyword of POSTGRES_COMPLIANCE_FORBIDDEN_SQL_KEYWORDS) {
        expect(containsWord(sql, keyword)).toBe(false);
      }
    }
    // 只读切片里没有任何写入 / 冲突覆盖语句
    expect(source).not.toContain('ON CONFLICT');
    expect(source).not.toContain('RETURNING');
  });

  it('adapter 不引入任何数据库驱动 / ORM 依赖（依赖面是固定的五个说明符）', () => {
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
      '@nestjs/common',
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
        './compliance.contract',
        './compliance.port',
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

  it('异步端口的实现者不是 Nest provider（不带装饰器、不注册到容器），且类型上满足异步契约', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).not.toMatch(/@Injectable\s*\(/u);
    expect(source).not.toMatch(/@Inject\s*\(/u);
    expect(source).not.toContain('Symbol(');

    // 类型层面的契约对应：adapter 可直接赋给异步端口，且能力声明与冻结常量一致
    const adapter: AsyncComplianceRepository = new PostgresComplianceRepository(
      new RecordingExecutor(),
    );
    expect(adapter.capabilities).toEqual(POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES);
    expect(adapter).toBeInstanceOf(PostgresComplianceRepository);
  });
});
