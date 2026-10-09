import { z } from 'zod';
import { uuidSchema } from '@rm/shared';
import type { PersistenceCapabilities, SqlExecutor } from '../../db/ports/sql-executor.port';
import {
  SELF_STATISTICS_FIELDS,
  parseSelfStatisticsView,
  statisticsCountSchema,
} from './statistics.contract';
import type { SelfStatisticsView } from './statistics.contract';
import type { SelfStatisticsRepository } from './statistics.port';

/**
 * 本人统计（`GET /me/statistics`）的 **PostgreSQL 聚合读 adapter**。
 *
 * ## 交付边界
 * - **已接入运行时**：`StatisticsModule` 的 `SELF_STATISTICS_REPOSITORY` 工厂在「解析出
 *   `DATABASE_URL`」时换绑到本文件的 `createLazyPostgresSelfStatisticsRepository`；未配置数据库时
 *   仍走四个内存基线组合出的内存聚合基线（默认全零，开发/测试行为不变）；
 * - **延迟建连**：装配阶段不碰数据库。未 attest 的执行器由启动期持久化边界**结构化拒绝**
 *   （而不是在这里静默降级成内存实现）；配置了数据库却没拿到执行器工厂时直接抛错；
 * - **不引入** `pg` / Prisma / TypeORM 等驱动或 ORM 依赖：本文件只依赖驱动无关的 `SqlExecutor`
 *   端口（`db/ports/sql-executor.port.ts`），真实执行器由 `SQL_CONNECTION_FACTORY` 提供；
 * - **不是 Nest provider**：没有任何 Nest 装饰器（`@Injectable`、`@Inject`、`@Module` 一律没有）、
 *   不参与依赖注入、不注册路由；换绑只发生在 `statistics.module.ts` 的工厂里；
 * - **不声称生产可用**：能力声明固定为 `backend = postgres`、`persistent = true`、
 *   `productionReady = false`（原因见下方「已登记的前置」）。
 *
 * ## 为什么异步契约暂放在本文件
 * 现有 `StatisticsCountRepository`（`statistics.port.ts`）是**同步**端口（`countByUserId(): number`）
 * 且按来源拆成四个实例；把运行时契约改成「一次聚合查询返回四个计数」是跨模块变更
 * （service / controller / 模块绑定与既有 spec 必须一起改），必须与真实驱动引入在同一片切片完成。
 * 因此本文件实现 `AsyncSelfStatisticsRepository`（Promise 版，语义与四个内存基线之和一致），
 * 让「SQL 与映射是否正确」可以在**没有驱动、也没有数据库**的情况下被离线验证。
 *
 * ## 与内存基线的语义对应（逐条可核对）
 * | 内存基线（四个实例） | 本 adapter |
 * |---|---|
 * | 每个来源各自只按主体计数 | 一条 SELECT 的四个聚合子查询，谓词全是 `WHERE user_id = $1::uuid` |
 * | 默认全零：空数据不是异常 | 四个 `count` 恒有值：该主体无记录即 0，稳定返回四个 0 |
 * | 端口只返回计数、不返回记录 | 行契约只有归属列与四个计数列；结果只裁剪出四个计数字段 |
 * | `capabilities.source` 逐来源声明 | 聚合读模型只有一个 adapter，能力声明只保留后端与持久性 |
 *
 * 与内存基线的**唯一刻意差异**：内存基线不做读取契约校验（存储层损坏必须能被出口门禁看见），
 * 而数据库实现必须把「存储层不变量」写成**严格行契约**（未知列、缺列、负数 / 小数 / NaN /
 * 超上限、非 UUID 归属一律拒绝），因为数据库是外部可变状态，行内容可能被任意来源写坏。
 *
 * ## 安全边界（本文件的七条硬约束）
 * 1. **固定显式四聚合列 SELECT**：语句由模块常量拼装（表名与列名都过 `assertSqlIdentifier`），
 *    四个 `count(1)::int` 子查询的别名就是行契约的四个聚合列；**不使用 `SELECT *`**，且语句里
 *    连 `*` 字符都不存在（聚合写成 `count(1)`），因此「存储层新增列自动流出」在结构上不可能；
 *    模块加载期即校验语句形状（参数位、聚合列数量、列名与来源表）。
 * 2. **单一 `$1::uuid` 参数化**：整条语句只有一个参数位（主体），值只走占位符绑定；SQL 文本里
 *    没有引号、分号、注释与通配符，不存在「值 → SQL 文本」的注入面；执行过的语句只有 `SELECT`。
 * 3. **严格非负安全整数行**：行契约 `.strict()`，计数复用 `statistics.contract.ts` 的
 *    `statisticsCountSchema`（整数、`>= 0`、`<= STATISTICS_COUNT_MAX`），因此负数、小数、NaN、
 *    Infinity 与字符串形计数（驱动默认把 `bigint` 返回成字符串）一律 fail-closed；SQL 侧用
 *    `count(1)::int` 把聚合钉在 int4（计数上限 1e9 < int4 上限），避免驱动交出字符串计数，
 *    也避免超上限计数被静默截断。
 * 4. **owner 复核**：归属列 `user_id` 由 `$1::uuid` 直接投影（不来自任何数据表），返回行上
 *    逐字节复核「行归属 === 请求主体」，不一致即 `OWNER_VIOLATION`：替身 / 驱动 / 被改写的 SQL
 *    返回了别的主体的行绝不被静默接受；归属列只在 adapter 内部流转，**不进入公开结果**。
 * 5. **四字段公开结果**：返回值是 `SelfStatisticsView`，恰为 `SELF_STATISTICS_FIELDS` 的四个计数
 *    字段；结果对象按「列 → 字段」映射单一事实来源**每次新建**，再过一次
 *    `parseSelfStatisticsView`（`.strict()` 闭集）出口门禁，绝不把数据库行或内部引用交给调用方。
 * 6. **结果集与异常 fail-closed**：聚合语句恒返回一行，因此 0 行与多行都判 `RESULT_SET_VIOLATION`
 *    （0 行绝不被当成「四个 0」）；执行器异常一律收敛为不含原始文本的 `EXECUTOR_FAILURE`
 *    ——不带原始消息、不带 `cause`、不带 SQL 与参数（原始错误的定位职责属于显式注册的驱动层）。
 * 7. **入口主体受存储 ID 域约束**：`ownerUserId` 必须是合法、非空、规范小写形的 UUID，否则
 *    `INVALID_SUBJECT` 且**一个 SQL 都不执行**（错误信息也不回显该值本身）。
 *
 * ## 已登记的前置（因此 `productionReady` 恒为 false）
 * 四张来源表已由迁移 `0002_education_records.sql` … `0005_ai_match_records.sql` 建出（本切片补齐），
 * 对真实 PostgreSQL 的集成验证也已在 `db/postgres/__tests__/postgres-integration.spec.ts` 就位；
 * 但**生产可用**仍需：驱动依赖的评估证据、在 `TEST_DATABASE_URL` 指向的测试库上真实跑过该集成
 * 套件、会话主体收敛为 UUID、以及聚合列类型在真实驱动下的复核。这些都已登记在
 * `POSTGRES_STATISTICS_REPOSITORY_VERIFICATION_STEPS` 里，不能只写声明。
 */

