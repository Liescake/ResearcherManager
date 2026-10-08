import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  PersistenceCapabilities,
  SqlExecutor,
  SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import { loadEnv } from '../../config/env';
import { AUDIT_EVENT_VIEW_FIELDS, parseStoredAuditEvent } from './audit.contract';
import { InMemoryAuditRepository } from './audit.in-memory-repository';
import {
  AUDIT_EVENT_TYPE_VALUES,
  AUDIT_REPOSITORY_BACKEND_POSTGRES,
  AUDIT_REPOSITORY_STORAGE_ID_DOMAIN,
  AuditEventType,
  AuditResourceType,
  AuditResult,
} from './audit.port';
import type {
  AsyncAuditRepository,
  AuditEvent,
  AuditRepository,
  AuditRepositoryCapabilities,
} from './audit.port';
import {
  POSTGRES_AUDIT_COLUMN_FIELDS,
  POSTGRES_AUDIT_COLUMNS,
  POSTGRES_AUDIT_FIELD_COLUMNS,
  POSTGRES_AUDIT_FORBIDDEN_METHODS,
  POSTGRES_AUDIT_INTERNAL_COLUMNS,
  POSTGRES_AUDIT_OWNER_COLUMNS,
  POSTGRES_AUDIT_PII_COLUMNS,
  POSTGRES_AUDIT_REPOSITORY_CAPABILITIES,
  POSTGRES_AUDIT_REPOSITORY_VERIFICATION_STEPS,
  POSTGRES_AUDIT_TABLE,
  POSTGRES_AUDIT_VIEW_EXCLUDED_COLUMNS,
  PostgresAuditRepository,
  PostgresAuditRepositoryError,
  assertAuditViewExclusion,
  assertPostgresAuditRepositoryCapabilities,
  findAuditViewExclusionLeaks,
} from './audit.postgres-repository';

/**
 * 不可变业务审计记录的 PostgreSQL 仓储 adapter 的**离线**验收（不连数据库、不引驱动）。
 *
 * 覆盖用户要求的补充安全契约测试与交付边界：
 * - **能力与交付边界**：`persistent = true` / `productionReady = false`（未真实驱动验证前严禁
 *   生产）、列清单与读取契约字段双射、`audit_logs` 尚未转为迁移、adapter 未被装配到
 *   `AuditModule`、不引驱动/ORM、同步端口未被改成异步、内存 provider 未被切换；
 * - **参数化 SQL 与固定标识符**：值只出现在参数里，SQL 文本只由模块常量构成（语句里没有任何
 *   引号 / 分号 / 注释符，因此不存在字面量注入面）；执行过的 SQL 只含 `INSERT` 与 `SELECT`；
 * - **SQL 注入**：摘要、主体、主键、关联 ID 等所有入口的注入载荷要么只进参数、要么在进入 SQL
 *   之前被拒绝（拒绝路径**一个 SQL 都不执行**）；
 * - **未知列 / 严格行契约 / 字段污染**：未登记列（请求头、user-agent、明文 IP / 对端地址、路径、
 *   URL、方法、payload、改前改后快照、理由、完整性字段）、缺列、写路径的 snake_case 别名与
 *   权限字段一律 fail-closed；
 * - **非法 event / action / time**：`action` 只接受事件类型闭集，`occurred_at` 只接受 `Date` 或
 *   ISO datetime（不把非法时间静默归一）；非法取值一律拒绝且不回显取值；
 * - **按服务端 actor / subject owner 隔离**：他人事件与仅管理端可见的事件既不出库（归属与
 *   可见性下推进 SQL）也不得回流；
 * - **仅追加**：端口与 adapter 都没有 update / delete / 覆盖写入口，也不产生任何改写语句；
 * - **公开视图不泄露归属、关联 ID、网络归属、可见性口径、资源标识与内部审计字段**：视图恰好是
 *   白名单闭集；所有失败路径的错误信息与 `issues` 只含字段路径与违规类型，不含任何取值；
 * - **与内存基线同语义**：同 ID 冲突不得静默覆盖，取数只返回「本人 且 本人可见」。
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
const AUDIT_DIR = resolve(process.cwd(), 'src', 'modules', 'audit');
const ADAPTER_PATH = resolve(AUDIT_DIR, 'audit.postgres-repository.ts');
const PORT_PATH = resolve(AUDIT_DIR, 'audit.port.ts');
const MODULE_PATH = resolve(AUDIT_DIR, 'audit.module.ts');
const IN_MEMORY_PATH = resolve(AUDIT_DIR, 'audit.in-memory-repository.ts');
const ADAPTER_CLASS = 'PostgresAuditRepository';
const ADAPTER_MODULE = 'audit.postgres-repository';

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

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ACTOR_ID = '22222222-2222-4222-8222-222222222222';
/** 含十六进制字母的归属：用于验证「规范小写形」约束（纯数字 UUID 无法体现大小写差异） */
const HEX_ACTOR_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const HEX_ACTOR_ID_UPPER = 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678';
const HEX_ACTOR_ID_MIXED = 'a1b2c3d4-E5F6-4789-8abc-DEF012345678';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_EVENT_ID = '66666666-6666-4666-8666-666666666666';
/** 含十六进制字母的主键：用于验证「规范小写形」约束 */
const HEX_EVENT_ID = 'e1f2a3b4-c5d6-4789-8efa-0123456789ab';
const HEX_EVENT_ID_UPPER = 'E1F2A3B4-C5D6-4789-8EFA-0123456789AB';
const REQUEST_ID = '77777777-7777-4777-8777-777777777777';
const RESOURCE_ID = '88888888-8888-4888-8888-888888888888';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const OCCURRED_AT = '2026-01-02T03:04:05.000Z';
const LATER_AT = '2026-01-03T04:05:06.000Z';
const SUMMARY = '读取本人审计事件摘要';
/** 「被改写后的摘要」：用于证明追加结果不得被存储层改写（合法摘要内容，但不是请求值） */
const TAMPERED_SUMMARY = '被改写后的审计摘要';
/** 注入载荷：只允许出现在参数里，绝不允许出现在 SQL 文本或错误信息里 */
const INJECTION = "x'); DROP TABLE audit_logs; --";
/** 疑似身份证号（PII）：读取契约必须拒绝，且错误信息不得回显 */
const PII_SUMMARY = '证件 11010119900307123X 待核对';
/** 疑似密钥（PII）：读取契约必须拒绝，且错误信息不得回显 */
const SECRET_SUMMARY = 'token: abcdefgh1234';
/** 明文对端地址：绝不允许作为 ipHash 入库或外发 */
const FORGED_ADDRESS = '203.0.113.7';
/** 合法 ipHash：对端地址的 sha256（64 位小写十六进制） */
const IP_HASH = createHash('sha256').update('10.0.0.1', 'utf8').digest('hex');

/** 未绑定资源的审计事件样本（列表与追加的主要样本） */
const EVENT: AuditEvent = {
  id: EVENT_ID,
  actorUserId: ACTOR_ID,
  type: AuditEventType.SelfAuditEventsRead,
  result: AuditResult.Success,
  resourceType: AuditResourceType.AuditEvent,
  summary: SUMMARY,
  selfVisible: true,
  requestId: REQUEST_ID,
  ipHash: IP_HASH,
  occurredAt: OCCURRED_AT,
};

/** 带资源标识的事件样本：用于覆盖 `resource_id` 的「有值 / 为 NULL」两条路径 */
const RESOURCE_EVENT: AuditEvent = { ...EVENT, resourceId: RESOURCE_ID };

/** 仅管理端可见的事件样本：本人摘要里绝不能出现 */
const ADMIN_ONLY_EVENT: AuditEvent = {
  ...EVENT,
  id: OTHER_EVENT_ID,
  selfVisible: false,
  resourceType: AuditResourceType.User,
};

/** 数据库行（snake_case）：默认与给定记录等价 */
function rowFromEvent(
  event: AuditEvent,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: event.id,
    actor_user_id: event.actorUserId,
    action: event.type,
    result: event.result,
    resource_type: event.resourceType,
    resource_id: event.resourceId === undefined ? null : event.resourceId,
    summary: event.summary,
    self_visible: event.selfVisible,
    request_id: event.requestId,
    ip_hash: event.ipHash,
    occurred_at: new Date(event.occurredAt),
    ...overrides,
  };
}

/** 移除某一列，用于「缺列」用例 */
function withoutRowColumn(event: AuditEvent, column: string): Record<string, unknown> {
  const row = rowFromEvent(event);
  delete row[column];
  return row;
}

