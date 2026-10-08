import { z } from 'zod';
import { ACHIEVEMENT_TYPE_VALUES, REVIEW_STATUS_VALUES, uuidSchema } from '@rm/shared';
import type { SqlExecutor } from '../../db/ports/sql-executor.port';
import { parseStoredAchievement, storedAchievementSchema } from './achievements.contract';
import {
  ACHIEVEMENT_REPOSITORY_BACKEND_POSTGRES,
  type Achievement,
  type AchievementRepositoryCapabilities,
  type AsyncAchievementRepository,
} from './achievements.port';

/**
 * 成果的 **PostgreSQL 仓储 adapter（首个可验证实现，未接入运行时）**。
 *
 * ## 交付边界（本切片刻意不做的事）
 * - **不绑定**到 `AchievementsModule`：模块仍然只绑定内存基线 `InMemoryAchievementRepository`
 *   （provider 列表与 DI 令牌一字未改），运行时行为与本切片之前逐字节一致（有回归断言，
 *   见同名 spec）；
 * - **不引入** `pg` / Prisma / TypeORM 等驱动或 ORM 依赖：本文件只依赖驱动无关的
 *   `SqlExecutor` 端口（`db/ports/sql-executor.port.ts`），真实执行器由消费方在「启用数据库」
 *   那一步显式提供；
 * - **不声称生产可用**：能力声明固定为 `backend = postgres`、`persistent = true`、
 *   `productionReady = false`。在引入经评估的驱动、完成对真实 PostgreSQL 的集成验证、并把
 *   `achievements` 从字段字典落成 schema 草案 → 迁移之前，生产启动会被
 *   `PersistenceBoundaryService` 拒绝（`productionReady !== true` 即违规）。
 *
 * ## 为什么先有异步契约
 * 现有 `AchievementRepository`（`achievements.port.ts`）是同步接口；把运行时端口改成 Promise 是
 * 跨模块契约变更（service / controller / 既有 spec 必须一起改），必须与真实驱动引入在同一片
 * 切片完成。因此本文件实现 `AsyncAchievementRepository`（Promise 版，语义与内存基线完全一致），
 * 让「SQL 与映射是否正确」可以在**没有驱动、也没有数据库**的情况下被离线验证。
 *
 * ## 安全边界（本文件的五条硬约束）
 * 1. **参数化 SQL + 固定标识符**：所有客户端可控的值一律走 `$1…$n` 占位符绑定；进入 SQL 文本的
 *    只有模块常量（表名、列清单），且都经过 `assertSqlIdentifier` 校验，
 *    不存在任何「值 → SQL 文本」的路径（占位符与参数由同一份列清单派生，不会数量漂移）；
 * 2. **显式字段映射 + 严格行契约**：数据库行必须满足严格（`.strict()`）的行契约（未知列、
 *    非法枚举、非 UUID、坏时间戳一律拒绝），再**逐字段显式映射**为领域记录（列 → 字段的对应
 *    关系由 `POSTGRES_ACHIEVEMENT_COLUMN_FIELDS` 单一事实来源给出，并由
 *    `Record<keyof Achievement, …>` 在编译期强制完整），最后再过一次
 *    `achievements.contract.ts` 的读取契约；任何一步不合规都 **fail-closed** 抛错，
 *    绝不把未登记字段、未知审核态或半成品记录交给上层；
 * 3. **subject / 归属隔离**：`userId` 必须由调用方（service）从服务端会话主体写入，必须是合法、
 *    非空、规范小写形的 UUID（**存储 ID 域约束**，见 `achievements.port.ts`）；adapter
 *    不生成、不覆盖归属，并且**把归属下推进 SQL**：列表取数只返回请求主体的记录；返回行上再
 *    逐条复核归属（不一致即 `OWNER_VIOLATION`）——他人记录既不出库、也不得回流；
 * 4. **公开视图不携带归属与审核内部字段**：adapter 只在**内部存储记录**上承载 `userId`
 *    （不静默丢弃归属），对外裁剪由 `achievements.contract.ts` 的 `toAchievementView` 负责
 *    （`POSTGRES_ACHIEVEMENT_VIEW_EXCLUDED_COLUMNS` 给出本 adapter 侧不进入公开输出的列清单；
 *    审核内部字段——审核人、审核意见、审核时间、审计事件 ID——**根本不在**本 adapter 的列清单内，
 *    见 `POSTGRES_ACHIEVEMENT_REVIEW_INTERNAL_COLUMNS`）；
 * 5. **个人级内容只走内部存储契约**：`title` / `description` / `award_level` / `evidence_file_id`
 *    在本人自读范围内是合法内容（字段字典：`title` 个人、`evidence_file_id` 高敏感），因此
 *    **不做对外裁剪**，但它们是用户可自由填写的文本与文件标识，**绝不**写进错误消息与日志；
 *    错误消息**只带字段路径与违规类型**，避免把数据内容或注入载荷写进日志与错误响应。
 *
 * ## 尚未解决 / 已登记的前置（因此 productionReady 恒为 false）
 * `db/migrations/0001_bootstrap.sql` 只在注释里登记了 `achievements` 的建表计划，
 * 该表既没有 schema 草案也没有迁移；真实 PostgreSQL 的集成验证（建表、`id` 主键冲突、
 * `user_id` 索引、按归属取数与排序）尚未进行。这些都已登记在
 * `POSTGRES_ACHIEVEMENT_REPOSITORY_VERIFICATION_STEPS` 里，不能只写声明。
 */

