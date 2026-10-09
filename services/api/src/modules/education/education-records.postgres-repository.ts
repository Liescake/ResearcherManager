import { z } from 'zod';
import {
  EDUCATION_STATUS_VALUES,
  EDUCATION_TYPE_VALUES,
  REVIEW_STATUS_VALUES,
  uuidSchema,
  yearSchema,
} from '@rm/shared';
import type { SqlExecutor } from '../../db/ports/sql-executor.port';
import {
  parseStoredEducationRecord,
  storedEducationRecordSchema,
} from './education-records.contract';
import {
  EDUCATION_RECORD_REPOSITORY_BACKEND_POSTGRES,
  type EducationRecord,
  type EducationRecordRepository,
  type EducationRecordRepositoryCapabilities,
} from './education-records.port';

/**
 * 升学记录的 **PostgreSQL 仓储 adapter（已接入运行时换绑点）**。
 *
 * ## 交付边界
 * - **换绑点只有一个**：`education.module.ts` 的 `createEducationRecordRepository`——
 *   未配置 `DATABASE_URL` 时绑定内存基线，配置时经 `createLazyPostgresEducationRecordRepository`
 *   延迟建连，配置了数据库却拿不到执行器工厂则**抛错**（绝不静默退回内存存储）；
 * - **不引入** `pg` / Prisma / TypeORM 等驱动或 ORM 依赖：本文件只依赖驱动无关的
 *   `SqlExecutor` 端口（`db/ports/sql-executor.port.ts`），真实执行器由消费方（`db/postgres/`
 *   驱动层）显式提供；
 * - **不声称生产可用**：能力声明固定为 `backend = postgres`、`persistent = true`、
 *   `productionReady = false`，因此生产启动仍会被 `PersistenceBoundaryService` 拒绝
 *   （`productionReady !== true` 即违规），直到完成 attest 与集成验证并显式改声明。
 *
 * ## 端口契约
 * 端口 `EducationRecordRepository`（`education-records.port.ts`）是**异步**的，内存基线与本 adapter
 * 实现同一份契约，因此 service 的取数调用一律 `await`，「未授权就碰仓储」不会因同步返回而被掩盖。
 *
 * ## 安全边界（本文件的四条硬约束）
 * 1. **参数化 SQL + 固定标识符**：所有客户端可控的值一律走 `$1…$n` 占位符绑定；进入 SQL 文本的
 *    只有模块常量（表名、列清单），且都经过 `assertSqlIdentifier` 校验，
 *    不存在任何「值 → SQL 文本」的路径（占位符与参数由同一份列清单派生，不会数量漂移）；
 * 2. **显式字段映射 + 严格行契约**：数据库行必须满足严格（`.strict()`）的行契约（未知列、
 *    非法枚举、非数组、坏时间戳一律拒绝），再**逐字段显式映射**为领域记录（列 → 字段的对应
 *    关系由 `POSTGRES_EDUCATION_RECORD_COLUMN_FIELDS` 单一事实来源给出，并由
 *    `Record<keyof EducationRecord, …>` 在编译期强制完整），最后再过一次
 *    `education-records.contract.ts` 的读取契约；任何一步不合规都 **fail-closed** 抛错，
 *    绝不把未登记字段、未知状态或半成品记录交给上层；
 * 3. **subject / 归属隔离**：`userId` 必须由调用方（service）从服务端会话主体写入，必须是合法、
 *    非空、规范小写形的 UUID（**存储 ID 域约束**，见 `education-records.port.ts`）；adapter
 *    不生成、不覆盖归属，并且**把归属下推进 SQL**：单条读取只返回「资源 ID 与归属同时命中」的
 *    记录，列表取数只返回请求主体的记录；返回行上再做一次归属复核（不一致即
 *    `OWNER_VIOLATION`）——他人记录既不出库、也不得回流。资源 ID 同样受存储 ID 域约束：
 *    写路径在**进入 SQL 之前**就校验 `id`，否则非规范形 ID 会在已经落库之后被规范形回读判成
 *    `IDENTITY_MISMATCH`（调用方看到失败、库里却留下一条记录）；
 * 4. **公开视图不携带归属与个人级内容**：adapter 只在**内部存储记录**上承载 `userId`
 *    （不静默丢弃归属），对外裁剪由 `education-records.contract.ts` 的
 *    `toEducationRecordView` 负责（`POSTGRES_EDUCATION_RECORD_VIEW_EXCLUDED_COLUMNS` 给出本
 *    adapter 侧不进入公开输出的列清单）；错误消息**只带字段路径与违规类型**，
 *    绝不带回归属标识或「院校或去向」原文，避免把数据内容或注入载荷写进日志与错误响应。
 *
 * ## 前置与验证状态（因此 productionReady 恒为 false）
 * `education_records` 已由迁移 `db/migrations/0002_education_records.sql` 建立（列清单与
 * `user_id` 索引都在其中），本 adapter 复用该迁移、**不新增 schema**。仍未完成的是
 * 「驱动 attest + 真实 PostgreSQL 集成验证 + 会话主体标识收敛为 UUID」，因此
 * `productionReady` 保持 `false`：生产环境只要绑定到本 adapter，启动期持久化边界守卫
 * 就会以 `BACKEND_NOT_PRODUCTION_READY_IN_PRODUCTION` 拒绝。这些前置登记在
 * `POSTGRES_EDUCATION_RECORD_REPOSITORY_VERIFICATION_STEPS` 里，不能只写声明。
 */