/** 后端标识：与其它 postgres adapter 一致，只出现在能力声明与错误文案里 */
export const POSTGRES_STATISTICS_BACKEND = 'postgres';

/**
 * 归属列：四个聚合子查询的 `WHERE` 谓词与归属复核都用它。
 * 它是**内部列**：只在 adapter 内部流转，绝不进入公开结果，也绝不写进错误消息与日志。
 */
export const POSTGRES_STATISTICS_OWNER_COLUMN = 'user_id';

/** 聚合列的声明形状：SQL 别名（行契约的键）、公开字段、来源表 */
export interface PostgresStatisticsAggregateColumn {
  /** SQL 别名：同时是行契约里的键，必须以 `_` 分隔（零字面量注入面） */
  readonly column: string;
  /** 公开输出字段：必须是 `SELF_STATISTICS_FIELDS` 之一 */
  readonly field: (typeof SELF_STATISTICS_FIELDS)[number];
  /** 计数的来源表：只读 SELECT 的 FROM 目标 */
  readonly table: string;
}

/**
 * 四个聚合列的**唯一事实来源**：`SELECT` 列表、行契约、公开结果三者都由它派生。
 *
 * 来源表与 `statistics.port.ts` 的令牌注释一致（`education_records` / `join_applications` /
 * `achievements` / `ai_match_records`），并与各领域 adapter 的 `POSTGRES_*_TABLE` 同名。
 * `field` 一侧由类型约束钉在 `SELF_STATISTICS_FIELDS` 上，顺序另由模块加载期自检比对。
 */
export const POSTGRES_STATISTICS_AGGREGATE_COLUMNS = Object.freeze([
  { column: 'education_records', field: 'educationRecords', table: 'education_records' },
  { column: 'applications', field: 'applications', table: 'join_applications' },
  { column: 'achievements', field: 'achievements', table: 'achievements' },
  { column: 'matching_requests', field: 'matchingRequests', table: 'ai_match_records' },
] as const satisfies readonly PostgresStatisticsAggregateColumn[]);

