import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  PersistenceCapabilities,
  SqlExecutor,
  SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import {
  NOTIFICATION_VIEW_FIELDS,
  markNotificationRead,
  parseNotificationView,
  parseStoredNotification,
  toNotificationView,
} from './notifications.contract';
import type {
  AsyncNotificationRepository,
  Notification,
  NotificationRepositoryCapabilities,
} from './notifications.port';
import {
  NOTIFICATION_REPOSITORY_BACKEND_POSTGRES,
  NOTIFICATION_REPOSITORY_STORAGE_ID_DOMAIN,
  NOTIFICATION_STATUS_VALUES,
  NOTIFICATION_TYPE_VALUES,
  NotificationStatus,
  NotificationType,
} from './notifications.port';
import {
  POSTGRES_NOTIFICATION_COLUMN_FIELDS,
  POSTGRES_NOTIFICATION_COLUMNS,
  POSTGRES_NOTIFICATION_FIELD_COLUMNS,
  POSTGRES_NOTIFICATION_IMMUTABLE_COLUMNS,
  POSTGRES_NOTIFICATION_INTERNAL_COLUMNS,
  POSTGRES_NOTIFICATION_MUTABLE_COLUMNS,
  POSTGRES_NOTIFICATION_OWNER_COLUMNS,
  POSTGRES_NOTIFICATION_PII_COLUMNS,
  POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES,
  POSTGRES_NOTIFICATION_REPOSITORY_VERIFICATION_STEPS,
  POSTGRES_NOTIFICATION_TABLE,
  POSTGRES_NOTIFICATION_VIEW_EXCLUDED_COLUMNS,
  PostgresNotificationRepository,
  PostgresNotificationRepositoryError,
  assertNotificationViewExclusion,
  assertPostgresNotificationRepositoryCapabilities,
  canAdvanceNotificationStatus,
  findNotificationViewExclusionLeaks,
  notificationStatusPredecessors,
} from './notifications.postgres-repository';

/**
 * 站内通知 PostgreSQL 仓储 adapter 的**离线**验收（不连数据库、不引驱动）。
 *
 * 覆盖用户要求的补充安全契约测试与交付边界：
 * - **能力与交付边界**：`persistent = true` / `productionReady = false`（未真实驱动验证前严禁
 *   生产）、列清单与读取契约字段双射、`notifications` 尚未转为迁移、adapter 未被装配到
 *   `NotificationsModule`、不引驱动/ORM、同步端口未被改成异步；
 * - **参数化 SQL 与固定标识符**：客户端可控值只出现在参数里，SQL 文本只由模块常量构成
 *   （语句里没有任何引号 / 分号 / 注释符，因此不存在字面量注入面）；
 * - **SQL 注入**：标题、正文、主体、资源 ID 等所有入口的注入载荷要么只进参数、要么在进入 SQL
 *   之前被拒绝（拒绝路径**一个 SQL 都不执行**）；
 * - **未知列 / 严格行契约 / 字段污染**：未登记列（含内部 payload、路径、URL、storage handle、
 *   PII 收件标识）、缺列、写路径的 snake_case 别名与权限字段一律 fail-closed；
 * - **read 状态转换仅允许服务端幂等规则**：闭集取值全部往返；`save` 的前驱集合与
 *   `notifications.contract.ts` 的标记已读状态机**逐对**一致（全矩阵）；`unread` 无前驱因此
 *   无法回退；已读记录再写一次被 `TRANSITION_REJECTED` 拒绝，`readAt` 不可能被改写；
 * - **按服务端 subject owner 隔离**：他人通知既不出库（归属下推进 SQL）也不得回流，归属与
 *   不可变列不得被改写；
 * - **公开视图不泄露归属与内部信息**：视图恰好是白名单闭集，不含 `userId`、内部 payload、
 *   路径、URL、storage handle 或 PII；所有失败路径的错误信息与 `issues` 只含字段路径与违规
 *   类型，不含任何取值。
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
const NOTIFICATIONS_DIR = resolve(process.cwd(), 'src', 'modules', 'notifications');
const ADAPTER_PATH = resolve(NOTIFICATIONS_DIR, 'notifications.postgres-repository.ts');
const PORT_PATH = resolve(NOTIFICATIONS_DIR, 'notifications.port.ts');
const MODULE_PATH = resolve(NOTIFICATIONS_DIR, 'notifications.module.ts');
const ADAPTER_CLASS = 'PostgresNotificationRepository';
const ADAPTER_MODULE = 'notifications.postgres-repository';

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
/** 含十六进制字母的归属：用于验证「规范小写形」约束（纯数字 UUID 无法体现大小写差异） */
const HEX_OWNER_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const HEX_OWNER_ID_UPPER = 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678';
const HEX_OWNER_ID_MIXED = 'a1b2c3d4-E5F6-4789-8abc-DEF012345678';
const NOTIFICATION_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_NOTIFICATION_ID = '66666666-6666-4666-8666-666666666666';
/** 含十六进制字母的主键：用于验证「规范小写形」约束 */
const HEX_NOTIFICATION_ID = 'e1f2a3b4-c5d6-4789-8efa-0123456789ab';
const HEX_NOTIFICATION_ID_UPPER = 'E1F2A3B4-C5D6-4789-8EFA-0123456789AB';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const CREATED_AT = '2026-01-02T03:04:05.000Z';
const UPDATED_AT = '2026-01-03T04:05:06.000Z';
const READ_AT = '2026-01-04T05:06:07.000Z';
/** 标记已读后的 `updatedAt` */
const SAVED_AT = '2026-01-05T06:07:08.000Z';
const TITLE = '入组申请审核结果';
const BODY = '你提交的入组申请已通过审核';
/** 注入载荷：只允许出现在参数里，绝不允许出现在 SQL 文本或错误信息里 */
const INJECTION = "x'); DROP TABLE notifications; --";
/** 疑似身份证号（PII）：读取契约必须拒绝，且错误信息不得回显 */
const PII_TITLE = '证件 11010119900307123X 待核对';
/** 疑似密钥（PII）：读取契约必须拒绝，且错误信息不得回显 */
const SECRET_BODY = 'token: abcdefgh1234';

/** 未读通知样本（列表与单条读取的主要样本） */
const UNREAD_NOTIFICATION: Notification = {
  id: NOTIFICATION_ID,
  userId: OWNER_ID,
  type: NotificationType.MembershipReview,
  title: TITLE,
  body: BODY,
  status: NotificationStatus.Unread,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

/** 已读通知样本（`read` 是终态；用于写回与公开视图裁剪） */
const READ_NOTIFICATION: Notification = {
  ...UNREAD_NOTIFICATION,
  status: NotificationStatus.Read,
  readAt: READ_AT,
  updatedAt: SAVED_AT,
};

/** 数据库行（snake_case）：默认与给定记录等价 */
function rowFromRecord(
  record: Notification,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: record.id,
    user_id: record.userId,
    type: record.type,
    title: record.title,
    body: record.body,
    status: record.status,
    read_at: record.readAt === undefined ? null : new Date(record.readAt),
    created_at: new Date(record.createdAt),
    updated_at: new Date(record.updatedAt),
    ...overrides,
  };
}

/** 移除某一列，用于「缺列」用例 */
function withoutRowColumn(record: Notification, column: string): Record<string, unknown> {
  const row = rowFromRecord(record);
  delete row[column];
  return row;
}

/** 复制记录并去掉某个字段（模拟「缺必填字段」的写入记录） */
function omitField(record: Notification, field: keyof Notification): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  delete copy[field];
  return copy;
}

/** 造一批稳定且唯一的 UUID（版本位 4、变体位 8，满足 uuidSchema） */
function uuidForIndex(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** 用给定响应构造 adapter（响应按调用顺序消费） */
function repoWith(...responses: unknown[]): {
  repository: PostgresNotificationRepository;
  executor: RecordingExecutor;
} {
  const executor = new RecordingExecutor(responses);
  return { repository: new PostgresNotificationRepository(executor), executor };
}

async function captureRepoError(
  run: () => Promise<unknown>,
): Promise<PostgresNotificationRepositoryError> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresNotificationRepositoryError);
  return captured as PostgresNotificationRepositoryError;
}

function captureSyncError(run: () => unknown): PostgresNotificationRepositoryError {
  let captured: unknown;
  try {
    run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresNotificationRepositoryError);
  return captured as PostgresNotificationRepositoryError;
}

