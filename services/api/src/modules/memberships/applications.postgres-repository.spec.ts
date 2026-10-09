import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_KIND_VALUES,
  APPLICATION_STATUS_VALUES,
  ApplicationKind,
  ApplicationStatus,
  canTransitionApplication,
} from '@rm/shared';
import type {
  PersistenceCapabilities,
  SqlExecutor,
  SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import {
  APPLICATION_INITIAL_STATUS,
  APPLICATION_SLICE_KIND,
  parseStoredApplication,
  storedApplicationSchema,
  toApplicationView,
} from './applications.contract';
import type {
  Application,
  ApplicationRepository,
  ApplicationRepositoryCapabilities,
} from './applications.port';
import {
  APPLICATION_REPOSITORY_BACKEND_POSTGRES,
  APPLICATION_REPOSITORY_STORAGE_ID_DOMAIN,
} from './applications.port';
import {
  POSTGRES_APPLICATION_COLUMN_FIELDS,
  POSTGRES_APPLICATION_COLUMNS,
  POSTGRES_APPLICATION_IMMUTABLE_COLUMNS,
  POSTGRES_APPLICATION_MUTABLE_COLUMNS,
  POSTGRES_APPLICATION_OWNER_COLUMNS,
  POSTGRES_APPLICATION_PII_COLUMNS,
  POSTGRES_APPLICATION_REPOSITORY_CAPABILITIES,
  POSTGRES_APPLICATION_REPOSITORY_VERIFICATION_STEPS,
  POSTGRES_APPLICATION_REVIEW_INTERNAL_COLUMNS,
  POSTGRES_APPLICATION_TABLE,
  POSTGRES_APPLICATION_VIEW_EXCLUDED_COLUMNS,
  PostgresApplicationRepository,
  PostgresApplicationRepositoryError,
  applicationStatusPredecessors,
  assertPostgresApplicationRepositoryCapabilities,
} from './applications.postgres-repository';

/**
 * 入组申请 PostgreSQL 仓储 adapter 的**离线**验收（不连数据库、不引驱动）。
 *
 * 覆盖用户要求的五类补充测试与两条交付边界：
 * - **repository 契约**：能力声明（persistent=true / productionReady=false）、列 ↔ 读取契约字段
 *   一一对应、审核内部列必须被公开视图裁剪、**经工厂绑定到 `MembershipsModule`**、不引驱动/ORM、
 *   `join_applications` 已由迁移 0003 建立；端口是**单一异步契约**（`findById` 的主体参数是
 *   刻意且已文档化的归属隔离强化）；
 * - **参数化 SQL 与固定标识符**：客户端可控值只出现在参数里，SQL 文本只由模块常量构成
 *   （语句里没有任何引号 / 分号 / 注释符，因此不存在字面量注入面）；
 * - **SQL 注入**：备注、主体、资源 ID、小组 ID 等所有入口的注入载荷要么只进参数、
 *   要么在进入 SQL 之前被拒绝（拒绝路径**一个 SQL 都不执行**）；
 * - **未知列 / 字段污染**：未登记列、缺列、写路径的 snake_case 别名与权限字段一律 fail-closed；
 * - **状态闭集与非法状态转换**：闭集取值全部往返；`save` 的前驱集合与共享状态机**逐对**
 *   一致（25 个 (from, to) 组合全矩阵）；`pending` 无前驱因此无法写回；非法转移不产生写入；
 * - **归属隔离与重复申请边界**：他人记录既不出库（归属下推进 SQL）也不得回流，归属与不可变列
 *   不得被改写；`listByUserAndGroup` 无状态谓词（终态语义属共享状态机 + service + 后续唯一索引）；
 * - **公开视图**：对外视图不含 `userId` 与审核人/审核意见/审核时间，失败路径的错误信息不含归属
 *   标识、备注原文、审核意见与注入载荷。
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
const MEMBERSHIPS_DIR = resolve(process.cwd(), 'src', 'modules', 'memberships');
const ADAPTER_PATH = resolve(MEMBERSHIPS_DIR, 'applications.postgres-repository.ts');
const PORT_PATH = resolve(MEMBERSHIPS_DIR, 'applications.port.ts');
const MODULE_PATH = resolve(MEMBERSHIPS_DIR, 'memberships.module.ts');
/**
 * adapter **类名**的独立引用（词边界）：工厂导出名 `createLazyPostgresApplicationRepository`
 * 把它作为后缀包含在内，因此不能用「子串出现」来判定「某文件引用了 adapter 类」。
 */
const ADAPTER_CLASS_REFERENCE = /\bPostgresApplicationRepository\b/u;

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
/** 含十六进制字母的归属 / 审核人标识：用于验证「规范小写形」约束（纯数字 UUID 无法体现大小写差异） */
const HEX_OWNER_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const HEX_OWNER_ID_UPPER = 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678';
const HEX_OWNER_ID_MIXED = 'a1b2c3d4-E5F6-4789-8abc-DEF012345678';
const HEX_REVIEWER_ID = 'b1c2d3e4-f5a6-4789-8bcd-ef0123456789';
const GROUP_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_GROUP_ID = '44444444-4444-4444-8444-444444444444';
const APPLICATION_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_APPLICATION_ID = '66666666-6666-4666-8666-666666666666';
/** 含十六进制字母的小组 / 主键：用于验证「规范小写形」约束（纯数字 UUID 无法体现大小写差异） */
const HEX_GROUP_ID = 'd1e2f3a4-b5c6-4789-8def-0123456789ab';
const HEX_GROUP_ID_UPPER = 'D1E2F3A4-B5C6-4789-8DEF-0123456789AB';
const HEX_APPLICATION_ID = 'e1f2a3b4-c5d6-4789-8efa-0123456789ab';
const HEX_APPLICATION_ID_UPPER = 'E1F2A3B4-C5D6-4789-8EFA-0123456789AB';
const CREATED_AT = '2026-01-02T03:04:05.000Z';
const UPDATED_AT = '2026-01-03T04:05:06.000Z';
/** 撤回 / 审核推进后的时间戳 */
const SAVED_AT = '2026-01-04T05:06:07.000Z';
const REVIEWED_AT = '2026-01-05T06:07:08.000Z';
const NOTE = '希望加入课题组，参与横向项目';
const REVIEW_COMMENT = '材料齐全，同意入组';

const APPLICATION: Application = {
  id: APPLICATION_ID,
  userId: OWNER_ID,
  groupId: GROUP_ID,
  kind: ApplicationKind.Join,
  note: NOTE,
  status: ApplicationStatus.Pending,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

/** 撤回后的记录（`pending -> withdrawn` 是合法转移）：写回路径的主要样本 */
const WITHDRAWN_APPLICATION: Application = {
  ...APPLICATION,
  status: ApplicationStatus.Withdrawn,
  updatedAt: SAVED_AT,
};

/** 审核通过后的记录（含审核留痕）：用于公开视图裁剪与「审核内部字段被承载但不外泄」 */
const APPROVED_APPLICATION: Application = {
  ...APPLICATION,
  status: ApplicationStatus.Approved,
  reviewedByUserId: HEX_REVIEWER_ID,
  reviewComment: REVIEW_COMMENT,
  reviewedAt: REVIEWED_AT,
  updatedAt: SAVED_AT,
};

/** 数据库行（snake_case），默认与 APPLICATION 等价 */
function rowFromRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APPLICATION.id,
    user_id: APPLICATION.userId,
    group_id: APPLICATION.groupId,
    kind: 'join',
    note: APPLICATION.note,
    status: 'pending',
    reviewed_by_user_id: null,
    review_comment: null,
    reviewed_at: null,
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

/** 用给定响应构造 adapter（响应按调用顺序消费） */
function repoWith(...responses: unknown[]): {
  repository: PostgresApplicationRepository;
  executor: RecordingExecutor;
} {
  const executor = new RecordingExecutor(responses);
  return { repository: new PostgresApplicationRepository(executor), executor };
}

async function captureRepoError(
  run: () => Promise<unknown>,
): Promise<PostgresApplicationRepositoryError> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresApplicationRepositoryError);
  return captured as PostgresApplicationRepositoryError;
}