/** 行契约的列闭集：归属列 + 四个聚合列（顺序即 `SELECT` 列表顺序） */
export const POSTGRES_STATISTICS_ROW_COLUMNS: readonly string[] = Object.freeze([
  POSTGRES_STATISTICS_OWNER_COLUMN,
  ...POSTGRES_STATISTICS_AGGREGATE_COLUMNS.map((entry) => entry.column),
]);

/**
 * 本 adapter 侧**不进入公开输出**的列：归属。
 * 公开白名单由 `statistics.contract.ts` 的 `SELF_STATISTICS_FIELDS` 给出（只有四个计数），
 * 本清单用于机器校验「归属及其驼峰形都不在白名单里」。
 */
export const POSTGRES_STATISTICS_VIEW_EXCLUDED_COLUMNS = Object.freeze([
  POSTGRES_STATISTICS_OWNER_COLUMN,
] as const);

/** 能力声明：持久但**未验证**，因此生产环境仍会被持久化边界守卫拦下 */
export const POSTGRES_STATISTICS_REPOSITORY_CAPABILITIES: PersistenceCapabilities = Object.freeze({
  backend: POSTGRES_STATISTICS_BACKEND,
  persistent: true,
  productionReady: false,
});

/**
 * 转成生产可用前必须完成的验证清单（每一项都需要证据，不能只写声明）：
 * 1. 驱动依赖经评估后引入（`docs/P2-开源复用评估.md` 的 Prisma / TypeORM 比较结论）；
 * 2. 对真实 PostgreSQL 的集成测试：建表迁移、四张来源表的 `user_id` 索引、按主体计数语义、
 *    以及**存储层不产生跨主体计数**（他人记录不出库）；
 * 3. 四张来源表的 schema 已由 `db/migrations/0002_education_records.sql` … `0005_ai_match_records.sql`
 *    落地；剩余动作是在目标库上执行 `pnpm db:migrate` 并核对 `user_id` 索引确实生效
 *    （`db/migrations/0001_bootstrap.sql` 只在注释里登记表名，真实建表在这些主题迁移里）；
 * 4. 契约迁回端口：把 `AsyncSelfStatisticsRepository` 从本文件迁入 `statistics.port.ts`，并把
 *    service / controller / 模块的四个内存 provider 绑定一起改为异步实现；
 * 5. 会话主体 `userId` 收敛为 UUID（当前基线是 `u-student-1` 这类安全 ID，不在存储 ID 域内）；
 * 6. 聚合列类型在真实驱动下复核：确认 `count(1)::int` 交出 JS `number`（未退化为 `bigint`
 *    字符串），且行契约对非法计数的拒绝在真实连接上同样生效；
 * 7. 完成 1–6 后，才允许把 `productionReady` 改为 true，并同步删除能力自检
 *    （`assertPostgresStatisticsRepositoryCapabilities` 会拒绝「未验证就声称生产可用」）。
 */
export const POSTGRES_STATISTICS_REPOSITORY_VERIFICATION_STEPS = [
  'driver-dependency-evaluated',
  'integration-tests-against-real-postgres',
  'statistics-source-tables-schema-migrated-and-verified',
  'async-self-statistics-contract-migrated-into-port',
  'session-subject-converged-to-uuid',
  'aggregate-column-types-verified-with-real-driver',
  'production-ready-capability-flipped-with-evidence',
] as const;

/** `SELECT` 是本切片唯一允许的语句种类（只读端口：没有 INSERT / UPDATE / DELETE / DDL 模板） */
export const POSTGRES_STATISTICS_READ_ONLY_STATEMENTS = ['SELECT'] as const;

/** SQL 文本里绝不允许出现的关键字（写操作、DDL、权限、过程调用与集合 / 结果集写入） */
export const POSTGRES_STATISTICS_FORBIDDEN_SQL_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'MERGE',
  'CALL',
  'COPY',
  'VACUUM',
  'EXECUTE',
  'UNION',
  'INTO',
] as const;

export type PostgresStatisticsRepositoryErrorCode =
  | 'CAPABILITY_MISDECLARED'
  | 'COLUMN_MISDECLARED'
  | 'SQL_VIOLATION'
  | 'EXECUTOR_UNAVAILABLE'
  | 'EXECUTOR_NOT_POSTGRES'
  | 'EXECUTOR_NOT_PERSISTENT'
  | 'EXECUTOR_FAILURE'
  | 'INVALID_SUBJECT'
  | 'INVALID_ROW'
  | 'RESULT_SET_VIOLATION'
  | 'OWNER_VIOLATION'
  | 'PUBLIC_VIEW_VIOLATION';

/**
 * adapter 的 fail-closed 错误。
 *
 * `issues` 只承载**字段路径与违规类型**（例如 `education_records(invalid_type)`、
 * `user_id`），不承载字段取值，避免把归属标识或注入载荷写进日志与错误响应。
 * `EXECUTOR_FAILURE` 更进一步：连原始错误的文本与 `cause` 都不携带。
 */