/** 复制记录并去掉某个字段（模拟「缺必填字段」的写入记录） */
function omitField(event: AuditEvent, field: keyof AuditEvent): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...event };
  delete copy[field];
  return copy;
}

/** 造一批稳定且唯一的 UUID（版本位 4、变体位 8，满足 uuidSchema） */
function uuidForIndex(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** 用给定响应构造 adapter（响应按调用顺序消费） */
function repoWith(...responses: unknown[]): {
  repository: PostgresAuditRepository;
  executor: RecordingExecutor;
} {
  const executor = new RecordingExecutor(responses);
  return { repository: new PostgresAuditRepository(executor), executor };
}

async function captureRepoError(
  run: () => Promise<unknown>,
): Promise<PostgresAuditRepositoryError> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresAuditRepositoryError);
  return captured as PostgresAuditRepositoryError;
}

function captureSyncError(run: () => unknown): PostgresAuditRepositoryError {
  let captured: unknown;
  try {
    run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresAuditRepositoryError);
  return captured as PostgresAuditRepositoryError;
}

/**
 * 断言 `issues` 里存在指向某个字段路径的违规。
 *
 * `issues` 的形状是 `字段路径(违规类型)`（例如 `action(invalid_enum_value)`），违规类型取决于
 * zod 的 issue code，因此只固定「指向哪个字段」，不把违规类型写死（那属于实现细节）。
 * 存储 ID 域约束走的是 adapter 自有的 `requireStorageUuid`，它只给出裸字段路径（例如 `id`），
 * 因此裸路径同样算命中。
 */
function expectIssueOn(error: PostgresAuditRepositoryError, path: string): void {
  expect(error.issues.some((issue) => issue === path || issue.startsWith(`${path}(`))).toBe(true);
}

/**
 * 断言 `issues` 里存在指向给定若干字段路径之一的违规。
 *
 * 同一概念在写路径上是驼峰字段名（`actorUserId`，由共享读取契约给出），在存储域约束上是
 * snake_case 列名（`actor_user_id`，由 adapter 的 `requireStorageUuid` 给出），因此需要
 * 「之一命中」的断言，而不是把某一侧的命名写死。
 */
function expectIssueOnAny(error: PostgresAuditRepositoryError, paths: readonly string[]): void {
  expect(
    error.issues.some((issue) =>
      paths.some((path) => issue === path || issue.startsWith(`${path}(`)),
    ),
  ).toBe(true);
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
  const index = [...POSTGRES_AUDIT_COLUMNS].indexOf(
    column as (typeof POSTGRES_AUDIT_COLUMNS)[number],
  );
  expect(index).toBeGreaterThanOrEqual(0);
  return call?.parameters?.[index];
}

/** 单词边界命中（避免 `ip` 命中 `ip_hash`、`request_path` 命中 `request_headers` 之类） */
function containsWord(sql: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'u').test(sql);
}

/**
 * 语句卫生：只由模块常量与 `$n` 占位符构成。
 *
 * 没有任何引号 ⇒ 语句里不存在字符串字面量（因此没有「值 → SQL 文本」的注入面）；
 * 没有分号 / `--` ⇒ 不存在语句拼接与注释截断面。
 */
function expectParameterizedSql(sql: string): void {
  expect(sql).not.toMatch(/['";]/u);
  expect(sql).not.toContain('--');
  expect(sql).not.toContain('*');
  expect(sql).not.toMatch(/\b(?:DROP|ALTER|TRUNCATE|GRANT|COPY|DELETE|UPDATE)\b/u);
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
  const parsed = parseStoredAuditEvent(RESOURCE_EVENT);
  if (!parsed.ok) {
    throw new Error('样本记录未通过共享读取契约');
  }
  return Object.keys(parsed.value).sort();
}

/** camelCase 期望值：用于证明「列 → 字段」只有 `action → type` 一处非同名映射 */
function camelCase(column: string): string {
  return column.replace(/_([a-z0-9])/gu, (_match, char: string) => char.toUpperCase());
}

/** 失败路径的信息卫生断言：错误信息与 issues 都不含任何取值 */
function expectNoValueLeak(error: PostgresAuditRepositoryError): void {
  const text = `${error.message} ${error.issues.join(' ')}`;
  for (const forbidden of [
    ACTOR_ID,
    OTHER_ACTOR_ID,
    HEX_ACTOR_ID,
    EVENT_ID,
    OTHER_EVENT_ID,
    HEX_EVENT_ID,
    REQUEST_ID,
    RESOURCE_ID,
    SUMMARY,
    OCCURRED_AT,
    LATER_AT,
    INJECTION,
    FORGED_ADDRESS,
    IP_HASH,
    '11010119900307123X',
    'abcdefgh1234',
  ]) {
    expect(text).not.toContain(forbidden);
  }
  // 冒号与引号意味着「键=值」形态的回显（issues 只允许 `字段路径(违规类型)`）
  expect(error.issues.every((issue) => !issue.includes(':') && !issue.includes('='))).toBe(true);
}

/** 断言「执行过的 SQL 都是仅追加的读 / 写」，并返回全部 SQL 文本 */
function expectAppendOnlySql(executor: RecordingExecutor): readonly string[] {
  const statements = executor.calls.map((call) => call.sql);
  for (const sql of statements) {
    expect(sql).toMatch(/\b(?:INSERT|SELECT)\b/u);
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|ALTER|DROP|GRANT)\b/u);
    expect(sql).not.toContain('ON CONFLICT (id) DO UPDATE');
  }
  return statements;
}