/**
 * 断言 `issues` 里存在指向某个字段路径的违规。
 *
 * `issues` 的形状是 `字段路径(违规类型)`（例如 `user_id(invalid_string)`），违规类型取决于
 * zod 的 issue code，因此只固定「指向哪个字段」，不把违规类型写死（那属于实现细节）。
 * 存储 ID 域约束走的是 adapter 自有的 `requireStorageUuid`，它只给出裸字段路径（例如 `id`），
 * 因此裸路径同样算命中。
 */
function expectIssueOn(error: PostgresNotificationRepositoryError, path: string): void {
  expect(error.issues.some((issue) => issue === path || issue.startsWith(`${path}(`))).toBe(true);
}

/** 断言 `issues` 里存在指向给定若干字段路径之一的违规 */
function expectIssueOnAny(
  error: PostgresNotificationRepositoryError,
  paths: readonly string[],
): void {
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
  const index = [...POSTGRES_NOTIFICATION_COLUMNS].indexOf(
    column as (typeof POSTGRES_NOTIFICATION_COLUMNS)[number],
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

/** 共享读取契约声明的**全部**领域字段（由契约本身推导，而不是在测试里另抄一份清单） */
function readContractFields(): readonly string[] {
  const parsed = parseStoredNotification(READ_NOTIFICATION);
  if (!parsed.ok) {
    throw new Error('样本记录未通过共享读取契约');
  }
  return Object.keys(parsed.value).sort();
}

/** 独立重算「目标状态的合法前驱集合」：只用契约状态机的正向行为，避免与实现共用同一份逆映射 */
function expectedPredecessors(status: NotificationStatus): readonly NotificationStatus[] {
  return NOTIFICATION_STATUS_VALUES.filter((from) => {
    const advanced = markNotificationRead(
      from === NotificationStatus.Read
        ? { ...READ_NOTIFICATION, status: NotificationStatus.Read }
        : { ...READ_NOTIFICATION, status: NotificationStatus.Unread, readAt: undefined },
      READ_AT,
    );
    return advanced.changed && advanced.record.status === status;
  });
}

/** 失败路径的信息卫生断言：错误信息与 issues 都不含任何取值 */
function expectNoValueLeak(error: PostgresNotificationRepositoryError): void {
  const text = `${error.message} ${error.issues.join(' ')}`;
  for (const forbidden of [
    OWNER_ID,
    OTHER_OWNER_ID,
    HEX_OWNER_ID,
    NOTIFICATION_ID,
    OTHER_NOTIFICATION_ID,
    HEX_NOTIFICATION_ID,
    TITLE,
    BODY,
    READ_AT,
    SAVED_AT,
    INJECTION,
    '11010119900307123X',
    'abcdefgh1234',
  ]) {
    expect(text).not.toContain(forbidden);
  }
  // 冒号与引号意味着「键=值」形态的回显（issues 只允许 `字段路径(违规类型)`）
  expect(error.issues.every((issue) => !issue.includes(':') && !issue.includes('='))).toBe(true);
}

describe('PostgreSQL 通知仓储：能力声明与交付边界', () => {
  it('能力声明恰好是 postgres / persistent=true / productionReady=false，且被冻结', () => {
    expect(POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES).toEqual({
      backend: NOTIFICATION_REPOSITORY_BACKEND_POSTGRES,
      persistent: true,
      productionReady: false,
    });
    expect(NOTIFICATION_REPOSITORY_BACKEND_POSTGRES).toBe('postgres');
    expect(Object.isFrozen(POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES)).toBe(true);
    expect(NOTIFICATION_REPOSITORY_STORAGE_ID_DOMAIN).toBe('uuid');
  });

  it('本 adapter 声明 persistent=true 但 productionReady=false（未真实驱动验证前严禁生产）', () => {
    const { repository } = repoWith();
    expect(repository.capabilities.persistent).toBe(true);
    expect(repository.capabilities.productionReady).toBe(false);
    expect(repository.capabilities.backend).toBe('postgres');
  });

  it('验证清单覆盖「驱动 → 集成 → 草案转迁移 → 异步端口 → UUID 主体 → 规范小写 → 幂等复核 → 409 映射 → 才可声明生产」九步', () => {
    expect([...POSTGRES_NOTIFICATION_REPOSITORY_VERIFICATION_STEPS]).toEqual([
      'driver-dependency-evaluated',
      'integration-tests-against-real-postgres',
      'notifications-schema-draft-created-and-promoted-to-migration',
      'notification-repository-port-migrated-to-async',
      'session-subject-user-ids-converged-to-uuid',
      'request-uuid-fields-normalized-to-canonical-lowercase',
      'read-state-idempotency-verified-at-storage-layer',
      'state-transition-rejection-mapped-to-409',
      'production-ready-capability-flipped-with-evidence',
    ]);
  });

  it('自检放行当前声明，但拒绝「未验证就声称生产可用」/ 非持久 / 非 postgres', () => {
    expect(() => assertPostgresNotificationRepositoryCapabilities()).not.toThrow();

    const cases: readonly NotificationRepositoryCapabilities[] = [
      { backend: 'postgres', persistent: true, productionReady: true },
      { backend: 'postgres', persistent: false, productionReady: false },
      { backend: 'in-memory-baseline', persistent: true, productionReady: false },
    ];
    for (const capabilities of cases) {
      const error = captureSyncError(() =>
        assertPostgresNotificationRepositoryCapabilities(capabilities),
      );
      expect(error.code).toBe('CAPABILITY_MISDECLARED');
      expect(error.message).toContain('不得声称生产可用');
      expectNoValueLeak(error);
    }
  });

  it('列清单与读取契约字段构成双射（列→字段 与 字段→列 互为逆映射）', () => {
    const contractFields = readContractFields();
    expect(contractFields).toEqual(
      [...POSTGRES_NOTIFICATION_COLUMNS]
        .map((column) => POSTGRES_NOTIFICATION_COLUMN_FIELDS[column])
        .sort(),
    );
    expect(contractFields).toEqual(Object.keys(POSTGRES_NOTIFICATION_FIELD_COLUMNS).sort());

    // 双射：任一方向都必须是另一方向的逆
    for (const column of POSTGRES_NOTIFICATION_COLUMNS) {
      const field = POSTGRES_NOTIFICATION_COLUMN_FIELDS[column];
      expect(POSTGRES_NOTIFICATION_FIELD_COLUMNS[field]).toBe(column);
    }
  });

  it('列清单刻意为 9 列、无 SELECT *：内部列不在其中', () => {
    expect([...POSTGRES_NOTIFICATION_COLUMNS]).toEqual([
      'id',
      'user_id',
      'type',
      'title',
      'body',
      'status',
      'read_at',
      'created_at',
      'updated_at',
    ]);
    for (const internal of POSTGRES_NOTIFICATION_INTERNAL_COLUMNS) {
      expect([...POSTGRES_NOTIFICATION_COLUMNS]).not.toContain(internal);
    }
  });

  it('表名是 notifications，且尚未登记在迁移与草案目录中（与 productionReady=false 配对）', () => {
    expect(POSTGRES_NOTIFICATION_TABLE).toBe('notifications');
    expect(/^[a-z][a-z0-9_]*$/u.test(POSTGRES_NOTIFICATION_TABLE)).toBe(true);

    for (const file of readdirSync(join(REPO_ROOT, 'db', 'migrations'))) {
      if (!file.endsWith('.sql')) continue;
      const sql = readFileSync(join(REPO_ROOT, 'db', 'migrations', file), 'utf8');
      expect(sql).not.toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?notifications\b/iu);
    }
    for (const file of readdirSync(join(REPO_ROOT, 'db', 'schema-drafts'))) {
      if (!file.endsWith('.sql')) continue;
      const draft = readFileSync(join(REPO_ROOT, 'db', 'schema-drafts', file), 'utf8');
      expect(draft).not.toMatch(/^--\s*target-table:\s*notifications\s*$/imu);
    }

    expect(POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES.productionReady).toBe(false);
    expect(POSTGRES_NOTIFICATION_REPOSITORY_VERIFICATION_STEPS).toContain(
      'notifications-schema-draft-created-and-promoted-to-migration',
    );
  });

  it('归属列 / 个人级内容列 / 存储侧内部列 / 公开输出裁剪列各有明确清单', () => {
    expect([...POSTGRES_NOTIFICATION_OWNER_COLUMNS]).toEqual(['user_id']);

    expect([...POSTGRES_NOTIFICATION_INTERNAL_COLUMNS]).toEqual([
      'payload',
      'deep_link_path',
      'action_url',
      'attachment_storage_handle',
      'recipient_openid',
    ]);

    // 个人级内容列（合法内容，但不进错误消息与日志）与内部 PII 列都在清单内
    expect([...POSTGRES_NOTIFICATION_PII_COLUMNS]).toEqual(['title', 'body', 'recipient_openid']);

    // 裁剪清单 = 归属 + 全部内部列，逐项核对，避免「漏登记一个内部列」
    expect([...POSTGRES_NOTIFICATION_VIEW_EXCLUDED_COLUMNS]).toEqual([
      'user_id',
      ...POSTGRES_NOTIFICATION_INTERNAL_COLUMNS,
    ]);
  });

  it('写回允许变更的列与不可变列互补：并集是列清单、交集为空', () => {
    const mutable: readonly string[] = POSTGRES_NOTIFICATION_MUTABLE_COLUMNS;
    const immutable: readonly string[] = POSTGRES_NOTIFICATION_IMMUTABLE_COLUMNS;

    expect(mutable.length).toBeGreaterThan(0);
    expect(immutable.length).toBeGreaterThan(0);
    expect([...new Set([...mutable, ...immutable])].sort()).toEqual(
      [...POSTGRES_NOTIFICATION_COLUMNS].sort(),
    );
    expect(mutable.filter((column) => immutable.includes(column))).toEqual([]);

    // 标记已读只允许改状态与时间戳；归属、类型、标题、正文、创建时间必须不可变
    expect([...mutable].sort()).toEqual(['read_at', 'status', 'updated_at']);
    for (const column of ['id', 'user_id', 'type', 'title', 'body', 'created_at']) {
      expect([...immutable]).toContain(column);
    }
  });

  it('实现的是异步仓储契约（Promise 语义），未被绑定为同步端口', async () => {
    const repository: AsyncNotificationRepository = new PostgresNotificationRepository(
      new RecordingExecutor([{ rows: [rowFromRecord(UNREAD_NOTIFICATION)], rowCount: 1 }]),
    );
    const created = repository.create(UNREAD_NOTIFICATION);
    expect(created).toBeInstanceOf(Promise);
    await expect(created).resolves.toEqual(UNREAD_NOTIFICATION);
    // 同步端口要求同步返回值：返回 Promise 说明实现的确实是并存的异步契约
    expect(created).not.toEqual(UNREAD_NOTIFICATION);
  });

  it('adapter 不是 Nest provider：源码不含 @Injectable / @Module / Inject(', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).not.toContain('@Injectable');
    expect(source).not.toContain('@Module');
    expect(source).not.toContain('Inject(');
    expect(source).not.toContain("from '@nestjs/common'");
  });

  it('异步契约与同步端口方法集对应，两处刻意签名差异都写在契约注释里', () => {
    const source = readFileSync(PORT_PATH, 'utf8');
    expect(source).toContain('export interface NotificationRepository {');
    expect(source).toContain('create(notification: Notification): Notification;');
    expect(source).toContain('findById(notificationId: string): Notification | undefined;');
    expect(source).toContain('listByUserId(userId: string): readonly Notification[];');
    expect(source).toContain('save(notification: Notification): Notification;');

    expect(source).toContain('export interface AsyncNotificationRepository {');
    expect(source).toContain('create(notification: Notification): Promise<Notification>;');
    expect(source).toContain(
      'findById(notificationId: string, ownerUserId: string): Promise<Notification | undefined>;',
    );
    expect(source).toContain('listByUserId(userId: string): Promise<readonly Notification[]>;');
    expect(source).toContain('save(notification: Notification): Promise<Notification>;');

    // 两处签名差异必须被文档化（归属隔离强化，不是语义漂移）
    expect(source).toContain('刻意的签名差异');
    expect(source).toContain('归属必须**下推进 SQL**');
    expect(source).toContain('拿他人通知的 ID 改写他人数据');
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
        './notifications.contract',
        './notifications.port',
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

describe('PostgreSQL 通知仓储：执行器 fail-closed', () => {
  it('没有执行器 / 执行器缺 query / 缺能力声明 → 构造即拒绝，且不执行任何 SQL', () => {
    const cases: readonly unknown[] = [
      undefined,
      null,
      {},
      { capabilities: { backend: 'postgres', persistent: true, productionReady: false } },
      { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
    ];
    for (const executor of cases) {
      const error = captureSyncError(
        () => new PostgresNotificationRepository(executor as SqlExecutor),
      );
      expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
      expectNoValueLeak(error);
    }
  });

  it('执行器声明的后端不是 PostgreSQL → 拒绝（不得把 adapter 挂到其他存储上）', () => {
    for (const backend of ['in-memory-baseline', 'sqlite', 'mysql', '']) {
      const executor = new RecordingExecutor();
      executor.capabilities = { backend, persistent: true, productionReady: false };
      const error = captureSyncError(() => new PostgresNotificationRepository(executor));
      expect(['EXECUTOR_NOT_POSTGRES', 'EXECUTOR_UNAVAILABLE']).toContain(error.code);
      expect(executor.calls).toEqual([]);
    }
  });

  it('执行器声明为非持久后端（内存替身）→ 拒绝', () => {
    const executor = new RecordingExecutor();
    executor.capabilities = { backend: 'postgres', persistent: false, productionReady: false };
    const error = captureSyncError(() => new PostgresNotificationRepository(executor));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toEqual([]);
  });

  it('构造后执行器被降级为非持久 → 下一次调用 fail-closed，且不再访问 SQL', async () => {
    const { repository, executor } = repoWith();
    executor.capabilities = { backend: 'postgres', persistent: false, productionReady: false };

    const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toEqual([]);
  });

  it('构造后能力声明被改写为「生产可用」→ 每次调用都 fail-closed（自检不被绕过）', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
    (repository as unknown as { capabilities: NotificationRepositoryCapabilities }).capabilities = {
      backend: 'postgres',
      persistent: true,
      productionReady: true,
    };

    const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
    expect(error.code).toBe('CAPABILITY_MISDECLARED');
    expect(executor.calls).toEqual([]);
  });

  it('结果集缺少 rows 数组 / 结果不是对象 → 判驱动缺陷，不伪装成「该主体尚无通知」', async () => {
    const malformed: readonly unknown[] = [
      'rows',
      3,
      { rowCount: 0 },
      { rows: 'x' },
      { rows: null },
    ];
    for (const response of malformed) {
      const { repository } = repoWith(response);
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }

    // 结果本身是 null / undefined：RecordingExecutor 会兜底成「空结果」，因此用最小执行器直接投喂
    for (const response of [null, undefined]) {
      const executor = {
        capabilities: { backend: 'postgres', persistent: true, productionReady: false },
        query: () => Promise.resolve(response),
      } as unknown as SqlExecutor;
      const repository = new PostgresNotificationRepository(executor);
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });

  it('空列表返回 []（不是抛错、也不是空对象 / undefined）；单条未命中返回 undefined', async () => {
    const empty = repoWith({ rows: [], rowCount: 0 });
    await expect(empty.repository.listByUserId(OWNER_ID)).resolves.toEqual([]);

    const missing = repoWith({ rows: [], rowCount: 0 });
    await expect(missing.repository.findById(NOTIFICATION_ID, OWNER_ID)).resolves.toBeUndefined();
  });
});

describe('PostgreSQL 通知仓储：参数化 SQL 与固定标识符', () => {
  it('写入使用占位符绑定：SQL 只由常量与 $n 组成，参数按列顺序传入', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord(UNREAD_NOTIFICATION)],
      rowCount: 1,
    });

    await repository.create(UNREAD_NOTIFICATION);

    const call = callAt(executor, 0);
    expect(call).toBeDefined();
    expectParameterizedSql(call!.sql);
    expect(call!.sql).toContain(`INSERT INTO ${POSTGRES_NOTIFICATION_TABLE}`);
    expect(call!.sql).toContain(`RETURNING ${[...POSTGRES_NOTIFICATION_COLUMNS].join(', ')}`);
    for (const column of POSTGRES_NOTIFICATION_COLUMNS) {
      expect(call!.sql).toContain(column);
    }
    expect(call!.parameters).toHaveLength(POSTGRES_NOTIFICATION_COLUMNS.length);
    expect(placeholderIndexes(call!.sql)).toHaveLength(POSTGRES_NOTIFICATION_COLUMNS.length);

    expect(parameterAt(call, 'id')).toBe(UNREAD_NOTIFICATION.id);
    expect(parameterAt(call, 'user_id')).toBe(UNREAD_NOTIFICATION.userId);
    expect(parameterAt(call, 'type')).toBe(UNREAD_NOTIFICATION.type);
    expect(parameterAt(call, 'title')).toBe(UNREAD_NOTIFICATION.title);
    expect(parameterAt(call, 'body')).toBe(UNREAD_NOTIFICATION.body);
    expect(parameterAt(call, 'status')).toBe(UNREAD_NOTIFICATION.status);
    expect(parameterAt(call, 'created_at')).toBe(UNREAD_NOTIFICATION.createdAt);
    expect(parameterAt(call, 'updated_at')).toBe(UNREAD_NOTIFICATION.updatedAt);
    // 未读记录不得绑定已读时间，必须写 null（而不是 undefined 或省略列）
    expect(parameterAt(call, 'read_at')).toBeNull();
  });

  it('写入语句没有 DO UPDATE，也没有任何子查询（创建端口只创建）', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord(UNREAD_NOTIFICATION)],
      rowCount: 1,
    });
    await repository.create(UNREAD_NOTIFICATION);

    const sql = callAt(executor, 0)!.sql;
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(sql).not.toContain('DO UPDATE');
    expect(sql).not.toMatch(/\bSELECT\b/u);
  });

  it('已读记录写入时绑定服务端已读时间（读状态由服务端状态机推进）', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord(READ_NOTIFICATION)],
      rowCount: 1,
    });
    await repository.create(READ_NOTIFICATION);

    const call = callAt(executor, 0);
    expect(parameterAt(call, 'status')).toBe('read');
    expect(parameterAt(call, 'read_at')).toBe(READ_AT);
    expect(parameterAt(call, 'updated_at')).toBe(SAVED_AT);
  });

  it('按主体列表取数把归属下推进 SQL：只按主体一个占位符，列清单显式（无 SELECT *）', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
    await repository.listByUserId(OWNER_ID);

    const call = callAt(executor, 0)!;
    expectParameterizedSql(call.sql);
    expect(call.sql).toContain(`SELECT ${[...POSTGRES_NOTIFICATION_COLUMNS].join(', ')}`);
    expect(call.sql).toContain('WHERE user_id = $1::uuid');
    expect(call.sql).toContain('ORDER BY created_at ASC, id ASC');
    expect(call.parameters).toEqual([OWNER_ID]);
  });

  it('单条读取：主键与归属同时作为谓词，两个占位符按序绑定', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
    await repository.findById(NOTIFICATION_ID, OWNER_ID);

    const call = callAt(executor, 0)!;
    expectParameterizedSql(call.sql);
    expect(call.sql).toContain('WHERE id = $1::uuid AND user_id = $2::uuid');
    expect(call.parameters).toEqual([NOTIFICATION_ID, OWNER_ID]);
  });

  it('写回是条件写入：SET 只含可变列，WHERE 钉住 id + user_id + 状态前驱集合', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord(READ_NOTIFICATION)],
      rowCount: 1,
    });
    await repository.save(READ_NOTIFICATION);

    const call = callAt(executor, 0)!;
    expectParameterizedSql(call.sql);
    expect(call.sql).toContain(
      'SET status = $3, read_at = $4::timestamptz, updated_at = $5::timestamptz',
    );
    expect(call.sql).toContain(
      'WHERE id = $1::uuid AND user_id = $2::uuid AND status::text = ANY($6::text[])',
    );
    expect(call.parameters).toEqual([
      READ_NOTIFICATION.id,
      READ_NOTIFICATION.userId,
      'read',
      READ_AT,
      SAVED_AT,
      ['unread'],
    ]);
  });

  it('表名与列清单只由模块常量构成且都是裸标识符，占位符数量与参数数量一致', async () => {
    expect(/^[a-z][a-z0-9_]*$/u.test(POSTGRES_NOTIFICATION_TABLE)).toBe(true);
    for (const column of POSTGRES_NOTIFICATION_COLUMNS) {
      expect(/^[a-z][a-z0-9_]*$/u.test(column)).toBe(true);
    }

    const { repository, executor } = repoWith(
      { rows: [rowFromRecord(UNREAD_NOTIFICATION)], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [rowFromRecord(READ_NOTIFICATION)], rowCount: 1 },
    );
    await repository.create(UNREAD_NOTIFICATION);
    await repository.listByUserId(OWNER_ID);
    await repository.findById(NOTIFICATION_ID, OWNER_ID);
    await repository.save(READ_NOTIFICATION);

    for (const call of executor.calls) {
      expectParameterizedSql(call.sql);
      expect(placeholderIndexes(call.sql)).toHaveLength(call.parameters?.length ?? 0);
    }
  });

  it('标题里的注入载荷只进参数：SQL 文本与正常输入逐字节相同', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord({ ...UNREAD_NOTIFICATION, title: INJECTION })],
      rowCount: 1,
    });
    await repository.create({ ...UNREAD_NOTIFICATION, title: INJECTION });

    const call = callAt(executor, 0)!;
    expect(call.sql).not.toContain(INJECTION);
    expect(call.sql).not.toContain('DROP');
    expect(call.sql).not.toContain("'");
    expect(parameterAt(call, 'title')).toBe(INJECTION);
    expect(call.parameters).toContain(INJECTION);
  });

  it('主体不是合法 UUID / 非规范小写形 / 空 UUID 时在进入 SQL 之前就被拒绝，且不访问数据库', async () => {
    const subjects = [
      'u-student-1',
      HEX_OWNER_ID_UPPER,
      HEX_OWNER_ID_MIXED,
      NIL_UUID,
      '',
      42,
      null,
    ];
    for (const subject of subjects) {
      const list = repoWith();
      const listError = await captureRepoError(() =>
        list.repository.listByUserId(subject as string),
      );
      expect(listError.code).toBe('INVALID_SUBJECT');
      expect(list.executor.calls).toEqual([]);
      expectNoValueLeak(listError);

      const single = repoWith();
      const singleError = await captureRepoError(() =>
        single.repository.findById(NOTIFICATION_ID, subject as string),
      );
      expect(singleError.code).toBe('INVALID_SUBJECT');
      expect(single.executor.calls).toEqual([]);
    }
  });

  it('资源 ID 的注入载荷 / 非标识符取值不进 SQL：直接按「不存在」返回，且不访问数据库', async () => {
    for (const notificationId of [
      INJECTION,
      'not-a-uuid',
      HEX_NOTIFICATION_ID_UPPER,
      NIL_UUID,
      '',
    ]) {
      const { repository, executor } = repoWith();
      await expect(repository.findById(notificationId, OWNER_ID)).resolves.toBeUndefined();
      expect(executor.calls).toEqual([]);
    }
  });

  it('行契约的枚举列不接受大小写漂移 / 未登记 / 注入式取值，且错误信息不回显取值', async () => {
    for (const status of ['READ', 'Read', 'archived', INJECTION, '', 1]) {
      const { repository } = repoWith({
        rows: [rowFromRecord(READ_NOTIFICATION, { status })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, 'status');
      expectNoValueLeak(error);
    }
    for (const type of ['MEMBERSHIP_REVIEW', 'unknown', INJECTION, '', 1]) {
      const { repository } = repoWith({
        rows: [rowFromRecord(UNREAD_NOTIFICATION, { type })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, 'type');
      expectNoValueLeak(error);
    }
  });

  it('SQL 语句里没有任何字面量注入面：无引号 / 无分号 / 无注释符 / 无危险关键字', async () => {
    const { repository, executor } = repoWith(
      {
        rows: [rowFromRecord({ ...UNREAD_NOTIFICATION, title: INJECTION, body: INJECTION })],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'unread' }], rowCount: 1 },
    );
    await repository.create({ ...UNREAD_NOTIFICATION, title: INJECTION, body: INJECTION });
    await repository.listByUserId(OWNER_ID);
    await repository.findById(NOTIFICATION_ID, OWNER_ID);
    await repository.save(READ_NOTIFICATION).catch(() => undefined);

    expect(executor.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of executor.calls) {
      expectParameterizedSql(call.sql);
      expect(call.sql).not.toContain(INJECTION);
    }
  });
});