export class PostgresStatisticsRepositoryError extends Error {
  readonly code: PostgresStatisticsRepositoryErrorCode;
  readonly issues: readonly string[];

  constructor(
    code: PostgresStatisticsRepositoryErrorCode,
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PostgresStatisticsRepositoryError';
    this.code = code;
    this.issues = [...issues];
  }
}

/** SQL 标识符：表名与列名只能是「小写字母开头 + 小写字母 / 数字 / 下划线」 */
const SQL_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;

/**
 * 标识符白名单校验：SQL 文本只允许由模块常量拼装，因此每个常量在进入文本前都必须过这一关。
 * 非法标识符是代码缺陷（不是运行时输入），必须在模块加载期立刻暴露，而不是拼进 SQL。
 */
function assertSqlIdentifier(value: string, label: string): string {
  if (!SQL_IDENTIFIER_PATTERN.test(value)) {
    throw new PostgresStatisticsRepositoryError(
      'COLUMN_MISDECLARED',
      `SQL 标识符不合法（${label}）：表名与列名只允许小写字母、数字与下划线`,
      [label],
    );
  }
  return value;
}

/** 单词边界命中（避免 `id` 命中 `user_id`、`int` 命中 `count(1)::int` 之类的误判） */
function containsWord(sql: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'u').test(sql);
}

/** SQL 里出现的占位符序号（去重升序），用于断言「占位符数量 === 参数数量」 */
export function statisticsPlaceholderIndexes(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1])))].sort(
    (left, right) => left - right,
  );
}

/**
 * 固定显式四聚合列语句：由聚合列清单与单一参数位拼装。
 *
 * - 归属列由 `$1::uuid` **直接投影**：它不来自任何表，唯一作用是让「返回了别的主体的行」
 *   成为可检测的差异（`OWNER_VIOLATION`）；
 * - 每个来源一个标量子查询，`count(1)::int`（不用 `count(*)`：语句里不存在 `*` 字符）；
 * - 全语句只有一个参数位，四个子查询与归属投影共用它。
 */
function buildSelectSelfStatisticsSql(): string {
  const owner = assertSqlIdentifier(POSTGRES_STATISTICS_OWNER_COLUMN, 'owner_column');
  const aggregates = POSTGRES_STATISTICS_AGGREGATE_COLUMNS.map((entry) => {
    const table = assertSqlIdentifier(entry.table, `${entry.field}.table`);
    const column = assertSqlIdentifier(entry.column, `${entry.field}.column`);
    return `(SELECT count(1)::int FROM ${table} WHERE ${owner} = $1::uuid) AS ${column}`;
  });
  return `SELECT $1::uuid AS ${owner}, ${aggregates.join(', ')}`;
}

/** 唯一一条语句：固定显式四聚合列 SELECT */
export const POSTGRES_STATISTICS_SELECT_SQL = buildSelectSelfStatisticsSql();

/**
 * 语句卫生（只读）：语句以 `SELECT` 开头，且文本里没有写操作 / DDL / 权限 / 过程调用与集合关键字，
 * 也没有分号、注释与通配符；聚合写成 `count(1)`，因此连 `*` 字符都不存在。
 */
export function assertPostgresStatisticsReadOnlySql(sql: string): void {
  const issues: string[] = [];
  const upper = sql.toUpperCase();
  if (!containsWord(upper, POSTGRES_STATISTICS_READ_ONLY_STATEMENTS[0])) {
    issues.push('statement');
  }
  if (!/^\s*SELECT\b/u.test(sql)) {
    issues.push('leading-statement');
  }
  for (const keyword of POSTGRES_STATISTICS_FORBIDDEN_SQL_KEYWORDS) {
    if (containsWord(upper, keyword)) {
      issues.push(`keyword:${keyword}`);
    }
  }
  if (sql.includes(';')) {
    issues.push('semicolon');
  }
  if (sql.includes('--') || sql.includes('/*')) {
    issues.push('comment');
  }
  if (sql.includes('*')) {
    issues.push('wildcard');
  }
  if (sql.includes("'") || sql.includes('"')) {
    issues.push('literal');
  }
  if (issues.length > 0) {
    throw new PostgresStatisticsRepositoryError(
      'SQL_VIOLATION',
      '本人统计语句不是本切片允许的只读 SELECT（写操作 / DDL / 权限 / 注释 / 通配符 / 字面量一律禁止）',
      issues,
    );
  }
}

/**
 * 语句形状自检（模块加载期执行）：四个聚合列、单一参数位、来源表与归属谓词都必须与
 * 聚合列清单一致。这样「列清单改了但语句没改」「SQL 被改成多参数或通配投影」都会在
 * 导入期立刻失败，而不是等运行到某个主体才暴露。
 */