function captureSyncError(run: () => unknown): PostgresApplicationRepositoryError {
  let captured: unknown;
  try {
    run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresApplicationRepositoryError);
  return captured as PostgresApplicationRepositoryError;
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
  const index = [...POSTGRES_APPLICATION_COLUMNS].indexOf(
    column as (typeof POSTGRES_APPLICATION_COLUMNS)[number],
  );
  expect(index).toBeGreaterThanOrEqual(0);
  return call?.parameters?.[index];
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

/** 独立重算「目标状态的合法前驱集合」：只用共享状态机的正向转移，避免与实现共用同一份逆映射 */
function expectedPredecessors(status: ApplicationStatus): readonly ApplicationStatus[] {
  return APPLICATION_STATUS_VALUES.filter((from) => canTransitionApplication(from, status));
}

describe('PostgreSQL 入组申请仓储：repository 契约与能力声明', () => {
  it('能力声明恰好是 postgres / persistent=true / productionReady=false，且被冻结', () => {
    expect(POSTGRES_APPLICATION_REPOSITORY_CAPABILITIES).toEqual({
      backend: APPLICATION_REPOSITORY_BACKEND_POSTGRES,
      persistent: true,
      productionReady: false,
    });
    expect(Object.isFrozen(POSTGRES_APPLICATION_REPOSITORY_CAPABILITIES)).toBe(true);
    // 后端标识与「未验证驱动」的 fail-closed 工厂区分开，避免运维把两者混为一谈
    expect(APPLICATION_REPOSITORY_BACKEND_POSTGRES).toBe('postgres');
    expect(APPLICATION_REPOSITORY_STORAGE_ID_DOMAIN).toBe('uuid');
  });

  it('验证清单覆盖「驱动 → 集成 → 草案转迁移 → 异步端口 → UUID 主体 → 规范小写 → 409 映射 → 才可声明生产」八步', () => {
    expect(POSTGRES_APPLICATION_REPOSITORY_VERIFICATION_STEPS).toHaveLength(8);
    expect([...POSTGRES_APPLICATION_REPOSITORY_VERIFICATION_STEPS]).toEqual([
      'driver-dependency-evaluated',
      'integration-tests-against-real-postgres',
      'join-applications-schema-draft-created-and-promoted-to-migration',
      'application-repository-port-migrated-to-async',
      'session-subject-user-ids-converged-to-uuid',
      'request-uuid-fields-normalized-to-canonical-lowercase',
      'state-transition-rejection-mapped-to-409',
      'production-ready-capability-flipped-with-evidence',
    ]);
  });

  it('自检放行当前声明，但拒绝「未验证就声称生产可用」', () => {
    expect(() => assertPostgresApplicationRepositoryCapabilities()).not.toThrow();

    for (const declared of [
      { backend: 'postgres', persistent: true, productionReady: true },
      { backend: 'postgres', persistent: false, productionReady: false },
      { backend: 'postgresql-draft', persistent: true, productionReady: false },
    ]) {
      const error = captureSyncError(() =>
        assertPostgresApplicationRepositoryCapabilities(declared),
      );
      expect(error.code).toBe('CAPABILITY_MISDECLARED');
    }
  });

  it('列清单与读取契约字段一一对应（单一事实来源，无遗漏、无多余）', () => {
    const mappedFields = Object.values(POSTGRES_APPLICATION_COLUMN_FIELDS).sort();
    const contractFields = Object.keys(storedApplicationSchema.shape).sort();
    expect(mappedFields).toEqual(contractFields);

    // 列自身的卫生：唯一、裸 snake_case 标识符、且列清单与映射表的键集一致
    expect([...POSTGRES_APPLICATION_COLUMNS]).toHaveLength(
      new Set(POSTGRES_APPLICATION_COLUMNS).size,
    );
    for (const column of POSTGRES_APPLICATION_COLUMNS) {
      expect(/^[a-z][a-z0-9_]*$/u.test(column)).toBe(true);
      expect(Object.keys(POSTGRES_APPLICATION_COLUMN_FIELDS)).toContain(column);
    }
    expect(Object.keys(POSTGRES_APPLICATION_COLUMN_FIELDS).sort()).toEqual(
      [...POSTGRES_APPLICATION_COLUMNS].sort(),
    );
  });

  it('表名是字段字典里的 join_applications，字典已登记的列都在列清单里', () => {
    expect(POSTGRES_APPLICATION_TABLE).toBe('join_applications');

    // 字段字典为该表登记的字段必须都落在列清单里（否则存储层与数据字典脱节）。
    // 字典正文属内部文档，公开归档不可读；这里断言**公开可校验**的那一半（列清单包含这些字段），
    // 与字典正文逐行比对的另一半放在下面按需跳过的用例里。
    for (const field of ['status', 'note']) {
      expect([...POSTGRES_APPLICATION_COLUMNS]).toContain(field);
    }

    // 其余列（主键 / 归属 / 目标小组 / 类型 / 审核留痕 / 时间戳）只由约定与读取契约声明，
    // 字段字典尚未逐行登记。
    for (const contractOnly of [
      'id',
      'user_id',
      'group_id',
      'kind',
      'reviewed_by_user_id',
      'review_comment',
      'reviewed_at',
      'created_at',
      'updated_at',
    ]) {
      expect([...POSTGRES_APPLICATION_COLUMNS]).toContain(contractOnly);
    }
  });

  // 内部字典不可读时**显式跳过**（输出里可见），不做「静默通过」的降级：
  // 生产安全断言（fail-closed / 列清单边界）不受影响，本用例只对齐文档与列清单。
  it.skipIf(!existsSync(INTERNAL_FIELD_DICTIONARY))(
    '与内部字段级数据字典逐行对齐（需要内部文档；公开归档按设计跳过）',
    () => {
      const dictionary = readFileSync(INTERNAL_FIELD_DICTIONARY, 'utf8');
      for (const field of ['status', 'note']) {
        expect(dictionary).toContain(`| join_applications | ${field} |`);
      }
      // schema 草案那一步补登之后这里会失败，提醒同步核对列清单与迁移
      for (const contractOnly of [
        'id',
        'user_id',
        'group_id',
        'kind',
        'reviewed_by_user_id',
        'review_comment',
        'reviewed_at',
        'created_at',
        'updated_at',
      ]) {
        expect(dictionary).not.toContain(`| join_applications | ${contractOnly} |`);
      }
    },
  );

  it('归属列 / 个人级内容列 / 审核内部列 / 公开输出裁剪列各有明确清单', () => {
    expect([...POSTGRES_APPLICATION_OWNER_COLUMNS]).toEqual(['user_id']);
    expect([...POSTGRES_APPLICATION_PII_COLUMNS]).toEqual(['note', 'review_comment']);
    expect([...POSTGRES_APPLICATION_REVIEW_INTERNAL_COLUMNS]).toEqual([
      'reviewed_by_user_id',
      'review_comment',
      'reviewed_at',
    ]);
    expect([...POSTGRES_APPLICATION_VIEW_EXCLUDED_COLUMNS]).toEqual([
      'user_id',
      'reviewed_by_user_id',
      'review_comment',
      'reviewed_at',
    ]);

    for (const column of POSTGRES_APPLICATION_OWNER_COLUMNS) {
      expect([...POSTGRES_APPLICATION_VIEW_EXCLUDED_COLUMNS]).toContain(column);
      expect([...POSTGRES_APPLICATION_COLUMNS]).toContain(column);
    }
    for (const column of POSTGRES_APPLICATION_PII_COLUMNS) {
      expect([...POSTGRES_APPLICATION_COLUMNS]).toContain(column);
    }
    // 审核内部列**在**列清单内（存储记录必须完整承载），但**必须**被公开视图裁剪
    for (const column of POSTGRES_APPLICATION_REVIEW_INTERNAL_COLUMNS) {
      expect([...POSTGRES_APPLICATION_COLUMNS]).toContain(column);
      expect([...POSTGRES_APPLICATION_VIEW_EXCLUDED_COLUMNS]).toContain(column);
    }
    // 公开输出裁剪清单 = 归属列 ∪ 审核内部列（没有第三类被裁掉的列，也没有漏裁的列）
    expect([...POSTGRES_APPLICATION_VIEW_EXCLUDED_COLUMNS].sort()).toEqual(
      [
        ...POSTGRES_APPLICATION_OWNER_COLUMNS,
        ...POSTGRES_APPLICATION_REVIEW_INTERNAL_COLUMNS,
      ].sort(),
    );
  });

  it('写回允许变更的列与不可变列互补：并集是列清单、交集为空', () => {
    const mutable = [...POSTGRES_APPLICATION_MUTABLE_COLUMNS];
    const immutable: readonly string[] = [...POSTGRES_APPLICATION_IMMUTABLE_COLUMNS];
    expect(mutable).toEqual([
      'note',
      'status',
      'reviewed_by_user_id',
      'review_comment',
      'reviewed_at',
      'updated_at',
    ]);
    expect(immutable).toEqual(['id', 'user_id', 'group_id', 'kind', 'created_at']);
    expect(mutable.filter((column) => immutable.includes(column))).toEqual([]);
    expect([...mutable, ...immutable].sort()).toEqual([...POSTGRES_APPLICATION_COLUMNS].sort());
  });

  it('实现的是运行时端口契约（Promise 语义 + 归属感知取数）', async () => {
    const { repository, executor } = repoWith(
      { rows: [rowFromRecord()], rowCount: 1 },
      { rows: [], rowCount: 0 },
    );
    const port: ApplicationRepository = repository;

    expect(port.capabilities).toEqual(POSTGRES_APPLICATION_REPOSITORY_CAPABILITIES);
    const created = port.create(APPLICATION);
    expect(created).toBeInstanceOf(Promise);
    await expect(created).resolves.toEqual(APPLICATION);

    const listed = port.listByUserId(OWNER_ID);
    expect(listed).toBeInstanceOf(Promise);
    await expect(listed).resolves.toEqual([]);
    expect(executor.calls).toHaveLength(2);
  });

  it('adapter 不是 Nest provider：源码不含 @Injectable / @Module / Inject(', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).not.toContain('@Injectable');
    expect(source).not.toContain('@Module');
    expect(source).not.toContain('Inject(');
    expect(source).not.toContain('@nestjs');
  });

  it('端口是**单一异步契约**（收敛完成：不再并存同步端口），两处刻意签名差异都写在契约注释里', () => {
    const source = readFileSync(PORT_PATH, 'utf8');
    const portStart = source.indexOf('export interface ApplicationRepository {');
    const portEnd = source.indexOf('/** DI 令牌：入组申请仓储 */');
    expect(portStart).toBeGreaterThan(-1);
    expect(portEnd).toBeGreaterThan(portStart);
    const portBlock = source.slice(portStart, portEnd);

    expect(portBlock).toContain('create(application: Application): Promise<Application>;');
    expect(portBlock).toContain('listByUserId(userId: string): Promise<readonly Application[]>;');
    expect(portBlock).toContain(
      'listByUserAndGroup(userId: string, groupId: string): Promise<readonly Application[]>;',
    );
    expect(portBlock).toContain('save(application: Application): Promise<Application>;');
    // 单条读取必须携带服务端主体（否则就不存在「他人记录不出库」的路径）——刻意差异 1
    expect(portBlock).toContain(
      'findById(applicationId: string, ownerUserId: string): Promise<Application | undefined>;',
    );
    expect(portBlock).toContain('ownerUserId');
    // 分页窗口属于后续切片：端口不得预置用不上的参数
    expect(portBlock).not.toMatch(/\b(?:window|limit|offset|page|cursor)\b/iu);
    // 刻意差异 2：`save` 的归属取自记录（记录由 service 从存储记录构造），契约里写明
    expect(portBlock).toContain('归属下推进 SQL');

    // 收敛事实：只剩这一份契约 —— 同步端口与并存的异步契约都不再是 interface 声明
    expect(source).not.toContain('export interface AsyncApplicationRepository');
    expect(source).not.toContain('create(application: Application): Application;');
    expect(source).not.toContain('findById(applicationId: string): Application | undefined;');
    expect(source).not.toContain('listByUserId(userId: string): readonly Application[];');
    expect(source).not.toContain('save(application: Application): Application;');
  });
});

