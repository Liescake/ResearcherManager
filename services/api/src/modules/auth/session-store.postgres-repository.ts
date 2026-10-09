import { z } from 'zod';
import type { AuthorizationSubject } from '@rm/shared';
import type { PersistenceCapabilities, SqlExecutor } from '../../db/ports/sql-executor.port';
import {
  generateSessionTicket,
  isSessionDigest,
  isSessionExpiryWithinBounds,
  isSessionSafeId,
  isSessionTicket,
  sessionTicketDigest,
} from './session-ticket';
import type {
  CreateSessionInput,
  IssuedSession,
  SessionBackendCapabilities,
  SessionRecord,
  SessionStore,
} from './session-subject.port';

/**
 * 会话存储的 **PostgreSQL adapter**（最小实现：创建 / 读取 / 撤销 / 过期清理）。
 *
 * ## 交付边界
 * - **已接入运行时**：`auth.module.ts` 的 `createSessionStore()` 在「解析出 `DATABASE_URL`」时
 *   把 `SESSION_STORE` 换绑到本文件的 `createLazyPostgresSessionStore`；未配置数据库时仍走
 *   `InMemorySessionStore`（开发/测试行为不变）；
 * - **延迟建连**：装配阶段不碰数据库。未 attest 的执行器由启动期持久化边界与依赖就绪门禁
 *   **结构化拒绝**（而不是在这里静默降级成内存实现）；配置了数据库却没拿到执行器工厂时直接抛错；
 * - **不引入** `pg` / Prisma / TypeORM 等驱动或 ORM 依赖：本文件只依赖驱动无关的 `SqlExecutor`
 *   端口（`db/ports/sql-executor.port.ts`），真实执行器由 `SQL_CONNECTION_FACTORY` 提供；
 * - **不是 Nest provider**：没有任何 Nest 装饰器（`@Injectable`、`@Inject`、`@Module` 一律没有）、
 *   不参与依赖注入、不注册路由；换绑只发生在 `auth.module.ts` 的工厂里；
 * - **不声称生产可用**：能力声明固定为 `backend = postgres`、`persistent = true`、
 *   `productionReady = false`（原因见下方「已登记的前置」）。
 *
 * ## 表结构（`db/migrations/0006_sessions.sql`）
 * 字段只有六个：`session_id`、`user_id`、`roles`、`scope`、`expires_at`、`revoked_at`。
 *
 * ## 敏感票据：只落不可逆摘要
 * - `session_id` 是客户端 Bearer 票据的 **sha256 摘要**（64 位小写十六进制）。原始票据在
 *   `createSession` 的返回值里出现**一次**（交给调用方转交），此后本 adapter 再也拿不到它：
 *   读取与撤销都把入参摘要化之后再进 SQL；
 * - 派生摘要的唯一实现是 `session-ticket.ts` 的 `sessionTicketDigest`，写路径与读路径共用，
 *   不存在「一处哈希、一处明文」的漂移面；
 * - **两种形态刻意不重叠**：票据是 43 字符 base64url，摘要是 64 字符十六进制。因此即使写入方
 *   忘了哈希、把原始票据直接绑进 SQL，数据库的形状约束（`^[0-9a-f]{64}$`）也会以约束冲突拒绝
 *   —— 「原始票据落不了库」由形状保证，而不是靠调用纪律；
 * - 形状不合法的入参在**下发任何 SQL 之前**就被拒绝（见 `isSessionTicket` 的前置判定），
 *   因此任意客户端字符串不会被带进查询路径；
 * - 错误信息与日志只承载违规类型与**列名**，绝不包含票据、摘要、主体取值或 SQL 文本。
 *
 * ## 四条语句（模块常量，加载期自检）
 * | 操作 | 语句 | 参数位 |
 * |---|---|---|
 * | 创建 | `INSERT INTO sessions (...) VALUES ($1, $2, $3::text[], $4::jsonb, $5::timestamptz)` | `$1`–`$5`，逐位一次 |
 * | 读取 | `SELECT session_id, user_id, roles, scope FROM sessions WHERE session_id = $1 AND revoked_at IS NULL AND expires_at > now()` | `$1` |
 * | 撤销 | `UPDATE sessions SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL` | `$1` |
 * | 过期清理 | `DELETE FROM sessions WHERE expires_at <= now()` | 无 |
 *
 * 过期判定一律用**数据库时钟**（`now()`），不用应用进程时间：否则多实例之间的时钟偏移会让
 * 「已过期」在不同实例上给出不同答案。`purgeExpired` 同理不接受调用方传入的时刻。
 *
 * ## 安全边界（本文件的硬约束）
 * 1. **固定显式列**：读取语句显式列出四列，**不使用 `SELECT *`**，语句文本里连 `*` 字符都不存在
 *    （加载期断言），因此「存储层新增列自动流出」在结构上不可能；`revoked_at` / `expires_at`
 *    只参与 `WHERE`，不进入结果；
 * 2. **逐位 `$n` 参数化**：值只走占位符绑定，语句文本里没有引号、分号与注释（加载期断言），
 *    不存在「值 → SQL 文本」的注入面；
 * 3. **严格行契约**（`.strict()`）：列缺失、未知列、非摘要形状的 `session_id`、非法 `user_id`、
 *    空或超量或形状非法的 `roles`、非对象的 `scope`、`scope` 里的未知键一律 fail-closed ——
 *    数据库是外部可变状态，行内容可能被任意来源写坏；
 * 4. **归属复核**：返回行的 `session_id` 必须与请求摘要逐字节一致，否则 `STORAGE_VIOLATION`：
 *    执行器 / 连接被改写而返回别的会话时绝不被静默接受；
 * 5. **结果集 fail-closed**：读取侧 0 行 = 「票据无效」（合法的 `undefined`），>1 行属于主键约束
 *    被破坏，判 `STORAGE_VIOLATION`；写入侧 `rowCount !== 1` 同样判 `STORAGE_VIOLATION`
 *    （创建没落库、撤销没生效都不能被当成成功）；
 * 6. **执行器异常的信息卫生**：驱动 / 连接池抛出的异常一律收敛为不含原始文本的 `EXECUTOR_FAILURE`
 *    ——不携带原始消息、`cause`、SQL 与参数；本 adapter 的错误会冒泡到 API 的 500 路径；
 * 7. **存储不可用必须抛出**：`findSession` 只有「票据无效」才返回 `undefined`；连接失败 / SQL 失败
 *    一律抛错（由上层脱敏成 500），绝不退化成 401 —— 否则一次数据库故障会被伪装成「所有人都未登录」。
 *
 * ## 已登记的前置（因此 `productionReady` 恒为 false）
 * 表由迁移 `0006_sessions.sql` 建出，真实 PostgreSQL 集成验证已在
 * `db/postgres/__tests__/postgres-integration.spec.ts` 就位（建表迁移 + 四个生命周期操作 + 摘要落库）；
 * 但**生产可用**仍需：驱动依赖的评估证据（`docs/P2-开源复用评估.md`）、在 `TEST_DATABASE_URL`
 * 指向的测试库上真实跑过该集成套件、以及签发封存声明与登记验证证据。这些已登记在
 * `POSTGRES_SESSION_STORE_VERIFICATION_STEPS` 里，不能只写声明。
 */