export function assertPostgresStatisticsSqlShape(
  sql: string = POSTGRES_STATISTICS_SELECT_SQL,
): void {
  const issues: string[] = [];
  const placeholders = statisticsPlaceholderIndexes(sql);
  if (placeholders.length !== 1 || placeholders[0] !== 1) {
    issues.push('parameters');
  }
  if (!sql.includes(`SELECT $1::uuid AS ${POSTGRES_STATISTICS_OWNER_COLUMN}`)) {
    issues.push('owner-projection');
  }
  const aggregateCount = [...sql.matchAll(/count\(1\)::int/gu)].length;
  if (aggregateCount !== POSTGRES_STATISTICS_AGGREGATE_COLUMNS.length) {
    issues.push('aggregate-count');
  }
  for (const entry of POSTGRES_STATISTICS_AGGREGATE_COLUMNS) {
    const expected = `(SELECT count(1)::int FROM ${entry.table} WHERE ${POSTGRES_STATISTICS_OWNER_COLUMN} = $1::uuid) AS ${entry.column}`;
    if (!sql.includes(expected)) {
      issues.push(`aggregate:${entry.field}`);
    }
  }
  if (issues.length > 0) {
    throw new PostgresStatisticsRepositoryError(
      'SQL_VIOLATION',
      '本人统计语句形状与聚合列清单不一致（固定显式四聚合列 + 单一 $1::uuid 参数位）',
      issues,
    );
  }
}

/**
 * 聚合列清单与公开白名单的对齐自检（模块加载期执行）：
 * 四个公开字段必须一个不多、一个不少且**顺序一致**，列名不得重复、不得与归属列同名。
 */
export function assertPostgresStatisticsColumnsAligned(): void {
  const issues: string[] = [];
  const fields = POSTGRES_STATISTICS_AGGREGATE_COLUMNS.map((entry) => entry.field);
  if (
    fields.length !== SELF_STATISTICS_FIELDS.length ||
    fields.some((field, index) => field !== SELF_STATISTICS_FIELDS[index])
  ) {
    issues.push('fields');
  }
  const columns: readonly string[] = POSTGRES_STATISTICS_AGGREGATE_COLUMNS.map(
    (entry) => entry.column,
  );
  if (new Set(columns).size !== columns.length) {
    issues.push('duplicate-columns');
  }
  if (columns.includes(POSTGRES_STATISTICS_OWNER_COLUMN)) {
    issues.push('owner-column-collision');
  }
  if (issues.length > 0) {
    throw new PostgresStatisticsRepositoryError(
      'COLUMN_MISDECLARED',
      '聚合列清单与公开的白名单字段不一致（四个公开字段必须与四个聚合列一一对应）',
      issues,
    );
  }
}

/** 能力自检：**未验证的实现不得声称生产可用**（任何环境都执行） */
export function assertPostgresStatisticsRepositoryCapabilities(
  capabilities: PersistenceCapabilities = POSTGRES_STATISTICS_REPOSITORY_CAPABILITIES,
): void {
  const issues: string[] = [];
  if (capabilities.backend !== POSTGRES_STATISTICS_BACKEND) {
    issues.push('backend');
  }
  if (capabilities.persistent !== true) {
    issues.push('persistent');
  }
  if (capabilities.productionReady !== false) {
    issues.push('productionReady');
  }
  if (issues.length > 0) {
    throw new PostgresStatisticsRepositoryError(
      'CAPABILITY_MISDECLARED',
      `PostgreSQL 统计仓储能力声明不符（backend 必须是 ${POSTGRES_STATISTICS_BACKEND}、persistent=true、productionReady=false）：未完成驱动集成验证前不得声称生产可用`,
      issues,
    );
  }
}

/** 下划线列名 → 驼峰形：用于把「归属不得进入公开视图」的判定扩展到字段名方向 */
function camelCase(column: string): string {
  return column.replace(/_([a-z0-9])/gu, (_match, char: string) => char.toUpperCase());
}

/** 公开结果裁剪的泄漏检测（纯函数，便于逐条用例固定）：返回空数组表示无泄漏 */
export function findStatisticsViewExclusionLeaks(viewFields: readonly string[]): readonly string[] {
  const declared = new Set(viewFields);
  return POSTGRES_STATISTICS_VIEW_EXCLUDED_COLUMNS.filter(
    (column) => declared.has(column) || declared.has(camelCase(column)),
  );
}