describe('PostgreSQL 通知仓储：严格行契约与未知列', () => {
  it('数据库返回未登记列（内部 payload / 路径 / URL / storage handle / PII / 软删除 / 审计 / 幂等键）→ 整行拒绝', async () => {
    const extras: readonly (readonly [string, unknown])[] = [
      ['payload', '{"template":"review_result"}'],
      ['deep_link_path', 'pages/notifications/detail'],
      ['action_url', 'https://example.invalid/n/1'],
      ['attachment_storage_handle', 's3://internal-bucket/obj'],
      ['recipient_openid', 'oUnderTestOpenId123'],
      ['deleted_at', new Date(UPDATED_AT)],
      ['idempotency_key', 'idem-12345678'],
      ['audit_event_id', NOTIFICATION_ID],
      ['notification_delivery_id', OTHER_NOTIFICATION_ID],
    ];
    for (const [column, value] of extras) {
      const { repository } = repoWith({
        rows: [rowFromRecord(UNREAD_NOTIFICATION, { [column]: value })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      expect(error.issues).toContain(`${column}(unexpected)`);
      // 只报字段名，绝不回显该列的值（可能含内部 payload / URL / storage handle / PII）
      expectNoValueLeak(error);
    }
  });

  it('缺列同样 fail-closed：列清单里的每一列缺失都必须被拒绝', async () => {
    for (const column of POSTGRES_NOTIFICATION_COLUMNS) {
      const { repository } = repoWith({
        rows: [withoutRowColumn(UNREAD_NOTIFICATION, column)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, column);
    }
  });

  it('列表与单条读取同样拒绝未登记列（不因为「只多几列」就放行）', async () => {
    const poisoned = rowFromRecord(UNREAD_NOTIFICATION, { payload: 'x' });

    const list = repoWith({ rows: [poisoned], rowCount: 1 });
    const listError = await captureRepoError(() => list.repository.listByUserId(OWNER_ID));
    expect(listError.code).toBe('INVALID_ROW');

    const single = repoWith({ rows: [poisoned], rowCount: 1 });
    const singleError = await captureRepoError(() =>
      single.repository.findById(NOTIFICATION_ID, OWNER_ID),
    );
    expect(singleError.code).toBe('INVALID_ROW');
  });

  it('写路径字段污染（snake_case 别名 / 归属别名 / 内部列 / 权限字段）→ INVALID_RECORD，且不写库', async () => {
    const polluted: readonly Record<string, unknown>[] = [
      { ...UNREAD_NOTIFICATION, user_id: OWNER_ID },
      { ...UNREAD_NOTIFICATION, read_at: READ_AT },
      { ...UNREAD_NOTIFICATION, payload: 'x' },
      { ...UNREAD_NOTIFICATION, action_url: 'https://example.invalid' },
      { ...UNREAD_NOTIFICATION, deep_link_path: 'pages/x' },
      { ...UNREAD_NOTIFICATION, attachment_storage_handle: 's3://b/o' },
      { ...UNREAD_NOTIFICATION, recipient_openid: 'oOpenId' },
      { ...UNREAD_NOTIFICATION, roles: ['admin'] },
      { ...UNREAD_NOTIFICATION, scope: 'GLOBAL' },
      { ...UNREAD_NOTIFICATION, permissions: ['user:delete'] },
      { ...UNREAD_NOTIFICATION, deleted_at: UPDATED_AT },
      { ...UNREAD_NOTIFICATION, idempotency_key: 'idem-12345678' },
    ];
    for (const record of polluted) {
      const { repository, executor } = repoWith();
      const error = await captureRepoError(() =>
        repository.create(record as unknown as Notification),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(error.issues.some((issue) => issue.endsWith('(unexpected)'))).toBe(true);
      expect(executor.calls).toEqual([]);
      expectNoValueLeak(error);
    }
  });

  it('写入记录缺失必填字段 / 类型不对 → INVALID_RECORD，且不写库', async () => {
    const cases: readonly unknown[] = [
      omitField(UNREAD_NOTIFICATION, 'title'),
      omitField(UNREAD_NOTIFICATION, 'body'),
      omitField(UNREAD_NOTIFICATION, 'status'),
      omitField(UNREAD_NOTIFICATION, 'userId'),
      { ...UNREAD_NOTIFICATION, title: 123 },
      { ...UNREAD_NOTIFICATION, body: null },
      { ...UNREAD_NOTIFICATION, createdAt: 'not-a-timestamp' },
      null,
      'record',
      [],
    ];
    for (const record of cases) {
      const { repository, executor } = repoWith();
      const error = await captureRepoError(() =>
        repository.create(record as unknown as Notification),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(executor.calls).toEqual([]);
      expectNoValueLeak(error);
    }
  });

  it('read / readAt 跨字段不变式：read 必带 readAt、unread 不得携带 readAt（写路径与读路径都拦）', async () => {
    // 写路径
    const writers: readonly unknown[] = [
      omitField(READ_NOTIFICATION, 'readAt'),
      { ...UNREAD_NOTIFICATION, readAt: READ_AT },
    ];
    for (const record of writers) {
      const { repository, executor } = repoWith();
      const error = await captureRepoError(() =>
        repository.create(record as unknown as Notification),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(executor.calls).toEqual([]);
    }

    // 读路径：read 缺 read_at / unread 带 read_at
    const missingReadAt = repoWith({
      rows: [rowFromRecord(READ_NOTIFICATION, { read_at: null })],
      rowCount: 1,
    });
    const first = await captureRepoError(() => missingReadAt.repository.listByUserId(OWNER_ID));
    expect(first.code).toBe('INVALID_ROW');
    expect(first.issues).toContain('readAt(invalid)');

    const unexpectedReadAt = repoWith({
      rows: [rowFromRecord(UNREAD_NOTIFICATION, { read_at: new Date(READ_AT) })],
      rowCount: 1,
    });
    const second = await captureRepoError(() => unexpectedReadAt.repository.listByUserId(OWNER_ID));
    expect(second.code).toBe('INVALID_ROW');
    expect(second.issues).toContain('readAt(invalid)');
  });

  it('标题 / 正文里的高敏内容（身份证号、疑似密钥）由读取契约拒绝，且不回显', async () => {
    const cases: readonly Record<string, unknown>[] = [{ title: PII_TITLE }, { body: SECRET_BODY }];
    for (const override of cases) {
      const { repository } = repoWith({
        rows: [rowFromRecord(UNREAD_NOTIFICATION, override)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      expect(
        error.issues.includes('title(invalid)') || error.issues.includes('body(invalid)'),
      ).toBe(true);
      expectNoValueLeak(error);
    }
  });

  it('控制字符由读取契约兜底拒绝（行契约只管形状与长度）', async () => {
    const { repository } = repoWith({
      rows: [rowFromRecord(UNREAD_NOTIFICATION, { body: 'bad\u0000body' })],
      rowCount: 1,
    });
    const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
    expect(error.code).toBe('INVALID_ROW');
    expect(error.issues).toContain('body(invalid)');
  });

  it('时间列的坏形状一律拒绝：坏时间戳 / 非 ISO / 缺列', async () => {
    for (const column of ['created_at', 'updated_at', 'read_at']) {
      const { repository } = repoWith({
        rows: [rowFromRecord(READ_NOTIFICATION, { [column]: 'not-a-timestamp' })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      expect(error.issues).toContain(column);
    }

    const wrongType = repoWith({
      rows: [rowFromRecord(UNREAD_NOTIFICATION, { created_at: 42 })],
      rowCount: 1,
    });
    const error = await captureRepoError(() => wrongType.repository.listByUserId(OWNER_ID));
    expect(error.code).toBe('INVALID_ROW');
  });
});

describe('PostgreSQL 通知仓储：read 状态机与幂等', () => {
  it('前驱集合是标记已读状态机的逆映射：read 的唯一前驱是 unread', () => {
    expect([...notificationStatusPredecessors(NotificationStatus.Read)]).toEqual(['unread']);
    expect([...notificationStatusPredecessors(NotificationStatus.Unread)]).toEqual([]);
    expect([...expectedPredecessors(NotificationStatus.Read)]).toEqual([
      ...notificationStatusPredecessors(NotificationStatus.Read),
    ]);
    expect([...expectedPredecessors(NotificationStatus.Unread)]).toEqual([]);
  });

  it('(from, to) 全矩阵：4 个组合里只有 unread → read 是可写回的前向边', () => {
    const allowed: readonly (readonly [NotificationStatus, NotificationStatus])[] = [
      [NotificationStatus.Unread, NotificationStatus.Read],
    ];
    for (const from of NOTIFICATION_STATUS_VALUES) {
      for (const to of NOTIFICATION_STATUS_VALUES) {
        const expected = allowed.some(([a, b]) => a === from && b === to);
        expect(canAdvanceNotificationStatus(from, to)).toBe(expected);
      }
    }
  });

  it('read 是终态：不存在 read → read 的自环（幂等重放不接受存储写入）', () => {
    expect(canAdvanceNotificationStatus(NotificationStatus.Read, NotificationStatus.Read)).toBe(
      false,
    );
    expect([...notificationStatusPredecessors(NotificationStatus.Read)]).not.toContain('read');
  });

  it('合法转移（unread → read）正常写回，且谓词集合恰好是 [unread]', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord(READ_NOTIFICATION)],
      rowCount: 1,
    });
    await expect(repository.save(READ_NOTIFICATION)).resolves.toEqual(READ_NOTIFICATION);

    const call = callAt(executor, 0)!;
    expect(call.parameters?.[5]).toEqual(['unread']);
    expect(executor.calls).toHaveLength(1);
  });

  it('save 无法把记录写回 unread：前驱为空集，谓词为空数组，永不命中', async () => {
    const { repository, executor } = repoWith(
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'read' }], rowCount: 1 },
    );
    const error = await captureRepoError(() => repository.save(UNREAD_NOTIFICATION));

    expect(error.code).toBe('TRANSITION_REJECTED');
    expect(callAt(executor, 0)?.parameters?.[5]).toEqual([]);
    expectNoValueLeak(error);
  });

  it('已读记录再写一次 → TRANSITION_REJECTED：不产生写入，readAt 不可能被重复请求改写', async () => {
    const { repository, executor } = repoWith(
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'read' }], rowCount: 1 },
    );
    const error = await captureRepoError(() => repository.save(READ_NOTIFICATION));

    expect(error.code).toBe('TRANSITION_REJECTED');
    expect(error.issues).toEqual(['status']);
    expectNoValueLeak(error);

    // 只有「条件写入 + 归属范围内诊断」两次调用：没有第二次写入、也没有任何覆盖写
    expect(executor.calls).toHaveLength(2);
    expect(executor.calls[0]?.sql).toContain('UPDATE');
    expect(executor.calls[0]?.parameters?.[3]).toBe(READ_AT);
    expect(executor.calls[1]?.sql).toContain('SELECT status');
    expect(executor.calls[1]?.parameters).toEqual([READ_NOTIFICATION.id, READ_NOTIFICATION.userId]);
    expect(executor.calls.filter((call) => call.sql.includes('UPDATE'))).toHaveLength(1);
  });

  it('幂等分工：service 的短路分支不写库，存储层拒绝重复写入（两道防线都要成立）', () => {
    const parsedRead = parseStoredNotification(READ_NOTIFICATION);
    expect(parsedRead.ok).toBe(true);
    if (!parsedRead.ok) return;

    const replay = markNotificationRead(parsedRead.value, SAVED_AT);
    expect(replay.changed).toBe(false);
    expect(replay.record).toEqual(READ_NOTIFICATION);
    // 存储层对同一目标状态的重复写入不再命中条件谓词（见上一条用例）
    expect(notificationStatusPredecessors(NotificationStatus.Read)).toEqual(['unread']);
  });

  it('记录不存在（或归属不符）→ NOT_FOUND（与内存基线「记录不存在时拒绝写入」同语义）', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });
    const error = await captureRepoError(() => repository.save(READ_NOTIFICATION));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.issues).toEqual(['id']);
    expectNoValueLeak(error);
    // 诊断查询同样被 id + user_id 双重限定：不跨归属探测
    expect(executor.calls[1]?.sql).toContain('WHERE id = $1::uuid AND user_id = $2::uuid');
  });

  it('诊断查询返回多行 / 未知状态 → 结果集违约 / 行契约违约', async () => {
    const multi = repoWith(
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'read' }, { status: 'read' }], rowCount: 2 },
    );
    const multiError = await captureRepoError(() => multi.repository.save(READ_NOTIFICATION));
    expect(multiError.code).toBe('RESULT_SET_VIOLATION');

    const unknown = repoWith(
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'archived' }], rowCount: 1 },
    );
    const unknownError = await captureRepoError(() => unknown.repository.save(READ_NOTIFICATION));
    expect(unknownError.code).toBe('INVALID_ROW');
    expect(unknownError.issues).toContain('status(invalid_enum_value)');
    expectNoValueLeak(unknownError);
  });

  it('写记录里的未知状态在进入 SQL 之前就被闭集拦下（INVALID_RECORD，不写库）', async () => {
    for (const status of ['archived', 'READ', 'pending', INJECTION, '']) {
      const { repository, executor } = repoWith();
      const error = await captureRepoError(() =>
        repository.save({ ...UNREAD_NOTIFICATION, status: status as NotificationStatus }),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expect(executor.calls).toEqual([]);
      expectNoValueLeak(error);
    }
  });

  it('闭集内的阅读状态全部可往返（不因取值不同被静默改写或过滤）', async () => {
    for (const record of [UNREAD_NOTIFICATION, READ_NOTIFICATION]) {
      const { repository, executor } = repoWith({
        rows: [rowFromRecord(record)],
        rowCount: 1,
      });
      await expect(repository.create(record)).resolves.toEqual(record);
      expect(parameterAt(callAt(executor, 0), 'status')).toBe(record.status);
    }
  });

  it('闭集内的通知类型全部可往返（本 adapter 不臆造额外收紧）', async () => {
    for (const type of NOTIFICATION_TYPE_VALUES) {
      const record: Notification = { ...UNREAD_NOTIFICATION, type };
      const { repository } = repoWith({ rows: [rowFromRecord(record)], rowCount: 1 });
      await expect(repository.create(record)).resolves.toEqual(record);
    }
  });
});