/** 后端标识：与其它 postgres adapter 一致，只出现在能力声明与错误文案里 */
export const POSTGRES_SESSION_STORE_BACKEND = 'postgres';

/** 会话表名（与迁移 `0006_sessions.sql` 一致） */
export const POSTGRES_SESSIONS_TABLE = 'sessions';

/** 读取结果列（顺序即 `SELECT` 列表顺序）：过期与撤销只参与 `WHERE`，不进入结果 */
export const POSTGRES_SESSIONS_SELECTED_COLUMNS: readonly string[] = Object.freeze([
  'session_id',
  'user_id',
  'roles',
  'scope',
]);

/** 能力声明：持久但**未验证**，因此生产环境仍会被持久化边界守卫拦下 */
export const POSTGRES_SESSION_STORE_CAPABILITIES: PersistenceCapabilities = Object.freeze({
  backend: POSTGRES_SESSION_STORE_BACKEND,
  persistent: true,
  productionReady: false,
});

/**
 * 转成生产可用前必须完成的验证清单（每一项都需要证据，不能只写声明）：
 * 1. 驱动依赖经评估后引入（`docs/P2-开源复用评估.md` 的 Prisma / TypeORM 比较结论）；
 * 2. 在真实 PostgreSQL 上跑通 `db/postgres/__tests__/postgres-integration.spec.ts` 的会话用例：
 *    建表迁移、创建 / 读取 / 撤销 / 过期清理四个操作、**原始票据不出现在表里**；
 * 3. 会话主体 `userId` 收敛为 UUID（当前基线是 `u-student-1` 这类安全 ID，与其它表的 `uuid` 列不同域）；
 * 4. 签发封存声明（`DependencyReadinessRegistry.attest`）并登记 `integration-test` 验证证据；
 * 5. 完成 1–4 后，才允许把 `productionReady` 改为 true，并同步删除能力自检
 *    （`assertPostgresSessionStoreCapabilities` 会拒绝「未验证就声称生产可用」）。
 */
export const POSTGRES_SESSION_STORE_VERIFICATION_STEPS = [
  'driver-dependency-evaluated',
  'integration-tests-against-real-postgres',
  'raw-ticket-never-persisted-verified',
  'session-subject-converged-to-uuid',
  'sealed-declaration-and-evidence-registered',
  'production-ready-capability-flipped-with-evidence',
] as const;