describe('PostgreSQL 入组申请仓储：构造与调用 fail-closed', () => {
  it('没有执行器 / 执行器缺 query / 缺能力声明 → 构造即拒绝，且不执行任何 SQL', () => {
    for (const broken of [undefined, null, {}, { capabilities: { backend: 'postgres' } }]) {
      const error = captureSyncError(
        () => new PostgresApplicationRepository(broken as unknown as SqlExecutor),
      );
      expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
    }

    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    new PostgresApplicationRepository(executor);
    expect(executor.calls).toHaveLength(0);
  });

  it('执行器声明的后端不是 PostgreSQL → 拒绝（不得把 adapter 挂到其他存储上）', () => {
    for (const backend of ['mysql', 'sqlite', 'in-memory-baseline']) {
      const error = captureSyncError(
        () =>
          new PostgresApplicationRepository({
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
        new PostgresApplicationRepository({
          query: () => Promise.resolve({ rows: [], rowCount: 0 }),
          capabilities: { backend: 'postgres', persistent: false, productionReady: false },
        }),
    );
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
  });

  it('构造后执行器被降级为非持久 → 下一次调用 fail-closed，且不再访问 SQL', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromRecord()], rowCount: 1 }]);
    const repository = new PostgresApplicationRepository(executor);

    executor.capabilities = { backend: 'postgres', persistent: false, productionReady: false };

    const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
  });

  it('构造后能力声明被改写为「生产可用」→ 每次调用都 fail-closed（自检不被绕过）', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });

    (repository as { capabilities: ApplicationRepositoryCapabilities }).capabilities = {
      backend: 'postgres',
      persistent: true,
      productionReady: true,
    };

    const error = await captureRepoError(() => repository.create(APPLICATION));
    expect(error.code).toBe('CAPABILITY_MISDECLARED');
    expect(error.issues).toContain('productionReady');
    expect(executor.calls).toHaveLength(0);
  });

  it('结果集缺少 rows 数组 → 判驱动缺陷，不伪装成「该主体尚无申请」', async () => {
    for (const broken of [undefined, null, {}, { rows: null }, 'rows']) {
      // 用「原样返回」的执行器，避免替身自身的默认值把 undefined 吞掉
      const rawExecutor: SqlExecutor = {
        capabilities: { backend: 'postgres-raw', persistent: true, productionReady: false },
        query: () => Promise.resolve(broken as unknown as SqlQueryResult<never>),
      };
      const repository = new PostgresApplicationRepository(rawExecutor);

      expect((await captureRepoError(() => repository.listByUserId(OWNER_ID))).code).toBe(
        'INVALID_ROW',
      );
      expect((await captureRepoError(() => repository.create(APPLICATION))).code).toBe(
        'INVALID_ROW',
      );
      expect(
        (await captureRepoError(() => repository.listByUserAndGroup(OWNER_ID, GROUP_ID))).code,
      ).toBe('INVALID_ROW');
      expect(
        (await captureRepoError(() => repository.findById(APPLICATION_ID, OWNER_ID))).code,
      ).toBe('INVALID_ROW');
      expect((await captureRepoError(() => repository.save(WITHDRAWN_APPLICATION))).code).toBe(
        'INVALID_ROW',
      );
    }
  });

  it('空列表返回 []（不是抛错、也不是空对象 / undefined）；单条未命中返回 undefined', async () => {
    const { repository } = repoWith({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });

    const listed = await repository.listByUserId(OWNER_ID);
    expect(listed).toEqual([]);
    expect(Array.isArray(listed)).toBe(true);

    const grouped = await repository.listByUserAndGroup(OWNER_ID, GROUP_ID);
    expect(grouped).toEqual([]);

    const found = await repository.findById(APPLICATION_ID, OWNER_ID);
    expect(found).toBeUndefined();
  });
});

describe('PostgreSQL 入组申请仓储：参数化 SQL 与显式字段映射', () => {
  it('写入使用占位符绑定：SQL 只由常量与 $n 组成，参数按列顺序传入', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });

    const stored = await repository.create(APPLICATION);

    const call = callAt(executor, 0);
    expect(call?.sql).toContain(`INSERT INTO ${POSTGRES_APPLICATION_TABLE} (`);
    expect(call?.sql).toContain(
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz)',
    );
    expect(call?.sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(call?.sql).toContain('RETURNING');
    expectParameterizedSql(call?.sql ?? '');
    expect(placeholderIndexes(call?.sql ?? '')).toEqual(
      Array.from({ length: POSTGRES_APPLICATION_COLUMNS.length }, (_unused, index) => index + 1),
    );
    expect(call?.parameters).toHaveLength(POSTGRES_APPLICATION_COLUMNS.length);

    // 领域对象的值只出现在参数里；SQL 文本里一个都不出现
    for (const value of [
      APPLICATION.id,
      APPLICATION.userId,
      APPLICATION.groupId,
      APPLICATION.note ?? '',
      APPLICATION.createdAt,
    ]) {
      expect(call?.sql).not.toContain(value);
    }
    expect(call?.parameters).toEqual([
      APPLICATION.id,
      APPLICATION.userId,
      APPLICATION.groupId,
      'join',
      NOTE,
      'pending',
      null,
      null,
      null,
      CREATED_AT,
      UPDATED_AT,
    ]);
    expect(stored).toEqual(APPLICATION);
    expect(stored).not.toHaveProperty('user_id');
    expect(stored).not.toHaveProperty('group_id');
    expect(stored).not.toHaveProperty('review_comment');
  });

  it('写入语句没有 DO UPDATE，也没有「同组未终态唯一性」的子查询（创建端口只创建）', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });
    await repository.create(APPLICATION);

    const sql = callAt(executor, 0)?.sql ?? '';
    expect(sql).not.toContain('DO UPDATE');
    expect(sql).not.toContain('WHERE');
    expect(sql).not.toContain('SELECT');
    expect(sql).not.toContain('NOT EXISTS');
    // 归属与生命周期列只出现在列清单 / 值占位 / RETURNING 里，不会出现在赋值位置
    for (const column of ['user_id', 'group_id', 'kind', 'created_at']) {
      expect(sql).not.toContain(`${column} = `);
      expect(sql).not.toContain(`${column}=`);
    }
  });

  it('缺失的可选字段写入 null（不是 undefined，也不是省略列）', async () => {
    const { note: _note, ...withoutOptional } = APPLICATION;
    const { repository, executor } = repoWith({
      rows: [
        rowFromRecord({
          note: null,
          reviewed_by_user_id: null,
          review_comment: null,
          reviewed_at: null,
        }),
      ],
      rowCount: 1,
    });

    const stored = await repository.create(withoutOptional);

    const call = callAt(executor, 0);
    for (const column of ['note', 'reviewed_by_user_id', 'review_comment', 'reviewed_at']) {
      expect(parameterAt(call, column)).toBeNull();
    }
    // null 列在领域记录里表现为「字段不存在」，而不是 undefined 悬挂
    for (const field of ['note', 'reviewedByUserId', 'reviewComment', 'reviewedAt']) {
      expect(stored).not.toHaveProperty(field);
    }
    expect(stored).toEqual(withoutOptional);
  });

  it('空串在写入前归一为 NULL，读取侧同样归一为「未填写」（避免往返不一致）', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord({ note: '', review_comment: '' })],
      rowCount: 1,
    });

    const stored = await repository.create({ ...APPLICATION, note: '', reviewComment: '' });

    const call = callAt(executor, 0);
    expect(parameterAt(call, 'note')).toBeNull();
    expect(parameterAt(call, 'review_comment')).toBeNull();
    expect(stored).not.toHaveProperty('note');
    expect(stored).not.toHaveProperty('reviewComment');
  });

  it('行 → 记录是逐字段显式映射：每个列的值都落在对应领域字段上', async () => {
    // 列与领域字段一一对应：整行映射后必须逐字节等于同一个领域记录（任何错位/漏映射都会失败）
    const mapped: Application = {
      id: HEX_APPLICATION_ID,
      userId: HEX_OWNER_ID,
      groupId: OTHER_GROUP_ID,
      kind: ApplicationKind.Leave,
      note: '退组备注甲',
      status: ApplicationStatus.Approved,
      reviewedByUserId: HEX_REVIEWER_ID,
      reviewComment: '审核意见乙',
      reviewedAt: REVIEWED_AT,
      createdAt: '2026-02-03T04:05:06.000Z',
      updatedAt: '2026-02-04T05:06:07.000Z',
    };
    const { repository } = repoWith({
      rows: [
        rowFromRecord({
          id: mapped.id,
          user_id: mapped.userId,
          group_id: mapped.groupId,
          kind: 'leave',
          note: mapped.note ?? null,
          status: 'approved',
          reviewed_by_user_id: mapped.reviewedByUserId,
          review_comment: mapped.reviewComment ?? null,
          reviewed_at: new Date(REVIEWED_AT),
          created_at: new Date('2026-02-03T04:05:06.000Z'),
          updated_at: new Date('2026-02-04T05:06:07.000Z'),
        }),
      ],
      rowCount: 1,
    });

    const stored = await repository.create(mapped);

    expect(stored).toEqual(mapped);
  });

  it('按主体列表取数把归属下推进 SQL：只按主体一个占位符，列清单显式（无 SELECT *）', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });

    const listed = await repository.listByUserId(OWNER_ID);

    const call = callAt(executor, 0);
    expect(call?.sql).toContain(`SELECT ${[...POSTGRES_APPLICATION_COLUMNS].join(', ')}`);
    expect(call?.sql).toContain(`FROM ${POSTGRES_APPLICATION_TABLE}`);
    expect(call?.sql).toContain('WHERE user_id = $1::uuid');
    expect(call?.sql).toContain('ORDER BY created_at ASC, id ASC');
    expectParameterizedSql(call?.sql ?? '');
    expect(call?.sql).not.toContain(OWNER_ID);
    expect(call?.parameters).toEqual([OWNER_ID]);
    expect(listed).toEqual([APPLICATION]);
  });

  it('按（主体, 小组）取数：两个谓词都是占位符，且没有状态谓词 / 分页窗口', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });

    const grouped = await repository.listByUserAndGroup(OWNER_ID, GROUP_ID);

    const call = callAt(executor, 0);
    expect(call?.sql).toContain('WHERE user_id = $1::uuid AND group_id = $2::uuid');
    expect(call?.sql).toContain('ORDER BY created_at ASC, id ASC');
    expectParameterizedSql(call?.sql ?? '');
    // 终态语义属共享状态机：adapter 不做「未终态」过滤，也不理解唯一性
    // （列清单里当然有 status 列，但 WHERE 里不得出现任何状态谓词）
    expect(call?.sql).not.toMatch(/status\s*(?:=|<>|!=|IN|ANY|LIKE)/u);
    expect(call?.sql).not.toMatch(/\b(?:LIMIT|OFFSET|FETCH|HAVING|DISTINCT)\b/u);
    expect(call?.parameters).toEqual([OWNER_ID, GROUP_ID]);
    expect(grouped).toEqual([APPLICATION]);
  });

  it('单条读取：主键与归属同时作为谓词，两个占位符按序绑定', async () => {
    const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });

    const found = await repository.findById(APPLICATION_ID, OWNER_ID);

    const call = callAt(executor, 0);
    expect(call?.sql).toContain('WHERE id = $1::uuid AND user_id = $2::uuid');
    expect(call?.sql).not.toContain('ORDER BY');
    expectParameterizedSql(call?.sql ?? '');
    expect(call?.parameters).toEqual([APPLICATION_ID, OWNER_ID]);
    expect(found).toEqual(APPLICATION);
  });

  it('写回是条件写入：SET 只含可变列，WHERE 钉住 id + user_id + 状态前驱集合', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord({ status: 'withdrawn', updated_at: new Date(SAVED_AT) })],
      rowCount: 1,
    });

    const saved = await repository.save(WITHDRAWN_APPLICATION);

    const call = callAt(executor, 0);
    expect(call?.sql).toContain(`UPDATE ${POSTGRES_APPLICATION_TABLE}`);
    expect(call?.sql).toContain(
      'SET note = $3, status = $4, reviewed_by_user_id = $5::uuid, review_comment = $6, reviewed_at = $7::timestamptz, updated_at = $8::timestamptz',
    );
    expect(call?.sql).toContain(
      'WHERE id = $1::uuid AND user_id = $2::uuid AND status::text = ANY($9::text[])',
    );
    expect(call?.sql).toContain('RETURNING');
    expectParameterizedSql(call?.sql ?? '');
    // SET 子句逐字节只含可变列（不可变列一个都不在赋值位置）
    const sql = call?.sql ?? '';
    const setClause = sql.slice(sql.indexOf('SET ') + 'SET '.length, sql.indexOf('\n  WHERE'));
    expect(setClause).toBe(
      'note = $3, status = $4, reviewed_by_user_id = $5::uuid, review_comment = $6, reviewed_at = $7::timestamptz, updated_at = $8::timestamptz',
    );
    for (const column of POSTGRES_APPLICATION_IMMUTABLE_COLUMNS) {
      // 只在 SET 子句上判定赋值位置（WHERE 里的 `id = $1` 是主键谓词，不是赋值）
      expect(setClause).not.toMatch(new RegExp(`(?:^|[\\s,(])${column} = `, 'u'));
    }
    expect(call?.parameters).toEqual([
      WITHDRAWN_APPLICATION.id,
      WITHDRAWN_APPLICATION.userId,
      NOTE,
      'withdrawn',
      null,
      null,
      null,
      SAVED_AT,
      ['pending'],
    ]);
    expect(saved).toEqual(WITHDRAWN_APPLICATION);
    // 合法转移一次写入即命中，不需要诊断查询
    expect(executor.calls).toHaveLength(1);
  });

  it('表名与列清单只由模块常量构成且都是裸标识符，占位符数量与参数数量一致', async () => {
    const { repository, executor } = repoWith(
      { rows: [rowFromRecord()], rowCount: 1 },
      { rows: [rowFromRecord()], rowCount: 1 },
      { rows: [rowFromRecord()], rowCount: 1 },
      { rows: [rowFromRecord()], rowCount: 1 },
      {
        rows: [rowFromRecord({ status: 'withdrawn', updated_at: new Date(SAVED_AT) })],
        rowCount: 1,
      },
    );

    await repository.create(APPLICATION);
    await repository.listByUserId(OWNER_ID);
    await repository.listByUserAndGroup(OWNER_ID, GROUP_ID);
    await repository.findById(APPLICATION_ID, OWNER_ID);
    await repository.save(WITHDRAWN_APPLICATION);

    expect(executor.calls).toHaveLength(5);
    for (const call of executor.calls) {
      expect(call.sql).toContain(POSTGRES_APPLICATION_TABLE);
      expectParameterizedSql(call.sql);
      expect(placeholderIndexes(call.sql)).toHaveLength(call.parameters?.length ?? 0);
    }
  });
});