/** 表名：与 docs/P1-字段级数据字典.md 的 `education_records` 一致 */
export const POSTGRES_EDUCATION_RECORD_TABLE = 'education_records';

/**
 * 列清单：同时定义 `SELECT` 输出列、`INSERT` 列顺序与 `RETURNING` 输出列。
 *
 * 刻意不写 `SELECT *`：存储层新增列（软删除时间、审核人、更正留痕、审计字段）不会因为本文件
 * 没更新就自动流进领域对象；配合行契约的 `.strict()`，未登记列会被显式拒绝而不是被静默带出。
 *
 * 注意：字段字典里的 `deleted_at` / 审核留痕（审核人、理由、改前改后值）**不在本清单内**——
 * 它们属于后续「状态流转与审核（`education:review`）」「管理员代改留痕」切片，
 * 本 adapter 既不读写它们，也不用它们做过滤，因此未来迁移新增这些列不会改变本 adapter 的行为。
 */
export const POSTGRES_EDUCATION_RECORD_COLUMNS = [
  'id',
  'user_id',
  'year',
  'type',
  'status',
  'institution_or_destination',
  'review_status',
  'created_at',
  'updated_at',
] as const;

/** 列 → 领域字段的唯一事实来源（编译期强制覆盖 `EducationRecord` 的全部字段） */
export const POSTGRES_EDUCATION_RECORD_COLUMN_FIELDS = Object.freeze({
  id: 'id',
  user_id: 'userId',
  year: 'year',
  type: 'type',
  status: 'status',
  institution_or_destination: 'institutionOrDestination',
  review_status: 'reviewStatus',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
} as const satisfies Record<
  (typeof POSTGRES_EDUCATION_RECORD_COLUMNS)[number],
  keyof EducationRecord
>);

/**
 * 归属列：只在服务端内部流转。
 * 它**不进入**公开视图，也绝不进入错误消息与日志（他人归属不得回流、也不得外泄）。
 */
export const POSTGRES_EDUCATION_RECORD_OWNER_COLUMNS: readonly (typeof POSTGRES_EDUCATION_RECORD_COLUMNS)[number][] =
  Object.freeze(['user_id']);

/**
 * 个人级内容列（字段字典敏感级别「个人」）：`institution_or_destination` 是自读视图的合法内容，
 * 因此**不做对外裁剪**，但它是用户可自由填写的文本，**绝不**写进错误消息与日志。
 */
export const POSTGRES_EDUCATION_RECORD_PERSONAL_COLUMNS: readonly (typeof POSTGRES_EDUCATION_RECORD_COLUMNS)[number][] =
  Object.freeze(['institution_or_destination']);

/**
 * 本 adapter 侧**不进入公开输出**的列：归属（`user_id`）。
 *
 * 对外裁剪由 `toEducationRecordView` 负责（逐字段显式赋值、不展开），本清单用于机器校验
 * 「adapter 不把归属投影出去」，与「自读范围下响应里没有可回传的归属信息」这一契约一致。
 */
export const POSTGRES_EDUCATION_RECORD_VIEW_EXCLUDED_COLUMNS: readonly (typeof POSTGRES_EDUCATION_RECORD_COLUMNS)[number][] =
  Object.freeze(['user_id']);

/** 仓储能力：持久但**未验证**，因此生产环境仍会被持久化边界守卫拦下 */
export const POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES: EducationRecordRepositoryCapabilities =
  Object.freeze({
    backend: EDUCATION_RECORD_REPOSITORY_BACKEND_POSTGRES,
    persistent: true,
    productionReady: false,
  });

