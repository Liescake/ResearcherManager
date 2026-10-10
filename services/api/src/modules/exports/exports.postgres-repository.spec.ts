import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../config/env';
import type {
  PersistenceCapabilities,
  SqlExecutor,
  SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import {
  EXPORTABLE_FIELDS,
  EXPORT_REQUEST_VIEW_FIELDS,
  parseStoredExportRequest,
  toExportRequestView,
} from './exports.contract';
import { InMemoryExportRepository } from './exports.in-memory-repository';
import {
  EXPORT_PAGE_MAX_LIMIT,
  EXPORT_REPOSITORY_BACKEND_POSTGRES,
  EXPORT_REPOSITORY_STORAGE_ID_DOMAIN,
  EXPORT_RESOURCE_VALUES,
  EXPORT_STATUS_VALUES,
  EXPORT_TRANSITION_REJECTED,
  ExportResource,
  ExportRevocationOutcome,
  ExportStatus,
  isExportTransitionRejection,
} from './exports.port';
import type {
  AsyncExportRepository,
  ExportRepository,
  ExportRepositoryCapabilities,
  ExportRequest,
} from './exports.port';
import {
  EXPORT_ENTRY_STATUS,
  EXPORT_REVOCABLE_STATUSES,
  canTransitionExport,
} from './exports.state-machine';
import {
  POSTGRES_EXPORT_COLUMN_FIELDS,
  POSTGRES_EXPORT_COLUMNS,
  POSTGRES_EXPORT_FIELD_COLUMNS,
  POSTGRES_EXPORT_FORBIDDEN_METHODS,
  POSTGRES_EXPORT_IMMUTABLE_COLUMNS,
  POSTGRES_EXPORT_INTERNAL_COLUMNS,
  POSTGRES_EXPORT_MUTABLE_COLUMNS,
  POSTGRES_EXPORT_OWNER_COLUMNS,
  POSTGRES_EXPORT_PII_COLUMNS,
  POSTGRES_EXPORT_REPOSITORY_CAPABILITIES,
  POSTGRES_EXPORT_REPOSITORY_VERIFICATION_STEPS,
  POSTGRES_EXPORT_REVOKE_COLUMNS,
  POSTGRES_EXPORT_TABLE,
  POSTGRES_EXPORT_TRUNCATION_FIELD,
  POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS,
  PostgresExportRepository,
  PostgresExportRepositoryError,
  assertExportInternalColumnsAbsent,
  assertExportViewExclusion,
  assertPostgresExportPageWindow,
  assertPostgresExportRepositoryCapabilities,
  assertPostgresExportRevocationTimestamp,
  createLazyPostgresExportRepository,
  exportStatusPredecessors,
  findExportInternalColumnOverlaps,
  findExportViewExclusionLeaks,
} from './exports.postgres-repository';

/**
 * 导出请求（`export_jobs`）的 PostgreSQL 仓储 adapter 的**离线**验收（不连数据库、不引驱动）。
 *
 * 覆盖用户要求的补充安全契约测试与交付边界：
 * - **能力与交付边界**：`persistent = true` / `productionReady = false`（未取得封存声明与已登记
 *   证据前严禁生产）、列清单与读取契约字段双射、`export_jobs` 已由迁移 `0013` 建出、adapter 已经
 *   换绑工厂装配到 `ExportsModule`（延迟建连，装配阶段不建连）、不引驱动/ORM、端口只保留一份
 *   异步契约（同步与异步已收敛）；
 * - **参数化 SQL 与固定标识符**：值只出现在参数里，SQL 文本只由模块常量构成（语句里没有任何
 *   引号 / 分号 / 注释符，因此不存在字面量注入面）；执行过的 SQL 只含 `INSERT` / `UPDATE` / `SELECT`；
 * - **SQL 注入**：归属、主键、资源、字段等所有入口的注入载荷要么只进参数、要么在进入 SQL
 *   之前被拒绝（拒绝路径**一个 SQL 都不执行**）；
 * - **未知列 / 严格行契约 / 字段污染**：未登记列（文件名、路径、下载地址、签名地址、存储 key、
 *   对象 key、产物句柄、文件体、内部资源快照、筛选条件、原始错误、簿记列）、缺列、写路径的
 *   snake_case 别名与权限字段一律 fail-closed；
 * - **非法枚举 / 坏时间戳 / 非 UUID**：`resource` / `status` 只接受闭集，时间列只接受 `Date` 或
 *   ISO datetime（不把非法时间静默归一），存储标识必须是规范小写形非空 UUID；
 * - **按服务端 subject owner 隔离**：他人导出请求既不出库（归属下推进 SQL）也不得回流，
 *   写回路径以 `id + 归属` 双重限定；
 * - **状态机 `pending -> completed | failed` 严格校验**：`create` 只接受入口状态，`save` 只接受
 *   合法转移，非法转移（目标无前驱 / 存储行不在前驱集合内）**不产生任何写入**；
 * - **重复多行**：创建 / 写回 / 取数 / 诊断查询返回多行或重复主键一律判结果集违约；
 * - **公开视图不泄露归属、产物句柄、文件位置、存储 key、内部资源字段、原始错误与 PII**：
 *   视图恰好是白名单闭集；所有失败路径的错误信息与 `issues` 只含字段路径与违规类型，不含任何取值；
 *   执行器异常收敛为不含原始文本的 `EXECUTOR_FAILURE`；
 * - **与内存基线同语义**：同 ID 冲突不得静默覆盖，写回未知 id 不得退化成插入。
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
const EXPORTS_DIR = resolve(process.cwd(), 'src', 'modules', 'exports');
const ADAPTER_PATH = resolve(EXPORTS_DIR, 'exports.postgres-repository.ts');
const PORT_PATH = resolve(EXPORTS_DIR, 'exports.port.ts');
const MODULE_PATH = resolve(EXPORTS_DIR, 'exports.module.ts');
const IN_MEMORY_PATH = resolve(EXPORTS_DIR, 'exports.in-memory-repository.ts');
const ADAPTER_CLASS = 'PostgresExportRepository';

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
const JOB_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_JOB_ID = '66666666-6666-4666-8666-666666666666';
/** 含十六进制字母的主键：用于验证「规范小写形」约束 */
const HEX_JOB_ID = 'e1f2a3b4-c5d6-4789-8efa-0123456789ab';
const HEX_JOB_ID_UPPER = 'E1F2A3B4-C5D6-4789-8EFA-0123456789AB';
const ARTIFACT_ID = '88888888-8888-4888-8888-888888888888';
const ARTIFACT_ID_OTHER = '99999999-9999-4999-8999-999999999999';
/** 含十六进制字母的产物句柄：用于验证「规范小写形」约束 */
const HEX_ARTIFACT_ID = 'b1c2d3e4-f5a6-4789-8bcd-ef0123456789';
const HEX_ARTIFACT_ID_UPPER = 'B1C2D3E4-F5A6-4789-8BCD-EF0123456789';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const CREATED_AT = '2026-01-02T03:04:05.000Z';
const LATER_AT = '2026-01-03T04:05:06.000Z';
/**
 * 服务端有效期样本（UTC 绝对时刻，**晚于** `CREATED_AT`）：与迁移 `0015` 的
 * `expires_at > created_at` 不变式一致。它是「服务端创建、只读」的事实，因此是记录夹具的
 * 固定组成部分（协议上可缺省，缺省 = 存储 `NULL` = 下载边界 fail-closed）。
 */
const EXPIRES_AT = '2026-01-02T04:04:05.000Z';
/**
 * 服务端撤销时刻样本（UTC 绝对时刻，**晚于** `CREATED_AT` 且**早于** `EXPIRES_AT`）：
 * 与迁移 `0016` 的 `revoked_at >= created_at` 不变式一致。缺省 = 存储 `NULL` = 未被撤销，
 * 因此它是「已撤销记录」夹具的显式组成部分（协议上可缺省）。
 */
const REVOKED_AT = '2026-01-02T03:30:00.000Z';
/** 注入载荷：只允许出现在参数里，绝不允许出现在 SQL 文本或错误信息里 */
const INJECTION = "x'); DROP TABLE export_jobs; --";
/** 伪造的产物路径（含疑似身份证号）：绝不允许入库到领域对象或外发 */
const FORGED_PATH = 'D:\\exports\\private\\11010119900307123X.pdf';
/** 伪造的签名下载地址（含疑似密钥）：绝不允许外发 */
const FORGED_URL = 'https://storage.example.com/private/signed?token=abcdefgh1234';
/** 疑似身份证号：读取契约必须拒绝（不在字段白名单内），且错误信息不得回显 */
const PII_FIELD = '11010119900307123X';
/** 疑似密钥：绝不允许出现在错误信息里 */
const SECRET = 'abcdefgh1234';

/** 入口状态样本（创建路径的主要样本） */
const PENDING_JOB: ExportRequest = {
  id: JOB_ID,
  ownerUserId: OWNER,
  resource: ExportResource.Profile,
  fields: ['college', 'major'],
  status: ExportStatus.Pending,
  expiresAt: EXPIRES_AT,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

/** 完成态样本（写回路径的主要样本）：`completed` 必带产物句柄 */
const COMPLETED_JOB: ExportRequest = {
  ...PENDING_JOB,
  status: ExportStatus.Completed,
  artifactId: ARTIFACT_ID,
  updatedAt: LATER_AT,
};

/** 失败态样本：`failed` 必无产物句柄 */
const FAILED_JOB: ExportRequest = {
  ...PENDING_JOB,
  status: ExportStatus.Failed,
  updatedAt: LATER_AT,
};

/**
 * **已撤销**样本：与状态机正交 —— `status` 仍是 `completed`（撤销不改写结论），
 * 只多出一个服务端撤销时刻；`updated_at` 随撤销写入而改写。
 * 它是「撤销优先于完成」这条判定的存储事实来源。
 */
const REVOKED_JOB: ExportRequest = {
  ...COMPLETED_JOB,
  revokedAt: REVOKED_AT,
  updatedAt: REVOKED_AT,
};

/** 他人名下的作业样本：本人列表 / 写回路径里绝不能出现 */
const OTHER_OWNER_JOB: ExportRequest = {
  ...PENDING_JOB,
  id: OTHER_JOB_ID,
  ownerUserId: OTHER_OWNER,
};

/** 数据库行（snake_case）：默认与给定记录等价 */
function rowFromJob(
  job: ExportRequest,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: job.id,
    requester_id: job.ownerUserId,
    resource: job.resource,
    fields: [...job.fields],
    status: job.status,
    artifact_id: job.artifactId === undefined ? null : job.artifactId,
    // 领域字段缺省 ⇒ 存储 NULL（不是省略键：PG 对 SELECT 列表中的列一定返回键）
    expires_at: job.expiresAt === undefined ? null : new Date(job.expiresAt),
    revoked_at: job.revokedAt === undefined ? null : new Date(job.revokedAt),
    created_at: new Date(job.createdAt),
    updated_at: new Date(job.updatedAt),
    ...overrides,
  };
}

/** 移除某一列，用于「缺列」用例 */
function withoutRowColumn(job: ExportRequest, column: string): Record<string, unknown> {
  const row = rowFromJob(job);
  delete row[column];
  return row;
}

/** 复制记录并去掉某个字段（模拟「缺必填字段」的写入记录） */
function omitField(job: ExportRequest, field: keyof ExportRequest): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...job };
  delete copy[field];
  return copy;
}

/** 用给定响应构造 adapter（响应按调用顺序消费） */
function repoWith(...responses: unknown[]): {
  repository: PostgresExportRepository;
  executor: RecordingExecutor;
} {
  const executor = new RecordingExecutor(responses);
  return { repository: new PostgresExportRepository(executor), executor };
}

async function captureRepoError(
  run: () => Promise<unknown>,
): Promise<PostgresExportRepositoryError> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresExportRepositoryError);
  return captured as PostgresExportRepositoryError;
}

function captureSyncError(run: () => unknown): PostgresExportRepositoryError {
  let captured: unknown;
  try {
    run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresExportRepositoryError);
  return captured as PostgresExportRepositoryError;
}

/**
 * 断言 `issues` 里存在指向某个字段路径的违规。
 *
 * `issues` 的形状是 `字段路径(违规类型)`（例如 `status(invalid_enum_value)`），违规类型取决于
 * zod 的 issue code，因此只固定「指向哪个字段」，不把违规类型写死（那属于实现细节）。
 * 存储 ID 域约束走的是 adapter 自有的 `requireStorageUuid`，它只给出裸字段路径（例如 `id`），
 * 因此裸路径同样算命中。
 */
function expectIssueOn(error: PostgresExportRepositoryError, path: string): void {
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

/** 某一列在写入参数数组里的位置（由列清单派生，避免硬编码下标漂移） */
function parameterAt(call: RecordedCall | undefined, column: string): unknown {
  const index = [...POSTGRES_EXPORT_COLUMNS].indexOf(
    column as (typeof POSTGRES_EXPORT_COLUMNS)[number],
  );
  expect(index).toBeGreaterThanOrEqual(0);
  return call?.parameters?.[index];
}

/** 单词边界命中（避免 `id` 命中 `artifact_id`、`resource_id` 命中 `resource` 之类） */
function containsWord(sql: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'u').test(sql);
}

/**
 * 语句卫生：只由模块常量与 `$n` 占位符构成。
 *
 * 没有任何引号 ⇒ 语句里不存在字符串字面量（因此没有「值 → SQL 文本」的注入面）；
 * 没有分号 / `--` ⇒ 不存在语句拼接与注释截断面。
 * 与审计切片的差异：本切片的写回是**条件 `UPDATE`**（端口既有 `save` 方法），因此
 * 这里允许 `UPDATE`，但仍禁止一切删除 / DDL / 权限语句。
 */