describe('PostgreSQL 入组申请仓储：SQL 注入防线', () => {
  const INJECTION = "x'); DROP TABLE join_applications; --";

  it('备注里的注入载荷只进参数：SQL 文本与正常输入逐字节相同', async () => {
    const normal = repoWith({ rows: [rowFromRecord()], rowCount: 1 });
    const injected = repoWith({ rows: [rowFromRecord({ note: INJECTION })], rowCount: 1 });

    await normal.repository.create(APPLICATION);
    await injected.repository.create({ ...APPLICATION, note: INJECTION });

    const baseSql = callAt(normal.executor, 0)?.sql ?? '';
    const injectedSql = callAt(injected.executor, 0)?.sql ?? '';
    expect(injectedSql).toBe(baseSql);
    expect(injectedSql).not.toContain('DROP TABLE');
    expect(injectedSql).not.toContain('--');
    // 载荷原样进参数（不会被静默改写，也不会被拼进语句）
    expect(parameterAt(callAt(injected.executor, 0), 'note')).toBe(INJECTION);
    expect(parameterAt(callAt(normal.executor, 0), 'note')).toBe(NOTE);
  });

  it('主体不是合法 UUID / 非规范小写形 / 空 UUID 时在进入 SQL 之前就被拒绝，且不访问数据库', async () => {
    for (const subject of [
      `${OWNER_ID}' OR 1=1 --`,
      'u-student-1',
      HEX_OWNER_ID_UPPER,
      HEX_OWNER_ID_MIXED,
      '00000000-0000-0000-0000-000000000000',
      '',
      null,
      undefined,
      42,
    ]) {
      for (const run of [
        (repository: PostgresApplicationRepository) => repository.listByUserId(subject as string),
        (repository: PostgresApplicationRepository) =>
          repository.listByUserAndGroup(subject as string, GROUP_ID),
        (repository: PostgresApplicationRepository) =>
          repository.findById(APPLICATION_ID, subject as string),
      ]) {
        const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });
        const error = await captureRepoError(() => run(repository));
        expect(error.code).toBe('INVALID_SUBJECT');
        expect(executor.calls).toHaveLength(0);
      }
    }
  });

  it('资源 ID 的注入载荷 / 非标识符取值不进 SQL：直接按「不存在」返回，且不访问数据库', async () => {
    for (const applicationId of [
      `${APPLICATION_ID}' OR 1=1 --`,
      'not-a-uuid',
      HEX_OWNER_ID_UPPER,
      HEX_OWNER_ID_MIXED,
      '00000000-0000-0000-0000-000000000000',
      '',
      '1 OR 1=1',
    ]) {
      const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });
      await expect(repository.findById(applicationId, OWNER_ID)).resolves.toBeUndefined();
      expect(executor.calls).toHaveLength(0);
    }
  });

  it('小组谓词不是规范存储标识符时 fail-closed（谓词无法正确回答，不得退化成空集）', async () => {
    for (const groupId of [
      `${GROUP_ID}' OR 1=1 --`,
      'g-group-1',
      HEX_GROUP_ID_UPPER,
      HEX_GROUP_ID.toUpperCase(),
      '00000000-0000-0000-0000-000000000000',
      '',
    ]) {
      const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });
      const error = await captureRepoError(() => repository.listByUserAndGroup(OWNER_ID, groupId));
      expect(error.code).toBe('INVALID_IDENTIFIER');
      expect(error.issues).toEqual(['groupId']);
      expect(executor.calls).toHaveLength(0);
    }
  });

  it('行契约的枚举列不接受大写 / 未登记 / 注入式取值，且错误信息不回显取值', async () => {
    for (const status of [`${INJECTION}`, 'PENDING', 'unknown_status', '', 1, null]) {
      const { repository } = repoWith({ rows: [rowFromRecord({ status })], rowCount: 1 });
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      expect(`${error.message} ${JSON.stringify(error.issues)}`).not.toContain(INJECTION);
    }
    for (const kind of [`${INJECTION}`, 'JOIN', 'transfer', 0]) {
      const { repository } = repoWith({ rows: [rowFromRecord({ kind })], rowCount: 1 });
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      expect(`${error.message} ${JSON.stringify(error.issues)}`).not.toContain(INJECTION);
    }
  });

  it('SQL 语句里没有任何字面量注入面：无引号 / 无分号 / 无注释符 / 无危险关键字', async () => {
    const { repository, executor } = repoWith(
      { rows: [rowFromRecord()], rowCount: 1 },
      { rows: [rowFromRecord()], rowCount: 1 },
      { rows: [rowFromRecord()], rowCount: 1 },
      { rows: [rowFromRecord()], rowCount: 1 },
      {
        rows: [rowFromRecord({ status: 'withdrawn', updated_at: new Date(SAVED_AT) })],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'rejected' }], rowCount: 1 },
    );

    await repository.create({ ...APPLICATION, note: INJECTION });
    await repository.listByUserId(OWNER_ID);
    await repository.listByUserAndGroup(OWNER_ID, GROUP_ID);
    await repository.findById(APPLICATION_ID, OWNER_ID);
    await repository.save({ ...WITHDRAWN_APPLICATION, note: INJECTION });
    // 非法状态转移走「条件写入 + 归属范围内诊断查询」两条语句，这里只关心语句卫生
    await captureRepoError(() =>
      repository.save({
        ...APPLICATION,
        status: ApplicationStatus.Approved,
        updatedAt: SAVED_AT,
      }),
    );

    expect(executor.calls).toHaveLength(7);
    for (const call of executor.calls) {
      expectParameterizedSql(call.sql);
      expect(call.sql).not.toContain(INJECTION);
      expect(call.sql).not.toContain('DROP TABLE');
      // 每条语句都必须锚定在本模块声明的表上
      expect(call.sql).toContain(POSTGRES_APPLICATION_TABLE);
    }
  });
});