/** 表名：与 docs/P1-字段级数据字典.md 的 `achievements` 一致 */
export const POSTGRES_ACHIEVEMENT_TABLE = 'achievements';

/**
 * 列清单：同时定义 `SELECT` 输出列、`INSERT` 列顺序与 `RETURNING` 输出列。
 *
 * 刻意不写 `SELECT *`：存储层新增列（软删除时间、审核留痕、审计字段）不会因为本文件
 * 没更新就自动流进领域对象；配合行契约的 `.strict()`，未登记列会被显式拒绝而不是被静默带出。
 *
 * 注意：字段字典/审核切片里的审核留痕（审核人、审核意见、审核时间、审计事件 ID）与
 * `deleted_at` **不在本清单内**——它们属于后续「审核（`achievement:review`）」「管理员代改留痕」
 * 切片，本 adapter 既不读写它们，也不用它们做过滤，因此未来迁移新增这些列不会改变本 adapter
 * 的行为（除非有人把它们塞进本清单，那时严格行契约会立刻暴露字段污染）。
 */
export const POSTGRES_ACHIEVEMENT_COLUMNS = [
  'id',
  'user_id',
  'type',
  'title',
  'award_level',
  'description',
  'achieved_at',
  'evidence_file_id',
  'review_status',
  'created_at',
  'updated_at',
] as const;

/** 列 → 领域字段的唯一事实来源（编译期强制覆盖 `Achievement` 的全部字段） */
export const POSTGRES_ACHIEVEMENT_COLUMN_FIELDS = Object.freeze({
  id: 'id',
  user_id: 'userId',
  type: 'type',
  title: 'title',
  award_level: 'awardLevel',
  description: 'description',
  achieved_at: 'achievedAt',
  evidence_file_id: 'evidenceFileId',
  review_status: 'reviewStatus',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
} as const satisfies Record<(typeof POSTGRES_ACHIEVEMENT_COLUMNS)[number], keyof Achievement>);

/**
 * 归属列：只在服务端内部流转。
 * 它**不进入**公开视图，也绝不进入错误消息与日志（他人归属不得回流、也不得外泄）。
 */
export const POSTGRES_ACHIEVEMENT_OWNER_COLUMNS: readonly (typeof POSTGRES_ACHIEVEMENT_COLUMNS)[number][] =
  Object.freeze(['user_id']);

/**
 * 个人级内容列（字段字典：`title` 个人级、`evidence_file_id` 高敏感、`description` 为自由文本）：
 * 在**本人自读**范围内是合法内容，因此不对外裁剪；但**绝不**写进错误消息与日志。
 *
 * 注：`award_level`（内部级）同属自由文本，一并在错误信息里按「不回显取值」处理。
 */