/** 空 UUID：合法 UUID 但不是可用主体，读写路径一律拒绝 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * 存储 ID 域判定（单一事实来源）：合法 UUID **且**非空 **且** 规范小写形。
 *
 * 归属复核是逐字节精确比较（`OWNER_VIOLATION`），而 UUID 文本在数据库侧大小写不敏感：
 * 若静默小写化，就会把「归属被改写」与「大小写差异」混成同一种静默修正。因此统一要求
 * 规范小写形，非规范形的主体在进入 SQL 之前就被拒绝。
 */
function isStorageUuid(value: unknown): value is string {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success && parsed.data !== NIL_UUID && parsed.data === parsed.data.toLowerCase();
}

/** 行契约里的归属列：形状 = 存储 ID 域（规范小写、非空） */
const storageUuidSchema = uuidSchema.refine(isStorageUuid, '必须是规范小写形的非空 UUID');

/**
 * 数据库行契约（**严格**）。
 *
 * `.strict()` 是「字段污染」防线：数据库返回的未登记列会让解析失败，而不是被静默丢弃或带进
 * 结果；列缺失同样失败（PG 对 `SELECT` 列表中存在的列一定返回键，缺键说明驱动或 SQL 已被改动）。
 * 计数列复用 `statisticsCountSchema`：整数、非负、不超上限 —— 负数 / 小数 / NaN / Infinity /
 * 字符串形 `bigint` 都在这里 fail-closed。
 */
const postgresStatisticsRowSchema = z
  .object({
    user_id: storageUuidSchema,
    education_records: statisticsCountSchema,
    applications: statisticsCountSchema,
    achievements: statisticsCountSchema,
    matching_requests: statisticsCountSchema,
  })
  .strict();

/** 行契约解析结果类型（四个聚合列 + 归属列，全部由严格契约收口） */
type PostgresStatisticsRow = z.infer<typeof postgresStatisticsRowSchema>;

/** 行契约的键必须与列清单逐字逐序一致（防止「列清单改了、schema 没改」） */
export function assertPostgresStatisticsRowAligned(): void {
  const keys = Object.keys(postgresStatisticsRowSchema.shape);
  const expected = [...POSTGRES_STATISTICS_ROW_COLUMNS];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new PostgresStatisticsRepositoryError(
      'COLUMN_MISDECLARED',
      '行契约的列与聚合列清单不一致：新增 / 改名聚合列必须同时登记在列清单与行契约里',
      ['row'],
    );
  }
}

/** 只保留字段路径与违规类型，绝不含字段取值（归属与计数取值都不进错误消息） */
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

function invalidRow(error: z.ZodError): PostgresStatisticsRepositoryError {
  return new PostgresStatisticsRepositoryError(
    'INVALID_ROW',
    '数据库行不符合本人统计的严格行契约（归属 + 四个非负安全整数计数，未知列与缺列一律拒绝）',
    describeIssues(error),
  );
}

/**
 * 执行器 fail-closed 校验：没有执行器、执行器不像 PostgreSQL、或声明为**非持久**（内存替身）
 * 时一律拒绝，而不是「先跑起来再说」。
 */
function assertUsableExecutor(executor: unknown): SqlExecutor {
  if (typeof executor !== 'object' || executor === null) {
    throw new PostgresStatisticsRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      '未提供 SQL 执行器：PostgreSQL 统计仓储拒绝在半可用状态下构造或调用',
      ['executor'],
    );
  }
  const candidate = executor as { query?: unknown; capabilities?: unknown };
  if (typeof candidate.query !== 'function') {
    throw new PostgresStatisticsRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器缺少 query 方法：PostgreSQL 统计仓储拒绝在半可用状态下构造或调用',
      ['executor.query'],
    );
  }
  const capabilities = candidate.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new PostgresStatisticsRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器未声明能力（backend/persistent/productionReady）',
      ['executor.capabilities'],
    );
  }
  const { backend, persistent } = capabilities as { backend?: unknown; persistent?: unknown };
  if (typeof backend !== 'string' || backend.trim() === '') {
    throw new PostgresStatisticsRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器的能力声明缺少 backend 标识',
      ['executor.capabilities.backend'],
    );
  }
  if (!/^postgres/iu.test(backend.trim())) {
    throw new PostgresStatisticsRepositoryError(
      'EXECUTOR_NOT_POSTGRES',
      'SQL 执行器声明的后端不是 PostgreSQL：拒绝把本 adapter 挂到其他存储上',
      ['executor.capabilities.backend'],
    );
  }
  if (persistent !== true) {
    throw new PostgresStatisticsRepositoryError(
      'EXECUTOR_NOT_PERSISTENT',
      'SQL 执行器声明为非持久后端（内存替身）：PostgreSQL 统计仓储拒绝在其上运行',
      ['executor.capabilities.persistent'],
    );
  }
  return executor as SqlExecutor;
}