/**
 * 转成生产可用前必须完成的验证清单（每一项都需要证据，不能只写声明）：
 * 1. 驱动依赖经评估后引入（`docs/P2-开源复用评估.md` 的 Prisma / TypeORM 比较结论）；
 * 2. 对真实 PostgreSQL 的集成测试：建表迁移、`id` 主键冲突、按 `user_id` 取数与排序；
 * 3. `education_records` 的 schema 草案创建并按 `db/migrations/README.md` 转为迁移并执行验证
 *    —— **已完成**：迁移 `db/migrations/0002_education_records.sql` 建立该表；
 * 4. `EducationRecordRepository` 端口改为异步：service / controller 与其测试一起改，
 *    单条读取必须传入服务端解析出的归属（本契约的 `findById(recordId, ownerUserId)`）
 *    —— **已完成**：端口已收敛为异步唯一契约；
 * 5. 会话主体 `userId` 收敛为 UUID（当前基线是 `u-student-1` 这类安全 ID，不满足存储 ID 域）
 *    —— **未完成**，因此绑定到数据库实现时非 UUID 会话主体会被 fail-closed 拒绝；
 * 6. 完成 1 / 2 / 5 后，才允许把 `productionReady` 改为 true，并同步删除能力自检
 *    （`assertPostgresEducationRecordRepositoryCapabilities` 会拒绝「未验证就声称生产可用」）。
 */
export const POSTGRES_EDUCATION_RECORD_REPOSITORY_VERIFICATION_STEPS = [
  'driver-dependency-evaluated',
  'integration-tests-against-real-postgres',
  'education-records-schema-draft-created-and-promoted-to-migration',
  'education-record-repository-port-migrated-to-async',
  'session-subject-user-ids-converged-to-uuid',
  'production-ready-capability-flipped-with-evidence',
] as const;

export type PostgresEducationRecordRepositoryErrorCode =
  | 'CAPABILITY_MISDECLARED'
  | 'INVALID_CONFIGURATION'
  | 'EXECUTOR_UNAVAILABLE'
  | 'EXECUTOR_NOT_POSTGRES'
  | 'EXECUTOR_NOT_PERSISTENT'
  | 'INVALID_SUBJECT'
  | 'INVALID_RECORD_ID'
  | 'INVALID_RECORD'
  | 'INVALID_ROW'
  | 'RESULT_SET_VIOLATION'
  | 'CONFLICT'
  | 'IDENTITY_MISMATCH'
  | 'OWNER_VIOLATION';

/**
 * adapter 的 fail-closed 错误。
 *
 * `issues` 只承载**字段路径与违规类型**（例如 `user_id`、`year(too_small)`、
 * `institution_or_destination(too_big)`），不承载字段取值，
 * 避免把归属标识、院校或去向原文、注入载荷或连接信息写进日志与错误响应。
 */
export class PostgresEducationRecordRepositoryError extends Error {
  readonly code: PostgresEducationRecordRepositoryErrorCode;
  readonly issues: readonly string[];

  constructor(
    code: PostgresEducationRecordRepositoryErrorCode,
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PostgresEducationRecordRepositoryError';
    this.code = code;
    this.issues = [...issues];
  }
}

/**
 * 能力自检：**未验证的实现不得声称生产可用**。
 *
 * 任何环境都会执行（能力声明缺失属于代码缺陷，不能等生产才暴露）。
 * 生产可用性的提升必须与 `POSTGRES_EDUCATION_RECORD_REPOSITORY_VERIFICATION_STEPS` 的证据、
 * 以及本断言的同步修改一起发生。
 */