export const POSTGRES_ACHIEVEMENT_PII_COLUMNS: readonly (typeof POSTGRES_ACHIEVEMENT_COLUMNS)[number][] =
  Object.freeze(['title', 'description', 'evidence_file_id']);

/**
 * 审核内部字段：**明确禁止进入本 adapter 的列清单**（因此也不可能进入领域记录与公开视图）。
 *
 * 它们不是列清单的子集（类型刻意写成 `readonly string[]`）：一旦有人把它们加进
 * `POSTGRES_ACHIEVEMENT_COLUMNS`，同名 spec 的「列清单不得与审核内部字段相交」与
 * 「行契约拒绝审核内部列」两条断言会立刻失败。
 */
export const POSTGRES_ACHIEVEMENT_REVIEW_INTERNAL_COLUMNS: readonly string[] = Object.freeze([
  'reviewer_user_id',
  'reviewed_by_user_id',
  'review_comment',
  'reviewed_at',
  'audit_event_id',
]);

/**
 * 本 adapter 侧**不进入公开输出**的列：归属（`user_id`）。
 *
 * 对外裁剪由 `toAchievementView` 负责（逐字段显式赋值、不展开），本清单用于机器校验
 * 「adapter 不把归属投影出去」，与「自读范围下响应里没有可回传的归属信息」这一契约一致。
 */
export const POSTGRES_ACHIEVEMENT_VIEW_EXCLUDED_COLUMNS: readonly (typeof POSTGRES_ACHIEVEMENT_COLUMNS)[number][] =
  Object.freeze(['user_id']);

/** 仓储能力：持久但**未验证**，因此生产环境仍会被持久化边界守卫拦下 */
export const POSTGRES_ACHIEVEMENT_REPOSITORY_CAPABILITIES: AchievementRepositoryCapabilities =
  Object.freeze({
    backend: ACHIEVEMENT_REPOSITORY_BACKEND_POSTGRES,
    persistent: true,
    productionReady: false,
  });

/**
 * 转成生产可用前必须完成的验证清单（每一项都需要证据，不能只写声明）：
 * 1. 驱动依赖经评估后引入（`docs/P2-开源复用评估.md` 的 Prisma / TypeORM 比较结论）；
 * 2. 对真实 PostgreSQL 的集成测试：建表迁移、`id` 主键冲突、按 `user_id` 取数与排序；
 * 3. `achievements` 的 schema 草案创建并按 `db/migrations/README.md` 转为迁移并执行验证
 *    （当前 `db/migrations/0001_bootstrap.sql` 只在注释里登记了该表）；
 * 4. `AchievementRepository` 端口改为异步：service / controller 与其测试一起改；
 * 5. 会话主体 `userId` 收敛为 UUID（当前基线是 `u-student-1` 这类安全 ID，不满足存储 ID 域）；
 * 6. 完成 1–5 后，才允许把 `productionReady` 改为 true，并同步删除能力自检
 *    （`assertPostgresAchievementRepositoryCapabilities` 会拒绝「未验证就声称生产可用」）。
 */
export const POSTGRES_ACHIEVEMENT_REPOSITORY_VERIFICATION_STEPS = [
  'driver-dependency-evaluated',
  'integration-tests-against-real-postgres',
  'achievements-schema-draft-created-and-promoted-to-migration',
  'achievement-repository-port-migrated-to-async',
  'session-subject-user-ids-converged-to-uuid',
  'production-ready-capability-flipped-with-evidence',
] as const;

export type PostgresAchievementRepositoryErrorCode =
  | 'CAPABILITY_MISDECLARED'
  | 'INVALID_CONFIGURATION'
  | 'EXECUTOR_UNAVAILABLE'
  | 'EXECUTOR_NOT_POSTGRES'
  | 'EXECUTOR_NOT_PERSISTENT'
  | 'INVALID_SUBJECT'
  | 'INVALID_RECORD'
  | 'INVALID_ROW'
  | 'RESULT_SET_VIOLATION'
  | 'CONFLICT'
  | 'IDENTITY_MISMATCH'
  | 'OWNER_VIOLATION';

/**
 * adapter 的 fail-closed 错误。
 *
 * `issues` 只承载**字段路径与违规类型**（例如 `user_id`、`title(too_big)`、
 * `review_status(invalid_enum_value)`），不承载字段取值，
 * 避免把归属标识、标题/说明原文、佐证文件 ID、注入载荷或连接信息写进日志与错误响应。
 */