/** 主体 ID 形状（与 `session-ticket.ts` 的 `SESSION_SAFE_ID_PATTERN` 同口径，行契约共用） */
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,64}$/u;

/** 角色元素形状：小写标识符（与迁移 `0006_sessions.sql` 的存储层约束镜像） */
const ROLE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;

/** 角色数量上界：与迁移里的 `cardinality(roles) BETWEEN 1 AND 16` 同口径 */
export const POSTGRES_SESSION_STORE_MAX_ROLES = 16;

/**
 * 四条语句的**唯一事实来源**。
 *
 * 写成显式常量（而不是在方法里就地拼字符串）才能被加载期自检与单测逐条钉住：参数位、列清单、
 * 「`revoked_at` / `expires_at` 只出现在 `WHERE`」都是可机器判定的性质。
 */
export const POSTGRES_SESSION_INSERT_SQL =
  `INSERT INTO ${POSTGRES_SESSIONS_TABLE} (session_id, user_id, roles, scope, expires_at) ` +
  'VALUES ($1, $2, $3::text[], $4::jsonb, $5::timestamptz)';

export const POSTGRES_SESSION_SELECT_SQL =
  `SELECT ${POSTGRES_SESSIONS_SELECTED_COLUMNS.join(', ')} FROM ${POSTGRES_SESSIONS_TABLE} ` +
  'WHERE session_id = $1 AND revoked_at IS NULL AND expires_at > now()';

export const POSTGRES_SESSION_REVOKE_SQL = `UPDATE ${POSTGRES_SESSIONS_TABLE} SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`;

export const POSTGRES_SESSION_PURGE_SQL = `DELETE FROM ${POSTGRES_SESSIONS_TABLE} WHERE expires_at <= now()`;

export type PostgresSessionStoreErrorCode =
  | 'CAPABILITY_MISDECLARED'
  | 'SQL_VIOLATION'
  | 'EXECUTOR_UNAVAILABLE'
  | 'EXECUTOR_NOT_POSTGRES'
  | 'EXECUTOR_NOT_PERSISTENT'
  | 'EXECUTOR_FAILURE'
  | 'INVALID_SUBJECT'
  | 'INVALID_EXPIRY'
  | 'INVALID_ROW'
  | 'STORAGE_VIOLATION';

/**
 * adapter 的 fail-closed 错误。
 *
 * `issues` 只承载**字段路径与违规类型**（例如 `roles(invalid_type)`、`session_id`），
 * 不承载字段取值、票据与摘要，避免把可用凭证或主体标识写进日志与错误响应。
 * `EXECUTOR_FAILURE` 更进一步：连原始错误的文本与 `cause` 都不携带。
 */
export class PostgresSessionStoreError extends Error {
  readonly code: PostgresSessionStoreErrorCode;
  readonly issues: readonly string[];

  constructor(
    code: PostgresSessionStoreErrorCode,
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PostgresSessionStoreError';
    this.code = code;
    this.issues = [...issues];
  }
}

/** 语句里出现的占位符序号（去重升序），用于加载期断言参数位布局 */
export function sessionPlaceholderIndexes(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1])))].sort(
    (left, right) => left - right,
  );
}

/**
 * 语句卫生（加载期执行）：四条语句都是本文件允许的形态 ——
 * 无分号、无注释、无字符串字面量、无通配符 `*`。
 *
 * 无引号文字面量意味着**所有值都必须是参数**；无 `*` 意味着不存在通配投影
 * （读取语句显式列出列，写入语句显式列出列与值）。
 */
export function assertPostgresSessionSqlHygiene(sql: string, label: string): void {
  const issues: string[] = [];
  if (sql.includes(';')) {
    issues.push('semicolon');
  }
  if (sql.includes('--') || sql.includes('/*')) {
    issues.push('comment');
  }
  if (sql.includes("'") || sql.includes('"')) {
    issues.push('literal');
  }
  if (sql.includes('*')) {
    issues.push('wildcard');
  }
  if (issues.length > 0) {
    throw new PostgresSessionStoreError(
      'SQL_VIOLATION',
      '会话语句不是本切片允许的形态（分号 / 注释 / 字面量 / 通配符一律禁止：值必须全部走参数绑定）',
      issues.map((issue) => `${label}.${issue}`),
    );
  }
}

/**
 * 语句形状自检（模块加载期执行）：参数位逐位连续且不重复；读取语句的列清单与
 * `POSTGRES_SESSIONS_SELECTED_COLUMNS` 一致；`revoked_at` / `expires_at` 不得出现在读取结果列里。
 * 这样「改了列清单没改语句」「把 `expires_at` 加进结果」「参数位复用」都会在导入期立刻失败。
 */