export function assertPostgresEducationRecordRepositoryCapabilities(
  capabilities: EducationRecordRepositoryCapabilities = POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES,
): void {
  const issues: string[] = [];
  if (capabilities.backend !== EDUCATION_RECORD_REPOSITORY_BACKEND_POSTGRES) {
    issues.push('backend');
  }
  if (capabilities.persistent !== true) {
    issues.push('persistent');
  }
  if (capabilities.productionReady !== false) {
    issues.push('productionReady');
  }
  if (issues.length > 0) {
    throw new PostgresEducationRecordRepositoryError(
      'CAPABILITY_MISDECLARED',
      `PostgreSQL 升学记录仓储能力声明不符（backend 必须是 ${EDUCATION_RECORD_REPOSITORY_BACKEND_POSTGRES}、persistent=true、productionReady=false）：未完成驱动集成验证前不得声称生产可用`,
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
    throw new PostgresEducationRecordRepositoryError(
      'INVALID_CONFIGURATION',
      `SQL 标识符不合规（必须是裸小写标识符）：${label}`,
      [label],
    );
  }
  return value;
}

/** 模块加载即校验：表名与列名一旦被改成非标识符形状，直接 fail-closed（不静默拼进 SQL） */
const TABLE_IDENTIFIER = assertSqlIdentifier(POSTGRES_EDUCATION_RECORD_TABLE, 'table');
const COLUMN_LIST = POSTGRES_EDUCATION_RECORD_COLUMNS.map((column) =>
  assertSqlIdentifier(column, 'column'),
).join(', ');

/** 逐列的类型转换：只在「列 → 参数占位」这一步使用，值本身永远不进入 SQL 文本 */
const COLUMN_PARAMETER_CASTS: Partial<
  Record<(typeof POSTGRES_EDUCATION_RECORD_COLUMNS)[number], string>
> = {
  id: '::uuid',
  user_id: '::uuid',
  year: '::smallint',
  created_at: '::timestamptz',
  updated_at: '::timestamptz',
};

/** `VALUES ($1::uuid, $2::uuid, …)`：占位符与列一一对应，由列清单派生，不会出现数量漂移 */
const INSERT_VALUES = POSTGRES_EDUCATION_RECORD_COLUMNS.map(
  (column, index) => `$${index + 1}${COLUMN_PARAMETER_CASTS[column] ?? ''}`,
).join(', ');

/**
 * 写入语句：客户端可控值全部走 `$n`；`ON CONFLICT (id) DO NOTHING` 让**主键冲突显式暴露**
 * （与内存基线 `create` 抛「升学记录 ID 冲突」同语义：入库记录 ID 由服务端生成，
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
 * 单条取数语句：**资源 ID 与归属同时命中**才返回（归属下推进 SQL，他人记录不出库）。
 * 两个参数都走 `$n::uuid` 绑定；显式列清单，不使用 `SELECT *`。
 */
const SELECT_BY_ID_FOR_OWNER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
 WHERE id = $1::uuid AND user_id = $2::uuid`;

/**
 * 按主体取数语句：主体走 `$1::uuid` 绑定；显式列清单，不使用 `SELECT *`。
 * 排序固定为 `created_at ASC, id ASC`：与内存基线的插入顺序一致（service 在 append 时写入
 * `createdAt = now`），并给出逐页稳定、可复现的顺序，避免数据库返回顺序漂移。
 */
const SELECT_BY_OWNER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
 WHERE user_id = $1::uuid
 ORDER BY created_at ASC, id ASC`;

/**
 * 数据库行契约（**严格**）。
 *
 * `.strict()` 是「字段污染」防线：数据库返回的未登记列（`deleted_at`、`reviewer_user_id`、
 * `before_value`、`internal_note`…）会让解析失败，而不是被静默丢弃或带进领域对象。
 * 列缺失同样失败（PG 对 SELECT 列表中存在的列一定返回键，缺键说明驱动或 SQL 已被改动）。
 *
 * 枚举闭集与列上的长度约束在这里先拦一道；**内容安全**（控制字符等）与时间格式的最终判定
 * 交给 `education-records.contract.ts`（映射后用 `parseStoredEducationRecord` 复核）。
 */
const postgresEducationRecordRowSchema = z
  .object({
    id: uuidSchema,
    user_id: uuidSchema,
    year: yearSchema,
    type: z.enum(EDUCATION_TYPE_VALUES),
    status: z.enum(EDUCATION_STATUS_VALUES),
    institution_or_destination: z.string().max(200).nullable(),
    review_status: z.enum(REVIEW_STATUS_VALUES),
    created_at: z.union([z.date(), z.string()]),
    updated_at: z.union([z.date(), z.string()]),
  })
  .strict();

/** 写入记录契约：读取契约的严格版本（调用方不得通过领域对象夹带未登记字段） */
const strictWritableEducationRecordSchema = storedEducationRecordSchema.strict();

/** 只保留字段路径与违规类型，绝不含字段取值（归属与院校原文不进错误消息） */
function describeIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}(${issue.code})`);
}

function invalidRow(error: z.ZodError, label = 'row'): PostgresEducationRecordRepositoryError {
  return new PostgresEducationRecordRepositoryError(
    'INVALID_ROW',
    `数据库行不符合 postgres 行契约（${label}）`,
    describeIssues(error),
  );
}

/** 时间列 → ISO 字符串；坏时间戳 fail-closed（不产生 `Invalid Date` 之类的半成品） */
function toIsoTimestamp(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PostgresEducationRecordRepositoryError(
      'INVALID_ROW',
      `时间列不是合法时间戳：${label}`,
      [label],
    );
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
 * 顺序刻意如此：先按严格行契约解析（拒绝未登记列 / 未知枚举 / 坏时间戳 / 坏形状），
 * 再显式取字段构造新对象（即使行里有额外内容也不会被带出），最后用
 * `parseStoredEducationRecord` 复核共享读取契约（枚举闭集 + ISO 时间 + 内容安全），
 * 任一环节不合规都抛错。
 */
function mapRow(row: unknown): EducationRecord {
  const parsedRow = postgresEducationRecordRowSchema.safeParse(row);
  if (!parsedRow.success) {
    throw invalidRow(parsedRow.error);
  }
  const dbRow = parsedRow.data;

  const institutionOrDestination = optionalText(dbRow.institution_or_destination);

  const record = {
    id: dbRow.id,
    // 归属：adapter 只承载，不生成、不覆盖；对外由 toEducationRecordView 裁剪
    userId: dbRow.user_id,
    year: dbRow.year,
    type: dbRow.type,
    status: dbRow.status,
    ...(institutionOrDestination ? { institutionOrDestination } : {}),
    reviewStatus: dbRow.review_status,
    createdAt: toIsoTimestamp(dbRow.created_at, 'created_at'),
    updatedAt: toIsoTimestamp(dbRow.updated_at, 'updated_at'),
  };

  const parsedRecord = parseStoredEducationRecord(record);
  if (!parsedRecord.ok) {
    throw new PostgresEducationRecordRepositoryError(
      'INVALID_ROW',
      '数据库行映射后不符合升学记录读取契约',
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
    throw new PostgresEducationRecordRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      '未提供 SQL 执行器：PostgreSQL 升学记录仓储拒绝在半可用状态下构造或调用',
      ['executor'],
    );
  }
  const candidate = executor as { query?: unknown; capabilities?: unknown };
  if (typeof candidate.query !== 'function') {
    throw new PostgresEducationRecordRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器缺少 query 方法：PostgreSQL 升学记录仓储拒绝在半可用状态下构造或调用',
      ['executor.query'],
    );
  }
  const capabilities = candidate.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new PostgresEducationRecordRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器未声明能力（backend/persistent/productionReady）',
      ['executor.capabilities'],
    );
  }
  const { backend, persistent } = capabilities as { backend?: unknown; persistent?: unknown };
  if (typeof backend !== 'string' || backend.trim() === '') {
    throw new PostgresEducationRecordRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器的能力声明缺少 backend 标识',
      ['executor.capabilities.backend'],
    );
  }
  if (!/^postgres/iu.test(backend.trim())) {
    throw new PostgresEducationRecordRepositoryError(
      'EXECUTOR_NOT_POSTGRES',
      'SQL 执行器声明的后端不是 PostgreSQL：拒绝把本 adapter 挂到其他存储上',
      ['executor.capabilities.backend'],
    );
  }
  if (persistent !== true) {
    throw new PostgresEducationRecordRepositoryError(
      'EXECUTOR_NOT_PERSISTENT',
      'SQL 执行器声明为非持久后端（内存替身）：PostgreSQL 升学记录仓储拒绝在其上运行',
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
  code: PostgresEducationRecordRepositoryErrorCode,
  message: string,
  label: string,
): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success || parsed.data === NIL_UUID || parsed.data !== parsed.data.toLowerCase()) {
    throw new PostgresEducationRecordRepositoryError(code, message, [label]);
  }
  return parsed.data;
}

/**
 * 写入记录校验：读取契约的严格版本 + **资源 ID 与归属**都必须落在存储 ID 域内
 * （合法、非空、规范小写形的 UUID）。
 *
 * 为什么连 `id` 也要在这里判定：写入路径是「先落库、再由 `RETURNING` 复核主键」，
 * 非规范形（大小写不是规范小写形）或空 UUID 的 ID 会让数据库规范化后的回读值与请求值
 * 不一致，从而在**已经写库之后**被判成 `IDENTITY_MISMATCH`——调用方看到失败，库里却留下了
 * 一条记录。把「ID 也在存储 ID 域内」放在**进入 SQL 之前**判定，违规就在无副作用的情况下
 * fail-closed（`INVALID_RECORD`），且错误信息不回显该 ID。
 */
function assertWritableRecord(record: unknown): EducationRecord {
  const parsed = strictWritableEducationRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new PostgresEducationRecordRepositoryError(
      'INVALID_RECORD',
      '待写入的升学记录不符合读取契约的严格版本（含未登记字段或非法取值）',
      describeIssues(parsed.error),
    );
  }
  requireStorageUuid(
    parsed.data.id,
    'INVALID_RECORD',
    '待写入的升学记录缺少有效资源 ID（ID 必须由服务端生成，且是规范小写形的非空 UUID）',
    'id',
  );
  requireStorageUuid(
    parsed.data.userId,
    'INVALID_RECORD',
    '待写入的升学记录缺少有效归属（归属必须由服务端会话主体写入，且落在存储 ID 域内）',
    'userId',
  );
  return parsed.data;
}

/**
 * 结果集形状 fail-closed：执行器必须返回对象且带 `rows` 数组。
 * 「少字段 / 类型不对」属于驱动或替身实现缺陷，不得被当成「空结果」静默放过
 * （否则会把基础设施故障伪装成「该主体尚无升学记录」）。
 */
function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new PostgresEducationRecordRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果不是对象（驱动 / 替身实现缺陷）',
      ['result'],
    );
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new PostgresEducationRecordRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果缺少 rows 数组（驱动 / 替身实现缺陷）',
      ['rows'],
    );
  }
  return rows;
}

/**
 * 写入参数：**由列清单派生**（列 → 字段 → 值），因此参数顺序永远与 SQL 占位符一致；
 * `Record<keyof EducationRecord, unknown>` 让「新增领域字段但忘记补参数」成为编译错误。
 * 缺失的可选字段写 `NULL`（而不是 `undefined` 或省略列），空串同样归一为 `NULL`。
 */
function writeParameters(record: EducationRecord): readonly unknown[] {
  const values: Record<keyof EducationRecord, unknown> = {
    id: record.id,
    userId: record.userId,
    year: record.year,
    type: record.type,
    status: record.status,
    institutionOrDestination: optionalText(record.institutionOrDestination ?? null) ?? null,
    reviewStatus: record.reviewStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return POSTGRES_EDUCATION_RECORD_COLUMNS.map(
    (column) => values[POSTGRES_EDUCATION_RECORD_COLUMN_FIELDS[column]],
  );
}

/**
 * 基于 `SqlExecutor` 的 PostgreSQL 升学记录仓储。
 *
 * 构造与每次调用都会重新校验执行器（`assertUsableExecutor`）与自身能力声明，
 * 因此「执行器被换掉 / 被降级」或「能力声明被改写」都会 fail-closed，而不是静默继续。
 * 本类**不是** Nest provider（不带任何 Nest 装饰器）：模块经 `createLazyPostgresEducationRecordRepository`
 * 取用，装配期不建连。
 */
export class PostgresEducationRecordRepository implements EducationRecordRepository {
  readonly capabilities: EducationRecordRepositoryCapabilities =
    POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES;

  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    assertPostgresEducationRecordRepositoryCapabilities(this.capabilities);
    this.executor = assertUsableExecutor(executor);
  }

  /** 每次调用前的自检：能力声明与执行器都必须仍然可用 */
  private usableExecutor(): SqlExecutor {
    assertPostgresEducationRecordRepositoryCapabilities(this.capabilities);
    return assertUsableExecutor(this.executor);
  }

  /**
   * 写入一条已由 service 校验并补齐归属 / 审核态 / 时间戳的记录。
   *
   * - `userId` 必须是服务端会话主体，`id` 必须落在存储 ID 域内（非规范形 / 空 UUID / 未登记
   *   字段一律在进入 SQL 之前拒绝，因此拒绝不会留下任何已写入的行）；
   * - 主键冲突（`ON CONFLICT DO NOTHING` 无返回行）显式抛 `CONFLICT`，与内存基线同语义，
   *   不静默覆盖；
   * - 返回行必须能通过严格行契约与读取契约，且**主键与归属**都必须等于请求写入的记录
   *   （数据库回流出「他人记录」或归属被改写时判服务端缺陷）。
   */
  async create(record: EducationRecord): Promise<EducationRecord> {
    const executor = this.usableExecutor();
    const writable = assertWritableRecord(record);

    const result = await executor.query(INSERT_SQL, writeParameters(writable));

    const rows = rowsOf(result);
    if (rows.length === 0) {
      // 主键冲突（ON CONFLICT DO NOTHING）属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new PostgresEducationRecordRepositoryError(
        'CONFLICT',
        '升学记录 ID 冲突：写入未返回任何行（主键已存在）',
        ['id'],
      );
    }
    if (rows.length > 1) {
      throw new PostgresEducationRecordRepositoryError(
        'RESULT_SET_VIOLATION',
        '写入语句返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const created = mapRow(rows[0]);
    if (created.id !== writable.id) {
      // 纵深防御：返回的必须是刚写入的那条记录（主键一致），否则可能是他人记录
      throw new PostgresEducationRecordRepositoryError(
        'IDENTITY_MISMATCH',
        '返回记录的主键与请求写入的主键不一致（他人记录不得作为写入结果回流）',
        ['id'],
      );
    }
    if (created.userId !== writable.userId) {
      // 纵深防御：归属被改写或返回了他人记录，属服务端缺陷，不得作为写入结果返回
      throw new PostgresEducationRecordRepositoryError(
        'OWNER_VIOLATION',
        '返回记录的归属与请求写入的归属不一致（他人归属不得回流）',
        ['user_id'],
      );
    }
    return created;
  }

  /**
   * 按「资源 ID + 服务端主体归属」取单条记录。
   *
   * - 两个标识都必须落在存储 ID 域内（UUID，规范小写形），否则 `INVALID_RECORD_ID` /
   *   `INVALID_SUBJECT`，且**不访问数据库**；
   * - 归属下推进 SQL：他人记录不会出库；未命中（不存在、或存在但不属于该主体）统一返回
   *   `undefined`——调用方据此判 404，**不区分**「不存在」与「不是你的」，
   *   避免用存在性探测他人资源；
   * - 返回行必须通过严格行契约与读取契约，且**归属与主键**都必须等于请求的取值
   *   （数据库回流出「他人记录」或 SQL 被改动时判服务端缺陷）；
   * - 主键不唯一导致返回多行 → 结果集违约，fail-closed。
   */
  async findById(recordId: string, ownerUserId: string): Promise<EducationRecord | undefined> {
    const executor = this.usableExecutor();
    const id = requireStorageUuid(
      recordId,
      'INVALID_RECORD_ID',
      '记录 ID 必须落在存储 ID 域内（合法且非空的 UUID）：非 UUID 的资源标识属于服务端缺陷，不得进入 SQL',
      'recordId',
    );
    const ownerId = requireStorageUuid(
      ownerUserId,
      'INVALID_SUBJECT',
      '取数主体必须落在存储 ID 域内（合法且非空的 UUID）：非 UUID 的 userId 属于服务端缺陷，不得进入 SQL',
      'userId',
    );

    const result = await executor.query(SELECT_BY_ID_FOR_OWNER_SQL, [id, ownerId]);

    const rows = rowsOf(result);
    if (rows.length === 0) {
      return undefined;
    }
    if (rows.length > 1) {
      throw new PostgresEducationRecordRepositoryError(
        'RESULT_SET_VIOLATION',
        '按资源 ID 取数返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const found = mapRow(rows[0]);
    if (found.id !== id) {
      throw new PostgresEducationRecordRepositoryError(
        'IDENTITY_MISMATCH',
        '返回记录的主键与请求的资源标识不一致（SQL 或数据库视图已被改动）',
        ['id'],
      );
    }
    if (found.userId !== ownerId) {
      // 纵深防御：归属下推之外再复核一次，他人记录不得回流
      throw new PostgresEducationRecordRepositoryError(
        'OWNER_VIOLATION',
        '返回记录的归属与请求取数的主体不一致（他人升学记录不得回流）',
        ['user_id'],
      );
    }
    return found;
  }

  /**
   * 按服务端主体取数（列表）。
   *
   * - 主体必须落在存储 ID 域内，否则 `INVALID_SUBJECT`，且不访问数据库；
   * - 每条返回记录都会**逐条复核归属**：返回了他人记录即判服务端缺陷并 fail-closed，
   *   绝不把「别人的升学记录」当作本主体列表的一项交给上层（纵深防御）；
   * - 重复主键同样判结果集违约（避免同一记录在列表里出现两次而放大影响）；
   * - 无记录返回空数组（`[]`），不是 `undefined`，且不抛错。
   */
  async listByUserId(userId: string): Promise<readonly EducationRecord[]> {
    const executor = this.usableExecutor();
    const ownerId = requireStorageUuid(
      userId,
      'INVALID_SUBJECT',
      '取数主体必须落在存储 ID 域内（合法且非空的 UUID）：非 UUID 的 userId 属于服务端缺陷，不得进入 SQL',
      'userId',
    );

    const result = await executor.query(SELECT_BY_OWNER_SQL, [ownerId]);

    const rows = rowsOf(result);
    const records = rows.map((row) => mapRow(row));

    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id)) {
        throw new PostgresEducationRecordRepositoryError(
          'RESULT_SET_VIOLATION',
          '返回结果包含重复的升学记录 ID：结果集违反取数契约',
          ['id'],
        );
      }
      seen.add(record.id);
      if (record.userId !== ownerId) {
        throw new PostgresEducationRecordRepositoryError(
          'OWNER_VIOLATION',
          '返回了请求主体之外的升学记录（他人记录不得回流）',
          ['user_id'],
        );
      }
    }
    return records;
  }
}

/** 存储 ID 域内的**服务端主体**断言（供换绑分流点与测试复用，语义与 adapter 内的判定完全一致） */
export function assertPostgresEducationRecordSubject(userId: unknown): string {
  return requireStorageUuid(
    userId,
    'INVALID_SUBJECT',
    '取数主体必须落在存储 ID 域内（合法且非空的 UUID）：非 UUID 的 userId 属于服务端缺陷，不得进入 SQL',
    'userId',
  );
}

/**
 * 存储 ID 域内的**待写入记录**断言（严格记录契约 + 资源 ID 与归属都在域内）。
 *
 * 与 adapter 的 `create` 路径复用同一个判定：因此「延迟建连」的换绑点可以在**不建连**的前提下
 * 先拒绝非法写入，错误码与直接调用 adapter 逐字一致（`INVALID_RECORD`）。
 */
export function assertPostgresEducationRecordWritableRecord(record: unknown): EducationRecord {
  return assertWritableRecord(record);
}

/**
 * 延迟建连的升学记录仓储：**模块装配阶段不碰数据库**。
 *
 * 为什么必须延迟：`SQL_CONNECTION_FACTORY.connect()` 在数据库已配置但执行器未通过 attest 契约时
 * 会抛错。如果在这里急切建连，启动失败会表现为「模块工厂抛了数据库错」，而不是启动期持久化边界
 * 与依赖就绪门禁给出的**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED` /
 * `EDUCATION_RECORD_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`）。延迟后判定顺序保持为
 * 「配置 → 持久化边界 / 依赖就绪 → 首次真正读写库」。
 *
 * 连接只在首次读写时建立并被复用；建立失败不缓存失败结果（下一次调用会重试）。
 * 存储 ID 域**先判、再建连**：非 UUID 的资源 ID / 主体 / 待写记录都不会触发任何数据库连接，
 * 且错误码与直接调用 adapter 完全一致（读 `INVALID_RECORD_ID` / `INVALID_SUBJECT`、
 * 写 `INVALID_RECORD`）。
 */