export class PostgresAchievementRepositoryError extends Error {
  readonly code: PostgresAchievementRepositoryErrorCode;
  readonly issues: readonly string[];

  constructor(
    code: PostgresAchievementRepositoryErrorCode,
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PostgresAchievementRepositoryError';
    this.code = code;
    this.issues = [...issues];
  }
}

/**
 * 能力自检：**未验证的实现不得声称生产可用**。
 *
 * 任何环境都会执行（能力声明缺失属于代码缺陷，不能等生产才暴露）。
 * 生产可用性的提升必须与 `POSTGRES_ACHIEVEMENT_REPOSITORY_VERIFICATION_STEPS` 的证据、
 * 以及本断言的同步修改一起发生。
 */
export function assertPostgresAchievementRepositoryCapabilities(
  capabilities: AchievementRepositoryCapabilities = POSTGRES_ACHIEVEMENT_REPOSITORY_CAPABILITIES,
): void {
  const issues: string[] = [];
  if (capabilities.backend !== ACHIEVEMENT_REPOSITORY_BACKEND_POSTGRES) {
    issues.push('backend');
  }
  if (capabilities.persistent !== true) {
    issues.push('persistent');
  }
  if (capabilities.productionReady !== false) {
    issues.push('productionReady');
  }
  if (issues.length > 0) {
    throw new PostgresAchievementRepositoryError(
      'CAPABILITY_MISDECLARED',
      `PostgreSQL 成果仓储能力声明不符（backend 必须是 ${ACHIEVEMENT_REPOSITORY_BACKEND_POSTGRES}、persistent=true、productionReady=false）：未完成驱动集成验证前不得声称生产可用`,
      issues,
    );
  }
}

/** 空 UUID：合法 UUID 但不是可用主体，读写路径一律拒绝 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** SQL 标识符白名单：只允许小写字母开头的裸标识符，杜绝用「列名 / 表名」夹带 SQL 片段 */
const SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/u;

function assertSqlIdentifier(value: string, label: string): string {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new PostgresAchievementRepositoryError(
      'INVALID_CONFIGURATION',
      `SQL 标识符不合规（必须是裸小写标识符）：${label}`,
      [label],
    );
  }
  return value;
}

/** 模块加载即校验：表名与列名一旦被改成非标识符形状，直接 fail-closed（不静默拼进 SQL） */
const TABLE_IDENTIFIER = assertSqlIdentifier(POSTGRES_ACHIEVEMENT_TABLE, 'table');
const COLUMN_LIST = POSTGRES_ACHIEVEMENT_COLUMNS.map((column) =>
  assertSqlIdentifier(column, 'column'),
).join(', ');

/** 逐列的类型转换：只在「列 → 参数占位」这一步使用，值本身永远不进入 SQL 文本 */
const COLUMN_PARAMETER_CASTS: Partial<
  Record<(typeof POSTGRES_ACHIEVEMENT_COLUMNS)[number], string>
> = {
  id: '::uuid',
  user_id: '::uuid',
  achieved_at: '::timestamptz',
  evidence_file_id: '::uuid',
  created_at: '::timestamptz',
  updated_at: '::timestamptz',
};

/** `VALUES ($1::uuid, $2::uuid, …)`：占位符与列一一对应，由列清单派生，不会出现数量漂移 */
const INSERT_VALUES = POSTGRES_ACHIEVEMENT_COLUMNS.map(
  (column, index) => `$${index + 1}${COLUMN_PARAMETER_CASTS[column] ?? ''}`,
).join(', ');

/**
 * 写入语句：客户端可控值全部走 `$n`；`ON CONFLICT (id) DO NOTHING` 让**主键冲突显式暴露**
 * （与内存基线 `create` 抛「成果 ID 冲突」同语义：入库记录 ID 由服务端生成，
 * 冲突属于服务端缺陷，不得静默覆盖、也没有任何可覆盖的列）。
 * 刻意**没有** `DO UPDATE`：本端口只提供创建，任何「写入即改写」都会绕过审核/留痕切片。
 * `RETURNING` 让写入结果可被严格行契约复核（而不是「写完就当成功」）。
 */