export function assertPostgresSessionSqlShape(): void {
  const expectations: readonly {
    readonly label: string;
    readonly sql: string;
    readonly slots: number;
  }[] = [
    { label: 'insert', sql: POSTGRES_SESSION_INSERT_SQL, slots: 5 },
    { label: 'select', sql: POSTGRES_SESSION_SELECT_SQL, slots: 1 },
    { label: 'revoke', sql: POSTGRES_SESSION_REVOKE_SQL, slots: 1 },
    { label: 'purge', sql: POSTGRES_SESSION_PURGE_SQL, slots: 0 },
  ];

  const issues: string[] = [];
  for (const { label, sql, slots } of expectations) {
    try {
      assertPostgresSessionSqlHygiene(sql, label);
    } catch {
      issues.push(`${label}.hygiene`);
    }
    const placeholders = sessionPlaceholderIndexes(sql);
    const occurrences = [...sql.matchAll(/\$(\d+)/gu)].length;
    const expected = Array.from({ length: slots }, (_, index) => index + 1);
    if (placeholders.join(',') !== expected.join(',') || occurrences !== slots) {
      issues.push(`${label}.parameters`);
    }
  }

  const projection = POSTGRES_SESSIONS_SELECTED_COLUMNS.join(', ');
  if (!POSTGRES_SESSION_SELECT_SQL.startsWith(`SELECT ${projection} FROM `)) {
    issues.push('select.projection');
  }
  for (const column of POSTGRES_SESSIONS_SELECTED_COLUMNS) {
    if (!POSTGRES_SESSION_SELECT_SQL.includes(column)) {
      issues.push(`select.column.${column}`);
    }
  }
  // 过期与撤销只允许出现在 WHERE：结果列里出现它们就意味着「把过期/撤销状态外发」
  for (const column of ['expires_at', 'revoked_at']) {
    const projectionPart = POSTGRES_SESSION_SELECT_SQL.slice(
      0,
      POSTGRES_SESSION_SELECT_SQL.indexOf(' FROM '),
    );
    if (projectionPart.includes(column)) {
      issues.push(`select.result.${column}`);
    }
    if (!POSTGRES_SESSION_SELECT_SQL.includes(column)) {
      issues.push(`select.predicate.${column}`);
    }
  }

  if (issues.length > 0) {
    throw new PostgresSessionStoreError(
      'SQL_VIOLATION',
      '会话语句形状与列清单 / 参数位布局不一致（显式列投影 + 逐位连续的 $n 参数位）',
      issues,
    );
  }
}

/** 能力自检：**未验证的实现不得声称生产可用**（任何环境都执行） */
export function assertPostgresSessionStoreCapabilities(
  capabilities: PersistenceCapabilities = POSTGRES_SESSION_STORE_CAPABILITIES,
): void {
  const issues: string[] = [];
  if (capabilities.backend !== POSTGRES_SESSION_STORE_BACKEND) {
    issues.push('backend');
  }
  if (capabilities.persistent !== true) {
    issues.push('persistent');
  }
  if (capabilities.productionReady !== false) {
    issues.push('productionReady');
  }
  if (issues.length > 0) {
    throw new PostgresSessionStoreError(
      'CAPABILITY_MISDECLARED',
      `PostgreSQL 会话存储能力声明不符（backend 必须是 ${POSTGRES_SESSION_STORE_BACKEND}、persistent=true、productionReady=false）：未完成驱动集成验证前不得声称生产可用`,
      issues,
    );
  }
}

/**
 * 行契约（**严格**）。`.strict()` 是「字段污染」防线：数据库返回的未登记列会让解析失败，
 * 而不是被静默丢弃或带进主体。列缺失同样失败（PG 对 `SELECT` 列表中存在的列一定返回键）。
 *
 * 角色元素只做**形状**约束，不做角色闭集判定：闭集由 `packages/shared` 的 `ROLE_VALUES` 拥有，
 * 由认证边界（`normalizeSubject`）在解析时判定。在存储层复制一份枚举会让新增角色必须改迁移，
 * 也会让陈旧的库约束静默拒绝合法会话（那会表现为「某些用户突然登录不上」）。
 */
const sessionScopeSchema = z
  .object({
    groupIds: z.array(z.string().regex(SAFE_ID_PATTERN)).optional(),
    assignedResourceIds: z.array(z.string().regex(SAFE_ID_PATTERN)).optional(),
  })
  .strict();

const postgresSessionRowSchema = z
  .object({
    // 摘要形状复用 `session-ticket.ts` 的判定：与「票据形状」是同一处权威定义的两面
    session_id: z.string().refine(isSessionDigest, '必须是 sha256 摘要形态（64 位小写十六进制）'),
    user_id: z.string().regex(SAFE_ID_PATTERN),
    roles: z.array(z.string().regex(ROLE_PATTERN)).min(1).max(POSTGRES_SESSION_STORE_MAX_ROLES),
    scope: sessionScopeSchema,
  })
  .strict();

type PostgresSessionRow = z.infer<typeof postgresSessionRowSchema>;