describe('PostgreSQL 通知仓储：归属隔离与不可变列', () => {
  it('列表 SQL 必须带归属谓词：去掉 WHERE user_id 就不再是「按主体取数」', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 });
    await repository.listByUserId(OWNER_ID);
    const sql = callAt(executor, 0)!.sql;
    expect(sql).toContain('WHERE user_id = $1::uuid');
    expect(sql).not.toContain('GROUP BY');
  });

  it('列表里混入他人记录 → OWNER_VIOLATION（整批 fail-closed，不静默过滤也不返回）', async () => {
    const { repository } = repoWith({
      rows: [
        rowFromRecord(UNREAD_NOTIFICATION),
        rowFromRecord({
          ...UNREAD_NOTIFICATION,
          id: OTHER_NOTIFICATION_ID,
          userId: OTHER_OWNER_ID,
        }),
      ],
      rowCount: 2,
    });
    const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
    expect(error.code).toBe('OWNER_VIOLATION');
    expect(error.issues).toEqual(['user_id']);
    expectNoValueLeak(error);
  });

  it('列表出现重复主键 → RESULT_SET_VIOLATION（同一记录不得在列表里出现两次）', async () => {
    const { repository } = repoWith({
      rows: [rowFromRecord(UNREAD_NOTIFICATION), rowFromRecord(UNREAD_NOTIFICATION)],
      rowCount: 2,
    });
    const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
    expect(error.code).toBe('RESULT_SET_VIOLATION');
    expect(error.issues).toEqual(['id']);
  });

  it('单条读取的返回行仍复核主键与归属（纵深防御：坏执行器返回他人记录也不放行）', async () => {
    const stranger = repoWith({
      rows: [rowFromRecord({ ...UNREAD_NOTIFICATION, userId: OTHER_OWNER_ID })],
      rowCount: 1,
    });
    const ownerError = await captureRepoError(() =>
      stranger.repository.findById(NOTIFICATION_ID, OWNER_ID),
    );
    expect(ownerError.code).toBe('OWNER_VIOLATION');

    const mismatched = repoWith({
      rows: [rowFromRecord({ ...UNREAD_NOTIFICATION, id: OTHER_NOTIFICATION_ID })],
      rowCount: 1,
    });
    const idError = await captureRepoError(() =>
      mismatched.repository.findById(NOTIFICATION_ID, OWNER_ID),
    );
    expect(idError.code).toBe('IDENTITY_MISMATCH');
    expect(idError.issues).toEqual(['id']);
  });

  it('写入返回他人归属 / 他人主键 → 分别 OWNER_VIOLATION / IDENTITY_MISMATCH', async () => {
    const stranger = repoWith({
      rows: [rowFromRecord({ ...UNREAD_NOTIFICATION, userId: OTHER_OWNER_ID })],
      rowCount: 1,
    });
    const ownerError = await captureRepoError(() =>
      stranger.repository.create(UNREAD_NOTIFICATION),
    );
    expect(ownerError.code).toBe('OWNER_VIOLATION');
    expect(ownerError.issues).toEqual(['user_id']);

    const mismatched = repoWith({
      rows: [rowFromRecord({ ...UNREAD_NOTIFICATION, id: OTHER_NOTIFICATION_ID })],
      rowCount: 1,
    });
    const idError = await captureRepoError(() => mismatched.repository.create(UNREAD_NOTIFICATION));
    expect(idError.code).toBe('IDENTITY_MISMATCH');
    expect(idError.issues).toEqual(['id']);
  });

  it('写入未返回行 → CONFLICT（与内存基线「ID 冲突」同语义）；返回多行 → RESULT_SET_VIOLATION', async () => {
    const conflict = repoWith({ rows: [], rowCount: 0 });
    const conflictError = await captureRepoError(() =>
      conflict.repository.create(UNREAD_NOTIFICATION),
    );
    expect(conflictError.code).toBe('CONFLICT');
    expect(conflictError.issues).toEqual(['id']);

    const multi = repoWith({
      rows: [rowFromRecord(UNREAD_NOTIFICATION), rowFromRecord(UNREAD_NOTIFICATION)],
      rowCount: 2,
    });
    const multiError = await captureRepoError(() => multi.repository.create(UNREAD_NOTIFICATION));
    expect(multiError.code).toBe('RESULT_SET_VIOLATION');
  });

  it('写回后不可变列 / 回显列被改写 → 逐列 fail-closed（覆盖全部不可变列与状态、时间）', async () => {
    const rewritten: readonly (readonly [string, Record<string, unknown>])[] = [
      ['id', { id: OTHER_NOTIFICATION_ID }],
      ['user_id', { user_id: OTHER_OWNER_ID }],
      ['type', { type: NotificationType.Announcement }],
      ['title', { title: '被改写' }],
      ['body', { body: '被改写' }],
      ['created_at', { created_at: new Date(UPDATED_AT) }],
      // 改成 unread 时必须同时清空 read_at，否则会先被跨字段不变式拦下（那是另一条用例）
      ['status', { status: 'unread', read_at: null }],
      ['read_at', { read_at: new Date(SAVED_AT) }],
      ['updated_at', { updated_at: new Date(READ_AT) }],
    ];
    for (const [column, override] of rewritten) {
      const { repository } = repoWith({
        rows: [rowFromRecord(READ_NOTIFICATION, override)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.save(READ_NOTIFICATION));
      expect(error.code).toBe(column === 'user_id' ? 'OWNER_VIOLATION' : 'IDENTITY_MISMATCH');
      expect(error.issues).toEqual([column]);
      expectNoValueLeak(error);
    }
  });

  it('归属缺失 / 空 UUID / 非 UUID / 非规范小写形的写记录 → INVALID_RECORD，且不写库', async () => {
    const cases: readonly Record<string, unknown>[] = [
      omitField(UNREAD_NOTIFICATION, 'userId'),
      { ...UNREAD_NOTIFICATION, userId: NIL_UUID },
      { ...UNREAD_NOTIFICATION, userId: 'u-student-1' },
      { ...UNREAD_NOTIFICATION, userId: HEX_OWNER_ID_UPPER },
      { ...UNREAD_NOTIFICATION, userId: HEX_OWNER_ID_MIXED },
    ];
    for (const record of cases) {
      const { repository, executor } = repoWith();
      const error = await captureRepoError(() =>
        repository.create(record as unknown as Notification),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expectIssueOnAny(error, ['user_id', 'userId']);
      expect(executor.calls).toEqual([]);
      expectNoValueLeak(error);
    }
  });

  it('主键不在存储 ID 域内 → INVALID_RECORD，且不写库', async () => {
    for (const id of [NIL_UUID, HEX_NOTIFICATION_ID_UPPER, 'not-a-uuid', INJECTION]) {
      const { repository, executor } = repoWith();
      const error = await captureRepoError(() => repository.create({ ...UNREAD_NOTIFICATION, id }));
      expect(error.code).toBe('INVALID_RECORD');
      expectIssueOn(error, 'id');
      expect(executor.calls).toEqual([]);
      expectNoValueLeak(error);
    }
  });

  it('规范小写 UUID 归属可以正常取数（大小写约束不是「拒绝一切」）', async () => {
    const { repository } = repoWith({
      rows: [rowFromRecord({ ...UNREAD_NOTIFICATION, userId: HEX_OWNER_ID })],
      rowCount: 1,
    });
    const records = await repository.listByUserId(HEX_OWNER_ID);
    expect(records).toHaveLength(1);
    expect(records[0]?.userId).toBe(HEX_OWNER_ID);
  });

  it('行里的归属不是规范存储标识符（大写 / 空 UUID）→ INVALID_ROW（存储不变量必须成立）', async () => {
    for (const userId of [HEX_OWNER_ID_UPPER, NIL_UUID, 'u-student-1']) {
      const { repository } = repoWith({
        rows: [rowFromRecord({ ...UNREAD_NOTIFICATION, userId })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByUserId(OWNER_ID));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, 'user_id');
    }
  });

  it('写回语句把 id 与 user_id 一起下推：拿他人 ID 也写不中他人数据', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });
    await captureRepoError(() =>
      repository.save({ ...READ_NOTIFICATION, id: OTHER_NOTIFICATION_ID }),
    );

    const call = callAt(executor, 0)!;
    expect(call.sql).toContain('WHERE id = $1::uuid AND user_id = $2::uuid');
    expect(call.parameters?.[0]).toBe(OTHER_NOTIFICATION_ID);
    expect(call.parameters?.[1]).toBe(OWNER_ID);
  });

  it('大批量（500 条）完整返回、不截断：顺序与数据库返回顺序逐一一致', async () => {
    const records = Array.from({ length: 500 }, (_value, index) => ({
      ...UNREAD_NOTIFICATION,
      id: uuidForIndex(index),
    }));
    const { repository } = repoWith({
      rows: records.map((record) => rowFromRecord(record)),
      rowCount: records.length,
    });
    const listed = await repository.listByUserId(OWNER_ID);
    expect(listed).toHaveLength(500);
    expect(listed.map((record) => record.id)).toEqual(records.map((record) => record.id));
  });

  it('读取路径全部不本地截断：SQL 里不出现 LIMIT / OFFSET / FETCH', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });
    await repository.listByUserId(OWNER_ID);
    await repository.findById(NOTIFICATION_ID, OWNER_ID);

    for (const call of executor.calls) {
      expect(call.sql).not.toMatch(/\b(?:LIMIT|OFFSET|FETCH)\b/u);
    }
  });
});