const INSERT_SQL = `INSERT INTO ${TABLE_IDENTIFIER} (
  ${COLUMN_LIST}
) VALUES (${INSERT_VALUES})
ON CONFLICT (id) DO NOTHING
RETURNING ${COLUMN_LIST}`;

/**
 * 按主体取数语句：主体走 `$1::uuid` 绑定，**归属下推进 SQL**（他人记录既不出库也不回流）；
 * 显式列清单，不使用 `SELECT *`。
 *
 * 排序固定为 `created_at ASC, id ASC`：与内存基线的插入顺序一致（service 在 append 时写入
 * `createdAt = now`），并给出逐页稳定、可复现的**全序**——这正是后续「列表分页」切片做键集
 * 分页所需的稳定排序键。本切片**不加** `LIMIT/OFFSET`：端口还没有分页窗口，adapter 自行截断
 * 会让结果与内存基线语义不一致（同名 spec 有边界断言，分页参数一进入端口就会被拦下）。
 */
const SELECT_BY_OWNER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE user_id = $1::uuid
  ORDER BY created_at ASC, id ASC`;

/**
 * 数据库行契约（**严格**）。
 *
 * `.strict()` 是「字段污染」防线：数据库返回的未登记列（`deleted_at`、`reviewer_user_id`、
 * `review_comment`、`reviewed_at`、`audit_event_id`…）会让解析失败，而不是被静默丢弃或带进
 * 领域对象。列缺失同样失败（PG 对 SELECT 列表中存在的列一定返回键，缺键说明驱动或 SQL
 * 已被改动）。
 *
 * 枚举闭集与列上的形状约束在这里先拦一道；**内容安全**（控制字符、身份证号/密钥等敏感内容）
 * 与时间格式的最终判定交给 `achievements.contract.ts`（映射后用 `parseStoredAchievement` 复核）。
 */
const postgresAchievementRowSchema = z
  .object({
    id: uuidSchema,
    user_id: uuidSchema,
    type: z.enum(ACHIEVEMENT_TYPE_VALUES),
    title: z.string().min(1).max(300),
    award_level: z.string().max(100).nullable(),
    description: z.string().max(2000).nullable(),
    achieved_at: z.union([z.date(), z.string()]).nullable(),
    evidence_file_id: uuidSchema.nullable(),
    review_status: z.enum(REVIEW_STATUS_VALUES),
    created_at: z.union([z.date(), z.string()]),
    updated_at: z.union([z.date(), z.string()]),
  })
  .strict();

/** 写入记录契约：读取契约的严格版本（调用方不得通过领域对象夹带未登记字段） */
const strictWritableAchievementSchema = storedAchievementSchema.strict();

/** 只保留字段路径与违规类型，绝不含字段取值（归属与标题/说明原文不进错误消息） */
function describeIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}(${issue.code})`);
}

function invalidRow(error: z.ZodError, label = 'row'): PostgresAchievementRepositoryError {
  return new PostgresAchievementRepositoryError(
    'INVALID_ROW',
    `数据库行不符合 postgres 行契约（${label}）`,
    describeIssues(error),
  );
}

/** 时间列 → ISO 字符串；坏时间戳 fail-closed（不产生 `Invalid Date` 之类的半成品） */
function toIsoTimestamp(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PostgresAchievementRepositoryError('INVALID_ROW', `时间列不是合法时间戳：${label}`, [
      label,
    ]);
  }
  return date.toISOString();
}

/** 空串归一为「未填写」：与内存基线/service 的语义一致（service 从不下发空串） */
function optionalText(value: string | null): string | undefined {
  return value ? value : undefined;
}

/**
 * 行 → 领域记录：**逐字段显式映射**（不使用展开），再整体过一次读取契约。
 *
 * 顺序刻意如此：先按严格行契约解析（拒绝未登记列 / 未知枚举 / 坏 UUID / 坏时间戳 / 坏形状），
 * 再显式取字段构造新对象（即使行里有额外内容也不会被带出），最后用 `parseStoredAchievement`
 * 复核共享读取契约（枚举闭集 + ISO 时间 + 内容安全 + 长度），任一环节不合规都抛错。
 */