/** 行契约的键必须与显式列清单逐字逐序一致（防止「列清单改了、schema 没改」） */
export function assertPostgresSessionRowAligned(): void {
  const keys = Object.keys(postgresSessionRowSchema.shape);
  const expected = [...POSTGRES_SESSIONS_SELECTED_COLUMNS];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new PostgresSessionStoreError(
      'SQL_VIOLATION',
      '行契约的列与显式列清单不一致：新增 / 改名结果列必须同时登记在列清单与行契约里',
      ['row'],
    );
  }
}

/** 只保留字段路径与违规类型，绝不含字段取值（票据、摘要与主体取值都不进错误消息） */
function describeIssues(error: z.ZodError, prefix = ''): readonly string[] {
  return error.issues.flatMap((issue) => {
    const path = [prefix, issue.path.join('.')].filter((part) => part !== '').join('.');
    if (issue.code === 'unrecognized_keys') {
      // 只列出**字段名**（不是字段取值）：让「未知列 / 契约漂移」可定位，同时不泄露数据
      return issue.keys.map((key) => `${path ? `${path}.` : ''}${key}(unexpected)`);
    }
    return [`${path || '(root)'}(${issue.code})`];
  });
}

function invalidRow(error: z.ZodError): PostgresSessionStoreError {
  return new PostgresSessionStoreError(
    'INVALID_ROW',
    '数据库行不符合会话严格行契约（摘要形状 + 主体 ID + 角色元素形状 + 范围对象，未知列与缺列一律拒绝）',
    describeIssues(error),
  );
}

/**
 * 执行器 fail-closed 校验：没有执行器、执行器不像 PostgreSQL、或声明为**非持久**（内存替身）
 * 时一律拒绝，而不是「先跑起来再说」。
 */
function assertUsableExecutor(executor: unknown): SqlExecutor {
  if (typeof executor !== 'object' || executor === null) {
    throw new PostgresSessionStoreError(
      'EXECUTOR_UNAVAILABLE',
      '未提供 SQL 执行器：PostgreSQL 会话存储拒绝在半可用状态下构造或调用',
      ['executor'],
    );
  }
  const candidate = executor as { query?: unknown; capabilities?: unknown };
  if (typeof candidate.query !== 'function') {
    throw new PostgresSessionStoreError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器缺少 query 方法：PostgreSQL 会话存储拒绝在半可用状态下构造或调用',
      ['executor.query'],
    );
  }
  const capabilities = candidate.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new PostgresSessionStoreError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器未声明能力（backend/persistent/productionReady）',
      ['executor.capabilities'],
    );
  }
  const { backend, persistent } = capabilities as { backend?: unknown; persistent?: unknown };
  if (typeof backend !== 'string' || backend.trim() === '') {
    throw new PostgresSessionStoreError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器的能力声明缺少 backend 标识',
      ['executor.capabilities.backend'],
    );
  }
  if (!/^postgres/iu.test(backend.trim())) {
    throw new PostgresSessionStoreError(
      'EXECUTOR_NOT_POSTGRES',
      'SQL 执行器声明的后端不是 PostgreSQL：拒绝把本 adapter 挂到其他存储上',
      ['executor.capabilities.backend'],
    );
  }
  if (persistent !== true) {
    throw new PostgresSessionStoreError(
      'EXECUTOR_NOT_PERSISTENT',
      'SQL 执行器声明为非持久后端（内存替身）：PostgreSQL 会话存储拒绝在其上运行',
      ['executor.capabilities.persistent'],
    );
  }
  return executor as SqlExecutor;
}

/**
 * 结果集形状 fail-closed：执行器必须返回对象且带 `rows` 数组。
 * 「少字段 / 类型不对」属于驱动或替身实现缺陷，不得被当成「这个会话不存在」静默放过。
 */
function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new PostgresSessionStoreError(
      'INVALID_ROW',
      'SQL 执行结果不是对象（驱动 / 替身实现缺陷）',
      ['result'],
    );
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new PostgresSessionStoreError(
      'INVALID_ROW',
      'SQL 执行结果缺少 rows 数组（驱动 / 替身实现缺陷）',
      ['rows'],
    );
  }
  return rows;
}

/** 写入影响行数：非整数视为驱动缺陷 */
function rowCountOf(result: unknown): number {
  const rowCount =
    typeof result === 'object' && result !== null
      ? (result as { rowCount?: unknown }).rowCount
      : undefined;
  if (typeof rowCount !== 'number' || !Number.isInteger(rowCount) || rowCount < 0) {
    throw new PostgresSessionStoreError(
      'STORAGE_VIOLATION',
      'SQL 执行结果缺少合法的 rowCount：拒绝在无法确认写入是否生效时报告成功',
      ['rowCount'],
    );
  }
  return rowCount;
}