function expectParameterizedSql(sql: string): void {
  expect(sql).not.toMatch(/['";]/u);
  expect(sql).not.toContain('--');
  expect(sql).not.toContain('*');
  expect(sql).not.toMatch(/\b(?:DROP|ALTER|TRUNCATE|GRANT|COPY|DELETE)\b/u);
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

/**
 * 共享读取契约声明的**全部**领域字段（由契约本身推导，而不是在测试里另抄一份清单）。
 *
 * 样本必须把**全部可选字段都填满**（`expiresAt` 与 `revokedAt` 都是可选的），否则
 * 「列清单与读取契约字段构成双射」这条断言会少算一列 —— 这正是它要拦住的漂移。
 */
function readContractFields(): readonly string[] {
  const parsed = parseStoredExportRequest({
    ...REVOKED_JOB,
    updatedAt: LATER_AT,
  });
  if (!parsed.ok) {
    throw new Error('样本记录未通过共享读取契约');
  }
  return Object.keys(parsed.value).sort();
}

/** camelCase 期望值：用于证明「列 → 字段」只有 `requester_id → ownerUserId` 一处非同名映射 */
function camelCase(column: string): string {
  return column.replace(/_([a-z0-9])/gu, (_match, char: string) => char.toUpperCase());
}

/** 失败路径的信息卫生断言：错误信息与 issues 都不含任何取值 */
function expectNoValueLeak(error: PostgresExportRepositoryError): void {
  const text = `${error.message} ${error.issues.join(' ')}`;
  for (const forbidden of [
    OWNER,
    OTHER_OWNER,
    HEX_OWNER,
    HEX_OWNER_UPPER,
    HEX_OWNER_MIXED,
    JOB_ID,
    OTHER_JOB_ID,
    HEX_JOB_ID,
    HEX_JOB_ID_UPPER,
    ARTIFACT_ID,
    ARTIFACT_ID_OTHER,
    CREATED_AT,
    LATER_AT,
    INJECTION,
    FORGED_PATH,
    FORGED_URL,
    PII_FIELD,
    SECRET,
    'college',
    'major',
  ]) {
    expect(text).not.toContain(forbidden);
  }
  // 冒号与引号意味着「键=值」形态的回显（issues 只允许 `字段路径(违规类型)`）
  expect(error.issues.every((issue) => !issue.includes(':') && !issue.includes('='))).toBe(true);
}

/** 断言「执行过的 SQL 只有创建 / 条件写回 / 取数」，并返回全部 SQL 文本 */
function expectWriteAndReadOnlySql(executor: RecordingExecutor): readonly string[] {
  const statements = executor.calls.map((call) => call.sql);
  for (const sql of statements) {
    expect(sql).toMatch(/\b(?:INSERT|UPDATE|SELECT)\b/u);
    expect(sql).not.toMatch(/\b(?:DELETE|TRUNCATE|ALTER|DROP|GRANT|COPY)\b/u);
    expect(sql).not.toContain('ON CONFLICT (id) DO UPDATE');
  }
  return statements;
}

describe('PostgreSQL 导出仓储：能力声明与交付边界', () => {
  it('能力声明恰好是 postgres / persistent=true / productionReady=false，且被冻结', () => {
    expect(POSTGRES_EXPORT_REPOSITORY_CAPABILITIES).toEqual({
      backend: EXPORT_REPOSITORY_BACKEND_POSTGRES,
      persistent: true,
      productionReady: false,
    });
    expect(EXPORT_REPOSITORY_BACKEND_POSTGRES).toBe('postgres');
    expect(EXPORT_REPOSITORY_STORAGE_ID_DOMAIN).toBe('uuid');
    expect(Object.isFrozen(POSTGRES_EXPORT_REPOSITORY_CAPABILITIES)).toBe(true);
    // 「未真实驱动验证前严禁生产」必须写在源码里，且能力自检必须存在
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).toContain('productionReady: false');
    expect(source).toContain('不得声称生产可用');
  });

  it('能力自检对合法声明放行，对「非持久 / 后端不符 / 声称生产可用」逐项 fail-closed', () => {
    expect(() => assertPostgresExportRepositoryCapabilities()).not.toThrow();
    expect(() =>
      assertPostgresExportRepositoryCapabilities(POSTGRES_EXPORT_REPOSITORY_CAPABILITIES),
    ).not.toThrow();

    const cases: readonly (readonly [ExportRepositoryCapabilities, string])[] = [
      [{ backend: 'postgres', persistent: false, productionReady: false }, 'persistent'],
      [{ backend: 'postgres', persistent: true, productionReady: true }, 'productionReady'],
      [{ backend: 'sqlite', persistent: true, productionReady: false }, 'backend'],
    ];
    for (const [capabilities, issue] of cases) {
      const error = captureSyncError(() =>
        assertPostgresExportRepositoryCapabilities(capabilities),
      );
      expect(error.code).toBe('CAPABILITY_MISDECLARED');
      expect(error.issues).toContain(issue);
      expect(error.message).toContain('不得声称生产可用');
      expectNoValueLeak(error);
    }
  });

  it('验证清单只剩真正未闭合的前置：已闭环的必须从待办移除，且证据在仓库里', () => {
    // 仍未闭合的两项（因此 productionReady 恒为 false）
    for (const step of [
      'session-subject-owner-ids-converged-to-uuid',
      'production-ready-capability-flipped-with-evidence',
    ]) {
      expect(POSTGRES_EXPORT_REPOSITORY_VERIFICATION_STEPS).toContain(step);
    }
    expect(POSTGRES_EXPORT_REPOSITORY_VERIFICATION_STEPS).toHaveLength(2);
    // 本切片已经闭环的前置**必须**从「待办」里移除：清单停留在旧状态就是一条假声明
    for (const delivered of [
      'driver-dependency-evaluated',
      'integration-tests-against-real-postgres',
      'export-jobs-schema-draft-created-and-promoted-to-migration',
      'export-jobs-column-names-aligned-with-field-dictionary',
      'export-fields-column-type-aligned-with-driver',
      'export-repository-port-migrated-to-async',
      'executor-failure-mapped-to-500-without-raw-text',
      'public-view-exclusion-verified-against-real-queries',
      'state-transition-rejection-mapped-to-409',
    ]) {
      expect(POSTGRES_EXPORT_REPOSITORY_VERIFICATION_STEPS).not.toContain(delivered);
    }
    // 清单本身不得声称「已生产可用」
    expect([...POSTGRES_EXPORT_REPOSITORY_VERIFICATION_STEPS].join(' ')).not.toContain(
      'production-ready-verified',
    );
    // 「schema 已落成迁移」这条证据必须真的在磁盘上（不是只在注释里声明）
    expect(
      readFileSync(join(REPO_ROOT, 'db', 'migrations', '0013_export_jobs.sql'), 'utf8'),
    ).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+export_jobs\s*\(/u);
    // 能力声明仍是「持久但未验证」：清单变短不等于可以声称生产可用
    expect(POSTGRES_EXPORT_REPOSITORY_CAPABILITIES.productionReady).toBe(false);
  });

  it('列清单与读取契约字段构成双射，且只有 requester_id → ownerUserId 一处非同名映射', () => {
    const columns = [...POSTGRES_EXPORT_COLUMNS];
    const fields = readContractFields();

    expect(Object.keys(POSTGRES_EXPORT_COLUMN_FIELDS)).toEqual(columns);
    expect(Object.keys(POSTGRES_EXPORT_FIELD_COLUMNS).sort()).toEqual(fields);
    for (const column of columns) {
      const field = POSTGRES_EXPORT_COLUMN_FIELDS[column];
      expect(
        POSTGRES_EXPORT_FIELD_COLUMNS[field as keyof typeof POSTGRES_EXPORT_FIELD_COLUMNS],
      ).toBe(column);
    }
    // 双向都是单射（无列映射到同一字段，也无字段映射到同一列）
    expect(new Set(Object.values(POSTGRES_EXPORT_COLUMN_FIELDS)).size).toBe(columns.length);
    expect(new Set(Object.values(POSTGRES_EXPORT_FIELD_COLUMNS)).size).toBe(columns.length);
    // 唯一的**真正重命名**是 requester_id → ownerUserId；其余只是 snake_case → camelCase 约定
    expect(
      columns.filter((column) => POSTGRES_EXPORT_COLUMN_FIELDS[column] !== camelCase(column)),
    ).toEqual(['requester_id']);
  });

  it('归属列、可变列与不可变列都落在列清单内，且写回不得触碰身份与导出范围', () => {
    expect([...POSTGRES_EXPORT_OWNER_COLUMNS]).toEqual(['requester_id']);
    for (const column of POSTGRES_EXPORT_OWNER_COLUMNS) {
      expect(POSTGRES_EXPORT_COLUMNS).toContain(column);
    }
    for (const column of [
      ...POSTGRES_EXPORT_MUTABLE_COLUMNS,
      ...POSTGRES_EXPORT_IMMUTABLE_COLUMNS,
    ]) {
      expect(POSTGRES_EXPORT_COLUMNS).toContain(column);
    }
    expect([...POSTGRES_EXPORT_MUTABLE_COLUMNS]).toEqual(['status', 'artifact_id', 'updated_at']);
    expect([...POSTGRES_EXPORT_IMMUTABLE_COLUMNS]).toEqual([
      'id',
      'requester_id',
      'resource',
      'fields',
      'expires_at',
      'revoked_at',
      'created_at',
    ]);
    // 可变列 ∪ 不可变列 === 列清单，且两者不相交
    const mutable = new Set<string>(POSTGRES_EXPORT_MUTABLE_COLUMNS);
    for (const column of POSTGRES_EXPORT_IMMUTABLE_COLUMNS) {
      expect(mutable.has(column)).toBe(false);
    }
    expect(
      [...POSTGRES_EXPORT_MUTABLE_COLUMNS, ...POSTGRES_EXPORT_IMMUTABLE_COLUMNS].sort(),
    ).toEqual([...POSTGRES_EXPORT_COLUMNS].sort());
    // 写回不得触碰身份 / 归属 / 导出范围 / 有效期 / **撤销时刻**
    for (const forbidden of [
      'id',
      'requester_id',
      'resource',
      'fields',
      'expires_at',
      'revoked_at',
      'created_at',
    ]) {
      expect(POSTGRES_EXPORT_MUTABLE_COLUMNS).not.toContain(forbidden);
    }
    // 撤销写入只允许触碰两列：撤销时刻与服务端时钟（不得触碰结论 / 句柄 / 有效期 / 身份）
    expect([...POSTGRES_EXPORT_REVOKE_COLUMNS]).toEqual(['revoked_at', 'updated_at']);
    for (const forbidden of [
      'id',
      'requester_id',
      'resource',
      'fields',
      'status',
      'artifact_id',
      'expires_at',
      'created_at',
    ]) {
      expect(POSTGRES_EXPORT_REVOKE_COLUMNS).not.toContain(forbidden);
    }
    // 撤销列与状态机写回的可变列**刻意分开**：`revoked_at` 绝不出现在 `save` 的 SET 列表里，
    // 否则一次并发的 `pending -> completed` 写回就能把撤销事实清空
    expect(POSTGRES_EXPORT_MUTABLE_COLUMNS).not.toContain('revoked_at');
    expect(
      [...new Set([...POSTGRES_EXPORT_MUTABLE_COLUMNS, ...POSTGRES_EXPORT_REVOKE_COLUMNS])].sort(),
    ).toEqual(['artifact_id', 'revoked_at', 'status', 'updated_at']);
  });

  it('PII 与公开输出裁剪列覆盖归属、产物句柄、服务端有效期、撤销时刻与全部内部列，且不含公开视图字段', () => {
    expect([...POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS]).toEqual([
      'requester_id',
      'artifact_id',
      'expires_at',
      'revoked_at',
      ...POSTGRES_EXPORT_INTERNAL_COLUMNS,
    ]);
    for (const column of [
      'requester_id',
      'artifact_id',
      'expires_at',
      'revoked_at',
      ...POSTGRES_EXPORT_INTERNAL_COLUMNS,
    ]) {
      expect(POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS).toContain(column);
    }
    // 有效期是本切片新引入的「不进公开视图」的列：它必须在裁剪清单里，
    // 否则「顺手把 expiresAt 加进公开视图」就不会被模块加载期自检拦下
    expect(POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS).toContain('expires_at');
    // 撤销时刻同理：公开视图只把 status 呈现为 `revoked`，**不外发**撤销时刻本身
    expect(POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS).toContain('revoked_at');
    for (const column of [
      'requester_id',
      'expires_at',
      'revoked_at',
      'file_name',
      'file_path',
      'download_url',
      'signed_url',
      'storage_key',
      'object_key',
      'artifact_handle',
      'content',
      'resource_snapshot',
      'filters',
      'error_message',
      'failure_reason',
      'stack_trace',
    ]) {
      expect(POSTGRES_EXPORT_PII_COLUMNS).toContain(column);
    }
    // 高敏声明必须覆盖**全部**内部列（fail-closed：凡不进入公开视图的列一律按高敏处理）
    for (const column of [
      'requester_id',
      'expires_at',
      'revoked_at',
      ...POSTGRES_EXPORT_INTERNAL_COLUMNS,
    ]) {
      expect(POSTGRES_EXPORT_PII_COLUMNS).toContain(column);
    }
    // 高敏集合与公开视图字段零交集（公开字段绝不能被登记为高敏）
    for (const field of EXPORT_REQUEST_VIEW_FIELDS) {
      expect(POSTGRES_EXPORT_PII_COLUMNS).not.toContain(field);
    }
    // 高敏集合必须整体落在「不进入公开输出」的裁剪集合内（没有任何 PII 列会被投影出去）
    for (const column of POSTGRES_EXPORT_PII_COLUMNS) {
      expect(POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS).toContain(column);
    }
    // 公开视图字段一个都不在裁剪清单里
    for (const field of EXPORT_REQUEST_VIEW_FIELDS) {
      expect(POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS).not.toContain(field);
    }
  });

  it('表名与 db schema 边界一致：占位清单里的 export_jobs 已由迁移 0013 真实建出', () => {
    expect(POSTGRES_EXPORT_TABLE).toBe('export_jobs');
    const bootstrap = readFileSync(
      join(REPO_ROOT, 'db', 'migrations', '0001_bootstrap.sql'),
      'utf8',
    );
    // 0001 已应用且不可改写（校验和）：它只把 export_jobs 登记在业务表**占位清单**注释里
    expect(bootstrap).toContain('export_jobs');
    expect(bootstrap).not.toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?export_jobs/iu);

    // 表由**迁移 0013** 建出（本切片直接按迁移规范落成，不再需要 schema 草案这一中间物）
    const migration = readFileSync(
      join(REPO_ROOT, 'db', 'migrations', '0013_export_jobs.sql'),
      'utf8',
    );
    expect(migration).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+export_jobs\s*\(/u);
    // 迁移的列清单必须覆盖 adapter 的**每一个**输出列（少了任何一列，读取路径立刻 fail-closed）。
    // 两个例外是服务端有效期 `expires_at` 与服务端撤销时刻 `revoked_at`：0013 已应用且校验和
    // 钉住、不可改写，因此它们分别由**后续迁移 0015 / 0016** 补出
    // （迁移不可改写 ⇒ 加列必须新增迁移，而不是回头改 0013）。
    for (const column of POSTGRES_EXPORT_COLUMNS) {
      if (column === 'expires_at' || column === 'revoked_at') continue;
      expect(migration).toMatch(
        new RegExp(`^\\s+${column}\\s+(?:uuid|varchar|text|timestamptz)`, 'mu'),
      );
    }
    // 0013 里 `expires_at` / `revoked_at` 只允许出现在「刻意不建」的说明注释里，不得是真实列定义
    expect(migration).not.toMatch(/^\s+expires_at\s+(?:uuid|varchar|text|timestamptz)/mu);
    expect(migration).not.toMatch(/^\s+revoked_at\s+(?:uuid|varchar|text|timestamptz)/mu);
    // 0015 必须真的把有效期列加出来（不是只在注释里声明），且列类型是 timestamptz（绝对时刻）
    const expiryMigration = readFileSync(
      join(REPO_ROOT, 'db', 'migrations', '0015_export_jobs_expiry.sql'),
      'utf8',
    );
    expect(expiryMigration).toMatch(/ALTER\s+TABLE\s+export_jobs\b/iu);
    expect(expiryMigration).toMatch(/expires_at\s+timestamptz/iu);
    expect(expiryMigration).not.toMatch(/CREATE\s+TABLE\b/iu);
    expect(expiryMigration).not.toMatch(/^\s+revoked_at\s+(?:uuid|varchar|text|timestamptz)/mu);
    // 0016 必须真的把撤销列加出来（不是只在注释里声明），且列类型是 timestamptz（绝对时刻）；
    // 一条迁移只做一件事：加列 + 约束，不建表、不建索引
    const revocationMigration = readFileSync(
      join(REPO_ROOT, 'db', 'migrations', '0016_export_jobs_revocation.sql'),
      'utf8',
    );
    expect(revocationMigration).toMatch(/ALTER\s+TABLE\s+export_jobs\b/iu);
    expect(revocationMigration).toMatch(/revoked_at\s+timestamptz/iu);
    expect(revocationMigration).not.toMatch(/CREATE\s+TABLE\b/iu);
    expect(revocationMigration).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu);
    // 该列必须**可空且无 DEFAULT**（NULL = 未被撤销；撤销时刻只能由服务端写入）
    const addRevokedColumn = /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+revoked_at[^;]*/iu.exec(
      revocationMigration,
    )?.[0];
    expect(addRevokedColumn).toBeDefined();
    expect(addRevokedColumn).not.toMatch(/\bNOT\s+NULL\b/iu);
    expect(addRevokedColumn).not.toMatch(/\bDEFAULT\b/iu);
    // 存储侧内部列（产物位置 / 文件路径 / 下载与签名地址 / 存储 key / 文件体 / 原始错误 / 簿记）
    // 一律不得被声明成真实列——它们只允许出现在「刻意不建」的说明注释里
    for (const column of POSTGRES_EXPORT_INTERNAL_COLUMNS) {
      expect(migration).not.toMatch(
        new RegExp(`^\\s+${column}\\s+(?:uuid|varchar|text|timestamptz)`, 'mu'),
      );
      expect(expiryMigration).not.toMatch(
        new RegExp(`^\\s+${column}\\s+(?:uuid|varchar|text|timestamptz)`, 'mu'),
      );
      expect(revocationMigration).not.toMatch(
        new RegExp(`^\\s+${column}\\s+(?:uuid|varchar|text|timestamptz)`, 'mu'),
      );
    }

    // 草案目录不参与：迁移已定稿，草案里不得再出现 export_jobs（避免同一张表两份真相）
    const draftDir = join(REPO_ROOT, 'db', 'schema-drafts');
    const drafts = readdirSync(draftDir).filter((entry) => entry.endsWith('.draft.sql'));
    const draftContents = drafts
      .map((entry) => readFileSync(join(draftDir, entry), 'utf8'))
      .join('\n');
    expect(draftContents).not.toContain('export_jobs');

    // 建表语句**只有一份**：不能既在 0013 建、又在别的迁移里重复建
    const creators = readdirSync(join(REPO_ROOT, 'db', 'migrations'))
      .filter((entry) => entry.endsWith('.sql'))
      .filter((entry) =>
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?export_jobs/iu.test(
          readFileSync(join(REPO_ROOT, 'db', 'migrations', entry), 'utf8'),
        ),
      );
    expect(creators).toEqual(['0013_export_jobs.sql']);
  });

  it('端口只保留一份异步契约（同步与异步已收敛），并保留后端标识与令牌', () => {
    const source = readFileSync(PORT_PATH, 'utf8');
    // 唯一一份契约：`ExportRepository` 本身就是异步契约
    expect(source).toContain('export interface ExportRepository {');
    expect(source).toContain('create(request: ExportRequest): Promise<ExportRequest>;');
    expect(source).toContain('save(request: ExportRequest): Promise<ExportRequest>;');
    expect(source).toContain(
      'listByOwnerId(ownerUserId: string): Promise<readonly ExportRequest[]>;',
    );
    // 历史名保留为**类型别名**（引用不必改名），但绝不允许再出现第二份接口
    expect(source).toContain('export type AsyncExportRepository = ExportRepository;');
    expect(source).not.toContain('export interface AsyncExportRepository {');
    // 同步签名必须彻底消失：收敛后不该残留任何一份「返回非 Promise」的契约
    for (const syncSignature of [
      'create(request: ExportRequest): ExportRequest;',
      'save(request: ExportRequest): ExportRequest;',
      'listByOwnerId(ownerUserId: string): readonly ExportRequest[];',
    ]) {
      expect(source).not.toContain(syncSignature);
    }
    expect(source).toContain('export const EXPORT_REPOSITORY_BACKEND_POSTGRES');
    expect(source).toContain('export const EXPORT_REPOSITORY_STORAGE_ID_DOMAIN');
    expect(source).toContain("export const EXPORT_REPOSITORY = Symbol('EXPORT_REPOSITORY');");
    // 端口上不存在任何删除 / 归档契约
    expect(source).not.toMatch(/\b(?:delete|remove|archive|purge|truncate)\s*\(/u);
  });

  it('adapter 声明实现了异步端口，且本切片不新增任何删除 / 归档 / 覆盖插入入口', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).toContain(`export class ${ADAPTER_CLASS} implements AsyncExportRepository`);
    const { repository } = repoWith();
    const surface = repository as unknown as Record<string, unknown>;
    for (const method of POSTGRES_EXPORT_FORBIDDEN_METHODS) {
      expect(surface[method]).toBeUndefined();
    }
    // 公开面必须有 create / save / listByOwnerId / listByOwnerIdPage / findByIdForOwner 五个方法，
    // 且都不返回同步值
    for (const method of [
      'create',
      'save',
      'listByOwnerId',
      'listByOwnerIdPage',
      'findByIdForOwner',
    ]) {
      expect(typeof surface[method]).toBe('function');
    }
  });
});