describe('PostgreSQL 通知仓储：公开视图与失败路径信息卫生', () => {
  it('存储记录承载归属（不静默丢弃），但公开视图恰好是白名单闭集且不含 userId', async () => {
    const { repository } = repoWith({
      rows: [rowFromRecord(READ_NOTIFICATION)],
      rowCount: 1,
    });
    const records = await repository.listByUserId(OWNER_ID);
    const record = records[0];
    expect(record).toBeDefined();
    if (record === undefined) return;

    // 内部存储记录必须承载归属：service 的归属复核与 404 统一口径都依赖它
    expect(record.userId).toBe(OWNER_ID);

    const parsed = parseNotificationView(toNotificationView(record));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(Object.keys(parsed.value).sort()).toEqual([...NOTIFICATION_VIEW_FIELDS].sort());
    expect(Object.keys(parsed.value)).not.toContain('userId');
    expect(JSON.stringify(parsed.value)).not.toContain(OWNER_ID);
  });

  it('公开视图不含内部 payload / 路径 / URL / storage handle / PII 收件标识', async () => {
    const { repository } = repoWith({
      rows: [rowFromRecord(READ_NOTIFICATION)],
      rowCount: 1,
    });
    const records = await repository.listByUserId(OWNER_ID);
    const record = records[0];
    expect(record).toBeDefined();
    if (record === undefined) return;
    const view = toNotificationView(record);

    for (const internal of POSTGRES_NOTIFICATION_INTERNAL_COLUMNS) {
      expect(Object.keys(view)).not.toContain(internal);
    }
    expect(Object.keys(view)).not.toContain('recipient_openid');
    expect(JSON.stringify(view)).not.toContain('recipient_openid');
    expect(JSON.stringify(view)).not.toContain('payload');
    expect(JSON.stringify(view)).not.toContain('storage');

    // 已读时间必须随视图返回（本人自读范围内的合法字段）
    expect(view.readAt).toBe(READ_AT);
  });

  it('裁剪清单与公开视图白名单无交集：模块加载期自检对真实白名单放行、对泄漏白名单 fail-closed', () => {
    expect(findNotificationViewExclusionLeaks(NOTIFICATION_VIEW_FIELDS)).toEqual([]);
    expect(() => assertNotificationViewExclusion(NOTIFICATION_VIEW_FIELDS)).not.toThrow();

    // 归属字段一旦进入白名单就必须被判泄漏（`user_id` 映射到 `userId`）
    expect(findNotificationViewExclusionLeaks([...NOTIFICATION_VIEW_FIELDS, 'userId'])).toEqual([
      'userId',
    ]);
    for (const internal of POSTGRES_NOTIFICATION_INTERNAL_COLUMNS) {
      expect(findNotificationViewExclusionLeaks([...NOTIFICATION_VIEW_FIELDS, internal])).toEqual([
        internal,
      ]);
    }

    const error = captureSyncError(() =>
      assertNotificationViewExclusion([...NOTIFICATION_VIEW_FIELDS, 'userId', 'payload']),
    );
    expect(error.code).toBe('CAPABILITY_MISDECLARED');
    expect([...error.issues].sort()).toEqual(['payload', 'userId']);
    expectNoValueLeak(error);
  });

  it('存储侧内部列绝不进入任何被执行的 SQL（既不 SELECT 也不 RETURNING）', async () => {
    const { repository, executor } = repoWith(
      { rows: [rowFromRecord(UNREAD_NOTIFICATION)], rowCount: 1 },
      { rows: [rowFromRecord(READ_NOTIFICATION)], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [rowFromRecord(READ_NOTIFICATION)], rowCount: 1 },
    );
    await repository.create(UNREAD_NOTIFICATION);
    await repository.listByUserId(OWNER_ID);
    await repository.findById(NOTIFICATION_ID, OWNER_ID);
    await repository.save(READ_NOTIFICATION);

    for (const call of executor.calls) {
      for (const internal of POSTGRES_NOTIFICATION_INTERNAL_COLUMNS) {
        expect(call.sql).not.toContain(internal);
      }
    }
  });

  it('成功路径的返回记录里不出现任何 snake_case 列名（列名只存在于 SQL 与行契约）', async () => {
    const { repository } = repoWith({
      rows: [rowFromRecord(READ_NOTIFICATION)],
      rowCount: 1,
    });
    const [record] = await repository.listByUserId(OWNER_ID);

    expect(Object.keys(record ?? {}).sort()).toEqual(
      Object.keys(POSTGRES_NOTIFICATION_FIELD_COLUMNS).sort(),
    );
    for (const key of Object.keys(record ?? {})) {
      expect(key).not.toMatch(/_/u);
    }
  });

  it('任何失败路径的错误信息与 issues 都不含归属标识、标题/正文原文、内部载荷与注入载荷', async () => {
    const failures: readonly (() => Promise<unknown>)[] = [
      () => repoWith().repository.listByUserId('u-student-1'),
      () => repoWith({ rows: [] }).repository.listByUserId(HEX_OWNER_ID_UPPER),
      () =>
        repoWith({
          rows: [rowFromRecord(UNREAD_NOTIFICATION, { payload: INJECTION })],
        }).repository.listByUserId(OWNER_ID),
      () =>
        repoWith({
          rows: [rowFromRecord(UNREAD_NOTIFICATION, { user_id: OTHER_OWNER_ID })],
        }).repository.listByUserId(OWNER_ID),
      () =>
        repoWith({
          rows: [rowFromRecord(UNREAD_NOTIFICATION, { title: INJECTION })],
        }).repository.create(UNREAD_NOTIFICATION),
      () =>
        repoWith({
          rows: [rowFromRecord(UNREAD_NOTIFICATION, { body: SECRET_BODY })],
        }).repository.create(UNREAD_NOTIFICATION),
      () => repoWith({ rows: [] }).repository.create({ ...UNREAD_NOTIFICATION, title: INJECTION }),
      () =>
        repoWith({ rows: [] }, { rows: [{ status: 'read' }] }).repository.save(READ_NOTIFICATION),
      () => repoWith({ rows: [] }, { rows: [] }).repository.save(READ_NOTIFICATION),
      () =>
        repoWith({
          rows: [rowFromRecord(READ_NOTIFICATION, { title: INJECTION })],
        }).repository.save(READ_NOTIFICATION),
    ];

    for (const run of failures) {
      const error = await captureRepoError(run);
      expectNoValueLeak(error);
    }
  });
});