function mapRow(row: unknown): Achievement {
  const parsedRow = postgresAchievementRowSchema.safeParse(row);
  if (!parsedRow.success) {
    throw invalidRow(parsedRow.error);
  }
  const dbRow = parsedRow.data;

  const awardLevel = optionalText(dbRow.award_level);
  const description = optionalText(dbRow.description);
  const evidenceFileId = optionalText(dbRow.evidence_file_id);

  const achievement = {
    id: dbRow.id,
    // 归属：adapter 只承载，不生成、不覆盖；对外由 toAchievementView 裁剪
    userId: dbRow.user_id,
    type: dbRow.type,
    title: dbRow.title,
    ...(awardLevel ? { awardLevel } : {}),
    ...(description ? { description } : {}),
    ...(dbRow.achieved_at === null
      ? {}
      : { achievedAt: toIsoTimestamp(dbRow.achieved_at, 'achieved_at') }),
    ...(evidenceFileId ? { evidenceFileId } : {}),
    reviewStatus: dbRow.review_status,
    createdAt: toIsoTimestamp(dbRow.created_at, 'created_at'),
    updatedAt: toIsoTimestamp(dbRow.updated_at, 'updated_at'),
  };

  const parsedRecord = parseStoredAchievement(achievement);
  if (!parsedRecord.ok) {
    throw new PostgresAchievementRepositoryError(
      'INVALID_ROW',
      '数据库行映射后不符合成果读取契约',
      parsedRecord.issues.map((issue) => `${issue.path}(${issue.kind})`),
    );
  }
  return parsedRecord.value;
}

/**
 * 执行器 fail-closed 校验：没有执行器、执行器不像 PostgreSQL、或声明为**非持久**
 * （内存替身）时一律拒绝，而不是「先跑起来再说」。
 */
function assertUsableExecutor(executor: unknown): SqlExecutor {
  if (typeof executor !== 'object' || executor === null) {
    throw new PostgresAchievementRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      '未提供 SQL 执行器：PostgreSQL 成果仓储拒绝在半可用状态下构造或调用',
      ['executor'],
    );
  }
  const candidate = executor as { query?: unknown; capabilities?: unknown };
  if (typeof candidate.query !== 'function') {
    throw new PostgresAchievementRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器缺少 query 方法：PostgreSQL 成果仓储拒绝在半可用状态下构造或调用',
      ['executor.query'],
    );
  }
  const capabilities = candidate.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new PostgresAchievementRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器未声明能力（backend/persistent/productionReady）',
      ['executor.capabilities'],
    );
  }
  const { backend, persistent } = capabilities as { backend?: unknown; persistent?: unknown };
  if (typeof backend !== 'string' || backend.trim() === '') {
    throw new PostgresAchievementRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器的能力声明缺少 backend 标识',
      ['executor.capabilities.backend'],
    );
  }
  if (!/^postgres/iu.test(backend.trim())) {
    throw new PostgresAchievementRepositoryError(
      'EXECUTOR_NOT_POSTGRES',
      'SQL 执行器声明的后端不是 PostgreSQL：拒绝把本 adapter 挂到其他存储上',
      ['executor.capabilities.backend'],
    );
  }
  if (persistent !== true) {
    throw new PostgresAchievementRepositoryError(
      'EXECUTOR_NOT_PERSISTENT',
      'SQL 执行器声明为非持久后端（内存替身）：PostgreSQL 成果仓储拒绝在其上运行',
      ['executor.capabilities.persistent'],
    );
  }
  return executor as SqlExecutor;
}

/**
 * **存储 ID 域约束**：主体与资源标识必须是合法、非空、且为**规范小写形**的 UUID。
 *
 * 非 UUID 的标识（例如会话基线的 `u-student-1`，或注入式载荷）会让数据库侧 `uuid`
 * 比较退化为「转换失败 / 放弃类型约束」，因此在这里 fail-closed 拒绝，
 * **绝不绑定进 SQL**（错误信息也不回显该值本身）。
 *
 * 为什么连大写也拒绝：归属复核是**逐字节精确比较**（`OWNER_VIOLATION`），而 UUID 文本在
 * 数据库侧是大小写不敏感的。若在这里静默小写化，就会把「归属被改写」与「大小写差异」混成
 * 同一个静默修正；若原样绑定大写，则数据库返回的规范小写形会与本地上限值不一致而误报越权。
 * 因此统一要求规范小写形，由「会话主体标识收敛」切片负责规范化（已登记在验证清单里）。
 */