describe('PostgreSQL 入组申请仓储：未知列与字段污染', () => {
  it('数据库返回未登记列（审核别名 / 软删除 / 审计 / 幂等键 / 成员关系）→ 整行拒绝', async () => {
    for (const column of [
      'deleted_at',
      'reviewer_user_id',
      'reviewed_by',
      'reviewed_by_id',
      'audit_event_id',
      'idempotency_key',
      'membership_id',
      'applicant_id',
      'group_ids',
      'scope',
      'permission_points',
      'pii_note',
    ]) {
      const { repository } = repoWith({
        rows: [rowFromRecord({ [column]: 'x' })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      // 只报字段名与违规类型，不带字段取值
      expect(error.issues.join(' ')).toContain(`${column}(unexpected)`);
    }
  });

  it('缺列同样 fail-closed：列清单里的每一列缺失都必须被拒绝', async () => {
    for (const column of POSTGRES_APPLICATION_COLUMNS) {
      const { repository } = repoWith({ rows: [withoutRowColumn(column)], rowCount: 1 });
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      expect(error.issues.join(' ')).toContain(column);
    }
  });

  it('列表与单条读取同样拒绝未登记列（不因为「只多几列」就放行）', async () => {
    const polluted = rowFromRecord({ audit_event_id: 'evt-1' });

    for (const run of [
      (repository: PostgresApplicationRepository) => repository.listByUserId(OWNER_ID),
      (repository: PostgresApplicationRepository) =>
        repository.listByUserAndGroup(OWNER_ID, GROUP_ID),
      (repository: PostgresApplicationRepository) => repository.findById(APPLICATION_ID, OWNER_ID),
    ]) {
      const { repository } = repoWith({ rows: [polluted], rowCount: 1 });
      const error = await captureRepoError(() => Promise.resolve(run(repository)));
      expect(error.code).toBe('INVALID_ROW');
    }
  });

  it('写路径字段污染（snake_case 别名 / 归属别名 / 审核内部字段 / 权限字段）→ INVALID_RECORD，且不写库', async () => {
    const pollutedRecords: readonly Record<string, unknown>[] = [
      { ...APPLICATION, user_id: OWNER_ID },
      { ...APPLICATION, group_id: GROUP_ID },
      { ...APPLICATION, reviewed_by_user_id: HEX_REVIEWER_ID },
      { ...APPLICATION, reviewer_user_id: HEX_REVIEWER_ID },
      { ...APPLICATION, auditEventId: 'evt-1' },
      { ...APPLICATION, membershipId: APPLICATION_ID },
      { ...APPLICATION, groupIds: [GROUP_ID] },
      { ...APPLICATION, scope: 'SELF' },
      { ...APPLICATION, role: 'student' },
      { ...APPLICATION, applicantId: OWNER_ID },
    ];

    for (const record of pollutedRecords) {
      for (const run of [
        (repository: PostgresApplicationRepository) =>
          repository.create(record as unknown as Application),
        (repository: PostgresApplicationRepository) =>
          repository.save(record as unknown as Application),
      ]) {
        const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });
        const error = await captureRepoError(() => run(repository));
        expect(error.code).toBe('INVALID_RECORD');
        expect(executor.calls).toHaveLength(0);
      }
    }
  });

  it('写入记录缺失必填字段 / 类型不对 → INVALID_RECORD，且不写库', async () => {
    for (const record of [
      { ...APPLICATION, id: undefined },
      { ...APPLICATION, groupId: undefined },
      { ...APPLICATION, kind: undefined },
      { ...APPLICATION, status: undefined },
      { ...APPLICATION, createdAt: undefined },
      { ...APPLICATION, note: 42 },
      { ...APPLICATION, note: 'a'.repeat(1001) },
      { ...APPLICATION, note: '控制\u0000字符' },
      { ...APPLICATION, reviewComment: 'b'.repeat(501) },
      { ...APPLICATION, createdAt: '不是时间' },
    ]) {
      const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });
      const error = await captureRepoError(() =>
        repository.create(record as unknown as Application),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(executor.calls).toHaveLength(0);
    }
  });

  it('读取路径的控制字符由读取契约兜底拒绝（行契约只管形状与长度）', async () => {
    const { repository } = repoWith({
      rows: [rowFromRecord({ note: '正常备注\u0000截断' })],
      rowCount: 1,
    });
    const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
    expect(error.code).toBe('INVALID_ROW');
    expect(error.issues.join(' ')).toContain('note(invalid)');
  });
});

describe('PostgreSQL 入组申请仓储：状态闭集与非法状态转换（fail-closed）', () => {
  it('前驱集合是共享状态机的逆映射：5 个目标状态逐一核对（不引入第二套状态机）', () => {
    const total = APPLICATION_STATUS_VALUES.length;
    expect(total).toBe(5);

    let legalTransitions = 0;
    for (const target of APPLICATION_STATUS_VALUES) {
      const expected: ApplicationStatus[] = [];
      for (const from of APPLICATION_STATUS_VALUES) {
        if (canTransitionApplication(from, target)) {
          expected.push(from);
          legalTransitions += 1;
        }
      }
      expect([...applicationStatusPredecessors(target)]).toEqual(expected);
      expect([...applicationStatusPredecessors(target)]).toEqual([...expectedPredecessors(target)]);
      // 状态机里没有任何自转移：目标状态绝不把自己的状态当作前驱
      expect([...applicationStatusPredecessors(target)]).not.toContain(target);
    }
    // 共享状态机当前恰好 4 条合法转移（pending → 3 个 + approved → completed）
    expect(legalTransitions).toBe(4);
    // `pending` 没有前驱：条件写入因此永不命中，save 无法把记录写回待审核
    expect([...applicationStatusPredecessors(ApplicationStatus.Pending)]).toEqual([]);
    expect([...applicationStatusPredecessors(ApplicationStatus.Approved)]).toEqual(['pending']);
    expect([...applicationStatusPredecessors(ApplicationStatus.Rejected)]).toEqual(['pending']);
    expect([...applicationStatusPredecessors(ApplicationStatus.Withdrawn)]).toEqual(['pending']);
    expect([...applicationStatusPredecessors(ApplicationStatus.Completed)]).toEqual(['approved']);
  });

  it('(from, to) 全矩阵：25 个组合里只有共享状态机允许的那 4 个能被写回', async () => {
    for (const from of APPLICATION_STATUS_VALUES) {
      for (const to of APPLICATION_STATUS_VALUES) {
        const requested: Application = { ...APPLICATION, status: to, updatedAt: SAVED_AT };
        const allowed = canTransitionApplication(from, to);
        const { repository, executor } = repoWith(
          allowed
            ? {
                rows: [rowFromRecord({ status: to, updated_at: new Date(SAVED_AT) })],
                rowCount: 1,
              }
            : { rows: [], rowCount: 0 },
          { rows: [{ status: from }], rowCount: 1 },
        );

        if (allowed) {
          const saved = await repository.save(requested);
          expect(saved.status).toBe(to);
          expect(executor.calls).toHaveLength(1);
        } else {
          const error = await captureRepoError(() => repository.save(requested));
          expect(error.code).toBe('TRANSITION_REJECTED');
          expect(error.issues).toEqual(['status']);
          // 一次条件写入 + 一次归属范围内的诊断查询：没有任何「先写后判」的窗口
          expect(executor.calls).toHaveLength(2);
          expect(callAt(executor, 1)?.sql).toContain('SELECT status');
        }

        // 无论成败，条件写入携带的前驱集合都必须等于共享状态机的逆映射
        expect(callAt(executor, 0)?.parameters?.[8]).toEqual([...expectedPredecessors(to)]);
      }
    }
  });

  it('save 无法把记录写回 pending：前驱为空集，谓词为空数组', async () => {
    const { repository, executor } = repoWith(
      { rows: [], rowCount: 0 },
      {
        rows: [{ status: 'pending' }],
        rowCount: 1,
      },
    );

    const error = await captureRepoError(() => repository.save(APPLICATION));

    expect(error.code).toBe('TRANSITION_REJECTED');
    expect(callAt(executor, 0)?.parameters?.[8]).toEqual([]);
    expect(callAt(executor, 0)?.sql).toContain('ANY($9::text[])');
  });

  it('非法状态转换：写入 0 行 + 诊断查询确认记录仍存在 → TRANSITION_REJECTED，且不抛业务错误', async () => {
    const requested: Application = {
      ...APPLICATION,
      status: ApplicationStatus.Approved,
      updatedAt: SAVED_AT,
    };
    const { repository, executor } = repoWith(
      { rows: [], rowCount: 0 },
      {
        rows: [{ status: 'rejected' }],
        rowCount: 1,
      },
    );

    const error = await captureRepoError(() => repository.save(requested));

    expect(error.code).toBe('TRANSITION_REJECTED');
    // adapter 只抛自己的 fail-closed 错误：409 映射属于 service 切片（验证清单第 7 项）
    expect(error.name).toBe('PostgresApplicationRepositoryError');
    expect(error.issues).toEqual(['status']);
    // 诊断查询同样被 id + user_id 双重限定（不跨归属探测）
    const diagnostic = callAt(executor, 1);
    expect(diagnostic?.sql).toContain('WHERE id = $1::uuid AND user_id = $2::uuid');
    expect(diagnostic?.parameters).toEqual([requested.id, requested.userId]);
    // 诊断只取一列，且不回显状态取值
    expect(diagnostic?.sql).toContain('SELECT status');
    expect(error.message).not.toContain('rejected');
    expect(error.issues.join(' ')).not.toContain('rejected');
  });

  it('记录不存在（或归属不符）→ NOT_FOUND（与内存基线「记录不存在时拒绝写入」同语义）', async () => {
    const { repository } = repoWith({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });

    const error = await captureRepoError(() => repository.save(WITHDRAWN_APPLICATION));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.issues).toEqual(['id']);
  });

  it('诊断查询返回多行 / 未知状态 → 结果集违约 / 行契约违约', async () => {
    const duplicate = repoWith(
      { rows: [], rowCount: 0 },
      {
        rows: [{ status: 'pending' }, { status: 'pending' }],
        rowCount: 2,
      },
    );
    expect(
      (await captureRepoError(() => duplicate.repository.save(WITHDRAWN_APPLICATION))).code,
    ).toBe('RESULT_SET_VIOLATION');

    const unknown = repoWith(
      { rows: [], rowCount: 0 },
      {
        rows: [{ status: 'archived' }],
        rowCount: 1,
      },
    );
    expect(
      (await captureRepoError(() => unknown.repository.save(WITHDRAWN_APPLICATION))).code,
    ).toBe('INVALID_ROW');

    const polluted = repoWith(
      { rows: [], rowCount: 0 },
      {
        rows: [{ status: 'pending', reviewed_by_user_id: HEX_REVIEWER_ID }],
        rowCount: 1,
      },
    );
    expect(
      (await captureRepoError(() => polluted.repository.save(WITHDRAWN_APPLICATION))).code,
    ).toBe('INVALID_ROW');
  });

  it('写记录里的未知状态在进入 SQL 之前就被闭集拦下（INVALID_RECORD，不写库）', async () => {
    for (const status of ['archived', 'PENDING', 'cancelled', '', null, 42]) {
      for (const run of [
        (repository: PostgresApplicationRepository) =>
          repository.create({ ...APPLICATION, status } as unknown as Application),
        (repository: PostgresApplicationRepository) =>
          repository.save({ ...APPLICATION, status } as unknown as Application),
      ]) {
        const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });
        const error = await captureRepoError(() => run(repository));
        expect(error.code).toBe('INVALID_RECORD');
        expect(executor.calls).toHaveLength(0);
      }
    }
  });

  it('闭集内的状态全部可往返（不因取值不同被静默改写或过滤）', async () => {
    for (const status of APPLICATION_STATUS_VALUES) {
      const { repository, executor } = repoWith({
        rows: [rowFromRecord({ status })],
        rowCount: 1,
      });
      const created = await repository.create({ ...APPLICATION, status });
      expect(created.status).toBe(status);
      expect(parameterAt(callAt(executor, 0), 'status')).toBe(status);
    }
  });

  it('闭集内的申请类型全部可往返（入组/退组由记录契约表达，本 adapter 不臆造额外收紧）', async () => {
    for (const kind of APPLICATION_KIND_VALUES) {
      const { repository, executor } = repoWith({
        rows: [rowFromRecord({ kind })],
        rowCount: 1,
      });
      const created = await repository.create({ ...APPLICATION, kind });
      expect(created.kind).toBe(kind);
      expect(parameterAt(callAt(executor, 0), 'kind')).toBe(kind);
    }
    // 本切片的 service 常量仍是 join：adapter 不改变它，只是不为它新增第二套事实来源
    expect(APPLICATION_SLICE_KIND).toBe(ApplicationKind.Join);
    expect(APPLICATION_INITIAL_STATUS).toBe(ApplicationStatus.Pending);
  });

  it('状态列的坏形状一律拒绝：非字符串 / 缺列 / 大小写漂移 / 注入载荷', async () => {
    for (const status of [null, undefined, 1, true, {}, [], 'Pending', 'pending ', `${'x'};--`]) {
      const { repository } = repoWith({ rows: [rowFromRecord({ status })], rowCount: 1 });
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
    }
  });
});