/**
 * **存储 ID 域约束**：主体必须是合法、非空、且为**规范小写形**的 UUID。
 *
 * 非 UUID 的标识（例如会话基线的 `u-student-1`，或注入式载荷）会让数据库侧 `uuid` 比较退化为
 * 「转换失败 / 放弃类型约束」，因此在这里 fail-closed 拒绝，**绝不绑定进 SQL**
 * （错误信息也不回显该值本身）。
 */
function requireSubject(ownerUserId: unknown): string {
  if (!isStorageUuid(ownerUserId)) {
    throw new PostgresStatisticsRepositoryError(
      'INVALID_SUBJECT',
      '取数主体必须落在存储 ID 域内（合法且非空的规范小写 UUID）：非 UUID 的 ownerUserId 属于服务端缺陷，不得进入 SQL',
      ['ownerUserId'],
    );
  }
  return ownerUserId;
}

/**
 * 结果集形状 fail-closed：执行器必须返回对象且带 `rows` 数组。
 * 「少字段 / 类型不对」属于驱动或替身实现缺陷，不得被当成「没有统计」静默放过。
 */
function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new PostgresStatisticsRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果不是对象（驱动 / 替身实现缺陷）',
      ['result'],
    );
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new PostgresStatisticsRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果缺少 rows 数组（驱动 / 替身实现缺陷）',
      ['rows'],
    );
  }
  return rows;
}

/**
 * 执行一次 SQL 并返回行集。
 *
 * **执行器异常的信息卫生**：驱动 / 连接池抛出的异常一律收敛为不含原始文本的 `EXECUTOR_FAILURE`
 * ——不携带原始消息、不携带 `cause`、不携带 SQL 与参数。理由：驱动异常文本可能包含连接串、
 * 文件路径、SQL 片段与字段取值，而本 adapter 的错误会冒泡到 API 层的 500 路径。
 */
async function runQuery(
  executor: SqlExecutor,
  sql: string,
  parameters: readonly unknown[],
): Promise<readonly unknown[]> {
  let result: unknown;
  try {
    result = await executor.query(sql, parameters);
  } catch {
    throw new PostgresStatisticsRepositoryError(
      'EXECUTOR_FAILURE',
      'SQL 执行失败：原始驱动错误不得外发（错误文本、SQL、连接信息与字段取值都不进入本错误）',
      ['executor'],
    );
  }
  return rowsOf(result);
}

/**
 * 行 → **四个字段的公开结果**：按「列 → 字段」映射单一事实来源逐列赋值到**新建**对象，
 * 再过一次 `parseSelfStatisticsView`（`.strict()` 白名单）出口门禁。
 * 归属列不在映射里，因此结构上不可能进入结果；行对象本身也绝不交给调用方。
 */
function toSelfStatisticsView(row: PostgresStatisticsRow): SelfStatisticsView {
  const candidate: Record<string, number> = {};
  for (const entry of POSTGRES_STATISTICS_AGGREGATE_COLUMNS) {
    candidate[entry.field] = row[entry.column];
  }
  const parsed = parseSelfStatisticsView(candidate);
  if (!parsed.ok) {
    throw new PostgresStatisticsRepositoryError(
      'PUBLIC_VIEW_VIOLATION',
      '聚合结果不符合本人统计读取契约（必须恰好是四个合法计数的闭集）',
      parsed.issues.map((issue) => `${issue.path}(${issue.kind})`),
    );
  }
  return parsed.value;
}

/** 模块加载即校验：语句只读且形状固定（四聚合列 + 单一参数位） */
assertPostgresStatisticsReadOnlySql(POSTGRES_STATISTICS_SELECT_SQL);
assertPostgresStatisticsSqlShape();
assertPostgresStatisticsColumnsAligned();
assertPostgresStatisticsRowAligned();

/** 公开视图不含归属（模块加载期即校验，白名单与列清单同源） */
if (findStatisticsViewExclusionLeaks(SELF_STATISTICS_FIELDS).length > 0) {
  throw new PostgresStatisticsRepositoryError(
    'COLUMN_MISDECLARED',
    '公开结果白名单里出现了归属列或其驼峰形：他人归属不得随统计结果外发',
    ['view'],
  );
}

/**
 * 本人统计的异步读取契约已在 `statistics.port.ts` 落地（`SelfStatisticsRepository`）：本模块只提供
 * **实现**，不再自带一份契约副本，避免两份定义漂移。
 */

/**
 * 基于 `SqlExecutor` 的 PostgreSQL 本人统计聚合读仓储。
 *
 * 构造与每次调用都会重新校验执行器（`assertUsableExecutor`）与自身能力声明，因此「执行器被换掉 /
 * 被降级」或「能力声明被改写」都会 fail-closed，而不是静默继续。
 * 本类**不是** Nest provider（不带任何 Nest 装饰器），也未在任何模块中注册。
 */