function requireStorageUuid(
  value: unknown,
  code: PostgresAchievementRepositoryErrorCode,
  message: string,
  label: string,
): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success || parsed.data === NIL_UUID || parsed.data !== parsed.data.toLowerCase()) {
    throw new PostgresAchievementRepositoryError(code, message, [label]);
  }
  return parsed.data;
}

/** 写入记录校验：读取契约的严格版本 + 归属必须落在存储 ID 域内（合法且非空 UUID） */
function assertWritableRecord(record: unknown): Achievement {
  const parsed = strictWritableAchievementSchema.safeParse(record);
  if (!parsed.success) {
    throw new PostgresAchievementRepositoryError(
      'INVALID_RECORD',
      '待写入的成果不符合读取契约的严格版本（含未登记字段或非法取值）',
      describeIssues(parsed.error),
    );
  }
  requireStorageUuid(
    parsed.data.userId,
    'INVALID_RECORD',
    '待写入的成果缺少有效归属（归属必须由服务端会话主体写入，且落在存储 ID 域内）',
    'userId',
  );
  return parsed.data;
}

/**
 * 结果集形状 fail-closed：执行器必须返回对象且带 `rows` 数组。
 * 「少字段 / 类型不对」属于驱动或替身实现缺陷，不得被当成「空结果」静默放过
 * （否则会把基础设施故障伪装成「该主体尚无成果」）。
 */
function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new PostgresAchievementRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果不是对象（驱动 / 替身实现缺陷）',
      ['result'],
    );
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new PostgresAchievementRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果缺少 rows 数组（驱动 / 替身实现缺陷）',
      ['rows'],
    );
  }
  return rows;
}

/**
 * 写入参数：**由列清单派生**（列 → 字段 → 值），因此参数顺序永远与 SQL 占位符一致；
 * `Record<keyof Achievement, unknown>` 让「新增领域字段但忘记补参数」成为编译错误。
 * 缺失的可选字段写 `NULL`（而不是 `undefined` 或省略列），空串同样归一为 `NULL`。
 */