describe('PostgreSQL 导出仓储：执行器 fail-closed', () => {
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
        () => new PostgresExportRepository(executor as unknown as SqlExecutor),
      );
      expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
      expectNoValueLeak(error);
    }
  });

  it('执行器声明的后端不是 PostgreSQL → 拒绝（不得把 adapter 挂到其他存储上）', () => {
    for (const backend of ['sqlite', 'in-memory-baseline', 'mysql', 'sqlserver']) {
      const executor = new RecordingExecutor();
      executor.capabilities = { backend, persistent: true, productionReady: true };
      const error = captureSyncError(() => new PostgresExportRepository(executor));
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
    const error = captureSyncError(() => new PostgresExportRepository(executor));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
    expectNoValueLeak(error);
  });

  it('构造后执行器被降级为非持久 → 下一次调用 fail-closed，且不再访问 SQL', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 });
    executor.capabilities = {
      backend: 'postgres-test-double',
      persistent: false,
      productionReady: false,
    };
    const error = await captureRepoError(() => repository.listByOwnerId(OWNER));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
    expectNoValueLeak(error);
  });

  it('构造后能力声明被改写为「生产可用」→ 每次调用都 fail-closed（自检不被绕过）', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 });
    (repository as { capabilities: ExportRepositoryCapabilities }).capabilities = {
      backend: 'postgres',
      persistent: true,
      productionReady: true,
    };

    for (const run of [
      () => repository.create(PENDING_JOB),
      () => repository.save(COMPLETED_JOB),
      () => repository.listByOwnerId(OWNER),
    ]) {
      const error = await captureRepoError(run);
      expect(error.code).toBe('CAPABILITY_MISDECLARED');
      expect(error.message).toContain('不得声称生产可用');
    }
    // 自检发生在任何 SQL 之前
    expect(executor.calls).toHaveLength(0);
  });

  it('执行结果形状非法（非对象 / 缺 rows 数组）→ INVALID_ROW，不静默当成空结果', async () => {
    for (const response of [null, 'rows', { rowCount: 0 }, { rows: null }, { rows: {} }]) {
      const { repository } = repoWith(response);
      const error = await captureRepoError(() => repository.listByOwnerId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });
});

describe('PostgreSQL 导出仓储：参数化 SQL 与固定标识符', () => {
  it('创建 / 写回 / 取数三条语句都只由模块常量与 $n 占位符构成', async () => {
    const { repository, executor } = repoWith(
      { rows: [rowFromJob(PENDING_JOB)], rowCount: 1 },
      { rows: [rowFromJob(COMPLETED_JOB)], rowCount: 1 },
      { rows: [rowFromJob(PENDING_JOB)], rowCount: 1 },
    );
    await repository.create(PENDING_JOB);
    await repository.save(COMPLETED_JOB);
    await repository.listByOwnerId(OWNER);

    const statements = expectWriteAndReadOnlySql(executor);
    expect(statements).toHaveLength(3);
    for (const call of executor.calls) {
      expectParameterizedSql(call.sql);
      // 占位符数量 === 参数数量（占位符与参数由同一份列清单派生，不会数量漂移）
      expect(placeholderIndexes(call.sql)).toHaveLength(call.parameters?.length ?? 0);
    }
  });

  it('写入的值绝不进入 SQL 文本：归属、主键、资源、字段、时间戳只出现在参数里', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 });
    await repository.create(PENDING_JOB);

    const call = callAt(executor, 0);
    const sql = call?.sql ?? '';
    for (const value of [OWNER, JOB_ID, 'profile', 'college', 'major', CREATED_AT]) {
      expect(sql).not.toContain(value);
    }
    // 参数顺序由列清单派生：id, requester_id, resource, fields, status, artifact_id, expires_at,
    // revoked_at, created_at, updated_at（入口记录的撤销时刻恒为 NULL = 未被撤销）
    expect(call?.parameters).toEqual([
      JOB_ID,
      OWNER,
      'profile',
      ['college', 'major'],
      'pending',
      null,
      EXPIRES_AT,
      null,
      CREATED_AT,
      CREATED_AT,
    ]);
    expect(parameterAt(call, 'requester_id')).toBe(OWNER);
    expect(parameterAt(call, 'artifact_id')).toBeNull();
    expect(parameterAt(call, 'expires_at')).toBe(EXPIRES_AT);
    expect(parameterAt(call, 'revoked_at')).toBeNull();
    expect(parameterAt(call, 'created_at')).toBe(CREATED_AT);
  });

  it('写回参数由可变列清单派生：status / artifact_id / updated_at + 目标状态的前驱集合', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromJob(COMPLETED_JOB)], rowCount: 1 });
    await repository.save(COMPLETED_JOB);

    const call = callAt(executor, 0);
    expect(call?.parameters).toEqual([
      JOB_ID,
      OWNER,
      'completed',
      ARTIFACT_ID,
      LATER_AT,
      ['pending'],
    ]);
    const sql = call?.sql ?? '';
    for (const value of [OWNER, JOB_ID, ARTIFACT_ID, LATER_AT]) {
      expect(sql).not.toContain(value);
    }
  });

  it('SQL 文本里不出现任何存储侧内部列（既不 SELECT / RETURNING，也不进 SET 列表）', async () => {
    const { repository, executor } = repoWith(
      { rows: [rowFromJob(PENDING_JOB)], rowCount: 1 },
      { rows: [rowFromJob(COMPLETED_JOB)], rowCount: 1 },
      { rows: [rowFromJob(PENDING_JOB)], rowCount: 1 },
    );
    await repository.create(PENDING_JOB);
    await repository.save(COMPLETED_JOB);
    await repository.listByOwnerId(OWNER);

    for (const call of executor.calls) {
      for (const internal of POSTGRES_EXPORT_INTERNAL_COLUMNS) {
        expect(containsWord(call.sql, internal)).toBe(false);
      }
      // 归属、产物句柄、服务端有效期与撤销时刻是列清单内的裁剪列：
      // 可以出现在 SQL 里，但绝不能进入公开视图
      for (const excluded of POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS) {
        if (
          POSTGRES_EXPORT_COLUMNS.includes(excluded as (typeof POSTGRES_EXPORT_COLUMNS)[number])
        ) {
          continue;
        }
        expect(containsWord(call.sql, excluded)).toBe(false);
      }
    }
    expect(
      POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS.filter((column) =>
        POSTGRES_EXPORT_COLUMNS.includes(column as (typeof POSTGRES_EXPORT_COLUMNS)[number]),
      ),
    ).toEqual(['requester_id', 'artifact_id', 'expires_at', 'revoked_at']);
  });

  it('表名与列名都是裸小写标识符（杜绝用标识符夹带 SQL 片段）', () => {
    expect(POSTGRES_EXPORT_TABLE).toMatch(/^[a-z][a-z0-9_]*$/u);
    for (const column of POSTGRES_EXPORT_COLUMNS) {
      expect(column).toMatch(/^[a-z][a-z0-9_]*$/u);
    }
    for (const column of POSTGRES_EXPORT_INTERNAL_COLUMNS) {
      expect(column).toMatch(/^[a-z][a-z0-9_]*$/u);
    }
    // 内部列与列清单零交集：一旦重叠，内部列就会自动进入 SELECT / RETURNING / INSERT
    expect(findExportInternalColumnOverlaps()).toEqual([]);
    expect(() => assertExportInternalColumnsAbsent()).not.toThrow();
  });

  it('注入载荷只进参数或被拒绝：被拒绝的入口一个 SQL 都不执行', async () => {
    const injected: readonly Record<string, unknown>[] = [
      { ...PENDING_JOB, ownerUserId: INJECTION },
      { ...PENDING_JOB, id: INJECTION },
      { ...PENDING_JOB, resource: INJECTION },
      { ...PENDING_JOB, status: INJECTION },
      { ...PENDING_JOB, fields: ['college', INJECTION] },
      { ...PENDING_JOB, artifactId: INJECTION },
      { ...PENDING_JOB, requester_id: INJECTION },
      { ...PENDING_JOB, file_path: INJECTION },
      { ...PENDING_JOB, download_url: INJECTION },
    ];
    for (const record of injected) {
      const { repository, executor } = repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 });
      const error = await captureRepoError(() =>
        repository.create(record as unknown as ExportRequest),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }

    // 取数主体同样是拒绝路径（域外主体绝不绑定进 SQL）
    for (const subject of [INJECTION, 'u-student-1', NIL_UUID, HEX_OWNER_UPPER]) {
      const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
      const error = await captureRepoError(() => repository.listByOwnerId(subject));
      expect(error.code).toBe('INVALID_SUBJECT');
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
  });

  it('取数语句固定全序、不加本地截断，且归属谓词是唯一的主体入口', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 });
    await repository.listByOwnerId(OWNER);

    const sql = callAt(executor, 0)?.sql ?? '';
    expect(sql).toContain('WHERE requester_id = $1::uuid');
    // 全序是**毫秒粒度**的键集序：`date_trunc` 的字段名走参数（SQL 文本零引号），
    // 排序表达式与分页边界谓词共用同一份构造（见 adapter 的 orderByMillisecondKeyset）
    expect(sql).toContain('ORDER BY date_trunc($2::text, created_at) ASC, id ASC');
    expect(sql).not.toMatch(/\b(?:LIMIT|OFFSET|FETCH)\b/u);
    // 归属只出现在参数里；第二个参数是「毫秒截断字段」这一服务端常量（不是客户端输入）
    expect(callAt(executor, 0)?.parameters).toEqual([OWNER, POSTGRES_EXPORT_TRUNCATION_FIELD]);
  });

  it('创建语句是 ON CONFLICT (id) DO NOTHING（不静默覆盖），写回语句的 SET 不含身份与导出范围', async () => {
    const { repository, executor } = repoWith(
      { rows: [rowFromJob(PENDING_JOB)], rowCount: 1 },
      { rows: [rowFromJob(COMPLETED_JOB)], rowCount: 1 },
    );
    await repository.create(PENDING_JOB);
    await repository.save(COMPLETED_JOB);

    const insertSql = callAt(executor, 0)?.sql ?? '';
    expect(insertSql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(insertSql).not.toContain('DO UPDATE');

    const updateSql = callAt(executor, 1)?.sql ?? '';
    const setClause = updateSql.slice(updateSql.indexOf('SET'), updateSql.indexOf('WHERE'));
    for (const forbidden of [
      'id',
      'requester_id',
      'resource',
      'fields',
      'created_at',
      'expires_at',
      // 状态机写回**不得**触碰撤销时刻：它只能由 revokeForOwner 写入，且只增不减
      'revoked_at',
    ]) {
      expect(containsWord(setClause, forbidden)).toBe(false);
    }
    // WHERE 必须同时钉住主键、归属与合法前驱谓词
    expect(updateSql).toContain('WHERE id = $1::uuid AND requester_id = $2::uuid');
    expect(updateSql).toContain('status::text = ANY($6::text[])');
  });
});