describe('PostgreSQL 审计仓储：能力声明与交付边界', () => {
  it('能力声明恰好是 postgres / persistent=true / productionReady=false，且被冻结', () => {
    expect(POSTGRES_AUDIT_REPOSITORY_CAPABILITIES).toEqual({
      backend: AUDIT_REPOSITORY_BACKEND_POSTGRES,
      persistent: true,
      productionReady: false,
    });
    expect(AUDIT_REPOSITORY_BACKEND_POSTGRES).toBe('postgres');
    expect(Object.isFrozen(POSTGRES_AUDIT_REPOSITORY_CAPABILITIES)).toBe(true);
    expect(AUDIT_REPOSITORY_STORAGE_ID_DOMAIN).toBe('uuid');
  });

  it('本 adapter 声明 persistent=true 但 productionReady=false（未真实驱动验证前严禁生产）', () => {
    const { repository } = repoWith();
    expect(repository.capabilities.persistent).toBe(true);
    expect(repository.capabilities.productionReady).toBe(false);
    expect(repository.capabilities.backend).toBe('postgres');
  });

  it('验证清单覆盖「驱动 → 集成 → 草案转迁移 → 存储层禁止改写 → 异步端口 → UUID 主体 → 列名对齐 → 视图裁剪复核 → 才可声明生产」九步', () => {
    expect([...POSTGRES_AUDIT_REPOSITORY_VERIFICATION_STEPS]).toEqual([
      'driver-dependency-evaluated',
      'integration-tests-against-real-postgres',
      'audit-logs-schema-draft-created-and-promoted-to-migration',
      'append-only-enforced-at-storage-layer',
      'audit-repository-port-migrated-to-async',
      'session-subject-actor-ids-converged-to-uuid',
      'audit-column-names-aligned-with-field-dictionary',
      'public-view-exclusion-verified-against-real-queries',
      'production-ready-capability-flipped-with-evidence',
    ]);
  });

  it('自检放行当前声明，但拒绝「未验证就声称生产可用」/ 非持久 / 非 postgres', () => {
    expect(() => assertPostgresAuditRepositoryCapabilities()).not.toThrow();

    const cases: readonly AuditRepositoryCapabilities[] = [
      { backend: 'postgres', persistent: true, productionReady: true },
      { backend: 'postgres', persistent: false, productionReady: false },
      { backend: 'in-memory-baseline', persistent: true, productionReady: false },
    ];
    for (const capabilities of cases) {
      const error = captureSyncError(() => assertPostgresAuditRepositoryCapabilities(capabilities));
      expect(error.code).toBe('CAPABILITY_MISDECLARED');
      expect(error.message).toContain('不得声称生产可用');
      expectNoValueLeak(error);
    }
  });

  it('列清单与读取契约字段构成双射（列→字段 与 字段→列 互为逆映射）', () => {
    const contractFields = readContractFields();
    expect(contractFields).toEqual(
      [...POSTGRES_AUDIT_COLUMNS].map((column) => POSTGRES_AUDIT_COLUMN_FIELDS[column]).sort(),
    );
    expect(contractFields).toEqual(Object.keys(POSTGRES_AUDIT_FIELD_COLUMNS).sort());

    // 双射：任一方向都必须是另一方向的逆
    for (const column of POSTGRES_AUDIT_COLUMNS) {
      const field = POSTGRES_AUDIT_COLUMN_FIELDS[column];
      expect(POSTGRES_AUDIT_FIELD_COLUMNS[field]).toBe(column);
    }
    // 写入路径的别名不存在：字段名集合恰好是列 → 字段的像集
    expect(new Set(Object.keys(POSTGRES_AUDIT_FIELD_COLUMNS)).size).toBe(
      POSTGRES_AUDIT_COLUMNS.length,
    );
  });

  it('列清单刻意为 11 列、无 SELECT *：内部列不在其中', () => {
    expect([...POSTGRES_AUDIT_COLUMNS]).toEqual([
      'id',
      'actor_user_id',
      'action',
      'result',
      'resource_type',
      'resource_id',
      'summary',
      'self_visible',
      'request_id',
      'ip_hash',
      'occurred_at',
    ]);
    for (const internal of POSTGRES_AUDIT_INTERNAL_COLUMNS) {
      expect([...POSTGRES_AUDIT_COLUMNS]).not.toContain(internal);
    }
  });

  it('字典的 `action` 列映射到领域字段 `type`，且这是唯一的非同名映射', () => {
    // docs/P1-字段级数据字典.md §4 把「受控操作字典」命名为 action，端口命名为 type（AuditEventType）
    expect(POSTGRES_AUDIT_COLUMN_FIELDS.action).toBe('type');
    expect(POSTGRES_AUDIT_FIELD_COLUMNS.type).toBe('action');

    const nonIdentical = POSTGRES_AUDIT_COLUMNS.filter(
      (column) => POSTGRES_AUDIT_COLUMN_FIELDS[column] !== camelCase(column),
    );
    expect([...nonIdentical]).toEqual(['action']);

    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).toContain('非同名映射');
  });

  it('表名是 audit_logs，且尚未登记在迁移与草案目录中（与 productionReady=false 配对）', () => {
    expect(POSTGRES_AUDIT_TABLE).toBe('audit_logs');
    expect(/^[a-z][a-z0-9_]*$/u.test(POSTGRES_AUDIT_TABLE)).toBe(true);

    for (const file of readdirSync(join(REPO_ROOT, 'db', 'migrations'))) {
      if (!file.endsWith('.sql')) continue;
      const sql = readFileSync(join(REPO_ROOT, 'db', 'migrations', file), 'utf8');
      expect(sql).not.toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?audit_logs\b/iu);
    }
    for (const file of readdirSync(join(REPO_ROOT, 'db', 'schema-drafts'))) {
      if (!file.endsWith('.sql')) continue;
      const draft = readFileSync(join(REPO_ROOT, 'db', 'schema-drafts', file), 'utf8');
      expect(draft).not.toMatch(/^--\s*target-table:\s*audit_logs\s*$/imu);
    }

    expect(POSTGRES_AUDIT_REPOSITORY_CAPABILITIES.productionReady).toBe(false);
    expect(POSTGRES_AUDIT_REPOSITORY_VERIFICATION_STEPS).toContain(
      'audit-logs-schema-draft-created-and-promoted-to-migration',
    );
  });

  it('归属列 / 高敏列 / 存储侧内部列 / 公开输出裁剪列各有明确清单', () => {
    expect([...POSTGRES_AUDIT_OWNER_COLUMNS]).toEqual(['actor_user_id']);

    // 请求头、user-agent、明文 IP / 对端地址、路径、URL、方法、payload、快照、理由、内部审计字段
    expect([...POSTGRES_AUDIT_INTERNAL_COLUMNS]).toEqual([
      'ip',
      'peer_address',
      'request_headers',
      'user_agent',
      'request_path',
      'request_url',
      'request_method',
      'payload',
      'before',
      'after',
      'reason',
      'integrity_hash',
      'prev_hash',
      'sequence',
      'deleted_at',
      'idempotency_key',
    ]);
    for (const category of [
      'request_headers',
      'user_agent',
      'ip',
      'peer_address',
      'request_path',
      'request_url',
      'payload',
      'before',
      'after',
      'reason',
      'integrity_hash',
    ]) {
      expect([...POSTGRES_AUDIT_INTERNAL_COLUMNS]).toContain(category);
    }

    // 高敏列（合法存储内容，但不进错误消息与日志）
    expect([...POSTGRES_AUDIT_PII_COLUMNS]).toEqual([
      'actor_user_id',
      'ip_hash',
      'summary',
      'ip',
      'peer_address',
      'request_headers',
      'user_agent',
      'payload',
      'before',
      'after',
      'reason',
    ]);

    // 裁剪清单 = 归属 + 关联 ID + 网络归属 + 可见性口径 + 资源标识 + 全部内部列
    expect([...POSTGRES_AUDIT_VIEW_EXCLUDED_COLUMNS]).toEqual([
      'actor_user_id',
      'request_id',
      'ip_hash',
      'self_visible',
      'resource_id',
      ...POSTGRES_AUDIT_INTERNAL_COLUMNS,
    ]);
  });

  it('仅追加：端口与 adapter 都没有改写 / 删除入口，且禁止清单非空', () => {
    expect([...POSTGRES_AUDIT_FORBIDDEN_METHODS]).toEqual([
      'save',
      'update',
      'delete',
      'remove',
      'archive',
      'purge',
      'truncate',
      'upsert',
      'insertOrUpdate',
    ]);

    const { repository } = repoWith();
    // 端口层面「审计删除能力不存在」：这些方法在实例上一个都不存在
    for (const forbidden of POSTGRES_AUDIT_FORBIDDEN_METHODS) {
      expect(forbidden in repository).toBe(false);
    }
    expect(typeof repository.append).toBe('function');
    expect(typeof repository.listVisibleByActor).toBe('function');

    // 同步端口与异步契约都只有「追加 + 按主体取数」两个方法（类型层面的断言）
    const asSyncPort: AuditRepository = {
      capabilities: POSTGRES_AUDIT_REPOSITORY_CAPABILITIES,
      append: (event) => event,
      listVisibleByActor: () => [],
    };
    const asAsyncPort: AsyncAuditRepository = repository;
    for (const port of [asSyncPort, asAsyncPort] as const) {
      expect(typeof port.append).toBe('function');
      expect(typeof port.listVisibleByActor).toBe('function');
      for (const forbidden of POSTGRES_AUDIT_FORBIDDEN_METHODS) {
        expect(forbidden in port).toBe(false);
      }
    }
  });

  it('实现的是异步仓储契约（Promise 语义），未被绑定为同步端口', async () => {
    const repository: AsyncAuditRepository = new PostgresAuditRepository(
      new RecordingExecutor([{ rows: [rowFromEvent(EVENT)], rowCount: 1 }]),
    );
    const appended = repository.append(EVENT);
    expect(appended).toBeInstanceOf(Promise);
    await expect(appended).resolves.toEqual(EVENT);
    // 同步端口要求同步返回值：返回 Promise 说明实现的确实是并存的异步契约
    expect(appended).not.toEqual(EVENT);
  });

  it('adapter 不是 Nest provider：源码不含 @Injectable / @Module / Inject( / @nestjs', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).not.toContain('@Injectable');
    expect(source).not.toContain('@Module');
    expect(source).not.toContain('Inject(');
    expect(source).not.toContain('@nestjs');
    expect(source).not.toContain('APP_ENV');
  });

  it('异步契约与同步端口方法集逐字对应，DI 令牌与同步端口名一字未改', () => {
    const source = readFileSync(PORT_PATH, 'utf8');
    expect(source).toContain('export interface AuditRepository {');
    expect(source).toContain('append(event: AuditEvent): AuditEvent;');
    expect(source).toContain('listVisibleByActor(actorUserId: string): readonly AuditEvent[];');

    expect(source).toContain('export interface AsyncAuditRepository {');
    expect(source).toContain('append(event: AuditEvent): Promise<AuditEvent>;');
    expect(source).toContain(
      'listVisibleByActor(actorUserId: string): Promise<readonly AuditEvent[]>;',
    );
    expect(source).toContain('export const AUDIT_REPOSITORY_BACKEND_POSTGRES');
    expect(source).toContain('export const AUDIT_REPOSITORY_STORAGE_ID_DOMAIN');
    expect(source).toContain("export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');");
    // 只有两个方法：没有任何 update / delete 契约（仅追加在类型层面即不可表达）
    expect(source).not.toMatch(/\b(?:update|delete|remove|archive)\s*\(/u);
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
        './audit.contract',
        './audit.port',
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
});

describe('PostgreSQL 审计仓储：执行器 fail-closed', () => {
  it('没有执行器 / 执行器缺 query / 缺能力声明 → 构造即拒绝，且不执行任何 SQL', () => {
    const cases: readonly unknown[] = [
      undefined,
      null,
      {},
      { capabilities: { backend: 'postgres', persistent: true, productionReady: false } },
      { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
    ];
    for (const candidate of cases) {
      const error = captureSyncError(
        () => new PostgresAuditRepository(candidate as unknown as SqlExecutor),
      );
      expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
      expectNoValueLeak(error);
    }
  });

  it('执行器声明的后端不是 PostgreSQL → 拒绝（不得把 adapter 挂到其他存储上）', () => {
    const executor = new RecordingExecutor();
    executor.capabilities = {
      backend: 'sqlite',
      persistent: true,
      productionReady: true,
    };
    const error = captureSyncError(() => new PostgresAuditRepository(executor));
    expect(error.code).toBe('EXECUTOR_NOT_POSTGRES');
    expect(executor.calls).toHaveLength(0);
    expectNoValueLeak(error);
  });

  it('执行器声明为非持久后端（内存替身）→ 拒绝', () => {
    const executor = new RecordingExecutor();
    executor.capabilities = {
      backend: 'postgres-test-double',
      persistent: false,
      productionReady: false,
    };
    const error = captureSyncError(() => new PostgresAuditRepository(executor));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
    expectNoValueLeak(error);
  });

  it('构造后执行器被降级为非持久 → 下一次调用 fail-closed，且不再访问 SQL', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
    executor.capabilities = {
      backend: 'postgres-test-double',
      persistent: false,
      productionReady: false,
    };
    const error = await captureRepoError(() => repository.append(EVENT));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
    expectNoValueLeak(error);
  });

  it('构造后能力声明被改写为「生产可用」→ 每次调用都 fail-closed（自检不被绕过）', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
    (repository as { capabilities: AuditRepositoryCapabilities }).capabilities = {
      backend: 'postgres',
      persistent: true,
      productionReady: true,
    };

    for (const run of [
      () => repository.append(EVENT),
      () => repository.listVisibleByActor(ACTOR_ID),
    ]) {
      const error = await captureRepoError(run);
      expect(error.code).toBe('CAPABILITY_MISDECLARED');
      expect(error.message).toContain('不得声称生产可用');
    }
    // 自检发生在任何 SQL 之前
    expect(executor.calls).toHaveLength(0);
  });

  it('结果集缺少 rows 数组 / 结果不是对象 → 判驱动缺陷，不伪装成「该主体尚无审计事件」', async () => {
    const missingRows = repoWith({ rowCount: 0 });
    const first = await captureRepoError(() => missingRows.repository.listVisibleByActor(ACTOR_ID));
    expect(first.code).toBe('INVALID_ROW');
    expectIssueOn(first, 'rows');
    expectNoValueLeak(first);

    const notAnObject = repoWith('2026-01-02T03:04:05.000Z');
    const second = await captureRepoError(() =>
      notAnObject.repository.listVisibleByActor(ACTOR_ID),
    );
    expect(second.code).toBe('INVALID_ROW');
    expectIssueOn(second, 'result');
    expectNoValueLeak(second);
  });

  it('空列表返回 []（不是抛错、也不是空对象）；带资源的记录正常往返', async () => {
    const { repository } = repoWith({ rows: [], rowCount: 0 });
    await expect(repository.listVisibleByActor(ACTOR_ID)).resolves.toEqual([]);

    const withResource = repoWith({ rows: [rowFromEvent(RESOURCE_EVENT)], rowCount: 1 });
    await expect(withResource.repository.listVisibleByActor(ACTOR_ID)).resolves.toEqual([
      RESOURCE_EVENT,
    ]);
    // 无资源标识的记录不带 resourceId 字段（不是 undefined 占位）
    const withoutResource = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
    const [record] = await withoutResource.repository.listVisibleByActor(ACTOR_ID);
    expect(record === undefined ? true : 'resourceId' in record).toBe(false);
  });
});