function writeParameters(record: Achievement): readonly unknown[] {
  const values: Record<keyof Achievement, unknown> = {
    id: record.id,
    userId: record.userId,
    type: record.type,
    title: record.title,
    awardLevel: optionalText(record.awardLevel ?? null) ?? null,
    description: optionalText(record.description ?? null) ?? null,
    achievedAt: optionalText(record.achievedAt ?? null) ?? null,
    evidenceFileId: optionalText(record.evidenceFileId ?? null) ?? null,
    reviewStatus: record.reviewStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return POSTGRES_ACHIEVEMENT_COLUMNS.map(
    (column) => values[POSTGRES_ACHIEVEMENT_COLUMN_FIELDS[column]],
  );
}

/**
 * 基于 `SqlExecutor` 的 PostgreSQL 成果仓储。
 *
 * 构造与每次调用都会重新校验执行器（`assertUsableExecutor`）与自身能力声明，
 * 因此「执行器被换掉 / 被降级」或「能力声明被改写」都会 fail-closed，而不是静默继续。
 * 本类**不是** Nest provider（不带任何 Nest 装饰器），也未在任何模块中注册。
 */
export class PostgresAchievementRepository implements AsyncAchievementRepository {
  readonly capabilities: AchievementRepositoryCapabilities =
    POSTGRES_ACHIEVEMENT_REPOSITORY_CAPABILITIES;

  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    assertPostgresAchievementRepositoryCapabilities(this.capabilities);
    this.executor = assertUsableExecutor(executor);
  }

  /** 每次调用前的自检：能力声明与执行器都必须仍然可用 */
  private usableExecutor(): SqlExecutor {
    assertPostgresAchievementRepositoryCapabilities(this.capabilities);
    return assertUsableExecutor(this.executor);
  }

  /**
   * 写入一条已由 service 校验并补齐归属 / 审核态 / 时间戳的记录。
   *
   * - `userId` 必须是服务端会话主体（非法 UUID / 空 UUID / 未登记字段一律拒绝）；
   * - 主键冲突（`ON CONFLICT DO NOTHING` 无返回行）显式抛 `CONFLICT`，与内存基线同语义，
   *   不静默覆盖；
   * - 返回行必须能通过严格行契约与读取契约，且**主键与归属**都必须等于请求写入的记录
   *   （数据库回流出「他人记录」或归属被改写时判服务端缺陷）。
   */
  async create(achievement: Achievement): Promise<Achievement> {
    const executor = this.usableExecutor();
    const writable = assertWritableRecord(achievement);

    const result = await executor.query(INSERT_SQL, writeParameters(writable));

    const rows = rowsOf(result);
    if (rows.length === 0) {
      // 主键冲突（ON CONFLICT DO NOTHING）属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new PostgresAchievementRepositoryError(
        'CONFLICT',
        '成果 ID 冲突：写入未返回任何行（主键已存在）',
        ['id'],
      );
    }
    if (rows.length > 1) {
      throw new PostgresAchievementRepositoryError(
        'RESULT_SET_VIOLATION',
        '写入语句返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const created = mapRow(rows[0]);
    if (created.id !== writable.id) {
      // 纵深防御：返回的必须是刚写入的那条记录（主键一致），否则可能是他人记录
      throw new PostgresAchievementRepositoryError(
        'IDENTITY_MISMATCH',
        '返回记录的主键与请求写入的主键不一致（他人记录不得作为写入结果回流）',
        ['id'],
      );
    }
    if (created.userId !== writable.userId) {
      // 纵深防御：归属被改写或返回了他人记录，属服务端缺陷，不得作为写入结果返回
      throw new PostgresAchievementRepositoryError(
        'OWNER_VIOLATION',
        '返回记录的归属与请求写入的归属不一致（他人归属不得回流）',
        ['user_id'],
      );
    }
    return created;
  }

  /**
   * 按服务端主体取数（列表）。
   *
   * - 主体必须落在存储 ID 域内，否则 `INVALID_SUBJECT`，且不访问数据库；
   * - 归属下推进 SQL（`WHERE user_id = $1`），他人记录不会出库；每条返回记录都会
   *   **逐条复核归属**：返回了他人记录即判服务端缺陷并 fail-closed，绝不把「别人的成果」
   *   当作本主体列表的一项交给上层（纵深防御）；
   * - 重复主键同样判结果集违约（避免同一记录在列表里出现两次而放大影响）；
   * - 无记录返回空数组（`[]`），不是 `undefined`，且不抛错；
   * - 不做任何本地截断：结果集大小由 SQL 决定（本切片端口没有分页窗口，见 `SELECT_BY_OWNER_SQL`）。
   */
  async listByUserId(userId: string): Promise<readonly Achievement[]> {
    const executor = this.usableExecutor();
    const ownerId = requireStorageUuid(
      userId,
      'INVALID_SUBJECT',
      '取数主体必须落在存储 ID 域内（合法且非空的 UUID）：非 UUID 的 userId 属于服务端缺陷，不得进入 SQL',
      'userId',
    );

    const result = await executor.query(SELECT_BY_OWNER_SQL, [ownerId]);

    const rows = rowsOf(result);
    const achievements = rows.map((row) => mapRow(row));

    const seen = new Set<string>();
    for (const achievement of achievements) {
      if (seen.has(achievement.id)) {
        throw new PostgresAchievementRepositoryError(
          'RESULT_SET_VIOLATION',
          '返回结果包含重复的成果 ID：结果集违反取数契约',
          ['id'],
        );
      }
      seen.add(achievement.id);
      if (achievement.userId !== ownerId) {
        throw new PostgresAchievementRepositoryError(
          'OWNER_VIOLATION',
          '返回了请求主体之外的成果（他人记录不得回流）',
          ['user_id'],
        );
      }
    }
    return achievements;
  }
}