export class PostgresStatisticsRepository implements SelfStatisticsRepository {
  readonly capabilities: PersistenceCapabilities = POSTGRES_STATISTICS_REPOSITORY_CAPABILITIES;

  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    assertPostgresStatisticsRepositoryCapabilities(this.capabilities);
    this.executor = assertUsableExecutor(executor);
  }

  /** 每次调用前的自检：能力声明与执行器都必须仍然可用 */
  private usableExecutor(): SqlExecutor {
    assertPostgresStatisticsRepositoryCapabilities(this.capabilities);
    return assertUsableExecutor(this.executor);
  }

  /**
   * 按服务端主体聚合取数（四类计数一次读出）。
   *
   * - 主体必须落在存储 ID 域内，否则 `INVALID_SUBJECT`，且**不访问数据库**；
   * - 归属下推进 SQL（四个子查询都是 `WHERE user_id = $1::uuid`），他人记录不参与计数；
   * - 聚合语句恒返回一行：0 行与多行都判 `RESULT_SET_VIOLATION`（0 行绝不等于「四个 0」）；
   * - 返回行必须过严格行契约（未知列 / 缺列 / 非法计数 fail-closed）；
   * - 返回行的归属必须与请求主体逐字节一致，否则 `OWNER_VIOLATION`；
   * - 返回的是**每次新构造**的四个字段对象：不含归属，也不把数据库行或内部引用交给调用方。
   */
  async readCountsByUserId(ownerUserId: string): Promise<SelfStatisticsView> {
    const executor = this.usableExecutor();
    const ownerId = requireSubject(ownerUserId);

    const rows = await runQuery(executor, POSTGRES_STATISTICS_SELECT_SQL, [ownerId]);

    if (rows.length !== 1) {
      throw new PostgresStatisticsRepositoryError(
        'RESULT_SET_VIOLATION',
        '本人统计聚合查询必须恰好返回一行：0 行（结果集缺失）与多行都不得被当成有效统计',
        ['rows'],
      );
    }

    const parsed = postgresStatisticsRowSchema.safeParse(rows[0]);
    if (!parsed.success) {
      throw invalidRow(parsed.error);
    }
    const row = parsed.data;

    if (row[POSTGRES_STATISTICS_OWNER_COLUMN] !== ownerId) {
      throw new PostgresStatisticsRepositoryError(
        'OWNER_VIOLATION',
        '返回了请求主体之外的统计行（他人归属的计数不得回流）',
        [POSTGRES_STATISTICS_OWNER_COLUMN],
      );
    }

    return toSelfStatisticsView(row);
  }
}

/** DI 工厂：把驱动无关的 `SqlExecutor` 装成聚合读端口实现（本切片**唯一**的换绑点） */
export function createPostgresSelfStatisticsRepository(
  executor: SqlExecutor,
): SelfStatisticsRepository {
  return new PostgresStatisticsRepository(executor);
}

/** 仅供开发/测试装配以外的地方复用：把「主体必须在存储 ID 域内」变成可先于建连执行的断言 */
export function assertPostgresStatisticsSubject(ownerUserId: unknown): string {
  return requireSubject(ownerUserId);
}

/**
 * 延迟建连的聚合读端口：**模块装配阶段不碰数据库**。
 *
 * 为什么必须延迟：`SQL_CONNECTION_FACTORY.connect()` 在数据库已配置但执行器未通过 attest 契约时
 * 会抛错。如果在这里急切建连，启动失败会表现为「模块工厂抛了数据库错」，而不是启动期持久化边界
 * 给出的**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED` / `DECLARATION_NOT_SEALED` 等）。
 * 延迟后，判定顺序保持为「配置 → 持久化边界 → 首次真正读库」，与切片原则一致。
 *
 * 连接只在首次读取时建立并被复用；建立失败不缓存失败结果（下一次调用会重试），
 * 但错误文本一律经 adapter 的 `EXECUTOR_FAILURE` 收敛，不含驱动原文。
 */
export function createLazyPostgresSelfStatisticsRepository(
  resolveExecutor: () => Promise<SqlExecutor>,
  capabilities: PersistenceCapabilities = POSTGRES_STATISTICS_REPOSITORY_CAPABILITIES,
): SelfStatisticsRepository {
  assertPostgresStatisticsRepositoryCapabilities(capabilities);

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

  return {
    capabilities,
    async readCountsByUserId(ownerUserId: string): Promise<SelfStatisticsView> {
      // 主体域先判、再建连：非存储 ID 域的主体不应该触发任何数据库连接
      const ownerId = assertPostgresStatisticsSubject(ownerUserId);
      const resolved = await executor();
      return new PostgresStatisticsRepository(resolved).readCountsByUserId(ownerId);
    },
  };
}