describe('PostgreSQL 入组申请仓储：归属隔离（他人记录既不出库也不回流）', () => {
  it('列表 SQL 必须带归属谓词：去掉 WHERE user_id 就不再是「按主体取数」', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
    await repository.listByUserId(OWNER_ID);

    const sql = callAt(executor, 0)?.sql ?? '';
    expect(sql).toContain('WHERE user_id = $1::uuid');
    expect(callAt(executor, 0)?.parameters).toEqual([OWNER_ID]);
  });

  it('列表里混入他人记录 → OWNER_VIOLATION（整批 fail-closed，不静默过滤也不返回）', async () => {
    const { repository } = repoWith({
      rows: [rowFromRecord(), rowFromRecord({ id: OTHER_APPLICATION_ID, user_id: OTHER_OWNER_ID })],
      rowCount: 2,
    });

    const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
    expect(error.code).toBe('OWNER_VIOLATION');
    expect(error.issues).toEqual(['user_id']);
  });

  it('按小组取数里混入他人 / 别的小组的记录 → 分别 OWNER_VIOLATION / RESULT_SET_VIOLATION', async () => {
    const foreignOwner = repoWith({
      rows: [rowFromRecord({ user_id: OTHER_OWNER_ID })],
      rowCount: 1,
    });
    expect(
      (await captureRepoError(() => foreignOwner.repository.listByUserAndGroup(OWNER_ID, GROUP_ID)))
        .code,
    ).toBe('OWNER_VIOLATION');

    const foreignGroup = repoWith({
      rows: [rowFromRecord({ group_id: OTHER_GROUP_ID })],
      rowCount: 1,
    });
    const error = await captureRepoError(() =>
      foreignGroup.repository.listByUserAndGroup(OWNER_ID, GROUP_ID),
    );
    expect(error.code).toBe('RESULT_SET_VIOLATION');
    expect(error.issues).toEqual(['group_id']);
  });

  it('列表出现重复主键 → RESULT_SET_VIOLATION（同一记录不得在列表里出现两次）', async () => {
    for (const run of [
      (repository: PostgresApplicationRepository) => repository.listByUserId(OWNER_ID),
      (repository: PostgresApplicationRepository) =>
        repository.listByUserAndGroup(OWNER_ID, GROUP_ID),
    ]) {
      const { repository } = repoWith({ rows: [rowFromRecord(), rowFromRecord()], rowCount: 2 });
      const error = await captureRepoError(() => run(repository));
      expect(error.code).toBe('RESULT_SET_VIOLATION');
      expect(error.issues).toEqual(['id']);
    }
  });

  it('单条读取的返回行仍复核主键与归属（纵深防御：坏执行器返回他人记录也不放行）', async () => {
    const foreign = repoWith({
      rows: [rowFromRecord({ user_id: OTHER_OWNER_ID })],
      rowCount: 1,
    });
    expect(
      (await captureRepoError(() => foreign.repository.findById(APPLICATION_ID, OWNER_ID))).code,
    ).toBe('OWNER_VIOLATION');

    const otherId = repoWith({
      rows: [rowFromRecord({ id: OTHER_APPLICATION_ID })],
      rowCount: 1,
    });
    expect(
      (await captureRepoError(() => otherId.repository.findById(APPLICATION_ID, OWNER_ID))).code,
    ).toBe('IDENTITY_MISMATCH');

    const duplicate = repoWith({ rows: [rowFromRecord(), rowFromRecord()], rowCount: 2 });
    expect(
      (await captureRepoError(() => duplicate.repository.findById(APPLICATION_ID, OWNER_ID))).code,
    ).toBe('RESULT_SET_VIOLATION');
  });

  it('写入返回他人归属 / 他人主键 → 分别 OWNER_VIOLATION / IDENTITY_MISMATCH', async () => {
    const foreignOwner = repoWith({
      rows: [rowFromRecord({ user_id: OTHER_OWNER_ID })],
      rowCount: 1,
    });
    expect((await captureRepoError(() => foreignOwner.repository.create(APPLICATION))).code).toBe(
      'OWNER_VIOLATION',
    );

    const foreignId = repoWith({
      rows: [rowFromRecord({ id: OTHER_APPLICATION_ID })],
      rowCount: 1,
    });
    expect((await captureRepoError(() => foreignId.repository.create(APPLICATION))).code).toBe(
      'IDENTITY_MISMATCH',
    );
  });

  it('写入未返回行 → CONFLICT（与内存基线「ID 冲突」同语义）；返回多行 → RESULT_SET_VIOLATION', async () => {
    const conflict = repoWith({ rows: [], rowCount: 0 });
    const error = await captureRepoError(() => conflict.repository.create(APPLICATION));
    expect(error.code).toBe('CONFLICT');
    expect(error.issues).toEqual(['id']);

    const duplicate = repoWith({ rows: [rowFromRecord(), rowFromRecord()], rowCount: 2 });
    expect((await captureRepoError(() => duplicate.repository.create(APPLICATION))).code).toBe(
      'RESULT_SET_VIOLATION',
    );
  });

  it('写回后不可变 / 回显列被改写 → 逐列 fail-closed（覆盖全部不可变列与状态、时间）', async () => {
    const overrides: readonly [string, Record<string, unknown>, string][] = [
      ['id', { id: OTHER_APPLICATION_ID }, 'IDENTITY_MISMATCH'],
      ['user_id', { user_id: OTHER_OWNER_ID }, 'OWNER_VIOLATION'],
      ['group_id', { group_id: OTHER_GROUP_ID }, 'IDENTITY_MISMATCH'],
      ['kind', { kind: 'leave' }, 'IDENTITY_MISMATCH'],
      ['created_at', { created_at: new Date(REVIEWED_AT) }, 'IDENTITY_MISMATCH'],
      ['status', { status: 'rejected' }, 'IDENTITY_MISMATCH'],
      ['updated_at', { updated_at: new Date(REVIEWED_AT) }, 'IDENTITY_MISMATCH'],
    ];

    // 每一列都必须真的被复核：漏掉任一列，这条断言就会失败
    expect(overrides.map(([column]) => column).sort()).toEqual(
      [...POSTGRES_APPLICATION_IMMUTABLE_COLUMNS, 'status', 'updated_at'].sort(),
    );

    for (const [column, override, code] of overrides) {
      const row = rowFromRecord({
        status: 'withdrawn',
        updated_at: new Date(SAVED_AT),
        ...override,
      });
      const { repository } = repoWith({ rows: [row], rowCount: 1 });
      const error = await captureRepoError(() => repository.save(WITHDRAWN_APPLICATION));
      expect(error.code, `列 ${column}`).toBe(code);
      expect(error.issues).toEqual([column]);
    }
  });

  it('归属缺失 / 空 UUID / 非 UUID / 非规范小写形的写记录 → INVALID_RECORD，且不写库', async () => {
    // 形状就不合规（缺失 / 类型不对 / 长度越界）：由读取契约的严格版本拦下，字段路径是领域字段
    for (const userId of [undefined, '', 42, 'u'.repeat(65)]) {
      for (const run of [
        (repository: PostgresApplicationRepository) =>
          repository.create({ ...APPLICATION, userId } as unknown as Application),
        (repository: PostgresApplicationRepository) =>
          repository.save({ ...WITHDRAWN_APPLICATION, userId } as unknown as Application),
      ]) {
        const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });
        const error = await captureRepoError(() => run(repository));
        expect(error.code).toBe('INVALID_RECORD');
        expect(error.issues.some((issue) => issue.startsWith('userId'))).toBe(true);
        expect(executor.calls).toHaveLength(0);
      }
    }

    // 形状合规但**不在存储 ID 域**（非 UUID / 空 UUID / 大写）：由存储 ID 域约束拦下
    for (const userId of [
      'u-student-1',
      '00000000-0000-0000-0000-000000000000',
      HEX_OWNER_ID_UPPER,
      HEX_OWNER_ID_MIXED,
      `${OWNER_ID}' OR 1=1 --`,
    ]) {
      for (const run of [
        (repository: PostgresApplicationRepository) =>
          repository.create({ ...APPLICATION, userId } as unknown as Application),
        (repository: PostgresApplicationRepository) =>
          repository.save({ ...WITHDRAWN_APPLICATION, userId } as unknown as Application),
      ]) {
        const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });
        const error = await captureRepoError(() => run(repository));
        expect(error.code).toBe('INVALID_RECORD');
        expect(error.issues).toContain('user_id');
        expect(executor.calls).toHaveLength(0);
      }
    }
  });

  it('目标小组 / 主键 / 审核人不在存储 ID 域内 → INVALID_RECORD，且不写库', async () => {
    for (const record of [
      { ...APPLICATION, groupId: 'g-group-1' },
      { ...APPLICATION, groupId: HEX_GROUP_ID_UPPER },
      { ...APPLICATION, groupId: '00000000-0000-0000-0000-000000000000' },
      { ...APPLICATION, id: 'not-a-uuid' },
      { ...APPLICATION, id: HEX_APPLICATION_ID_UPPER },
      { ...APPLICATION, reviewedByUserId: 'u-admin-1' },
      { ...APPLICATION, reviewedByUserId: HEX_REVIEWER_ID.toUpperCase() },
    ]) {
      const { repository, executor } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });
      const error = await captureRepoError(() =>
        repository.create(record as unknown as Application),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(executor.calls).toHaveLength(0);
    }
  });

  it('规范小写 UUID 归属可以正常取数（大小写约束不是「拒绝一切」）', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord({ user_id: HEX_OWNER_ID })],
      rowCount: 1,
    });

    const listed = await repository.listByUserId(HEX_OWNER_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.userId).toBe(HEX_OWNER_ID);
    expect(callAt(executor, 0)?.parameters).toEqual([HEX_OWNER_ID]);
  });

  it('行里的归属不是规范存储标识符（大写 / 空 UUID）→ INVALID_ROW（存储不变量必须成立）', async () => {
    for (const user_id of [
      HEX_OWNER_ID_UPPER,
      '00000000-0000-0000-0000-000000000000',
      'u-student-1',
    ]) {
      const { repository } = repoWith({ rows: [rowFromRecord({ user_id })], rowCount: 1 });
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
    }
  });

  it('写回语句把 id 与 user_id 一起下推：拿他人 ID 也写不中他人数据', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });
    await captureRepoError(() => repository.save(WITHDRAWN_APPLICATION));

    const sql = callAt(executor, 0)?.sql ?? '';
    expect(sql).toContain('WHERE id = $1::uuid AND user_id = $2::uuid');
    expect(callAt(executor, 0)?.parameters?.slice(0, 2)).toEqual([
      WITHDRAWN_APPLICATION.id,
      WITHDRAWN_APPLICATION.userId,
    ]);
  });
});