/**
 * 执行一次 SQL。
 *
 * **执行器异常的信息卫生**：驱动 / 连接池抛出的异常一律收敛为不含原始文本的 `EXECUTOR_FAILURE`
 * ——不携带原始消息、不携带 `cause`、不携带 SQL 与参数。理由：驱动异常文本可能包含连接串、
 * 文件路径、SQL 片段与字段取值，而本 adapter 的错误会冒泡到 API 层的 500 路径。
 */
async function runQuery(
  executor: SqlExecutor,
  sql: string,
  parameters: readonly unknown[],
): Promise<unknown> {
  try {
    return await executor.query(sql, parameters);
  } catch {
    throw new PostgresSessionStoreError(
      'EXECUTOR_FAILURE',
      'SQL 执行失败：原始驱动错误不得外发（错误文本、SQL、连接信息与字段取值都不进入本错误）',
      ['executor'],
    );
  }
}

/** 创建会话的输入校验（服务端动作：非法即抛，且错误信息不回显取值） */
function validateCreateInput(
  input: CreateSessionInput,
  nowMs: number,
): {
  readonly userId: string;
  readonly roles: readonly string[];
  readonly scope: {
    readonly groupIds?: readonly string[];
    readonly assignedResourceIds?: readonly string[];
  };
  readonly expiresAt: string;
} {
  const issues: string[] = [];
  const subject = input.subject;

  if (typeof subject !== 'object' || subject === null) {
    throw new PostgresSessionStoreError(
      'INVALID_SUBJECT',
      '创建会话必须提供服务端主体：未提供主体时拒绝写入任何会话',
      ['subject'],
    );
  }
  if (!isSessionSafeId(subject.userId)) {
    throw new PostgresSessionStoreError(
      'INVALID_SUBJECT',
      '创建会话的主体 userId 不在存储 ID 域内（非空、长度 ≤ 64、无控制字符）：拒绝写入',
      ['subject.userId'],
    );
  }

  const roles = Array.isArray(subject.roles) ? subject.roles : [];
  if (roles.length === 0 || roles.length > POSTGRES_SESSION_STORE_MAX_ROLES) {
    issues.push('subject.roles(count)');
  }
  for (const [index, role] of roles.entries()) {
    if (typeof role !== 'string' || !ROLE_PATTERN.test(role)) {
      issues.push(`subject.roles.${index}(shape)`);
    }
  }

  const groupIds = subject.groupIds;
  if (groupIds !== undefined) {
    if (!Array.isArray(groupIds)) {
      issues.push('subject.groupIds(invalid_type)');
    } else {
      for (const [index, value] of groupIds.entries()) {
        if (!isSessionSafeId(value)) {
          issues.push(`subject.groupIds.${index}(shape)`);
        }
      }
    }
  }
  const assignedResourceIds = subject.assignedResourceIds;
  if (assignedResourceIds !== undefined) {
    if (!Array.isArray(assignedResourceIds)) {
      issues.push('subject.assignedResourceIds(invalid_type)');
    } else {
      for (const [index, value] of assignedResourceIds.entries()) {
        if (!isSessionSafeId(value)) {
          issues.push(`subject.assignedResourceIds.${index}(shape)`);
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new PostgresSessionStoreError(
      'INVALID_SUBJECT',
      '创建会话的主体不符合存储契约（角色元素形状 / 数量、范围 ID 形状）：拒绝写入任何会话',
      issues,
    );
  }

  if (!isSessionExpiryWithinBounds(input.expiresAt, nowMs)) {
    throw new PostgresSessionStoreError(
      'INVALID_EXPIRY',
      '创建会话的过期时刻必须是带时区的 ISO 时间戳，且落在「现在之后、有效期内」：拒绝写入任何会话',
      ['expiresAt'],
    );
  }

  return {
    userId: subject.userId,
    roles: [...roles],
    scope: {
      ...(groupIds === undefined ? {} : { groupIds: [...groupIds] }),
      ...(assignedResourceIds === undefined
        ? {}
        : { assignedResourceIds: [...assignedResourceIds] }),
    },
    expiresAt: input.expiresAt,
  };
}

/** 行 → 主体记录：列 → 字段映射单一事实来源，未知键不可能进入结果（行契约已 `.strict()`） */
function toSessionRecord(row: PostgresSessionRow): SessionRecord {
  const subject: AuthorizationSubject = {
    userId: row.user_id,
    roles: [...row.roles] as AuthorizationSubject['roles'],
    ...(row.scope.groupIds === undefined ? {} : { groupIds: [...row.scope.groupIds] }),
    ...(row.scope.assignedResourceIds === undefined
      ? {}
      : { assignedResourceIds: [...row.scope.assignedResourceIds] }),
  };
  return { sessionId: row.session_id, subject };
}

// 模块加载即校验：语句只读形态 + 参数位布局 + 列清单 / 行契约对齐 + 能力声明
assertPostgresSessionSqlShape();
assertPostgresSessionRowAligned();
assertPostgresSessionStoreCapabilities();

/**
 * 基于 `SqlExecutor` 的 PostgreSQL 会话存储。
 *
 * 构造与每次调用都会重新校验执行器与自身能力声明，因此「执行器被换掉 / 被降级」或
 * 「能力声明被改写」都会 fail-closed，而不是静默继续。
 * 本类**不是** Nest provider（不带任何 Nest 装饰器），换绑只发生在 `auth.module.ts`。
 */
export class PostgresSessionStore implements SessionStore {
  readonly capabilities: SessionBackendCapabilities;
  private readonly executor: SqlExecutor;

  constructor(
    executor: SqlExecutor,
    capabilities: PersistenceCapabilities = POSTGRES_SESSION_STORE_CAPABILITIES,
  ) {
    assertPostgresSessionStoreCapabilities(capabilities);
    this.capabilities = capabilities;
    this.executor = assertUsableExecutor(executor);
  }

  /** 每次调用前的自检：能力声明与执行器都必须仍然可用 */
  private usableExecutor(): SqlExecutor {
    assertPostgresSessionStoreCapabilities(this.capabilities);
    return assertUsableExecutor(this.executor);
  }

  /**
   * 按**客户端提交的原始票据**读取会话。
   *
   * - 票据形状不合法（不是 43 字符 base64url 的上线形）→ `undefined`，且**不执行任何 SQL**；
   * - 只把 `sha256(票据)` 绑定进 `WHERE session_id = $1`：原始票据不进入 SQL、参数与日志；
   * - `revoked_at IS NULL AND expires_at > now()` 由数据库判定，过期 / 已撤销一律查不到；
   * - 0 行 = 票据无效（`undefined`）；>1 行 = 主键约束被破坏，判 `STORAGE_VIOLATION`；
   * - 返回行的 `session_id` 必须与请求摘要逐字节一致，否则 `STORAGE_VIOLATION`。
   */
  async findSession(ticket: string): Promise<SessionRecord | undefined> {
    const executor = this.usableExecutor();
    if (!isSessionTicket(ticket)) {
      return undefined;
    }
    const digest = sessionTicketDigest(ticket);
    const result = await runQuery(executor, POSTGRES_SESSION_SELECT_SQL, [digest]);
    const rows = rowsOf(result);

    if (rows.length === 0) {
      return undefined;
    }
    if (rows.length > 1) {
      throw new PostgresSessionStoreError(
        'STORAGE_VIOLATION',
        '会话读取返回多行：session_id 主键约束已被破坏，拒绝接受其中任意一行',
        ['rows'],
      );
    }

    const parsed = postgresSessionRowSchema.safeParse(rows[0]);
    if (!parsed.success) {
      throw invalidRow(parsed.error);
    }
    const row = parsed.data;

    if (row.session_id !== digest) {
      throw new PostgresSessionStoreError(
        'STORAGE_VIOLATION',
        '返回了请求票据之外的会话行（摘要与请求不一致）：他人会话不得回流',
        ['session_id'],
      );
    }

    return toSessionRecord(row);
  }

  /**
   * 创建会话：只把票据**摘要**写入 `session_id`，原始票据仅在返回值里出现一次。
   *
   * - 主体与过期时刻在**下发 SQL 之前**校验（非法即抛，不写任何行）；
   * - `rowCount !== 1` 判 `STORAGE_VIOLATION`：创建没落库不能被当成成功（否则客户端会拿到一张
   *   立刻失效的票据，而服务端以为签发成功）；
   * - `expires_at` 由服务端时钟计算（调用方给出带时区的 ISO 时刻），不接受客户端字段。
   */
  async createSession(input: CreateSessionInput): Promise<IssuedSession> {
    const executor = this.usableExecutor();
    const validated = validateCreateInput(input, Date.now());

    const ticket = generateSessionTicket();
    const digest = sessionTicketDigest(ticket);
    const scopeJson = JSON.stringify(validated.scope);

    const result = await runQuery(executor, POSTGRES_SESSION_INSERT_SQL, [
      digest,
      validated.userId,
      [...validated.roles],
      scopeJson,
      validated.expiresAt,
    ]);

    if (rowCountOf(result) !== 1) {
      throw new PostgresSessionStoreError(
        'STORAGE_VIOLATION',
        '会话创建未写入恰好一行：拒绝在无法确认会话已落库时签发票据',
        ['rowCount'],
      );
    }

    return {
      ticket,
      record: {
        sessionId: digest,
        subject: {
          userId: validated.userId,
          roles: [...validated.roles] as AuthorizationSubject['roles'],
          ...(validated.scope.groupIds === undefined
            ? {}
            : { groupIds: [...validated.scope.groupIds] }),
          ...(validated.scope.assignedResourceIds === undefined
            ? {}
            : { assignedResourceIds: [...validated.scope.assignedResourceIds] }),
        },
      },
      expiresAt: validated.expiresAt,
    };
  }

  /**
   * 撤销会话（幂等）：把未撤销的会话置为已撤销。
   *
   * - 票据形状不合法 → `false`，且**不执行任何 SQL**；
   * - 返回「本次是否真的把一条未撤销会话置为已撤销」；重复撤销返回 `false`（不是错误）；
   * - 已经过期的会话也允许被撤销（`revoked_at` 与 `expires_at` 相互独立），避免「撤销一条
   *   刚过期的会话」变成失败路径。
   */
  async revokeSession(ticket: string): Promise<boolean> {
    const executor = this.usableExecutor();
    if (!isSessionTicket(ticket)) {
      return false;
    }
    const digest = sessionTicketDigest(ticket);
    const result = await runQuery(executor, POSTGRES_SESSION_REVOKE_SQL, [digest]);
    const rowCount = rowCountOf(result);
    if (rowCount > 1) {
      throw new PostgresSessionStoreError(
        'STORAGE_VIOLATION',
        '会话撤销影响了多行：session_id 主键约束已被破坏',
        ['rowCount'],
      );
    }
    return rowCount === 1;
  }

  /**
   * 过期清理：删除 `expires_at <= now()` 的会话，返回删除条数。
   *
   * 用数据库时钟判定过期（不接受调用方传入时刻）：多实例之间的时钟偏移不得改变「哪些会话已过期」。
   * 已撤销但未过期的会话**保留**，其撤销事实由上层审计切片负责，本方法只做过期清理。
   */
  async purgeExpired(): Promise<number> {
    const executor = this.usableExecutor();
    const result = await runQuery(executor, POSTGRES_SESSION_PURGE_SQL, []);
    return rowCountOf(result);
  }
}

/** DI 工厂：把驱动无关的 `SqlExecutor` 装成会话存储端口实现 */
export function createPostgresSessionStore(
  executor: SqlExecutor,
  capabilities: PersistenceCapabilities = POSTGRES_SESSION_STORE_CAPABILITIES,
): SessionStore {
  return new PostgresSessionStore(executor, capabilities);
}

/**
 * 延迟建连的会话存储：**模块装配阶段不碰数据库**。
 *
 * 为什么必须延迟：`SQL_CONNECTION_FACTORY.connect()` 在数据库已配置但执行器未通过 attest 契约时
 * 会抛错。如果在这里急切建连，启动失败会表现为「模块工厂抛了数据库错」，而不是启动期持久化边界 /
 * 依赖就绪门禁给出的**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED`、
 * `SESSION_STORE[DEPENDENCY_NOT_VERIFIED]` 等）。延迟后，判定顺序保持为
 * 「配置 → 门禁 → 首次真正读写会话」。
 *
 * 连接只在首次读写时建立并被复用；建立失败不缓存失败结果（下一次调用会重试），
 * 但错误文本一律经 adapter 的 `EXECUTOR_FAILURE` 收敛，不含驱动原文。
 *
 * 票据形状与创建输入的校验在**建连之前**完成：形状不合法的请求不应该触发任何数据库连接。
 */
export function createLazyPostgresSessionStore(
  resolveExecutor: () => Promise<SqlExecutor>,
  capabilities: PersistenceCapabilities = POSTGRES_SESSION_STORE_CAPABILITIES,
): SessionStore {
  assertPostgresSessionStoreCapabilities(capabilities);

  let pending: Promise<SqlExecutor> | undefined;
  const executor = (): Promise<SqlExecutor> => {
    if (pending === undefined) {
      pending = resolveExecutor().catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
  const withStore = async <Result>(
    run: (store: PostgresSessionStore) => Promise<Result>,
  ): Promise<Result> => run(new PostgresSessionStore(await executor(), capabilities));

  return {
    capabilities,
    async findSession(ticket: string): Promise<SessionRecord | undefined> {
      // 形状先判、再建连：非法票据不应该触发任何数据库连接
      if (!isSessionTicket(ticket)) {
        return undefined;
      }
      return withStore((store) => store.findSession(ticket));
    },
    async createSession(input: CreateSessionInput): Promise<IssuedSession> {
      // 输入先判、再建连：非法主体不应该触发任何数据库连接
      validateCreateInput(input, Date.now());
      return withStore((store) => store.createSession(input));
    },
    async revokeSession(ticket: string): Promise<boolean> {
      if (!isSessionTicket(ticket)) {
        return false;
      }
      return withStore((store) => store.revokeSession(ticket));
    },
    async purgeExpired(): Promise<number> {
      return withStore((store) => store.purgeExpired());
    },
  };
}

/** 仅供测试与装配断言：把票据摘要化（与 adapter 内部同一实现，避免测试自己复制一份哈希） */
export function digestSessionTicket(ticket: string): string {
  return sessionTicketDigest(ticket);
}