describe('PostgreSQL 审计仓储：参数化 SQL 与固定标识符', () => {
  it('追加使用占位符绑定：SQL 只由常量与 $n 组成，参数按列顺序传入', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromEvent(RESOURCE_EVENT)],
      rowCount: 1,
    });
    await expect(repository.append(RESOURCE_EVENT)).resolves.toEqual(RESOURCE_EVENT);

    const call = callAt(executor, 0);
    expect(call).toBeDefined();
    expect(call?.sql).toContain(`INSERT INTO ${POSTGRES_AUDIT_TABLE}`);
    expectParameterizedSql(call?.sql ?? '');

    // 参数数量与列清单严格一致，且逐列对应（顺序由列清单派生，不会漂移）
    expect(call?.parameters).toHaveLength(POSTGRES_AUDIT_COLUMNS.length);
    expect(placeholderIndexes(call?.sql ?? '')).toHaveLength(POSTGRES_AUDIT_COLUMNS.length);
    for (const column of POSTGRES_AUDIT_COLUMNS) {
      const field = POSTGRES_AUDIT_COLUMN_FIELDS[column];
      const expected = field === 'resourceId' ? RESOURCE_EVENT.resourceId : RESOURCE_EVENT[field];
      expect(parameterAt(call, column)).toBe(expected);
    }
    expect(parameterAt(call, 'action')).toBe(AuditEventType.SelfAuditEventsRead);
    expect(parameterAt(call, 'resource_id')).toBe(RESOURCE_ID);
  });

  it('追加语句没有 DO UPDATE，也没有任何子查询（端口只追加）', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
    await repository.append(EVENT);

    const sql = callAt(executor, 0)?.sql ?? '';
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(sql).not.toContain('DO UPDATE');
    expect(sql).not.toMatch(/\bSELECT\b/u);
    // 只有一次写入调用：不存在「写入后再覆盖」的第二条语句
    expect(executor.calls).toHaveLength(1);
  });

  it('按主体取数把归属与可见性一起下推进 SQL：只有一个占位符，列清单显式', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
    await repository.listVisibleByActor(ACTOR_ID);

    const call = callAt(executor, 0);
    expect(call?.sql).toContain('WHERE actor_user_id = $1::uuid');
    expect(call?.sql).toContain('self_visible = TRUE');
    expect(call?.sql).toContain(`FROM ${POSTGRES_AUDIT_TABLE}`);
    expect(call?.parameters).toEqual([ACTOR_ID]);
    expect(placeholderIndexes(call?.sql ?? '')).toEqual([1]);
    for (const column of POSTGRES_AUDIT_COLUMNS) {
      expect(containsWord(call?.sql ?? '', column)).toBe(true);
    }
    // 显式列清单：不出现 SELECT *
    expect(call?.sql).not.toContain('*');
    expect(call?.sql).toContain('ORDER BY occurred_at ASC, id ASC');
  });

  it('表名与列清单只由模块常量构成且都是裸标识符，占位符数量与参数数量一致', async () => {
    expect(/^[a-z][a-z0-9_]*$/u.test(POSTGRES_AUDIT_TABLE)).toBe(true);
    for (const column of POSTGRES_AUDIT_COLUMNS) {
      expect(/^[a-z][a-z0-9_]*$/u.test(column)).toBe(true);
    }

    const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
    await repository.append(EVENT);
    await repository.listVisibleByActor(ACTOR_ID);

    for (const call of executor.calls) {
      const placeholders = placeholderIndexes(call.sql);
      expect(call.parameters).toHaveLength(placeholders.length);
      expect(placeholders).toEqual(
        Array.from({ length: placeholders.length }, (_value, index) => index + 1),
      );
    }
  });

  it('摘要里的注入载荷只进参数：SQL 文本与正常输入逐字节相同', async () => {
    const poisoned: AuditEvent = { ...EVENT, summary: INJECTION };
    const clean = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
    const dirty = repoWith({ rows: [rowFromEvent(poisoned)], rowCount: 1 });

    await clean.repository.append(EVENT);
    await dirty.repository.append(poisoned);

    expect(callAt(dirty.executor, 0)?.sql).toBe(callAt(clean.executor, 0)?.sql);
    expect(callAt(dirty.executor, 0)?.sql).not.toContain('DROP TABLE');
    expect(parameterAt(callAt(dirty.executor, 0), 'summary')).toBe(INJECTION);
  });

  it('主体不是合法 UUID / 非规范小写形 / 空 UUID 时在进入 SQL 之前就被拒绝，且不访问数据库', async () => {
    const cases: readonly string[] = [
      'u-student-1',
      '',
      'not-a-uuid',
      NIL_UUID,
      HEX_ACTOR_ID_UPPER,
      HEX_ACTOR_ID_MIXED,
      "x' OR 1=1 --",
    ];
    for (const actorUserId of cases) {
      const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
      const error = await captureRepoError(() => repository.listVisibleByActor(actorUserId));
      expect(error.code).toBe('INVALID_SUBJECT');
      expectIssueOn(error, 'actorUserId');
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
      expect(error.message).not.toContain(actorUserId === '' ? '\u0000' : actorUserId);
    }
  });

  it('行契约的 action 列不接受大小写漂移 / 未登记 / 注入式取值，且错误信息不回显取值', async () => {
    for (const action of ['unknown_type', 'AUDIT_SELF_EVENTS_READ', INJECTION, 42, null]) {
      const { repository } = repoWith({
        rows: [rowFromEvent(EVENT, { action })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listVisibleByActor(ACTOR_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, 'action');
      expectNoValueLeak(error);
    }
  });

  it('SQL 语句里没有任何字面量注入面：无引号 / 无分号 / 无注释符 / 无危险关键字', async () => {
    const quoted: AuditEvent = { ...EVENT, summary: "1' OR '1'='1" };
    const { repository, executor } = repoWith(
      { rows: [rowFromEvent({ ...EVENT, summary: INJECTION })], rowCount: 1 },
      { rows: [rowFromEvent(EVENT)], rowCount: 1 },
      { rows: [rowFromEvent(quoted)], rowCount: 1 },
    );
    await repository.append({ ...EVENT, summary: INJECTION });
    await repository.listVisibleByActor(ACTOR_ID);
    await repository.append(quoted);

    for (const call of executor.calls) {
      expectParameterizedSql(call.sql);
    }
  });

  it('执行过的全部 SQL 只含 INSERT 与 SELECT：没有任何 UPDATE / DELETE / TRUNCATE（仅追加）', async () => {
    const secondEvent: AuditEvent = { ...EVENT, id: OTHER_EVENT_ID };
    const { repository, executor } = repoWith(
      { rows: [rowFromEvent(EVENT)], rowCount: 1 },
      { rows: [rowFromEvent(EVENT)], rowCount: 1 },
      { rows: [rowFromEvent(secondEvent)], rowCount: 1 },
    );
    await repository.append(EVENT);
    await repository.listVisibleByActor(ACTOR_ID);
    await repository.append(secondEvent);

    const statements = expectAppendOnlySql(executor);
    expect(statements).toHaveLength(3);
    expect(statements.filter((sql) => sql.includes('INSERT'))).toHaveLength(2);
    expect(statements.filter((sql) => sql.includes('SELECT'))).toHaveLength(1);
  });
});

describe('PostgreSQL 审计仓储：严格行契约与未知列', () => {
  it('数据库返回未登记列（请求头 / UA / IP / 路径 / URL / payload / 快照 / 理由 / 内部审计字段）→ 整行拒绝', async () => {
    for (const internal of POSTGRES_AUDIT_INTERNAL_COLUMNS) {
      const { repository } = repoWith({
        rows: [rowFromEvent(EVENT, { [internal]: 'internal-value' })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listVisibleByActor(ACTOR_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, `${internal}(unexpected)`);
      expectNoValueLeak(error);
    }

    // 其它未登记列（归属别名、权限字段、软删除别名）同样整行拒绝
    for (const extra of ['user_id', 'actor_user_id_alias', 'permissions', 'deleted', 'note']) {
      const { repository } = repoWith({
        rows: [rowFromEvent(EVENT, { [extra]: 'x' })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listVisibleByActor(ACTOR_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, `${extra}(unexpected)`);
    }
  });

  it('缺列同样 fail-closed：列清单里的每一列缺失都必须被拒绝', async () => {
    for (const column of POSTGRES_AUDIT_COLUMNS) {
      const { repository } = repoWith({
        rows: [withoutRowColumn(RESOURCE_EVENT, column)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listVisibleByActor(ACTOR_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, column);
      expectNoValueLeak(error);
    }
  });

  it('写路径字段污染（snake_case 别名 / 归属别名 / 内部列 / 权限字段）→ INVALID_RECORD，且不写库', async () => {
    const polluted: readonly Record<string, unknown>[] = [
      { ...EVENT, user_id: ACTOR_ID },
      { ...EVENT, actor_user_id: ACTOR_ID },
      { ...EVENT, actorId: ACTOR_ID },
      { ...EVENT, action: EVENT.type },
      { ...EVENT, request_headers: { 'x-forwarded-for': FORGED_ADDRESS } },
      { ...EVENT, ip: FORGED_ADDRESS },
      { ...EVENT, payload: { secret: 'x' } },
      { ...EVENT, before: { summary: 'old' } },
      { ...EVENT, reason: '代改' },
      { ...EVENT, permissions: ['audit:read'] },
      { ...EVENT, role: 'admin' },
    ];
    for (const record of polluted) {
      const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
      const error = await captureRepoError(() =>
        repository.append(record as unknown as AuditEvent),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(error.issues.some((issue) => issue.endsWith('(unexpected)'))).toBe(true);
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
  });

  it('写入记录缺失必填字段 / 类型不对 → INVALID_RECORD，且不写库', async () => {
    for (const field of [
      'id',
      'actorUserId',
      'type',
      'result',
      'resourceType',
      'summary',
      'selfVisible',
      'requestId',
      'ipHash',
      'occurredAt',
    ] as const) {
      const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
      const error = await captureRepoError(() =>
        repository.append(omitField(EVENT, field) as unknown as AuditEvent),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expectIssueOn(error, field);
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }

    for (const record of [undefined, null, [], 'audit']) {
      const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
      const error = await captureRepoError(() =>
        repository.append(record as unknown as AuditEvent),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(executor.calls).toHaveLength(0);
    }
  });

  it('非法 event / action：闭集外的取值在写路径与读路径都被拦下', async () => {
    for (const bad of ['unknown_type', 'AUDIT_SELF_EVENTS_READ', '', INJECTION]) {
      const write = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
      const writeError = await captureRepoError(() =>
        write.repository.append({ ...EVENT, type: bad as AuditEventType }),
      );
      expect(writeError.code).toBe('INVALID_RECORD');
      expectIssueOn(writeError, 'type');
      expect(write.executor.calls).toHaveLength(0);
      expectNoValueLeak(writeError);

      const read = repoWith({ rows: [rowFromEvent(EVENT, { action: bad })], rowCount: 1 });
      const readError = await captureRepoError(() => read.repository.listVisibleByActor(ACTOR_ID));
      expect(readError.code).toBe('INVALID_ROW');
      expectIssueOn(readError, 'action');
      expectNoValueLeak(readError);
    }
  });

  it('非法 result / resource_type：闭集外的取值一律拒绝（读路径与写路径）', async () => {
    const writeResult = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
    const firstError = await captureRepoError(() =>
      writeResult.repository.append({ ...EVENT, result: 'partial' as AuditResult }),
    );
    expect(firstError.code).toBe('INVALID_RECORD');
    expectIssueOn(firstError, 'result');

    const writeResource = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
    const secondError = await captureRepoError(() =>
      writeResource.repository.append({
        ...EVENT,
        resourceType: 'unknown_resource' as AuditResourceType,
      }),
    );
    expect(secondError.code).toBe('INVALID_RECORD');
    expectIssueOn(secondError, 'resourceType');

    const read = repoWith({
      rows: [rowFromEvent(EVENT, { result: 'partial', resource_type: 'unknown_resource' })],
      rowCount: 1,
    });
    const thirdError = await captureRepoError(() => read.repository.listVisibleByActor(ACTOR_ID));
    expect(thirdError.code).toBe('INVALID_ROW');
    expectNoValueLeak(thirdError);
  });

  it('非法 time：坏时间戳 / 非 ISO / 数字 / 缺列一律拒绝，不把非法时间静默归一', async () => {
    const badTimes: readonly unknown[] = [
      'not-a-timestamp',
      '2026/01/05',
      '2026-01-02',
      '',
      42,
      null,
      new Date('invalid'),
      { iso: OCCURRED_AT },
    ];
    for (const occurredAt of badTimes) {
      const { repository } = repoWith({
        rows: [rowFromEvent(EVENT, { occurred_at: occurredAt })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listVisibleByActor(ACTOR_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, 'occurred_at');
      expectNoValueLeak(error);
    }

    // 写路径同样拒绝非 ISO 时间：不得把客户端 / 调用方提交的坏时间写进存储
    for (const occurredAt of ['2026/01/05', 'not-a-timestamp', '2026-01-02']) {
      const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
      const error = await captureRepoError(() => repository.append({ ...EVENT, occurredAt }));
      expect(error.code).toBe('INVALID_RECORD');
      expectIssueOn(error, 'occurredAt');
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }

    // ISO 字符串与 Date 两种驱动返回形态都接受（形状合法，不是「拒绝一切」）
    const isoString = repoWith({
      rows: [rowFromEvent(EVENT, { occurred_at: OCCURRED_AT })],
      rowCount: 1,
    });
    await expect(isoString.repository.listVisibleByActor(ACTOR_ID)).resolves.toEqual([EVENT]);
    const later = repoWith({
      rows: [rowFromEvent(EVENT, { occurred_at: new Date(LATER_AT) })],
      rowCount: 1,
    });
    const [record] = await later.repository.listVisibleByActor(ACTOR_ID);
    expect(record?.occurredAt).toBe(LATER_AT);
  });

  it('摘要里的高敏内容（身份证号、疑似密钥）由读取契约拒绝，且不回显', async () => {
    for (const summary of [PII_SUMMARY, SECRET_SUMMARY, '']) {
      const read = repoWith({ rows: [rowFromEvent(EVENT, { summary })], rowCount: 1 });
      const readError = await captureRepoError(() => read.repository.listVisibleByActor(ACTOR_ID));
      expect(readError.code).toBe('INVALID_ROW');
      expectIssueOn(readError, 'summary');
      expectNoValueLeak(readError);

      const write = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
      const writeError = await captureRepoError(() =>
        write.repository.append({ ...EVENT, summary }),
      );
      expect(writeError.code).toBe('INVALID_RECORD');
      expectIssueOn(writeError, 'summary');
      expect(write.executor.calls).toHaveLength(0);
      expectNoValueLeak(writeError);
    }
  });

  it('控制字符由读取契约兜底拒绝', async () => {
    const { repository } = repoWith({
      rows: [rowFromEvent(EVENT, { summary: 'bad\u0000summary' })],
      rowCount: 1,
    });
    const error = await captureRepoError(() => repository.listVisibleByActor(ACTOR_ID));
    expect(error.code).toBe('INVALID_ROW');
    expectIssueOn(error, 'summary');
  });

  it('ip_hash 只接受 sha256 十六进制：明文 IP / 大写 / 长度不足一律拒绝', async () => {
    for (const ipHash of [FORGED_ADDRESS, '127.0.0.1', 'A'.repeat(64), 'a'.repeat(63)]) {
      const { repository } = repoWith({
        rows: [rowFromEvent(EVENT, { ip_hash: ipHash })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listVisibleByActor(ACTOR_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, 'ip_hash');
      expectNoValueLeak(error);
    }
  });

  it('resource_id 只接受 null 或存储 ID 域内的 UUID', async () => {
    for (const resourceId of ['not-a-uuid', NIL_UUID, HEX_EVENT_ID_UPPER, 42]) {
      const { repository } = repoWith({
        rows: [rowFromEvent(EVENT, { resource_id: resourceId })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listVisibleByActor(ACTOR_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, 'resource_id');
      expectNoValueLeak(error);
    }
    await expect(
      repoWith({ rows: [rowFromEvent(EVENT, { resource_id: null })], rowCount: 1 })
        .repository.listVisibleByActor(ACTOR_ID)
        .then((records) => records[0]?.resourceId),
    ).resolves.toBeUndefined();
  });
});

describe('PostgreSQL 审计仓储：actor / subject owner 隔离与仅追加', () => {
  it('取数 SQL 必须带归属谓词与可见性谓词：否则不再是「本人可见取数」', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
    await repository.listVisibleByActor(ACTOR_ID);

    const sql = callAt(executor, 0)?.sql ?? '';
    expect(sql).toContain('WHERE actor_user_id = $1::uuid');
    expect(sql).toContain('self_visible = TRUE');
    expect(callAt(executor, 0)?.parameters).toEqual([ACTOR_ID]);
  });

  it('列表里混入他人记录 → OWNER_VIOLATION（整批 fail-closed，不静默过滤也不返回）', async () => {
    const foreign = { ...EVENT, id: OTHER_EVENT_ID, actorUserId: OTHER_ACTOR_ID };
    const { repository } = repoWith({
      rows: [rowFromEvent(EVENT), rowFromEvent(foreign, { actor_user_id: OTHER_ACTOR_ID })],
      rowCount: 2,
    });
    const error = await captureRepoError(() => repository.listVisibleByActor(ACTOR_ID));
    expect(error.code).toBe('OWNER_VIOLATION');
    expectIssueOn(error, 'actor_user_id');
    expectNoValueLeak(error);
  });

  it('列表返回未标记本人可见的记录 → VISIBILITY_VIOLATION（仅管理端可见的记录不得进入本人摘要）', async () => {
    const { repository } = repoWith({
      rows: [rowFromEvent(ADMIN_ONLY_EVENT)],
      rowCount: 1,
    });
    const error = await captureRepoError(() => repository.listVisibleByActor(ACTOR_ID));
    expect(error.code).toBe('VISIBILITY_VIOLATION');
    expectIssueOn(error, 'self_visible');
    expectNoValueLeak(error);
  });

  it('列表出现重复主键 → RESULT_SET_VIOLATION（同一记录不得在列表里出现两次）', async () => {
    const { repository } = repoWith({
      rows: [rowFromEvent(EVENT), rowFromEvent(EVENT)],
      rowCount: 2,
    });
    const error = await captureRepoError(() => repository.listVisibleByActor(ACTOR_ID));
    expect(error.code).toBe('RESULT_SET_VIOLATION');
    expectIssueOn(error, 'id');
    expectNoValueLeak(error);
  });

  it('追加返回他人归属 / 他人主键 → 分别 OWNER_VIOLATION / IDENTITY_MISMATCH', async () => {
    const ownerSwapped = repoWith({
      rows: [rowFromEvent(EVENT, { actor_user_id: OTHER_ACTOR_ID })],
      rowCount: 1,
    });
    const ownerError = await captureRepoError(() => ownerSwapped.repository.append(EVENT));
    expect(ownerError.code).toBe('OWNER_VIOLATION');
    expectIssueOn(ownerError, 'actor_user_id');
    expectNoValueLeak(ownerError);

    const idSwapped = repoWith({
      rows: [rowFromEvent(EVENT, { id: OTHER_EVENT_ID })],
      rowCount: 1,
    });
    const idError = await captureRepoError(() => idSwapped.repository.append(EVENT));
    expect(idError.code).toBe('IDENTITY_MISMATCH');
    expectIssueOn(idError, 'id');
    expectNoValueLeak(idError);
  });

  it('追加未返回行 → CONFLICT（与内存基线「ID 冲突」同语义）；返回多行 → RESULT_SET_VIOLATION', async () => {
    const conflict = repoWith({ rows: [], rowCount: 0 });
    const conflictError = await captureRepoError(() => conflict.repository.append(EVENT));
    expect(conflictError.code).toBe('CONFLICT');
    expectIssueOn(conflictError, 'id');
    expectNoValueLeak(conflictError);

    // 与内存基线同语义：同 ID 冲突抛错、不得静默覆盖
    const baseline = new InMemoryAuditRepository(loadEnv({}));
    baseline.append(EVENT);
    expect(() => baseline.append(EVENT)).toThrow(/审计事件 ID 冲突/u);

    const multi = repoWith({ rows: [rowFromEvent(EVENT), rowFromEvent(EVENT)], rowCount: 2 });
    const multiError = await captureRepoError(() => multi.repository.append(EVENT));
    expect(multiError.code).toBe('RESULT_SET_VIOLATION');
    expectNoValueLeak(multiError);
  });

  it('追加后逐列被改写 → 逐列 fail-closed（覆盖除归属与主键外的全部列）', async () => {
    const tampered: readonly (readonly [string, unknown])[] = [
      ['action', AuditEventType.MembershipApply],
      ['result', AuditResult.Denied],
      ['resource_type', AuditResourceType.Membership],
      ['resource_id', EVENT_ID],
      ['summary', TAMPERED_SUMMARY],
      ['self_visible', false],
      ['request_id', EVENT_ID],
      ['ip_hash', createHash('sha256').update('198.51.100.9', 'utf8').digest('hex')],
      ['occurred_at', new Date(LATER_AT)],
    ];
    for (const [column, value] of tampered) {
      const { repository } = repoWith({
        rows: [rowFromEvent(RESOURCE_EVENT, { [column]: value })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.append(RESOURCE_EVENT));
      expect(error.code).toBe('IDENTITY_MISMATCH');
      expectIssueOn(error, column);
      expectNoValueLeak(error);
    }
  });

  it('归属缺失 / 空 UUID / 非 UUID / 非规范小写形的写记录 → INVALID_RECORD，且不写库', async () => {
    for (const actorUserId of [
      'u-student-1',
      '',
      NIL_UUID,
      HEX_ACTOR_ID_UPPER,
      HEX_ACTOR_ID_MIXED,
    ]) {
      const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
      const error = await captureRepoError(() => repository.append({ ...EVENT, actorUserId }));
      expect(error.code).toBe('INVALID_RECORD');
      expectIssueOnAny(error, ['actor_user_id', 'actorUserId']);
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
    // 字段整体缺失
    const missing = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
    const missingError = await captureRepoError(() =>
      missing.repository.append(omitField(EVENT, 'actorUserId') as unknown as AuditEvent),
    );
    expect(missingError.code).toBe('INVALID_RECORD');
    expectIssueOn(missingError, 'actorUserId');
    expect(missing.executor.calls).toHaveLength(0);
  });

  it('主键 / requestId / resourceId 不在存储 ID 域内 → INVALID_RECORD，且不写库', async () => {
    const cases: readonly Record<string, unknown>[] = [
      { id: 'not-a-uuid' },
      { id: NIL_UUID },
      { id: HEX_EVENT_ID_UPPER },
      { requestId: 'not-a-uuid' },
      { requestId: NIL_UUID },
      { requestId: HEX_EVENT_ID_UPPER },
      { resourceId: 'not-a-uuid' },
      { resourceId: NIL_UUID },
    ];
    for (const override of cases) {
      const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
      const error = await captureRepoError(() =>
        repository.append({ ...EVENT, ...override } as AuditEvent),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expectIssueOnAny(error, ['id', 'request_id', 'requestId', 'resource_id', 'resourceId']);
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
  });

  it('规范小写 UUID 归属与主键可以正常往返（大小写约束不是「拒绝一切」）', async () => {
    const hexOwnerEvent: AuditEvent = {
      ...EVENT,
      id: HEX_EVENT_ID,
      actorUserId: HEX_ACTOR_ID,
      requestId: REQUEST_ID,
    };
    const { repository } = repoWith({ rows: [rowFromEvent(hexOwnerEvent)], rowCount: 1 });
    await expect(repository.listVisibleByActor(HEX_ACTOR_ID)).resolves.toEqual([hexOwnerEvent]);

    const appended = repoWith({ rows: [rowFromEvent(hexOwnerEvent)], rowCount: 1 });
    await expect(appended.repository.append(hexOwnerEvent)).resolves.toEqual(hexOwnerEvent);
  });

  it('行里的归属不是规范存储标识符（大写 / 空 UUID / 非 UUID）→ INVALID_ROW', async () => {
    for (const actorUserId of [HEX_ACTOR_ID_UPPER, NIL_UUID, 'u-student-1']) {
      const { repository } = repoWith({
        rows: [rowFromEvent(EVENT, { actor_user_id: actorUserId })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listVisibleByActor(ACTOR_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, 'actor_user_id');
      expectNoValueLeak(error);
    }
  });

  it('与内存基线同语义：只返回「主体本人 且 本人可见」的记录', async () => {
    const baseline = new InMemoryAuditRepository(loadEnv({}));
    baseline.append(EVENT);
    baseline.append(ADMIN_ONLY_EVENT);
    baseline.append({ ...EVENT, id: uuidForIndex(9), actorUserId: OTHER_ACTOR_ID });

    expect(baseline.listVisibleByActor(ACTOR_ID)).toHaveLength(1);
    expect(baseline.listVisibleByActor(ACTOR_ID)[0]?.id).toBe(EVENT_ID);

    // adapter 侧由 SQL 谓词 + 逐条复核共同保证同一结论
    const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
    await expect(repository.listVisibleByActor(ACTOR_ID)).resolves.toEqual([EVENT]);
    expect(callAt(executor, 0)?.sql).toContain('self_visible = TRUE');
    expect(callAt(executor, 0)?.parameters).toEqual([ACTOR_ID]);
  });

  it('大批量（500 条）完整返回、不截断：顺序与数据库返回顺序逐一一致', async () => {
    const events: AuditEvent[] = Array.from({ length: 500 }, (_value, index) => ({
      ...EVENT,
      id: uuidForIndex(index + 1),
      occurredAt: new Date(Date.parse(OCCURRED_AT) + index * 1000).toISOString(),
    }));
    const { repository } = repoWith({
      rows: events.map((event) => rowFromEvent(event)),
      rowCount: events.length,
    });
    const records = await repository.listVisibleByActor(ACTOR_ID);

    expect(records).toHaveLength(500);
    expect(records.map((record) => record.id)).toEqual(events.map((event) => event.id));
  });

  it('读取路径全部不本地截断：SQL 里不出现 LIMIT / OFFSET / FETCH', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 });
    await repository.listVisibleByActor(ACTOR_ID);

    expect(callAt(executor, 0)?.sql).not.toMatch(/\b(?:LIMIT|OFFSET|FETCH)\b/u);
  });
});

describe('PostgreSQL 审计仓储：公开视图与失败路径信息卫生', () => {
  it('存储记录承载归属（不静默丢弃），但公开视图恰好是白名单闭集且不含归属与内部字段', () => {
    const parsed = parseStoredAuditEvent(EVENT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.actorUserId).toBe(ACTOR_ID);

    expect([...AUDIT_EVENT_VIEW_FIELDS]).toEqual([
      'id',
      'type',
      'result',
      'resourceType',
      'summary',
      'occurredAt',
    ]);
    for (const forbidden of [
      'actorUserId',
      'userId',
      'requestId',
      'ipHash',
      'selfVisible',
      'resourceId',
      'requestHeaders',
      'ip',
      'path',
      'url',
      'payload',
      'before',
      'after',
      'reason',
    ]) {
      expect([...AUDIT_EVENT_VIEW_FIELDS]).not.toContain(forbidden);
    }
  });

  it('裁剪清单与公开视图白名单无交集：模块加载期自检对真实白名单放行、对泄漏白名单 fail-closed', () => {
    expect(findAuditViewExclusionLeaks(AUDIT_EVENT_VIEW_FIELDS)).toEqual([]);
    expect(() => assertAuditViewExclusion(AUDIT_EVENT_VIEW_FIELDS)).not.toThrow();

    // 逐项探针：列名本身或其映射字段名一旦出现在视图白名单里，必须被判为泄漏
    for (const column of POSTGRES_AUDIT_VIEW_EXCLUDED_COLUMNS) {
      const leaked = [...AUDIT_EVENT_VIEW_FIELDS, column];
      expect(findAuditViewExclusionLeaks(leaked)).toContain(column);

      const error = captureSyncError(() => assertAuditViewExclusion(leaked));
      expect(error.code).toBe('CAPABILITY_MISDECLARED');
      expect(error.issues).toContain(column);
      expectNoValueLeak(error);
    }
    // 字段名方向的探针（actor_user_id → actorUserId 等）
    for (const field of ['actorUserId', 'requestId', 'ipHash', 'selfVisible', 'resourceId']) {
      const leaked = [...AUDIT_EVENT_VIEW_FIELDS, field];
      expect(findAuditViewExclusionLeaks(leaked)).toContain(field);
      expect(() => assertAuditViewExclusion(leaked)).toThrow(PostgresAuditRepositoryError);
    }
  });

  it('存储侧内部列绝不进入任何被执行的 SQL（既不 SELECT 也不 RETURNING）', async () => {
    const { repository, executor } = repoWith(
      { rows: [rowFromEvent(RESOURCE_EVENT)], rowCount: 1 },
      { rows: [rowFromEvent(RESOURCE_EVENT)], rowCount: 1 },
    );
    await repository.append(RESOURCE_EVENT);
    await repository.listVisibleByActor(ACTOR_ID);

    for (const call of executor.calls) {
      for (const internal of POSTGRES_AUDIT_INTERNAL_COLUMNS) {
        expect(containsWord(call.sql, internal)).toBe(false);
      }
      // 裁剪列里只有「列清单内」的那些会出现在 SQL 里（它们承载内部存储事实，绝不进入公开视图）；
      // 其余裁剪列（存储侧内部列）一个都不许出现在 SQL 文本里
      for (const excluded of POSTGRES_AUDIT_VIEW_EXCLUDED_COLUMNS) {
        if (POSTGRES_AUDIT_COLUMNS.includes(excluded as (typeof POSTGRES_AUDIT_COLUMNS)[number])) {
          continue;
        }
        expect(containsWord(call.sql, excluded)).toBe(false);
      }
    }
    expect(
      POSTGRES_AUDIT_VIEW_EXCLUDED_COLUMNS.filter((column) =>
        POSTGRES_AUDIT_COLUMNS.includes(column as (typeof POSTGRES_AUDIT_COLUMNS)[number]),
      ),
    ).toEqual(['actor_user_id', 'request_id', 'ip_hash', 'self_visible', 'resource_id']);
  });

  it('成功路径的返回记录里不出现任何 snake_case 列名（列名只存在于 SQL 与行契约）', async () => {
    const { repository } = repoWith({
      rows: [rowFromEvent(RESOURCE_EVENT)],
      rowCount: 1,
    });
    const records = await repository.listVisibleByActor(ACTOR_ID);
    expect(records).toHaveLength(1);
    for (const key of Object.keys(records[0] ?? {})) {
      expect(key).not.toContain('_');
    }
    expect(records[0]).toEqual(RESOURCE_EVENT);
  });

  it('任何失败路径的错误信息与 issues 都不含归属标识、摘要原文、哈希、内部载荷与注入载荷', async () => {
    const failures: readonly (() => Promise<unknown>)[] = [
      () =>
        repoWith({ rows: [rowFromEvent(EVENT, { ip_hash: FORGED_ADDRESS })], rowCount: 1 })
          .repository.listVisibleByActor(ACTOR_ID)
          .then((records) => records),
      () =>
        repoWith({
          rows: [rowFromEvent(EVENT, { actor_user_id: OTHER_ACTOR_ID })],
          rowCount: 1,
        }).repository.listVisibleByActor(ACTOR_ID),
      () =>
        repoWith({
          rows: [rowFromEvent(ADMIN_ONLY_EVENT)],
          rowCount: 1,
        }).repository.listVisibleByActor(ACTOR_ID),
      () => repoWith({ rows: [], rowCount: 0 }).repository.append(EVENT),
      () =>
        repoWith({
          rows: [rowFromEvent(EVENT, { summary: PII_SUMMARY })],
          rowCount: 1,
        }).repository.listVisibleByActor(ACTOR_ID),
      () =>
        repoWith({
          rows: [rowFromEvent(EVENT, { action: INJECTION, request_headers: INJECTION })],
          rowCount: 1,
        }).repository.listVisibleByActor(ACTOR_ID),
      () =>
        repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 }).repository.append({
          ...EVENT,
          summary: INJECTION,
        }),
      () =>
        repoWith({ rows: [rowFromEvent(EVENT)], rowCount: 1 }).repository.append({
          ...EVENT,
          actorUserId: HEX_ACTOR_ID_UPPER,
        }),
    ];

    for (const run of failures) {
      let captured: unknown;
      try {
        await run();
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(PostgresAuditRepositoryError);
      expectNoValueLeak(captured as PostgresAuditRepositoryError);
    }
  });
});

describe('PostgreSQL 审计仓储：未装配、无驱动依赖、与 schema 边界对齐', () => {
  it('AuditModule 仍只绑定内存基线（本 adapter 未被装配）', () => {
    const content = readFileSync(MODULE_PATH, 'utf8');

    expect(content).not.toContain(ADAPTER_CLASS);
    expect(content).not.toContain(ADAPTER_MODULE);
    expect(content).toContain('InMemoryAuditRepository');
    expect(content).toContain(
      '{ provide: AUDIT_REPOSITORY, useExisting: InMemoryAuditRepository }',
    );
  });

  it('持久化登记与数据库模块都不引用本 adapter（端口登记表仍按令牌判定）', () => {
    for (const relative of [
      join('src', 'db', 'persistence-bindings.ts'),
      join('src', 'db', 'database.module.ts'),
      join('src', 'db', 'ports', 'sql-executor.port.ts'),
      join('src', 'modules', 'audit', 'audit.port.ts'),
      join('src', 'app.module.ts'),
      join('src', 'startup-assembly.spec.ts'),
    ]) {
      const content = readApiFile(relative);
      expect(content).not.toContain(ADAPTER_CLASS);
      expect(content).not.toMatch(
        /(?:from\s+['"][^'"]*audit\.postgres-repository['"]|require\(\s*['"][^'"]*audit\.postgres-repository['"]\s*\))/u,
      );
    }
  });

  it('内存基线仍是同步契约的实现者（本切片不改动它，也不切换内存 provider）', () => {
    const source = readFileSync(IN_MEMORY_PATH, 'utf8');
    expect(source).toContain('implements AuditRepository');
    expect(source).not.toContain(ADAPTER_CLASS);
    expect(source).toContain('persistent: false');
    expect(source).toContain('productionReady: false');
    // 内存基线也没有改写 / 删除入口
    for (const forbidden of POSTGRES_AUDIT_FORBIDDEN_METHODS) {
      expect(source).not.toMatch(new RegExp(`\\b${forbidden}\\s*\\(`, 'u'));
    }
  });

  it('同步端口契约未被改成异步（本切片只新增并存的异步契约与后端标识）', () => {
    const source = readFileSync(PORT_PATH, 'utf8');
    expect(source).toContain('export interface AuditRepository {');
    expect(source).toContain('append(event: AuditEvent): AuditEvent;');
    expect(source).toContain('listVisibleByActor(actorUserId: string): readonly AuditEvent[];');
    expect(source).toContain('export interface AsyncAuditRepository {');
    expect(source).toContain('append(event: AuditEvent): Promise<AuditEvent>;');
    expect(source).toContain('export const AUDIT_REPOSITORY_BACKEND_POSTGRES');
    expect(source).toContain('export const AUDIT_REPOSITORY_STORAGE_ID_DOMAIN');
  });

  it('adapter 的公开面覆盖能力、验证清单、列清单与仅追加事实（供上层与运维机器判定）', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    for (const exported of [
      'POSTGRES_AUDIT_TABLE',
      'POSTGRES_AUDIT_COLUMNS',
      'POSTGRES_AUDIT_COLUMN_FIELDS',
      'POSTGRES_AUDIT_FIELD_COLUMNS',
      'POSTGRES_AUDIT_OWNER_COLUMNS',
      'POSTGRES_AUDIT_INTERNAL_COLUMNS',
      'POSTGRES_AUDIT_PII_COLUMNS',
      'POSTGRES_AUDIT_VIEW_EXCLUDED_COLUMNS',
      'POSTGRES_AUDIT_FORBIDDEN_METHODS',
      'POSTGRES_AUDIT_REPOSITORY_CAPABILITIES',
      'POSTGRES_AUDIT_REPOSITORY_VERIFICATION_STEPS',
    ]) {
      expect(source).toContain(`export const ${exported}`);
    }
    expect(source).toContain('export class PostgresAuditRepository');
    expect(source).toContain('export class PostgresAuditRepositoryError');
    expect(source).toContain('export function assertPostgresAuditRepositoryCapabilities');
    expect(source).toContain('export function findAuditViewExclusionLeaks');
    expect(source).toContain('export function assertAuditViewExclusion');
    expect(source).toContain('export type PostgresAuditRepositoryErrorCode');
    // 能力声明与自检都必须以「未验证不得生产」的措辞自证
    expect(source).toContain('productionReady: false');
    expect(source).toContain('不得声称生产可用');
    // 仅追加：源码里的 SQL 模板只有 INSERT 与 SELECT，没有任何以改写 / 删除语句开头的模板
    // （注释里描述「禁止改写」的措辞不算语句；`DO UPDATE` 的缺席另由「追加语句没有 DO UPDATE」用例固定）
    expect(source).toContain('const INSERT_SQL = `INSERT INTO');
    expect(source).toContain('const SELECT_VISIBLE_BY_ACTOR_SQL = `SELECT');
    expect(source).toContain('ON CONFLICT (id) DO NOTHING');
    expect(source).not.toMatch(/`(?:UPDATE|DELETE|TRUNCATE|ALTER|DROP|GRANT|COPY)\b/u);
  });

  it('闭集取值全部可往返（本 adapter 不臆造额外收紧）', async () => {
    for (const type of AUDIT_EVENT_TYPE_VALUES) {
      const event: AuditEvent = { ...EVENT, type };
      const { repository } = repoWith(
        { rows: [rowFromEvent(event)], rowCount: 1 },
        { rows: [rowFromEvent(event)], rowCount: 1 },
      );
      await expect(repository.listVisibleByActor(ACTOR_ID)).resolves.toEqual([event]);
      await expect(repository.append(event)).resolves.toEqual(event);
    }
  });
});