describe('PostgreSQL 通知仓储：未装配、无驱动依赖、与 schema 边界对齐', () => {
  it('NotificationsModule 仍只绑定内存基线（本 adapter 未被装配）', () => {
    const content = readFileSync(MODULE_PATH, 'utf8');

    expect(content).not.toContain(ADAPTER_CLASS);
    expect(content).not.toContain(ADAPTER_MODULE);
    expect(content).toContain('InMemoryNotificationRepository');
    expect(content).toContain(
      '{ provide: NOTIFICATION_REPOSITORY, useExisting: InMemoryNotificationRepository }',
    );
  });

  it('持久化登记与数据库模块都不引用本 adapter（端口登记表仍按令牌判定）', () => {
    for (const relative of [
      join('src', 'db', 'persistence-bindings.ts'),
      join('src', 'db', 'database.module.ts'),
      join('src', 'db', 'ports', 'sql-executor.port.ts'),
      join('src', 'modules', 'notifications', 'notifications.port.ts'),
      join('src', 'app.module.ts'),
      join('src', 'startup-assembly.spec.ts'),
    ]) {
      const content = readApiFile(relative);
      // 端口文件只在注释里以「示例路径」提到 adapter 模块文件名，这不构成装配；任何 import /
      // provider 引用（类名或模块路径）都必须为零
      expect(content).not.toContain(ADAPTER_CLASS);
      expect(content).not.toMatch(
        /(?:from\s+['"][^'"]*notifications\.postgres-repository['"]|require\(\s*['"][^'"]*notifications\.postgres-repository['"]\s*\))/u,
      );
    }
  });

  it('内存基线仍是同步契约的实现者（本切片不改动它）', () => {
    const source = readApiFile(
      join('src', 'modules', 'notifications', 'notifications.in-memory-repository.ts'),
    );
    expect(source).toContain('implements NotificationRepository');
    expect(source).not.toContain(ADAPTER_CLASS);
    expect(source).toContain('persistent: false');
    expect(source).toContain('productionReady: false');
  });

  it('同步端口契约未被改成异步（本切片只新增并存的异步契约与后端标识）', () => {
    const source = readFileSync(PORT_PATH, 'utf8');
    expect(source).toContain('export interface NotificationRepository {');
    expect(source).toContain('findById(notificationId: string): Notification | undefined;');
    expect(source).toContain('save(notification: Notification): Notification;');
    expect(source).toContain('export interface AsyncNotificationRepository {');
    expect(source).toContain('findById(notificationId: string, ownerUserId: string)');
    expect(source).toContain('export const NOTIFICATION_REPOSITORY_BACKEND_POSTGRES');
    expect(source).toContain('export const NOTIFICATION_REPOSITORY_STORAGE_ID_DOMAIN');
    // 同步端口名与 DI 令牌一字未改
    expect(source).toContain(
      "export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');",
    );
  });

  it('adapter 的公开面覆盖能力、验证清单、列清单与状态机逆映射（供上层与运维机器判定）', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    for (const exported of [
      'POSTGRES_NOTIFICATION_TABLE',
      'POSTGRES_NOTIFICATION_COLUMNS',
      'POSTGRES_NOTIFICATION_COLUMN_FIELDS',
      'POSTGRES_NOTIFICATION_FIELD_COLUMNS',
      'POSTGRES_NOTIFICATION_OWNER_COLUMNS',
      'POSTGRES_NOTIFICATION_INTERNAL_COLUMNS',
      'POSTGRES_NOTIFICATION_PII_COLUMNS',
      'POSTGRES_NOTIFICATION_VIEW_EXCLUDED_COLUMNS',
      'POSTGRES_NOTIFICATION_MUTABLE_COLUMNS',
      'POSTGRES_NOTIFICATION_IMMUTABLE_COLUMNS',
      'POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES',
      'POSTGRES_NOTIFICATION_REPOSITORY_VERIFICATION_STEPS',
    ]) {
      expect(source).toContain(`export const ${exported}`);
    }
    expect(source).toContain('export class PostgresNotificationRepository');
    expect(source).toContain('export class PostgresNotificationRepositoryError');
    expect(source).toContain('export function assertPostgresNotificationRepositoryCapabilities');
    expect(source).toContain('export function notificationStatusPredecessors');
    expect(source).toContain('export function findNotificationViewExclusionLeaks');
    expect(source).toContain('export function assertNotificationViewExclusion');
    expect(source).toContain('export type PostgresNotificationRepositoryErrorCode');
    // 能力声明与自检都必须以「未验证不得生产」的措辞自证
    expect(source).toContain('productionReady: false');
    expect(source).toContain('不得声称生产可用');
  });

  it('adapter 不 import 任何 Nest 装饰器 / 模块装饰器（不是 provider，也不自建模块）', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).not.toContain('@nestjs');
    expect(source).not.toContain('Injectable');
    expect(source).not.toContain('APP_ENV');
  });
});