describe('PostgreSQL 入组申请仓储：重复申请边界与结果集边界', () => {
  it('同组多次申请原样返回：adapter 不做未终态过滤（终态语义属共享状态机 + service）', async () => {
    const rows = [
      rowFromRecord({ id: uuidForIndex(1), status: 'pending' }),
      rowFromRecord({ id: uuidForIndex(2), status: 'withdrawn', note: null }),
      rowFromRecord({ id: uuidForIndex(3), status: 'rejected', note: null }),
    ];
    const { repository, executor } = repoWith({ rows, rowCount: 3 });

    const grouped = await repository.listByUserAndGroup(OWNER_ID, GROUP_ID);

    expect(grouped.map((record) => record.status)).toEqual(['pending', 'withdrawn', 'rejected']);
    // 结果集大小由 SQL 决定：adapter 不本地截断、不本地去重、不加状态谓词
    // （列清单里当然有 status 列，但 WHERE 里不得出现任何状态谓词）
    expect(callAt(executor, 0)?.sql).not.toMatch(/status\s*(?:=|<>|!=|IN|ANY|LIKE)/u);
    expect(callAt(executor, 0)?.sql).toContain('WHERE user_id = $1::uuid AND group_id = $2::uuid');
    expect(callAt(executor, 0)?.sql).not.toMatch(/\b(?:LIMIT|OFFSET)\b/u);
    expect(callAt(executor, 0)?.parameters).toEqual([OWNER_ID, GROUP_ID]);
  });

  it('同组结果里出现重复主键 → RESULT_SET_VIOLATION（重复申请不得被静默折叠）', async () => {
    const { repository } = repoWith({
      rows: [rowFromRecord({ id: uuidForIndex(1) }), rowFromRecord({ id: uuidForIndex(1) })],
      rowCount: 2,
    });

    const error = await captureRepoError(() => repository.listByUserAndGroup(OWNER_ID, GROUP_ID));
    expect(error.code).toBe('RESULT_SET_VIOLATION');
  });

  it('重复写入同一 ID：入库侧由主键冲突显式暴露（CONFLICT），不静默覆盖', async () => {
    const { repository, executor } = repoWith(
      { rows: [rowFromRecord()], rowCount: 1 },
      { rows: [], rowCount: 0 },
    );

    await repository.create(APPLICATION);
    const error = await captureRepoError(() => repository.create(APPLICATION));

    expect(error.code).toBe('CONFLICT');
    // 写入语句没有 DO UPDATE：既有的申请不会被第二次写入改写
    expect(callAt(executor, 0)?.sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(callAt(executor, 0)?.sql).not.toContain('DO UPDATE');
  });

  it('大批量（500 条）完整返回、不截断：顺序与数据库返回顺序逐一一致', async () => {
    const rows = Array.from({ length: 500 }, (_unused, index) =>
      rowFromRecord({ id: uuidForIndex(index + 1), note: null }),
    );
    const { repository } = repoWith({ rows, rowCount: rows.length });

    const listed = await repository.listByUserId(OWNER_ID);

    expect(listed).toHaveLength(500);
    expect(listed.map((record) => record.id)).toEqual(
      Array.from({ length: 500 }, (_unused, index) => uuidForIndex(index + 1)),
    );
  });

  it('读取路径全部不本地截断：SQL 里不出现 LIMIT / OFFSET / FETCH', async () => {
    const { repository, executor } = repoWith(
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    );

    await repository.listByUserId(OWNER_ID);
    await repository.listByUserAndGroup(OWNER_ID, GROUP_ID);
    await repository.findById(APPLICATION_ID, OWNER_ID);

    for (const call of executor.calls) {
      expect(call.sql).not.toMatch(/\b(?:LIMIT|OFFSET|FETCH|TOP)\b/u);
      expect(call.parameters?.length ?? 0).toBeLessThanOrEqual(2);
    }
  });
});

describe('PostgreSQL 入组申请仓储：公开视图与错误信息（不泄露归属 / 审核内部字段 / PII）', () => {
  it('存储记录承载归属与审核留痕（不静默丢弃），但对外视图必须完全不含它们', async () => {
    const { repository } = repoWith({
      rows: [
        rowFromRecord({
          status: 'approved',
          reviewed_by_user_id: APPROVED_APPLICATION.reviewedByUserId,
          review_comment: APPROVED_APPLICATION.reviewComment,
          reviewed_at: new Date(REVIEWED_AT),
          updated_at: new Date(SAVED_AT),
        }),
      ],
      rowCount: 1,
    });

    const listed = await repository.listByUserId(OWNER_ID);
    const stored = listed[0];
    expect(stored?.userId).toBe(OWNER_ID);
    expect(stored?.reviewedByUserId).toBe(HEX_REVIEWER_ID);
    expect(stored?.reviewComment).toBe(REVIEW_COMMENT);
    expect(stored?.reviewedAt).toBe(REVIEWED_AT);

    const parsed = parseStoredApplication(stored);
    expect(parsed.ok).toBe(true);
    const view = toApplicationView(parsed.ok ? parsed.value : ({} as never)) as unknown as Record<
      string,
      unknown
    >;

    for (const excluded of POSTGRES_APPLICATION_VIEW_EXCLUDED_COLUMNS) {
      expect(Object.keys(view)).not.toContain(excluded);
    }
    for (const internal of [
      'userId',
      'reviewedByUserId',
      'reviewComment',
      'reviewedAt',
      'reviewerId',
      'reviewerUserId',
      'auditEventId',
      'membershipId',
    ]) {
      expect(Object.keys(view)).not.toContain(internal);
    }

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(OWNER_ID);
    expect(serialized).not.toContain(HEX_REVIEWER_ID);
    expect(serialized).not.toContain(REVIEW_COMMENT);
    expect(serialized).not.toContain('user_id');
    expect(serialized).not.toContain('review_');
    // 视图键集 = 读取契约字段去掉「公开输出裁剪列」对应的领域字段后的键集
    const excludedFields = POSTGRES_APPLICATION_VIEW_EXCLUDED_COLUMNS.map(
      (column) => POSTGRES_APPLICATION_COLUMN_FIELDS[column],
    );
    const expectedKeys = Object.keys(storedApplicationSchema.shape)
      .filter((key) => !excludedFields.includes(key as keyof Application))
      .sort();
    expect(Object.keys(view).sort()).toEqual(expectedKeys);
  });

  it('公开视图保留本人自读范围内的字段（目标小组 / 类型 / 备注 / 状态 / 时间）', async () => {
    const { repository } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });
    const listed = await repository.listByUserId(OWNER_ID);
    const parsed = parseStoredApplication(listed[0]);
    const view = toApplicationView(parsed.ok ? parsed.value : ({} as never));

    // 本切片没有 group 详情端口，group ID 必须在视图里（否则前端无法展示申请目标）；
    // 备注是「申请人自己填的备注」，在本人自读范围内是合法内容，因此不裁剪。
    expect(view).toEqual({
      id: APPLICATION_ID,
      groupId: GROUP_ID,
      kind: 'join',
      note: NOTE,
      status: 'pending',
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
  });

  it('成功路径的返回记录里不出现任何 snake_case 列名（列名只存在于 SQL 与行契约）', async () => {
    const { repository } = repoWith({ rows: [rowFromRecord()], rowCount: 1 });
    const stored = (await repository.create(APPLICATION)) as unknown as Record<string, unknown>;

    for (const key of Object.keys(stored)) {
      expect(key.includes('_')).toBe(false);
    }
    for (const column of POSTGRES_APPLICATION_COLUMNS.filter((entry) => entry.includes('_'))) {
      expect(stored).not.toHaveProperty(column);
    }
  });

  it('任何失败路径的错误信息与 issues 都不含归属标识、备注原文、审核意见与注入载荷', async () => {
    const longNote = '超长备注'.repeat(300);
    const secrets = [
      OWNER_ID,
      OTHER_OWNER_ID,
      HEX_OWNER_ID,
      HEX_REVIEWER_ID,
      NOTE,
      REVIEW_COMMENT,
      longNote,
      `${OWNER_ID}' OR 1=1 --`,
      "x'); DROP TABLE join_applications; --",
      'DROP TABLE',
      GROUP_ID.toUpperCase(),
    ];

    const scenarios: readonly (() => Promise<unknown>)[] = [
      // 归属不符（他人记录回流）
      () =>
        repoWith({
          rows: [rowFromRecord({ id: OTHER_APPLICATION_ID, user_id: OTHER_OWNER_ID })],
          rowCount: 1,
        }).repository.listByUserId(OWNER_ID),
      // 未登记列（含审核别名与注入载荷）
      () =>
        repoWith({
          rows: [rowFromRecord({ reviewer_comment: `${REVIEW_COMMENT} DROP TABLE` })],
          rowCount: 1,
        }).repository.listByUserId(OWNER_ID),
      // 未知状态
      () =>
        repoWith({
          rows: [rowFromRecord({ status: 'unknown_status' })],
          rowCount: 1,
        }).repository.listByUserId(OWNER_ID),
      // 备注越界
      () =>
        repoWith({
          rows: [rowFromRecord({ note: longNote })],
          rowCount: 1,
        }).repository.listByUserId(OWNER_ID),
      // 写路径字段污染
      () =>
        repoWith({ rows: [rowFromRecord()], rowCount: 1 }).repository.create({
          ...APPLICATION,
          reviewerUserId: HEX_REVIEWER_ID,
        } as unknown as Application),
      // 主体非法（注入载荷）
      () =>
        repoWith({ rows: [rowFromRecord()], rowCount: 1 }).repository.listByUserId(
          `${OWNER_ID}' OR 1=1 --`,
        ),
      // 小组谓词非法（非规范小写形 UUID）
      () =>
        repoWith({ rows: [rowFromRecord()], rowCount: 1 }).repository.listByUserAndGroup(
          OWNER_ID,
          HEX_GROUP_ID_UPPER,
        ),
      // 非法状态转换（诊断出的是内部状态）
      () =>
        repoWith(
          { rows: [], rowCount: 0 },
          { rows: [{ status: 'rejected' }], rowCount: 1 },
        ).repository.save({
          ...APPLICATION,
          status: ApplicationStatus.Approved,
          updatedAt: SAVED_AT,
        }),
      // 记录不存在
      () =>
        repoWith({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }).repository.save(
          WITHDRAWN_APPLICATION,
        ),
      // 写入未返回行（主键冲突）
      () => repoWith({ rows: [], rowCount: 0 }).repository.create(APPLICATION),
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

describe('PostgreSQL 入组申请仓储：已接入运行时绑定、无驱动依赖、与 schema 边界对齐', () => {
  it('MembershipsModule 经工厂绑定本 adapter（唯一换绑点；未配置数据库时才落到内存基线）', () => {
    const content = readFileSync(MODULE_PATH, 'utf8');

    // 换绑事实由「端口令牌 + 工厂导出名 + 配置分流函数」三项同时成立，
    // 登记表 `POSTGRES_BOUND_SLICE_REGISTRY` 就是按这些项做机器判定的
    expect(content).toContain('APPLICATION_REPOSITORY');
    expect(content).toContain('createLazyPostgresApplicationRepository');
    expect(content).toContain('resolveAppDatabaseConfig');
    // 未配置数据库时的回落实现仍在模块里（分流，而不是「永远内存」）
    expect(content).toContain('InMemoryApplicationRepository');
    // 装配只发生在模块的工厂里：adapter 类名不得作为 provider 出现
    expect(content).not.toMatch(ADAPTER_CLASS_REFERENCE);
    expect(content).not.toContain('useExisting');
  });

  it('登记表 / 数据库模块 / 端口文件都不 import 本 adapter（装配只发生在 memberships.module.ts 的工厂里）', () => {
    for (const relative of [
      join('src', 'db', 'persistence-bindings.ts'),
      join('src', 'db', 'database.module.ts'),
      join('src', 'db', 'ports', 'sql-executor.port.ts'),
      join('src', 'modules', 'memberships', 'applications.port.ts'),
      join('src', 'app.module.ts'),
    ]) {
      const content = readApiFile(relative);
      // 端口文件只在注释里以「示例路径」提到 adapter 模块文件名，这不构成装配；任何 import /
      // provider 引用（类名或模块路径）都必须为零
      expect(content).not.toMatch(ADAPTER_CLASS_REFERENCE);
      expect(content).not.toMatch(
        /(?:from\s+['"][^'"]*applications\.postgres-repository['"]|require\(\s*['"][^'"]*applications\.postgres-repository['"]\s*\))/u,
      );
    }
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
        './applications.contract',
        './applications.port',
        // 审核端端口：审核仓储实现与申请人端实现**同文件**（门禁规定一个模块只能有一个
        // 持久化适配切片），但仍是各自独立的端口，因此这里多出一个**端口**说明符
        // —— 不是驱动，也不是另一个 adapter（同模块 adapter 之间互相 import 会被
        // postgres-adapter-boundary 判为转发并拒绝）。
        './application-reviews.port',
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

  it('join_applications 已由迁移 0003 建立（已装配但未完成验证，productionReady 保持 false）', () => {
    const migrations = readdirSync(join(REPO_ROOT, 'db', 'migrations'));
    expect(migrations).toContain('0003_join_applications.sql');

    const sql = readFileSync(
      join(REPO_ROOT, 'db', 'migrations', '0003_join_applications.sql'),
      'utf8',
    );
    // 建表语句必须真的存在，而不是像 bootstrap 那样只在注释里登记
    expect(sql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+join_applications\s*\(/iu);
    // 列清单里的每一列都必须在迁移里有定义（列清单 ↔ schema 单向核对）
    for (const column of POSTGRES_APPLICATION_COLUMNS) {
      expect(sql).toMatch(
        new RegExp(
          `\\b${column}\\s+(?:uuid|smallint|integer|varchar|timestamptz|jsonb|boolean)\\b`,
          'u',
        ),
      );
    }
    // 统计聚合读按归属过滤：user_id 必须被索引
    expect(sql).toMatch(/CREATE\s+INDEX[\s\S]*?\(\s*user_id/iu);

    // 草案目录里仍然没有 join_applications（本切片直接落迁移，不落草案）
    const drafts = readdirSync(join(REPO_ROOT, 'db', 'schema-drafts'));
    expect(drafts.some((file) => file.includes('application'))).toBe(false);

    // 表已建 ≠ 已装配：能力声明仍不得声称生产可用
    expect(POSTGRES_APPLICATION_REPOSITORY_CAPABILITIES.productionReady).toBe(false);
    expect(POSTGRES_APPLICATION_REPOSITORY_VERIFICATION_STEPS).toContain(
      'join-applications-schema-draft-created-and-promoted-to-migration',
    );
  });

  it('内存基线实现**同一份异步端口**，且归属隔离口径与数据库实现一致', () => {
    const source = readApiFile(
      join('src', 'modules', 'memberships', 'applications.in-memory-repository.ts'),
    );
    expect(source).toContain('implements ApplicationRepository');
    expect(source).not.toMatch(ADAPTER_CLASS_REFERENCE);
    expect(source).toContain('persistent: false');
    expect(source).toContain('productionReady: false');
    // 异步端口：方法都是 async；单条读取必须按（资源 ID, 服务端主体）双命中返回
    expect(source).toContain('async findById(');
    expect(source).toContain('ownerUserId');
    expect(source).toContain('record.userId !== ownerUserId');
  });

  it('端口已收敛为异步契约（运行时不再有同步签名可依赖）', () => {
    const source = readApiFile(join('src', 'modules', 'memberships', 'applications.port.ts'));
    expect(source).toContain('export interface ApplicationRepository {');
    expect(source).toContain('create(application: Application): Promise<Application>;');
    expect(source).toContain(
      'findById(applicationId: string, ownerUserId: string): Promise<Application | undefined>;',
    );
    expect(source).toContain('save(application: Application): Promise<Application>;');
    expect(source).not.toContain('export interface AsyncApplicationRepository {');
    expect(source).not.toContain('create(application: Application): Application;');
  });

  it('adapter 的公开面覆盖能力、验证清单、列清单与状态机逆映射（供上层与运维机器判定）', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    for (const exported of [
      'POSTGRES_APPLICATION_TABLE',
      'POSTGRES_APPLICATION_COLUMNS',
      'POSTGRES_APPLICATION_COLUMN_FIELDS',
      'POSTGRES_APPLICATION_OWNER_COLUMNS',
      'POSTGRES_APPLICATION_PII_COLUMNS',
      'POSTGRES_APPLICATION_REVIEW_INTERNAL_COLUMNS',
      'POSTGRES_APPLICATION_VIEW_EXCLUDED_COLUMNS',
      'POSTGRES_APPLICATION_MUTABLE_COLUMNS',
      'POSTGRES_APPLICATION_IMMUTABLE_COLUMNS',
      'POSTGRES_APPLICATION_REPOSITORY_CAPABILITIES',
      'POSTGRES_APPLICATION_REPOSITORY_VERIFICATION_STEPS',
    ]) {
      expect(source).toContain(`export const ${exported}`);
    }
    expect(source).toContain('export class PostgresApplicationRepository');
    expect(source).toContain('export class PostgresApplicationRepositoryError');
    expect(source).toContain('export function assertPostgresApplicationRepositoryCapabilities');
    expect(source).toContain('export function applicationStatusPredecessors');
    expect(source).toContain('export function createLazyPostgresApplicationRepository');
    expect(source).toContain('export type PostgresApplicationRepositoryErrorCode');
    // 能力声明与自检都必须以「未验证不得生产」的措辞自证
    expect(source).toContain('productionReady: false');
    expect(source).toContain('不得声称生产可用');
  });
});