describe('PostgreSQL 导出仓储：严格行契约与未知列', () => {
  it('未登记列（产物位置 / 内部资源内容 / 原始错误 / 簿记）一律 fail-closed 且不回显取值', async () => {
    for (const internal of POSTGRES_EXPORT_INTERNAL_COLUMNS) {
      const { repository } = repoWith({
        rows: [rowFromJob(COMPLETED_JOB, { [internal]: FORGED_PATH })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByOwnerId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, internal);
      expectNoValueLeak(error);
    }
  });

  it('写路径夹带的 snake_case 别名与权限字段一律 INVALID_RECORD（拒绝而不是静默剥离）', async () => {
    for (const field of [
      'requester_id',
      'owner_user_id',
      'user_id',
      'artifact_id',
      'filePath',
      'file_path',
      'downloadUrl',
      'storageKey',
      'roles',
      'scope',
      'groupId',
      'expires_at',
      'deletedAt',
      'idempotencyKey',
    ]) {
      const { repository, executor } = repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 });
      const error = await captureRepoError(() =>
        repository.create({ ...PENDING_JOB, [field]: 'x' } as unknown as ExportRequest),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expectIssueOn(error, field);
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
  });

  it('缺列同样 fail-closed（PG 对 SELECT 列表中的列一定返回键，缺键说明驱动或 SQL 被改动）', async () => {
    for (const column of POSTGRES_EXPORT_COLUMNS) {
      const { repository } = repoWith({
        rows: [withoutRowColumn(COMPLETED_JOB, column)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByOwnerId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, column);
      expectNoValueLeak(error);
    }
  });

  it('未知 resource / 未知 status 取值 → INVALID_ROW（闭集外一律不当作合法值外发）', async () => {
    for (const overrides of [
      { resource: 'system_configs' },
      { resource: INJECTION },
      { status: 'archived' },
      { status: 'cancelled' },
      { status: INJECTION },
    ]) {
      const { repository } = repoWith({
        rows: [rowFromJob(COMPLETED_JOB, overrides)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByOwnerId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });

  it('坏时间戳不被静默归一（只接受 Date 或 ISO datetime 字符串）', async () => {
    for (const overrides of [
      { created_at: '2026/01/05' },
      { created_at: 'not-a-date' },
      { created_at: 1767323045000 },
      { created_at: null },
      { updated_at: '2026-13-45T99:99:99.000Z' },
      { updated_at: new Date(Number.NaN) },
      { updated_at: {} },
      // 服务端有效期同样只接受 Date / ISO datetime：**非法形态 fail-closed**，
      // 但「缺省」是合法的（见下一条用例），两者必须被区分对待
      { expires_at: '2026/01/05' },
      { expires_at: 'not-a-date' },
      { expires_at: 1767323045000 },
      { expires_at: '' },
      { expires_at: {} },
      { expires_at: new Date(Number.NaN) },
    ]) {
      const { repository } = repoWith({
        rows: [rowFromJob(COMPLETED_JOB, overrides)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByOwnerId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });

  it('服务端有效期：非空可往返、NULL 映射为字段缺省（fail-closed 而不是行契约违规）', async () => {
    // 1) 非空：仍然走严格时间契约，且映射回领域层时是**同一个** UTC ISO 形态（写入侧同形）
    const withExpiry = repoWith({ rows: [rowFromJob(COMPLETED_JOB)], rowCount: 1 });
    await expect(withExpiry.repository.listByOwnerId(OWNER)).resolves.toEqual([COMPLETED_JOB]);

    // 2) NULL：映射为「没有 expiresAt」，**不是** INVALID_ROW。
    //    理由是安全属性：NULL 必须由下载边界统一 fail-closed（与「不存在 / 跨主体 / 未完成 /
    //    产物缺失」同一 404），若在这里判成 500，「这条记录存在但缺有效期」就被外发出来了。
    const withoutExpiry = repoWith({
      rows: [rowFromJob(COMPLETED_JOB, { expires_at: null })],
      rowCount: 1,
    });
    const records = await withoutExpiry.repository.listByOwnerId(OWNER);
    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty('expiresAt');
    expect(Object.keys(records[0] ?? {}).sort()).toEqual(
      [
        'artifactId',
        'createdAt',
        'fields',
        'id',
        'ownerUserId',
        'resource',
        'status',
        'updatedAt',
      ].sort(),
    );

    // 3) 缺省字段写入 ⇒ 参数是 NULL（**列仍然出现在 INSERT 里**，绝不因为缺省就省略列，
    //    否则参数与占位符会错位），返回行也不带 expiresAt（往返一致）
    const entry = { ...PENDING_JOB } as Record<string, unknown>;
    delete entry['expiresAt'];
    const created = repoWith({
      rows: [rowFromJob(entry as unknown as ExportRequest)],
      rowCount: 1,
    });
    const written = await created.repository.create(entry as unknown as ExportRequest);
    expect(written).not.toHaveProperty('expiresAt');
    expect(parameterAt(callAt(created.executor, 0), 'expires_at')).toBeNull();
  });

  it('写回路径不得改写服务端有效期：返回行被旁路改写成别的有效期 ⇒ IDENTITY_MISMATCH', async () => {
    // 写回语句的 SET 里没有 expires_at（不可变列），因此存储层返回的值必须与请求记录逐字节一致。
    // 若存储被旁路改写（触发器 / SQL 被替换），这里必须 fail-closed —— 否则「把已过期的交付物
    // 续期回可下载状态」会成为一条静默可达的路径。
    const tampered = repoWith({
      rows: [rowFromJob(COMPLETED_JOB, { expires_at: new Date('2027-01-01T00:00:00.000Z') })],
      rowCount: 1,
    });
    const error = await captureRepoError(() => tampered.repository.save(COMPLETED_JOB));
    expect(error.code).toBe('IDENTITY_MISMATCH');
    expectIssueOn(error, 'expires_at');
    expectNoValueLeak(error);
    // 反向：有效期被**清空**（NULL）同样是改写，不得被当作「记为缺失」而放行
    const cleared = repoWith({
      rows: [rowFromJob(COMPLETED_JOB, { expires_at: null })],
      rowCount: 1,
    });
    const clearedError = await captureRepoError(() => cleared.repository.save(COMPLETED_JOB));
    expect(clearedError.code).toBe('IDENTITY_MISMATCH');
    expectIssueOn(clearedError, 'expires_at');
    expectNoValueLeak(clearedError);
  });

  it('行内的存储标识必须落在存储 ID 域（规范小写、非空 UUID）', async () => {
    for (const overrides of [
      { id: 'u-student-1' },
      { id: NIL_UUID },
      { id: HEX_JOB_ID_UPPER },
      { requester_id: 'u-student-1' },
      { requester_id: NIL_UUID },
      { requester_id: HEX_OWNER_UPPER },
      { requester_id: HEX_OWNER_MIXED },
      { artifact_id: 'not-a-uuid' },
      { artifact_id: NIL_UUID },
      { artifact_id: HEX_ARTIFACT_ID_UPPER },
    ]) {
      const { repository } = repoWith({
        rows: [rowFromJob(COMPLETED_JOB, overrides)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByOwnerId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });

  it('字段列表非法形状（非数组 / 空 / 超量 / 元素非法 / 含 PII）→ fail-closed', async () => {
    const cases: readonly unknown[] = [
      'college',
      [],
      Array.from({ length: 14 }, (_value, index) => `field${index}`),
      [42],
      [''],
      [PII_FIELD],
      ['college', PII_FIELD],
      ['college', 'college'],
      ['year'],
      [FORGED_PATH],
      [FORGED_URL],
    ];
    for (const fields of cases) {
      const { repository } = repoWith({
        rows: [rowFromJob(COMPLETED_JOB, { fields })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByOwnerId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });

  it('状态与产物句柄不自洽（completed 无句柄 / 非 completed 带句柄）→ INVALID_ROW', async () => {
    for (const overrides of [
      { status: 'completed', artifact_id: null },
      { status: 'failed', artifact_id: ARTIFACT_ID },
      { status: 'pending', artifact_id: ARTIFACT_ID },
    ]) {
      const { repository } = repoWith({
        rows: [rowFromJob(COMPLETED_JOB, overrides)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByOwnerId(OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, 'artifactId');
      expectNoValueLeak(error);
    }
  });

  it('写入记录缺必填字段 / 非对象 / 数组 → INVALID_RECORD，且不访问数据库', async () => {
    const cases: readonly unknown[] = [
      undefined,
      null,
      [],
      'export',
      omitField(PENDING_JOB, 'id'),
      omitField(PENDING_JOB, 'ownerUserId'),
      omitField(PENDING_JOB, 'resource'),
      omitField(PENDING_JOB, 'fields'),
      omitField(PENDING_JOB, 'status'),
      omitField(PENDING_JOB, 'createdAt'),
      omitField(PENDING_JOB, 'updatedAt'),
    ];
    for (const record of cases) {
      const { repository, executor } = repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 });
      const error = await captureRepoError(() =>
        repository.create(record as unknown as ExportRequest),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
  });

  it('写入记录含非法枚举 / 白名单外字段 / 非规范小写标识 → INVALID_RECORD', async () => {
    const cases: readonly unknown[] = [
      { ...PENDING_JOB, resource: 'system_configs' },
      { ...PENDING_JOB, status: 'archived' },
      { ...PENDING_JOB, fields: ['year'] },
      { ...PENDING_JOB, fields: ['college', 'college'] },
      { ...PENDING_JOB, fields: [PII_FIELD] },
      { ...PENDING_JOB, ownerUserId: HEX_OWNER_UPPER },
      { ...PENDING_JOB, ownerUserId: HEX_OWNER_MIXED },
      { ...PENDING_JOB, ownerUserId: NIL_UUID },
      { ...PENDING_JOB, ownerUserId: 'u-student-1' },
      { ...PENDING_JOB, id: HEX_JOB_ID_UPPER },
      { ...PENDING_JOB, id: NIL_UUID },
      { ...PENDING_JOB, createdAt: '2026/01/05' },
      { ...PENDING_JOB, updatedAt: 'yesterday' },
    ];
    for (const record of cases) {
      const { repository, executor } = repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 });
      const error = await captureRepoError(() =>
        repository.create(record as unknown as ExportRequest),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
  });

  it('创建 / 写回 / 取数返回多行或重复主键 → RESULT_SET_VIOLATION', async () => {
    const duplicated = repoWith({
      rows: [rowFromJob(PENDING_JOB), rowFromJob(PENDING_JOB)],
      rowCount: 2,
    });
    expect((await captureRepoError(() => duplicated.repository.create(PENDING_JOB))).code).toBe(
      'RESULT_SET_VIOLATION',
    );

    const duplicatedSave = repoWith({
      rows: [rowFromJob(COMPLETED_JOB), rowFromJob(COMPLETED_JOB)],
      rowCount: 2,
    });
    expect((await captureRepoError(() => duplicatedSave.repository.save(COMPLETED_JOB))).code).toBe(
      'RESULT_SET_VIOLATION',
    );

    const duplicatedList = repoWith({
      rows: [rowFromJob(PENDING_JOB), rowFromJob(PENDING_JOB)],
      rowCount: 2,
    });
    expect(
      (await captureRepoError(() => duplicatedList.repository.listByOwnerId(OWNER))).code,
    ).toBe('RESULT_SET_VIOLATION');

    // 两条不同主键但同时回流「他人记录」时，归属复核同样 fail-closed
    const foreign = repoWith({
      rows: [rowFromJob(PENDING_JOB), rowFromJob(OTHER_OWNER_JOB)],
      rowCount: 2,
    });
    expect((await captureRepoError(() => foreign.repository.listByOwnerId(OWNER))).code).toBe(
      'OWNER_VIOLATION',
    );
  });
});

describe('PostgreSQL 导出仓储：subject owner 隔离与状态机', () => {
  it('创建入口记录成功：状态恒为 pending、无产物句柄，返回记录与写入逐字段一致', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 });
    await expect(repository.create(PENDING_JOB)).resolves.toEqual(PENDING_JOB);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.sql).toContain('INSERT INTO export_jobs');
  });

  it('创建路径拒绝「创建即终态」：completed / failed 一律 INVALID_RECORD 且零 SQL', async () => {
    for (const record of [COMPLETED_JOB, FAILED_JOB]) {
      const { repository, executor } = repoWith({ rows: [rowFromJob(record)], rowCount: 1 });
      const error = await captureRepoError(() => repository.create(record));
      expect(error.code).toBe('INVALID_RECORD');
      expectIssueOn(error, 'status');
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
    expect(EXPORT_ENTRY_STATUS).toBe('pending');
  });

  it('创建主键冲突（0 行）→ CONFLICT，不静默覆盖既有导出请求', async () => {
    const { repository } = repoWith({ rows: [], rowCount: 0 });
    const error = await captureRepoError(() => repository.create(PENDING_JOB));
    expect(error.code).toBe('CONFLICT');
    expectIssueOn(error, 'id');
    expectNoValueLeak(error);
  });

  it('写入回流被改写时逐列 fail-closed：主键 / 归属 / 资源 / 字段 / 状态 / 句柄 / 时间戳', async () => {
    const cases: readonly (readonly [Record<string, unknown>, string, string])[] = [
      [{ id: OTHER_JOB_ID }, 'IDENTITY_MISMATCH', 'id'],
      [{ requester_id: OTHER_OWNER }, 'OWNER_VIOLATION', 'requester_id'],
      [{ fields: ['college'] }, 'IDENTITY_MISMATCH', 'fields'],
      [{ fields: ['major', 'college'] }, 'IDENTITY_MISMATCH', 'fields'],
      [{ created_at: new Date(LATER_AT) }, 'IDENTITY_MISMATCH', 'created_at'],
      [{ updated_at: new Date(LATER_AT) }, 'IDENTITY_MISMATCH', 'updated_at'],
    ];
    for (const [overrides, code, issue] of cases) {
      const { repository } = repoWith({ rows: [rowFromJob(PENDING_JOB, overrides)], rowCount: 1 });
      const error = await captureRepoError(() => repository.create(PENDING_JOB));
      expect(error.code).toBe(code);
      expectIssueOn(error, issue);
      expectNoValueLeak(error);
    }

    // 资源被改写：用 profile / education 白名单**共有**的字段，避免先被读取契约拦下
    const sharedFieldJob: ExportRequest = { ...PENDING_JOB, fields: ['createdAt', 'updatedAt'] };
    const tamperedResource = repoWith({
      rows: [rowFromJob(sharedFieldJob, { resource: 'education' })],
      rowCount: 1,
    });
    const resourceError = await captureRepoError(() =>
      tamperedResource.repository.create(sharedFieldJob),
    );
    expect(resourceError.code).toBe('IDENTITY_MISMATCH');
    expectIssueOn(resourceError, 'resource');
    expectNoValueLeak(resourceError);

    // 创建回流的 status 被改写（completed 必带句柄，否则先被读取契约拦下）
    const tamperedStatus = repoWith({
      rows: [rowFromJob(PENDING_JOB, { status: 'completed', artifact_id: ARTIFACT_ID })],
      rowCount: 1,
    });
    const statusError = await captureRepoError(() => tamperedStatus.repository.create(PENDING_JOB));
    expect(statusError.code).toBe('IDENTITY_MISMATCH');
    expectIssueOn(statusError, 'status');
    expectNoValueLeak(statusError);
  });

  it('写回回流被改写时 fail-closed：句柄被换 / 归属被换', async () => {
    const tamperedArtifact = repoWith({
      rows: [rowFromJob(COMPLETED_JOB, { artifact_id: ARTIFACT_ID_OTHER })],
      rowCount: 1,
    });
    const artifactError = await captureRepoError(() =>
      tamperedArtifact.repository.save(COMPLETED_JOB),
    );
    expect(artifactError.code).toBe('IDENTITY_MISMATCH');
    expectIssueOn(artifactError, 'artifact_id');
    expectNoValueLeak(artifactError);

    const foreign = repoWith({
      rows: [rowFromJob(COMPLETED_JOB, { requester_id: OTHER_OWNER })],
      rowCount: 1,
    });
    const ownerError = await captureRepoError(() => foreign.repository.save(COMPLETED_JOB));
    expect(ownerError.code).toBe('OWNER_VIOLATION');
    expectIssueOn(ownerError, 'requester_id');
    expectNoValueLeak(ownerError);
  });

  it('合法转移 pending -> completed / pending -> failed 都能写回（含产物句柄语义）', async () => {
    for (const target of [COMPLETED_JOB, FAILED_JOB]) {
      const { repository, executor } = repoWith({ rows: [rowFromJob(target)], rowCount: 1 });
      await expect(repository.save(target)).resolves.toEqual(target);
      expect(executor.calls).toHaveLength(1);
      const call = callAt(executor, 0);
      expect(call?.parameters?.[2]).toBe(target.status);
      expect(call?.parameters?.[3]).toBe(target.artifactId ?? null);
      expect(call?.parameters?.[5]).toEqual(['pending']);
    }
  });

  it('目标状态没有任何合法前驱（回写入口状态 pending）→ TRANSITION_REJECTED 且零 SQL', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 });
    const error = await captureRepoError(() => repository.save(PENDING_JOB));
    expect(error.code).toBe('TRANSITION_REJECTED');
    // 拒绝带**端口级并发冲突标记**：service 按它映射 409，不靠错误消息猜类型
    expect(error.code).toBe(EXPORT_TRANSITION_REJECTED);
    expect(isExportTransitionRejection(error)).toBe(true);
    expectIssueOn(error, 'status');
    expect(executor.calls).toHaveLength(0);
    expectNoValueLeak(error);
  });

  it('条件写入 0 行且归属范围内诊断无行 → NOT_FOUND（不外泄「该 ID 属于他人」）', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });
    const error = await captureRepoError(() => repository.save(COMPLETED_JOB));
    expect(error.code).toBe('NOT_FOUND');
    expectIssueOn(error, 'id');
    expect(executor.calls).toHaveLength(2);
    // 诊断查询同样被 id + 归属双重限定，且只取 status 一列
    const diagnosticSql = callAt(executor, 1)?.sql ?? '';
    expect(diagnosticSql).toContain('WHERE id = $1::uuid AND requester_id = $2::uuid');
    expect(containsWord(diagnosticSql, 'status')).toBe(true);
    for (const internal of POSTGRES_EXPORT_INTERNAL_COLUMNS) {
      expect(containsWord(diagnosticSql, internal)).toBe(false);
    }
    expect(callAt(executor, 1)?.parameters).toEqual([JOB_ID, OWNER]);
    expectNoValueLeak(error);
  });

  it('条件写入 0 行但诊断有行（已到终态 / 被并发推进）→ TRANSITION_REJECTED，且不产生第二次写', async () => {
    const { repository, executor } = repoWith(
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'completed' }], rowCount: 1 },
    );
    const error = await captureRepoError(() => repository.save(FAILED_JOB));
    expect(error.code).toBe('TRANSITION_REJECTED');
    expect(isExportTransitionRejection(error)).toBe(true);
    expectIssueOn(error, 'status');
    expect(executor.calls).toHaveLength(2);
    const writes = executor.calls.filter((call) => /\b(?:INSERT|UPDATE)\b/u.test(call.sql));
    expect(writes).toHaveLength(1);
    expectNoValueLeak(error);
  });

  it('端口级并发冲突标记只认 TRANSITION_REJECTED：服务端缺陷与执行器故障不得被误判为 409', async () => {
    // 正例：adapter 的两条拒绝路径都满足端口标记
    expect(EXPORT_TRANSITION_REJECTED).toBe('TRANSITION_REJECTED');
    const rejected = await captureRepoError(() =>
      repoWith({ rows: [], rowCount: 0 }).repository.save(PENDING_JOB),
    );
    expect(isExportTransitionRejection(rejected)).toBe(true);

    // 反例：其它失败码仍是服务端缺陷 / 基础设施故障，必须继续 fail-closed（由 service 边界抛 500）
    const others = [
      await captureRepoError(() =>
        repoWith({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }).repository.save(
          COMPLETED_JOB,
        ),
      ),
      await captureRepoError(() =>
        repoWith({
          rows: [rowFromJob(COMPLETED_JOB, { requester_id: OTHER_OWNER })],
          rowCount: 1,
        }).repository.save(COMPLETED_JOB),
      ),
      await captureRepoError(() =>
        new PostgresExportRepository(new ThrowingExecutor(new Error('boom'))).save(COMPLETED_JOB),
      ),
    ];
    for (const other of others) {
      expect(other).toBeInstanceOf(PostgresExportRepositoryError);
      expect(isExportTransitionRejection(other)).toBe(false);
    }
    // 非错误值与非 Error 抛出物同样不满足标记（判定不靠错误名、不解析消息）
    for (const value of [{ code: 'TRANSITION_REJECTED' }, null, undefined, 'TRANSITION_REJECTED']) {
      expect(isExportTransitionRejection(value)).toBe(false);
    }
    // 伪造同名字段的消息文本不能把普通异常变成 409
    const plain = new Error('非法状态转移 TRANSITION_REJECTED');
    expect(isExportTransitionRejection(plain)).toBe(false);
  });

  it('诊断查询返回多行 / 未知状态 / 额外列 → fail-closed', async () => {
    const multi = repoWith(
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'pending' }, { status: 'pending' }], rowCount: 2 },
    );
    expect((await captureRepoError(() => multi.repository.save(COMPLETED_JOB))).code).toBe(
      'RESULT_SET_VIOLATION',
    );

    for (const row of [{ status: 'archived' }, { status: 'pending', reason: 'x' }, {}]) {
      const { repository } = repoWith({ rows: [], rowCount: 0 }, { rows: [row], rowCount: 1 });
      const error = await captureRepoError(() => repository.save(COMPLETED_JOB));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });

  it('状态机前驱由状态机逆映射派生（不另写一份转移表）', () => {
    expect([...exportStatusPredecessors(ExportStatus.Completed)]).toEqual([ExportStatus.Pending]);
    expect([...exportStatusPredecessors(ExportStatus.Failed)]).toEqual([ExportStatus.Pending]);
    expect([...exportStatusPredecessors(ExportStatus.Pending)]).toEqual([]);

    // 与状态机函数逐项一致：前驱集合恰好等于「能从 from 走到 status」的 from 集合
    for (const from of EXPORT_STATUS_VALUES) {
      for (const to of EXPORT_STATUS_VALUES) {
        const isPredecessor = exportStatusPredecessors(to).includes(from);
        expect(isPredecessor).toBe(canTransitionExport(from, to));
      }
    }
  });

  it('取数只按服务端主体下推：他人记录回流一律 OWNER_VIOLATION，重复主键判结果集违约', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromJob(OTHER_OWNER_JOB)], rowCount: 1 });
    const error = await captureRepoError(() => repository.listByOwnerId(OWNER));
    expect(error.code).toBe('OWNER_VIOLATION');
    expectIssueOn(error, 'requester_id');
    expect(executor.calls).toHaveLength(1);
    expectNoValueLeak(error);
  });

  it('无记录返回空数组（不是 undefined、不抛错）；本人记录按 SQL 全序返回', async () => {
    const empty = repoWith({ rows: [], rowCount: 0 });
    await expect(empty.repository.listByOwnerId(OWNER)).resolves.toEqual([]);

    const second: ExportRequest = { ...COMPLETED_JOB, id: OTHER_JOB_ID };
    const { repository } = repoWith({
      rows: [rowFromJob(PENDING_JOB), rowFromJob(second)],
      rowCount: 2,
    });
    await expect(repository.listByOwnerId(OWNER)).resolves.toEqual([PENDING_JOB, second]);
  });

  it('创建与写回都不改写归属：写入参数里的归属恒等于服务端主体', async () => {
    const { repository, executor } = repoWith(
      { rows: [rowFromJob(PENDING_JOB)], rowCount: 1 },
      { rows: [rowFromJob(COMPLETED_JOB)], rowCount: 1 },
    );
    await repository.create(PENDING_JOB);
    await repository.save(COMPLETED_JOB);

    expect(parameterAt(callAt(executor, 0), 'requester_id')).toBe(OWNER);
    expect(callAt(executor, 1)?.parameters?.[1]).toBe(OWNER);
    // 两条语句都不含任何「按客户端提交的归属取数 / 写数」的替代路径
    for (const call of executor.calls) {
      expect(call.sql).not.toContain('OR requester_id');
    }
  });

  it('闭集取值全部可往返（本 adapter 不臆造额外收紧）', async () => {
    for (const resource of EXPORT_RESOURCE_VALUES) {
      const entry: ExportRequest = {
        ...PENDING_JOB,
        resource,
        fields: [...EXPORTABLE_FIELDS[resource]],
      };
      const { repository } = repoWith(
        { rows: [rowFromJob(entry)], rowCount: 1 },
        { rows: [rowFromJob(entry)], rowCount: 1 },
      );
      await expect(repository.create(entry)).resolves.toEqual(entry);
      await expect(repository.listByOwnerId(OWNER)).resolves.toEqual([entry]);
    }

    for (const status of EXPORT_STATUS_VALUES) {
      if (status === ExportStatus.Pending) continue;
      const target: ExportRequest = {
        ...PENDING_JOB,
        status,
        ...(status === ExportStatus.Completed ? { artifactId: ARTIFACT_ID } : {}),
        updatedAt: LATER_AT,
      };
      const { repository } = repoWith({ rows: [rowFromJob(target)], rowCount: 1 });
      await expect(repository.save(target)).resolves.toEqual(target);
    }
  });

  it('规范小写形（含十六进制字母）的标识可往返，大写 / 混合形一律拒绝', async () => {
    const hexJob: ExportRequest = {
      ...COMPLETED_JOB,
      id: HEX_JOB_ID,
      ownerUserId: HEX_OWNER,
      artifactId: HEX_ARTIFACT_ID,
    };
    const { repository, executor } = repoWith({ rows: [rowFromJob(hexJob)], rowCount: 1 });
    await expect(repository.save(hexJob)).resolves.toEqual(hexJob);
    expect(callAt(executor, 0)?.parameters).toEqual([
      HEX_JOB_ID,
      HEX_OWNER,
      'completed',
      HEX_ARTIFACT_ID,
      LATER_AT,
      ['pending'],
    ]);

    for (const overrides of [
      { id: HEX_JOB_ID_UPPER },
      { requester_id: HEX_OWNER_UPPER },
      { artifact_id: HEX_ARTIFACT_ID_UPPER },
    ]) {
      const rejected = repoWith({ rows: [rowFromJob(hexJob, overrides)], rowCount: 1 });
      const error = await captureRepoError(() => rejected.repository.save(hexJob));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });
});

describe('PostgreSQL 导出仓储：公开视图与失败路径信息卫生', () => {
  it('存储记录承载归属与产物句柄（不静默丢弃），但公开视图恰好是白名单闭集', () => {
    const parsed = parseStoredExportRequest(COMPLETED_JOB);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.ownerUserId).toBe(OWNER);
    expect(parsed.value.artifactId).toBe(ARTIFACT_ID);

    expect([...EXPORT_REQUEST_VIEW_FIELDS]).toEqual([
      'id',
      'resource',
      'fields',
      'status',
      'createdAt',
      'updatedAt',
    ]);
    const view = toExportRequestView(parsed.value);
    expect(Object.keys(view).sort()).toEqual([...EXPORT_REQUEST_VIEW_FIELDS].sort());
    for (const forbidden of [
      'ownerUserId',
      'userId',
      'requesterId',
      'artifactId',
      'artifactHandle',
      'fileName',
      'filePath',
      'downloadUrl',
      'signedUrl',
      'url',
      'storageKey',
      'objectKey',
      'content',
      'checksum',
      'resourceId',
      'resourceSnapshot',
      'filters',
      'errorMessage',
      'failureReason',
      'stackTrace',
      'expiresAt',
      'downloadedAt',
      'deletedAt',
      'idempotencyKey',
    ]) {
      expect(Object.keys(view)).not.toContain(forbidden);
      expect(JSON.stringify(view)).not.toContain(forbidden);
    }
  });

  it('裁剪清单与公开视图白名单无交集：模块加载期自检对真实白名单放行、对泄漏白名单 fail-closed', () => {
    expect(findExportViewExclusionLeaks(EXPORT_REQUEST_VIEW_FIELDS)).toEqual([]);
    expect(() => assertExportViewExclusion(EXPORT_REQUEST_VIEW_FIELDS)).not.toThrow();

    // 逐项探针：列名本身或其驼峰形一旦出现在视图白名单里，必须被判为泄漏
    for (const column of POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS) {
      for (const candidate of [column, camelCase(column)]) {
        const leaked = [...EXPORT_REQUEST_VIEW_FIELDS, candidate];
        expect(findExportViewExclusionLeaks(leaked)).toContain(candidate);

        const error = captureSyncError(() => assertExportViewExclusion(leaked));
        expect(error.code).toBe('CAPABILITY_MISDECLARED');
        expect(error.issues).toContain(candidate);
        expectNoValueLeak(error);
      }
    }
    // 字段名方向的探针（requester_id → ownerUserId 等）
    for (const field of ['ownerUserId', 'artifactId', 'filePath', 'storageKey', 'errorMessage']) {
      const leaked = [...EXPORT_REQUEST_VIEW_FIELDS, field];
      expect(findExportViewExclusionLeaks(leaked)).toContain(field);
      expect(() => assertExportViewExclusion(leaked)).toThrow(PostgresExportRepositoryError);
    }
  });

  it('内部列与列清单零交集：探针一旦重叠即 fail-closed', () => {
    expect(findExportInternalColumnOverlaps()).toEqual([]);
    expect(() => assertExportInternalColumnsAbsent()).not.toThrow();

    for (const internal of POSTGRES_EXPORT_INTERNAL_COLUMNS) {
      const overlapped = [...POSTGRES_EXPORT_COLUMNS, internal];
      expect(findExportInternalColumnOverlaps(overlapped)).toContain(internal);

      const error = captureSyncError(() => assertExportInternalColumnsAbsent(overlapped));
      expect(error.code).toBe('CAPABILITY_MISDECLARED');
      expect(error.issues).toContain(internal);
      expectNoValueLeak(error);
    }
  });

  it('成功路径的返回记录里不出现任何 snake_case 列名，也不含任何内部列', async () => {
    const { repository } = repoWith({
      rows: [rowFromJob(COMPLETED_JOB)],
      rowCount: 1,
    });
    const records = await repository.listByOwnerId(OWNER);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toEqual(COMPLETED_JOB);
    for (const key of Object.keys(record ?? {})) {
      expect(key).not.toContain('_');
      expect(POSTGRES_EXPORT_INTERNAL_COLUMNS).not.toContain(key);
    }
  });

  it('任何失败路径的错误信息与 issues 都不含归属、产物句柄、字段取值、路径、URL 与 PII', async () => {
    const failures: readonly (() => Promise<unknown>)[] = [
      () =>
        repoWith({ rows: [rowFromJob(COMPLETED_JOB, { file_path: FORGED_PATH })], rowCount: 1 })
          .repository.listByOwnerId(OWNER)
          .then((records) => records),
      () =>
        repoWith({
          rows: [rowFromJob(COMPLETED_JOB, { download_url: FORGED_URL })],
          rowCount: 1,
        }).repository.listByOwnerId(OWNER),
      () =>
        repoWith({
          rows: [rowFromJob(COMPLETED_JOB, { error_message: SECRET })],
          rowCount: 1,
        }).repository.listByOwnerId(OWNER),
      () =>
        repoWith({ rows: [rowFromJob(OTHER_OWNER_JOB)], rowCount: 1 }).repository.listByOwnerId(
          OWNER,
        ),
      () => repoWith({ rows: [], rowCount: 0 }).repository.create(PENDING_JOB),
      () =>
        repoWith({
          rows: [rowFromJob(COMPLETED_JOB, { fields: [PII_FIELD] })],
          rowCount: 1,
        }).repository.listByOwnerId(OWNER),
      () =>
        repoWith({
          rows: [rowFromJob(COMPLETED_JOB, { status: INJECTION })],
          rowCount: 1,
        }).repository.listByOwnerId(OWNER),
      () =>
        repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 }).repository.create({
          ...PENDING_JOB,
          fields: [FORGED_PATH],
        }),
      () =>
        repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 }).repository.create({
          ...PENDING_JOB,
          ownerUserId: HEX_OWNER_UPPER,
        }),
      () =>
        repoWith(
          { rows: [], rowCount: 0 },
          { rows: [{ status: 'pending' }], rowCount: 1 },
        ).repository.save(COMPLETED_JOB),
      () => repoWith({ rows: [], rowCount: 0 }).repository.save(PENDING_JOB),
      () =>
        repoWith({
          rows: [rowFromJob(COMPLETED_JOB, { artifact_id: null })],
          rowCount: 1,
        }).repository.listByOwnerId(OWNER),
    ];

    for (const run of failures) {
      let captured: unknown;
      try {
        await run();
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(PostgresExportRepositoryError);
      expectNoValueLeak(captured as PostgresExportRepositoryError);
    }
  });

  it('执行器异常收敛为 EXECUTOR_FAILURE：原始错误文本、SQL 与连接信息都不外发', async () => {
    const raw = new Error(
      `connect ECONNREFUSED 10.0.0.9:5432 (${FORGED_PATH}) ${FORGED_URL} ${SECRET}`,
    );
    const repository = new PostgresExportRepository(new ThrowingExecutor(raw));

    for (const run of [
      () => repository.create(PENDING_JOB),
      () => repository.save(COMPLETED_JOB),
      () => repository.listByOwnerId(OWNER),
    ]) {
      const error = await captureRepoError(run);
      expect(error.code).toBe('EXECUTOR_FAILURE');
      expect(error.issues).toEqual(['executor']);
      expect(error.message).not.toContain('ECONNREFUSED');
      expect(error.message).not.toContain('5432');
      expect(error.message).not.toContain(FORGED_PATH);
      expect(error.message).not.toContain(FORGED_URL);
      expect(error.message).not.toContain(SECRET);
      // 原始错误对象本身不得被挂到公开错误上（cause 会被日志与序列化带出去）
      expect(error.cause).toBeUndefined();
      expectNoValueLeak(error);
    }
  });

  it('同步抛出的驱动异常同样被收敛（不把原始文本带出去）', async () => {
    const executor = new RecordingExecutor();
    const throwing: SqlExecutor = {
      capabilities: executor.capabilities,
      query: () => {
        throw new Error(`原始驱动错误 ${FORGED_PATH}`);
      },
    };
    const repository = new PostgresExportRepository(throwing);
    const error = await captureRepoError(() => repository.listByOwnerId(OWNER));
    expect(error.code).toBe('EXECUTOR_FAILURE');
    expect(error.message).not.toContain(FORGED_PATH);
    expect(error.cause).toBeUndefined();
    expectNoValueLeak(error);
  });
});

describe('PostgreSQL 导出仓储：已装配、无驱动依赖、与 schema 边界对齐', () => {
  it('ExportsModule 通过换绑工厂装配本 adapter（不再是「只绑内存基线」）', () => {
    const content = readFileSync(MODULE_PATH, 'utf8');

    // 模块引用的是**工厂导出名**（延迟建连），而不是 adapter 类名：
    // 装配阶段一次都不碰数据库，准入判定留给启动期门禁
    expect(content).toContain('createLazyPostgresExportRepository');
    expect(content).toContain('resolveAppDatabaseConfig');
    expect(content).toContain('SQL_CONNECTION_FACTORY');
    // 内存实现仍是「未配置数据库」分支，但**不再是 provider**（否则容器里会出现两份状态）
    expect(content).toContain('InMemoryExportRepository');
    expect(content).not.toContain('useExisting: InMemoryExportRepository');
    // adapter 类名不进模块（模块只能经工厂导出名换绑，不能绕过能力自检直接 new）
    expect(content).not.toContain(`new ${ADAPTER_CLASS}`);
  });

  it('adapter 与 port 都不直接引驱动：驱动只允许出现在 db/postgres 驱动层', () => {
    for (const relative of [
      join('src', 'modules', 'exports', 'exports.postgres-repository.ts'),
      join('src', 'modules', 'exports', 'exports.module.ts'),
      join('src', 'modules', 'exports', 'exports.port.ts'),
      join('src', 'modules', 'exports', 'exports.in-memory-repository.ts'),
    ]) {
      const source = readApiFile(relative);
      const specifiers = moduleSpecifiersOf(source);
      for (const forbidden of ['pg', 'pg-pool', 'pg-promise', 'postgres', 'slonik']) {
        expect(specifiers).not.toContain(forbidden);
      }
    }
    // 持久化登记表里导出端口仍按令牌登记，且没有把 adapter 类名写进任何绑定
    const bindings = readApiFile(join('src', 'db', 'persistence-bindings.ts'));
    expect(bindings).toContain('EXPORT_REPOSITORY');
    expect(bindings).toContain('EXPORT_ARTIFACT_STORE');
    expect(bindings).not.toContain(ADAPTER_CLASS);
  });

  it('内存基线实现**同一份**异步契约，且如实声明非持久 / 不可用于生产', () => {
    const source = readFileSync(IN_MEMORY_PATH, 'utf8');
    expect(source).toContain('implements ExportRepository');
    expect(source).not.toContain(ADAPTER_CLASS);
    expect(source).toContain('persistent: false');
    expect(source).toContain('productionReady: false');
    // 内存基线也没有删除 / 归档 / 覆盖插入入口
    for (const forbidden of POSTGRES_EXPORT_FORBIDDEN_METHODS) {
      expect(source).not.toMatch(new RegExp(`\\b${forbidden}\\s*\\(`, 'u'));
    }
    // 三个方法都是异步签名：与端口收敛后的唯一契约逐字一致
    for (const signature of [
      'async create(request: ExportRequest): Promise<ExportRequest>',
      'async save(request: ExportRequest): Promise<ExportRequest>',
      'async listByOwnerId(ownerUserId: string): Promise<readonly ExportRequest[]>',
    ]) {
      expect(source).toContain(signature);
    }

    const memory: ExportRepository = new InMemoryExportRepository({
      NODE_ENV: 'test',
    } as unknown as ConstructorParameters<typeof InMemoryExportRepository>[0]);
    expect(memory.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
  });

  it('延迟建连工厂是本切片的换绑点：导出它、且构造时不解析执行器', async () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).toContain('export function createLazyPostgresExportRepository');
    expect(source).toContain('export function assertPostgresExportSubject');

    // 类型层面的契约对应：延迟包装同样满足端口契约，能力声明与冻结常量一致
    let resolves = 0;
    const lazy: AsyncExportRepository = createLazyPostgresExportRepository(() => {
      resolves += 1;
      return Promise.resolve(undefined as unknown as SqlExecutor);
    });
    expect(lazy.capabilities).toEqual(POSTGRES_EXPORT_REPOSITORY_CAPABILITIES);
    expect(resolves).toBe(0);

    // 非 UUID 主体在**解析执行器之前**就被拒绝：既不进 SQL，也不建连
    await expect(lazy.listByOwnerId('u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    expect(resolves).toBe(0);

    // 主体域断言同样拦住写入路径（归属只能来自服务端会话主体）
    const pendingRecord = {
      id: '11111111-1111-4111-8111-111111111111',
      ownerUserId: 'u-student-1',
      resource: ExportResource.Profile,
      fields: ['title'],
      status: ExportStatus.Pending,
      createdAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
    } satisfies ExportRequest;
    await expect(lazy.create(pendingRecord)).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
    await expect(lazy.save(pendingRecord)).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
    expect(resolves).toBe(0);
  });

  it('adapter 的公开面覆盖能力、验证清单、列清单、内部列与裁剪事实（供上层与运维机器判定）', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    for (const exported of [
      'POSTGRES_EXPORT_TABLE',
      'POSTGRES_EXPORT_COLUMNS',
      'POSTGRES_EXPORT_COLUMN_FIELDS',
      'POSTGRES_EXPORT_FIELD_COLUMNS',
      'POSTGRES_EXPORT_OWNER_COLUMNS',
      'POSTGRES_EXPORT_INTERNAL_COLUMNS',
      'POSTGRES_EXPORT_PII_COLUMNS',
      'POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS',
      'POSTGRES_EXPORT_MUTABLE_COLUMNS',
      'POSTGRES_EXPORT_IMMUTABLE_COLUMNS',
      'POSTGRES_EXPORT_FORBIDDEN_METHODS',
      'POSTGRES_EXPORT_REPOSITORY_CAPABILITIES',
      'POSTGRES_EXPORT_REPOSITORY_VERIFICATION_STEPS',
    ]) {
      expect(source).toContain(`export const ${exported}`);
    }
    expect(source).toContain(`export class ${ADAPTER_CLASS}`);
    expect(source).toContain(`export class ${ADAPTER_CLASS}Error`);
    expect(source).toContain('export function assertPostgresExportRepositoryCapabilities');
    expect(source).toContain('export function findExportViewExclusionLeaks');
    expect(source).toContain('export function assertExportViewExclusion');
    expect(source).toContain('export function findExportInternalColumnOverlaps');
    expect(source).toContain('export function assertExportInternalColumnsAbsent');
    expect(source).toContain('export function exportStatusPredecessors');
    expect(source).toContain('export type PostgresExportRepositoryErrorCode');
    // 语句模板：只有创建 / 条件写回 / 取数 / 诊断，没有任何删除 / DDL 模板
    expect(source).toContain('const INSERT_SQL = `INSERT INTO');
    expect(source).toContain('const UPDATE_SQL = `UPDATE');
    expect(source).toContain('const SELECT_BY_OWNER_SQL = `SELECT');
    expect(source).toContain('const SELECT_STATUS_FOR_OWNER_SQL = `SELECT');
    expect(source).toContain('ON CONFLICT (id) DO NOTHING');
    expect(source).not.toMatch(/`(?:DELETE|TRUNCATE|ALTER|DROP|GRANT|COPY)\b/u);
  });

  it('adapter 不引入任何数据库驱动 / ORM 依赖（依赖面是固定的六个说明符）', () => {
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
        './exports.contract',
        './exports.port',
        './exports.state-machine',
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
    const adapter: AsyncExportRepository = new PostgresExportRepository(new RecordingExecutor());
    expect(adapter.capabilities).toEqual(POSTGRES_EXPORT_REPOSITORY_CAPABILITIES);
    expect(adapter).toBeInstanceOf(PostgresExportRepository);
  });
});

/**
 * 下载切片的取数入口（`findByIdForOwner`）：单条读取必须**同时**钉住主键与归属。
 *
 * 这些用例把「归属下推进 SQL」「不存在与属于他人不可区分」「非法标识零 SQL」「他人记录不得回流」
 * 四条安全属性固定在**真实 adapter 代码路径**上（记录型假执行器，不连数据库）。
 */
describe('PostgreSQL 导出仓储：单条取数的归属隔离（下载切片）', () => {
  it('SQL 是「主键 + 归属」双重参数化谓词：归属不进 SQL 文本，占位符与参数一一对应', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromJob(COMPLETED_JOB)],
      rowCount: 1,
    });

    const found = await repository.findByIdForOwner(JOB_ID, OWNER);
    expect(found).toEqual(COMPLETED_JOB);

    const call = callAt(executor, 0);
    const sql = call?.sql ?? '';
    expect(sql).toContain(
      'SELECT id, requester_id, resource, fields, status, artifact_id, expires_at, revoked_at, created_at, updated_at',
    );
    expect(sql).not.toContain('*');
    expect(sql).toContain('WHERE id = $1::uuid AND requester_id = $2::uuid');
    expectParameterizedSql(sql);
    // 归属与主键都只出现在参数里（SQL 文本里只有列名与占位符）
    expect(sql).not.toContain(OWNER);
    expect(sql).not.toContain(JOB_ID);
    expect(call?.parameters).toEqual([JOB_ID, OWNER]);
    expect(placeholderIndexes(sql)).toHaveLength(call?.parameters?.length ?? 0);
    expectWriteAndReadOnlySql(executor);
  });

  it('0 行 ⇒ undefined（不存在与「属于他人」不可区分），且不追加任何诊断查询', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 });

    await expect(repository.findByIdForOwner(JOB_ID, OWNER)).resolves.toBeUndefined();
    // 与「不存在」同一返回值：调用方没有任何可区分两者的信息；也不做跨归属探测
    await expect(repository.findByIdForOwner(OTHER_JOB_ID, OWNER)).resolves.toBeUndefined();
    expect(executor.calls).toHaveLength(2);
    for (const call of executor.calls) {
      expect(call.sql).toContain('requester_id = $2::uuid');
      expect(call.parameters).toEqual([expect.any(String), OWNER]);
    }
  });

  it('执行器越权返回他人记录 ⇒ OWNER_VIOLATION（纵深防御：仓储过滤不作为安全边界）', async () => {
    const { repository } = repoWith({ rows: [rowFromJob(OTHER_OWNER_JOB)], rowCount: 1 });

    const error = await captureRepoError(() => repository.findByIdForOwner(JOB_ID, OWNER));
    expect(error.code).toBe('OWNER_VIOLATION');
    expectIssueOn(error, 'requester_id');
    expectNoValueLeak(error);
  });

  it('行契约损坏（未知列 / 非法枚举 / 非 UUID 标识 / 坏时间戳）⇒ INVALID_ROW，不含取值', async () => {
    const cases: readonly Record<string, unknown>[] = [
      rowFromJob(COMPLETED_JOB, { storage_key: 'memory-export-artifacts/x.csv' }),
      rowFromJob(COMPLETED_JOB, { file_path: FORGED_PATH }),
      rowFromJob(COMPLETED_JOB, { status: 'unknown-status' }),
      rowFromJob(COMPLETED_JOB, { artifact_id: 'not-a-uuid' }),
      rowFromJob(COMPLETED_JOB, { created_at: '2026/01/02' }),
      withoutRowColumn(COMPLETED_JOB, 'requester_id'),
    ];
    for (const row of cases) {
      const { repository } = repoWith({ rows: [row], rowCount: 1 });
      const error = await captureRepoError(() => repository.findByIdForOwner(JOB_ID, OWNER));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });

  it('多行返回 ⇒ RESULT_SET_VIOLATION（主键唯一性被破坏不得被静默取第一条）', async () => {
    const { repository } = repoWith({
      rows: [rowFromJob(COMPLETED_JOB), rowFromJob(COMPLETED_JOB)],
      rowCount: 2,
    });
    const error = await captureRepoError(() => repository.findByIdForOwner(JOB_ID, OWNER));
    expect(error.code).toBe('RESULT_SET_VIOLATION');
    expectNoValueLeak(error);
  });

  it('非法记录 ID / 主体 ⇒ INVALID_ID / INVALID_SUBJECT，且一个 SQL 都不执行', async () => {
    for (const id of ['u-student-1', '', NIL_UUID, HEX_JOB_ID_UPPER, INJECTION]) {
      const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
      const error = await captureRepoError(() => repository.findByIdForOwner(id, OWNER));
      expect(error.code).toBe('INVALID_ID');
      expectIssueOn(error, 'id');
      expectNoValueLeak(error);
      expect(executor.calls).toHaveLength(0);
    }
    for (const owner of ['u-student-1', '', NIL_UUID, HEX_OWNER_UPPER, HEX_OWNER_MIXED]) {
      const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
      const error = await captureRepoError(() =>
        repository.findByIdForOwner(HEX_JOB_ID, owner as string),
      );
      expect(error.code).toBe('INVALID_SUBJECT');
      expectIssueOn(error, 'ownerUserId');
      expectNoValueLeak(error);
      expect(executor.calls).toHaveLength(0);
    }
  });

  it('执行器异常 ⇒ EXECUTOR_FAILURE，不携带原始错误文本', async () => {
    const repository = new PostgresExportRepository(
      new ThrowingExecutor(new Error(`connect postgres://user:${SECRET}@${FORGED_PATH}`)),
    );
    const error = await captureRepoError(() => repository.findByIdForOwner(JOB_ID, OWNER));
    expect(error.code).toBe('EXECUTOR_FAILURE');
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expectNoValueLeak(error);
    expect(error.message).not.toContain('://');
  });

  it('延迟建连包装同样先判标识、再解析执行器；非法标识不触发任何连接', async () => {
    let resolves = 0;
    const lazy: AsyncExportRepository = createLazyPostgresExportRepository(() => {
      resolves += 1;
      return Promise.resolve(undefined as unknown as SqlExecutor);
    });

    await expect(lazy.findByIdForOwner('not-a-uuid', OWNER)).rejects.toMatchObject({
      code: 'INVALID_ID',
    });
    await expect(lazy.findByIdForOwner(JOB_ID, 'u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    expect(resolves).toBe(0);

    // 合法标识：解析执行器并走到 adapter（此处执行器为 undefined，构造即 fail-closed）
    await expect(lazy.findByIdForOwner(JOB_ID, OWNER)).rejects.toMatchObject({
      code: 'EXECUTOR_UNAVAILABLE',
    });
    expect(resolves).toBe(1);
  });

  it('端口面：存在 findByIdForOwner，且不存在任何不带归属条件的单条读取入口', () => {
    const { repository } = repoWith();
    const surface = repository as unknown as Record<string, unknown>;
    expect(typeof surface.findByIdForOwner).toBe('function');
    for (const forbidden of ['findById', 'findByOwner', 'findAll', 'query', 'delete', 'upsert']) {
      expect(surface[forbidden]).toBeUndefined();
    }
    // 源码层面：模板里确实存在单条取数语句，且它含归属谓词
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).toContain('const SELECT_BY_ID_FOR_OWNER_SQL = `SELECT');
    expect(source).toContain('WHERE id = $1::uuid AND requester_id = $2::uuid');
    expect(source).not.toMatch(/`(?:DELETE|TRUNCATE|ALTER|DROP|GRANT|COPY)\b/u);
  });
});

/**
 * 键集分页（`listByOwnerIdPage`）的**离线**验收：SQL 形态、窗口 fail-closed、`hasNext` 语义。
 *
 * 真库上的「首 / 中 / 末页无重复无遗漏」由 `db/postgres/__tests__/exports-integration.spec.ts`
 * 闭环；这里固定的是**语句与边界**这一层（不需要数据库也能判定的部分）：
 * - 归属 + 边界 + 页大小**全部**是参数占位符，SQL 文本里没有取值、没有 `OFFSET`；
 * - 首页与续页是两条固定语句（续页才有 `(created_at, id) > ($3, $4)` 边界谓词）；
 * - `limit + 1` 是「多取一行」探针：取到 `limit + 1` 行 ⇒ `hasNext = true`，
 *   且**多取的那一行不进 `records`**；
 * - 非法窗口（越界 / 非整数 `limit`、非法键集边界）在**取数之前** fail-closed，一个 SQL 都不执行。
 */
describe('PostgreSQL 导出仓储：键集分页窗口', () => {
  const BOUNDARY = { createdAt: LATER_AT, id: OTHER_JOB_ID };

  it('首页：只剩归属与页大小两个参数，排序按毫秒键集，且没有 OFFSET', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 });

    const page = await repository.listByOwnerIdPage(OWNER, { limit: 2 });

    expect(page.hasNext).toBe(false);
    expect(page.records).toHaveLength(1);

    const call = callAt(executor, 0);
    const sql = call?.sql ?? '';
    expectParameterizedSql(sql);
    expect(sql).toContain('WHERE requester_id = $1::uuid');
    expect(sql).toContain('ORDER BY date_trunc($2::text, created_at) ASC, id ASC');
    expect(sql).toContain('LIMIT $3::int');
    // 键集分页：绝不使用位移
    expect(sql).not.toMatch(/\bOFFSET\b/u);
    expect(placeholderIndexes(sql)).toEqual([1, 2, 3]);
    // 参数恰好是「归属 + 毫秒截断字段常量 + limit + 1 的探针」
    expect(call?.parameters).toEqual([OWNER, POSTGRES_EXPORT_TRUNCATION_FIELD, 3]);
    expect(sql).not.toContain(OWNER);
  });

  it('续页：边界是 `(created_at, id)` 行构造器谓词（严格大于），键值只进参数、不进 SQL 文本', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 });

    await repository.listByOwnerIdPage(OWNER, { limit: 1, after: BOUNDARY });

    const call = callAt(executor, 0);
    const sql = call?.sql ?? '';
    expectParameterizedSql(sql);
    expect(sql).toContain('WHERE requester_id = $1::uuid');
    expect(sql).toContain(
      'AND (date_trunc($2::text, created_at), id) > ($3::timestamptz, $4::uuid)',
    );
    // 排序与边界谓词必须是同一个截断表达式（否则会重复或漏行）
    expect(sql).toContain('ORDER BY date_trunc($5::text, created_at) ASC, id ASC');
    expect(sql).toContain('LIMIT $6::int');
    expect(sql).not.toMatch(/\bOFFSET\b/u);
    expect(placeholderIndexes(sql)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(call?.parameters).toEqual([
      OWNER,
      POSTGRES_EXPORT_TRUNCATION_FIELD,
      BOUNDARY.createdAt,
      BOUNDARY.id,
      POSTGRES_EXPORT_TRUNCATION_FIELD,
      2,
    ]);
    // 边界键值与归属都不出现在 SQL 文本里
    expect(sql).not.toContain(OWNER);
    expect(sql).not.toContain(BOUNDARY.id);
    expect(sql).not.toContain(BOUNDARY.createdAt);
  });

  it('多取一行只用于判定 hasNext：取到 limit + 1 行时最后一行不进 records', async () => {
    const first = { ...PENDING_JOB, id: JOB_ID, createdAt: CREATED_AT };
    const second = { ...PENDING_JOB, id: HEX_JOB_ID, createdAt: LATER_AT };
    const { repository, executor } = repoWith({
      rows: [rowFromJob(first), rowFromJob(second)],
      rowCount: 2,
    });

    const page = await repository.listByOwnerIdPage(OWNER, { limit: 1 });

    expect(page.hasNext).toBe(true);
    expect(page.records.map((record) => record.id)).toEqual([JOB_ID]);
    // 探针是 limit + 1（不是 limit，也不是更大的窗口）
    expect(callAt(executor, 0)?.parameters?.[2]).toBe(2);
  });

  it('非法窗口（越界 / 非整数 / 非对象）在取数之前 fail-closed，一个 SQL 都不执行', async () => {
    const windows: readonly unknown[] = [
      { limit: 0 },
      { limit: -1 },
      { limit: 1.5 },
      { limit: Number.NaN },
      { limit: Number.POSITIVE_INFINITY },
      { limit: '1' },
      { limit: EXPORT_PAGE_MAX_LIMIT + 1 },
      { limit: 1_000_000 },
      {},
      null,
      [],
      'limit=1',
    ];
    for (const window of windows) {
      const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
      const error = await captureRepoError(() =>
        repository.listByOwnerIdPage(OWNER, window as never),
      );
      expect(error.code).toBe('INVALID_WINDOW');
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
  });

  it('非法键集边界（非 UUID / 非 ISO 时间 / 缺分量）同样在取数之前 fail-closed', async () => {
    const boundaries: readonly unknown[] = [
      { createdAt: LATER_AT, id: 'not-a-uuid' },
      { createdAt: LATER_AT, id: NIL_UUID },
      { createdAt: LATER_AT, id: HEX_JOB_ID_UPPER },
      { createdAt: '2026/01/02', id: OTHER_JOB_ID },
      { createdAt: '', id: OTHER_JOB_ID },
      { createdAt: LATER_AT },
      { id: OTHER_JOB_ID },
      {},
    ];
    for (const after of boundaries) {
      const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
      const error = await captureRepoError(() =>
        repository.listByOwnerIdPage(OWNER, { limit: 5, after: after as never }),
      );
      expect(['INVALID_WINDOW', 'INVALID_ID']).toContain(error.code);
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
  });

  it('窗口上限来自服务端常量：恰好等于上界可用，上界 + 1 被拒绝', async () => {
    const atBound = repoWith({ rows: [], rowCount: 0 });
    await expect(
      atBound.repository.listByOwnerIdPage(OWNER, { limit: EXPORT_PAGE_MAX_LIMIT }),
    ).resolves.toEqual({ records: [], hasNext: false });
    expect(assertPostgresExportPageWindow({ limit: EXPORT_PAGE_MAX_LIMIT })).toEqual({
      limit: EXPORT_PAGE_MAX_LIMIT,
    });
    expect(() => assertPostgresExportPageWindow({ limit: EXPORT_PAGE_MAX_LIMIT + 1 })).toThrow(
      PostgresExportRepositoryError,
    );
    expect(() => assertPostgresExportPageWindow({ limit: 0 })).toThrow(
      PostgresExportRepositoryError,
    );
  });

  it('取数主体仍先判存储 ID 域：非 UUID 主体绝不进入 SQL（窗口合法也一样）', async () => {
    for (const subject of ['u-student-1', '', NIL_UUID, HEX_OWNER_UPPER]) {
      const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
      const error = await captureRepoError(() =>
        repository.listByOwnerIdPage(subject, { limit: 1 }),
      );
      expect(error.code).toBe('INVALID_SUBJECT');
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
  });

  it('结果集仍然逐条复核：他人记录 / 重复主键 / 损坏行一律 fail-closed（不静默过滤）', async () => {
    const foreign = repoWith({ rows: [rowFromJob(OTHER_OWNER_JOB)], rowCount: 1 });
    const ownerError = await captureRepoError(() =>
      foreign.repository.listByOwnerIdPage(OWNER, { limit: 5 }),
    );
    expect(ownerError.code).toBe('OWNER_VIOLATION');

    const duplicated = repoWith({
      rows: [rowFromJob(PENDING_JOB), rowFromJob(PENDING_JOB)],
      rowCount: 2,
    });
    const dupError = await captureRepoError(() =>
      duplicated.repository.listByOwnerIdPage(OWNER, { limit: 5 }),
    );
    expect(dupError.code).toBe('RESULT_SET_VIOLATION');

    const broken = repoWith({
      rows: [rowFromJob(PENDING_JOB, { resource: 'bogus' })],
      rowCount: 1,
    });
    const rowError = await captureRepoError(() =>
      broken.repository.listByOwnerIdPage(OWNER, { limit: 5 }),
    );
    expect(rowError.code).toBe('INVALID_ROW');
  });

  it('能力 / 执行器自检先于窗口与取数（构造后被降级 ⇒ 立即 fail-closed）', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromJob(PENDING_JOB)], rowCount: 1 });
    (repository as { capabilities: ExportRepositoryCapabilities }).capabilities = {
      backend: 'postgres',
      persistent: true,
      productionReady: true,
    };
    const error = await captureRepoError(() => repository.listByOwnerIdPage(OWNER, { limit: 1 }));
    expect(error.code).toBe('CAPABILITY_MISDECLARED');
    expect(executor.calls).toHaveLength(0);
  });

  it('延迟建连包装：窗口与主体都在解析执行器之前判定，非法输入不触发任何连接', async () => {
    let resolves = 0;
    const lazy: AsyncExportRepository = createLazyPostgresExportRepository(() => {
      resolves += 1;
      return Promise.resolve(undefined as unknown as SqlExecutor);
    });

    await expect(lazy.listByOwnerIdPage(OWNER, { limit: 0 })).rejects.toMatchObject({
      code: 'INVALID_WINDOW',
    });
    await expect(
      lazy.listByOwnerIdPage(OWNER, { limit: 1, after: { createdAt: '2026/01/02', id: JOB_ID } }),
    ).rejects.toMatchObject({ code: 'INVALID_WINDOW' });
    await expect(lazy.listByOwnerIdPage('u-student-1', { limit: 1 })).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    expect(resolves).toBe(0);

    // 合法窗口：解析执行器并走到 adapter（此处执行器为 undefined，构造即 fail-closed）
    await expect(lazy.listByOwnerIdPage(OWNER, { limit: 1 })).rejects.toMatchObject({
      code: 'EXECUTOR_UNAVAILABLE',
    });
    expect(resolves).toBe(1);
  });

  it('端口与 adapter 的分页契约在源码层面固定：五个方法、没有 OFFSET、边界谓词只在续页语句里', () => {
    const portSource = readFileSync(PORT_PATH, 'utf8');
    expect(portSource).toContain(
      'listByOwnerIdPage(ownerUserId: string, window: ExportPageWindow): Promise<ExportPage>;',
    );
    expect(portSource).toContain('export const EXPORT_PAGE_DEFAULT_LIMIT');
    expect(portSource).toContain('export const EXPORT_PAGE_MAX_LIMIT');
    expect(portSource).toContain('export function isExportPageLimit');
    expect(portSource).toContain('export function compareExportKeysets');

    const adapterSource = readFileSync(ADAPTER_PATH, 'utf8');
    expect(adapterSource).toContain('async listByOwnerIdPage(');
    // 位移分页在本切片里根本不存在（既不是「先写后忘」，也不是「保留但不用」）。
    // 注意：`OFFSET` 这个词会出现在说明它「刻意不加」的注释里，因此这里判定的是
    // **可执行形态**（`OFFSET $n` / `OFFSET 数字` / `FETCH FIRST|NEXT`），而不是注释文本；
    // 真正下发的语句里连这个词都没有，由上面两条 SQL 用例逐条断言。
    expect(adapterSource).not.toMatch(/\bOFFSET\s+(?:\$|\d)/iu);
    expect(adapterSource).not.toMatch(/\bFETCH\s+(?:FIRST|NEXT)\b/iu);
  });
});

/**
 * 撤销切片（`revokeForOwner`）在**真实 adapter 代码路径**上的离线验收。
 *
 * 固定的硬性质（不连数据库、不引驱动）：
 * - **条件更新**：`SET` 只有 `revoked_at` / `updated_at`，`WHERE` 钉住 `id + 归属 +
 *   可撤销前驱集合 + revoked_at IS NULL`；所有值只进参数、SQL 文本零引号零分号；
 * - **不改写既有事实**：不触碰 `status` / `artifact_id` / `created_at` / `expires_at`，
 *   不删行（端口上也没有删除方法）；
 * - **结论闭集**：命中 1 行 ⇒ `revoked`；0 行时由**归属范围内**的诊断取数分类为
 *   `already-revoked`（幂等）/ `not-revocable`（`failed`）/ `undefined`（不存在或属于他人，
 *   两者不可区分）；多行 ⇒ 结果集违约；
 * - **fail-closed**：非法记录 ID / 主体 / 撤销时刻在**进 SQL 之前**拒绝（零 SQL）；
 *   执行器异常收敛为不含原始文本的 `EXECUTOR_FAILURE`；回流被改写（撤销时刻被换、
 *   结论不在可撤销集合内、他人归属）一律抛错。
 */
describe('PostgreSQL 导出仓储：本人撤销（条件更新与结论闭集）', () => {
  const REVOKED_AT = '2026-01-02T05:00:00.000Z';
  /** 已撤销的样本：`status` 仍是 completed（撤销与状态机正交），多出撤销时刻 */
  const ALREADY_REVOKED_JOB: ExportRequest = {
    ...COMPLETED_JOB,
    revokedAt: REVOKED_AT,
    updatedAt: REVOKED_AT,
  };

  it('撤销语句是条件更新：SET 只有 revoked_at / updated_at，WHERE 钉住归属 + 可撤销前驱 + revoked_at IS NULL', async () => {
    const target = { ...PENDING_JOB, revokedAt: REVOKED_AT, updatedAt: REVOKED_AT };
    const { repository, executor } = repoWith({ rows: [rowFromJob(target)], rowCount: 1 });

    const result = await repository.revokeForOwner(JOB_ID, OWNER, REVOKED_AT);
    expect(result?.outcome).toBe(ExportRevocationOutcome.Revoked);
    expect(result?.record.revokedAt).toBe(REVOKED_AT);
    // 命中即止：不追加任何诊断查询
    expect(executor.calls).toHaveLength(1);

    const call = callAt(executor, 0);
    const sql = call?.sql ?? '';
    expectParameterizedSql(sql);
    expect(sql).toMatch(/\bUPDATE\b/u);
    const setClause = sql.slice(sql.indexOf('SET'), sql.indexOf('WHERE'));
    expect(setClause).toContain('revoked_at = $3::timestamptz');
    expect(setClause).toContain('updated_at = $4::timestamptz');
    // 撤销**不覆盖**身份、导出范围、结论、产物句柄、创建时间与有效期
    for (const forbidden of [
      'id',
      'requester_id',
      'resource',
      'fields',
      'status',
      'artifact_id',
      'expires_at',
      'created_at',
    ]) {
      expect(containsWord(setClause, forbidden)).toBe(false);
    }
    // WHERE：归属与主键双重参数化 + 可撤销前驱谓词 + 单调性谓词
    expect(sql).toContain('WHERE id = $1::uuid AND requester_id = $2::uuid');
    expect(sql).toContain('status::text = ANY($5::text[])');
    expect(sql).toContain('revoked_at IS NULL');
    expect(sql).toContain(`RETURNING ${[...POSTGRES_EXPORT_COLUMNS].join(', ')}`);
    expect(sql).not.toContain('*');
    // 参数与占位符一一对应：撤销时刻写两次（revoked_at / updated_at 各占一个序号，同一次时钟读数）
    expect(call?.parameters).toEqual([
      JOB_ID,
      OWNER,
      REVOKED_AT,
      REVOKED_AT,
      [...EXPORT_REVOCABLE_STATUSES],
    ]);
    expect(placeholderIndexes(sql)).toHaveLength(call?.parameters?.length ?? 0);
    expect(expectWriteAndReadOnlySql(executor)).toHaveLength(1);
    // 归属、主键与撤销时刻都只出现在参数里
    for (const value of [OWNER, JOB_ID, REVOKED_AT]) {
      expect(sql).not.toContain(value);
    }
  });

  it('0 行 + 诊断行已带撤销时刻 ⇒ already-revoked（幂等，不改写既有撤销时刻）', async () => {
    const { repository, executor } = repoWith(
      { rows: [], rowCount: 0 },
      { rows: [rowFromJob(ALREADY_REVOKED_JOB)], rowCount: 1 },
    );

    const result = await repository.revokeForOwner(JOB_ID, OWNER, LATER_AT);
    expect(result?.outcome).toBe(ExportRevocationOutcome.AlreadyRevoked);
    expect(result?.record.revokedAt).toBe(REVOKED_AT);
    // 诊断查询同样是「主键 + 归属」双重限定，且不跨归属探测
    const diagnosis = callAt(executor, 1);
    expect(diagnosis?.sql).toContain('WHERE id = $1::uuid AND requester_id = $2::uuid');
    expect(diagnosis?.parameters).toEqual([JOB_ID, OWNER]);
  });

  it('0 行 + 诊断行是 failed ⇒ not-revocable（不可撤销结论，一行都没被写入）', async () => {
    const { repository, executor } = repoWith(
      { rows: [], rowCount: 0 },
      { rows: [rowFromJob(FAILED_JOB)], rowCount: 1 },
    );

    const result = await repository.revokeForOwner(OTHER_JOB_ID, OWNER, REVOKED_AT);
    expect(result?.outcome).toBe(ExportRevocationOutcome.NotRevocable);
    expect(result?.record.status).toBe(ExportStatus.Failed);
    expect(result?.record.revokedAt).toBeUndefined();
    // 只有「条件写入 + 一次诊断」两条语句，没有任何第二次写入
    expect(
      executor.calls.map((entry) => entry.sql.match(/\b(?:INSERT|UPDATE|SELECT)\b/u)?.[0]),
    ).toEqual(['UPDATE', 'SELECT']);
  });

  it('0 行 + 诊断无行 ⇒ undefined（不存在与「属于他人」不可区分，也不泄露存在性）', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });
    await expect(repository.revokeForOwner(JOB_ID, OWNER, REVOKED_AT)).resolves.toBeUndefined();
    expect(executor.calls).toHaveLength(2);
    for (const call of executor.calls) {
      expect(call.parameters?.[1]).toBe(OWNER);
    }
  });

  it('条件写入或诊断返回多行 ⇒ RESULT_SET_VIOLATION（主键唯一性被破坏不得静默取第一条）', async () => {
    const writeMulti = repoWith({
      rows: [rowFromJob(PENDING_JOB), rowFromJob(PENDING_JOB)],
      rowCount: 2,
    });
    expect(
      (
        await captureRepoError(() =>
          writeMulti.repository.revokeForOwner(JOB_ID, OWNER, REVOKED_AT),
        )
      ).code,
    ).toBe('RESULT_SET_VIOLATION');

    const diagnosisMulti = repoWith(
      { rows: [], rowCount: 0 },
      { rows: [rowFromJob(FAILED_JOB), rowFromJob(FAILED_JOB)], rowCount: 2 },
    );
    expect(
      (
        await captureRepoError(() =>
          diagnosisMulti.repository.revokeForOwner(JOB_ID, OWNER, REVOKED_AT),
        )
      ).code,
    ).toBe('RESULT_SET_VIOLATION');
  });

  it('非法记录 ID / 主体 / 撤销时刻在进 SQL 之前 fail-closed（零 SQL、零建连）', async () => {
    const cases: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ['INVALID_ID', () => repoWith().repository.revokeForOwner(INJECTION, OWNER, REVOKED_AT)],
      ['INVALID_ID', () => repoWith().repository.revokeForOwner(NIL_UUID, OWNER, REVOKED_AT)],
      [
        'INVALID_ID',
        () => repoWith().repository.revokeForOwner(HEX_JOB_ID_UPPER, OWNER, REVOKED_AT),
      ],
      [
        'INVALID_SUBJECT',
        () => repoWith().repository.revokeForOwner(JOB_ID, 'u-student-1', REVOKED_AT),
      ],
      [
        'INVALID_SUBJECT',
        () => repoWith().repository.revokeForOwner(JOB_ID, HEX_OWNER_UPPER, REVOKED_AT),
      ],
      [
        'INVALID_RECORD',
        () => repoWith().repository.revokeForOwner(JOB_ID, OWNER, '2026/01/02 05:00'),
      ],
      [
        'INVALID_RECORD',
        () => repoWith().repository.revokeForOwner(JOB_ID, OWNER, '2026-01-02T05:00:00+08:00'),
      ],
    ];

    for (const [code, run] of cases) {
      const error = await captureRepoError(run);
      expect(error.code).toBe(code);
      expectNoValueLeak(error);
    }
    // 零 SQL：上面每一次调用都新建了一个执行器，这里再显式核对一次典型入口
    const { repository, executor } = repoWith();
    await captureRepoError(() => repository.revokeForOwner('not-a-uuid', OWNER, REVOKED_AT));
    await captureRepoError(() => repository.revokeForOwner(JOB_ID, 'u-student-1', REVOKED_AT));
    await captureRepoError(() => repository.revokeForOwner(JOB_ID, OWNER, 'yesterday'));
    expect(executor.calls).toHaveLength(0);
  });

  it('执行器异常 ⇒ EXECUTOR_FAILURE（不携带原始错误文本、SQL 与连接信息）', async () => {
    const executor = new ThrowingExecutor(new Error('connect ECONNREFUSED user=postgres'));
    const error = await captureRepoError(() =>
      new PostgresExportRepository(executor).revokeForOwner(JOB_ID, OWNER, REVOKED_AT),
    );
    expect(error.code).toBe('EXECUTOR_FAILURE');
    expect(error.message).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(error.issues)).not.toContain('postgres');
    expectNoValueLeak(error);
  });

  it('回流被改写时 fail-closed：撤销时刻被换 / 结论不在可撤销集合内 / 他人归属', async () => {
    const rewrittenTime = repoWith({
      rows: [rowFromJob({ ...PENDING_JOB, revokedAt: LATER_AT, updatedAt: LATER_AT })],
      rowCount: 1,
    });
    expect(
      (
        await captureRepoError(() =>
          rewrittenTime.repository.revokeForOwner(JOB_ID, OWNER, REVOKED_AT),
        )
      ).code,
    ).toBe('IDENTITY_MISMATCH');

    // 结论不在可撤销集合内（failed）：撤销不得改写结论
    const rewrittenStatus = repoWith({ rows: [rowFromJob(FAILED_JOB)], rowCount: 1 });
    expect(
      (
        await captureRepoError(() =>
          rewrittenStatus.repository.revokeForOwner(JOB_ID, OWNER, REVOKED_AT),
        )
      ).code,
    ).toBe('IDENTITY_MISMATCH');

    // 他人归属回流：纵深防御（仓储过滤不作为安全边界）
    const otherOwner = repoWith({
      rows: [rowFromJob({ ...PENDING_JOB, revokedAt: REVOKED_AT, updatedAt: REVOKED_AT })],
      rowCount: 1,
    });
    expect(
      (
        await captureRepoError(() =>
          otherOwner.repository.revokeForOwner(JOB_ID, OTHER_OWNER, REVOKED_AT),
        )
      ).code,
    ).toBe('OWNER_VIOLATION');

    // 行契约损坏（未知列）同样 fail-closed
    const brokenRow = repoWith({
      rows: [
        rowFromJob(
          { ...PENDING_JOB, revokedAt: REVOKED_AT, updatedAt: REVOKED_AT },
          { file_path: FORGED_PATH },
        ),
      ],
      rowCount: 1,
    });
    expect(
      (await captureRepoError(() => brokenRow.repository.revokeForOwner(JOB_ID, OWNER, REVOKED_AT)))
        .code,
    ).toBe('INVALID_ROW');
    // 时间戳自检：合法形态原样返回，非法形态抛错（供延迟建连包装在解析执行器之前调用）
    expect(assertPostgresExportRevocationTimestamp(REVOKED_AT)).toBe(REVOKED_AT);
    expect(() => assertPostgresExportRevocationTimestamp('2026-01-02')).toThrow(
      PostgresExportRepositoryError,
    );
  });

  it('延迟建连包装：撤销的入参都在解析执行器之前判定，非法输入不触发任何连接', async () => {
    let resolves = 0;
    const lazy: AsyncExportRepository = createLazyPostgresExportRepository(() => {
      resolves += 1;
      return Promise.resolve(undefined as unknown as SqlExecutor);
    });

    await expect(lazy.revokeForOwner('not-a-uuid', OWNER, REVOKED_AT)).rejects.toMatchObject({
      code: 'INVALID_ID',
    });
    await expect(lazy.revokeForOwner(JOB_ID, 'u-student-1', REVOKED_AT)).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    await expect(lazy.revokeForOwner(JOB_ID, OWNER, 'yesterday')).rejects.toMatchObject({
      code: 'INVALID_RECORD',
    });
    expect(resolves).toBe(0);

    // 合法入参：解析执行器并走到 adapter（此处执行器为 undefined，构造即 fail-closed）
    await expect(lazy.revokeForOwner(JOB_ID, OWNER, REVOKED_AT)).rejects.toMatchObject({
      code: 'EXECUTOR_UNAVAILABLE',
    });
    expect(resolves).toBe(1);
  });

  it('端口与内存基线都提供撤销入口、都不提供删除入口；撤销列与状态机写回列刻意分开', () => {
    const portSource = readFileSync(PORT_PATH, 'utf8');
    expect(portSource).toContain('revokeForOwner(');
    expect(portSource).toContain('export const ExportRevocationOutcome');
    expect(portSource).toContain('export const EXPORT_REVOCATION_CLEANUP_BOUNDARY');
    expect(portSource).not.toMatch(/\b(?:delete|remove|archive|purge|truncate)\s*\(/u);

    const inMemorySource = readFileSync(IN_MEMORY_PATH, 'utf8');
    expect(inMemorySource).toContain('async revokeForOwner(');
    expect(inMemorySource).toContain('revokedAt');
    // 内存基线同样没有删除 / 归档入口（它读取 `NODE_ENV` 只是为了拒绝在生产环境构造）
    const inMemory = new InMemoryExportRepository(
      loadEnv({ NODE_ENV: 'test' }),
    ) as unknown as Record<string, unknown>;
    for (const method of ['delete', 'remove', 'archive', 'purge', 'truncate', 'upsert']) {
      expect(inMemory[method]).toBeUndefined();
    }

    // 撤销列与状态机写回的可变列刻意分开：`save` 的 SET 列表里没有 revoked_at
    expect([...POSTGRES_EXPORT_REVOKE_COLUMNS]).toEqual(['revoked_at', 'updated_at']);
    expect(POSTGRES_EXPORT_MUTABLE_COLUMNS).not.toContain('revoked_at');
    // 撤销时刻是不可变列 + 裁剪列：`save` 不得写它，公开视图不得含它
    expect(POSTGRES_EXPORT_IMMUTABLE_COLUMNS).toContain('revoked_at');
    expect(POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS).toContain('revoked_at');
    expect(POSTGRES_EXPORT_PII_COLUMNS).toContain('revoked_at');
    expect(EXPORT_REQUEST_VIEW_FIELDS).not.toContain('revokedAt');
  });
});