export function createLazyPostgresEducationRecordRepository(
  resolveExecutor: () => Promise<SqlExecutor>,
  capabilities: EducationRecordRepositoryCapabilities = POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES,
): EducationRecordRepository {
  assertPostgresEducationRecordRepositoryCapabilities(capabilities);

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
    async create(record: EducationRecord): Promise<EducationRecord> {
      // 严格记录契约（含资源 ID 与归属的存储 ID 域）先判、再建连：非法写入不触发任何数据库连接
      const writable = assertPostgresEducationRecordWritableRecord(record);
      const resolved = await executor();
      return new PostgresEducationRecordRepository(resolved).create(writable);
    },
    async findById(recordId: string, ownerUserId: string): Promise<EducationRecord | undefined> {
      // 两个标识都在进 SQL 之前判定，因此非法取值同样不会触发任何数据库连接
      const id = requireStorageUuid(
        recordId,
        'INVALID_RECORD_ID',
        '记录 ID 必须落在存储 ID 域内（合法且非空的 UUID）：非 UUID 的资源标识属于服务端缺陷，不得进入 SQL',
        'recordId',
      );
      const ownerId = assertPostgresEducationRecordSubject(ownerUserId);
      const resolved = await executor();
      return new PostgresEducationRecordRepository(resolved).findById(id, ownerId);
    },
    async listByUserId(userId: string): Promise<readonly EducationRecord[]> {
      const ownerId = assertPostgresEducationRecordSubject(userId);
      const resolved = await executor();
      return new PostgresEducationRecordRepository(resolved).listByUserId(ownerId);
    },
  };
}
