import { z } from 'zod';
import {
  GRADE_VALUES,
  PROGRAMMING_LEVEL_VALUES,
  availableTimeSchema,
  trimmedText,
  uuidSchema,
} from '@rm/shared';
import type { SqlExecutor } from '../../db/ports/sql-executor.port';
import { parseStoredStudentProfile, storedStudentProfileSchema } from './student-profile.contract';
import {
  PROFILE_REPOSITORY_BACKEND_POSTGRES,
  type AsyncProfileRepository,
  type ProfileRepository,
  type ProfileRepositoryCapabilities,
  type StudentProfile,
  type StoredAvailableTime,
  type StoredPrivacyConsent,
} from './student-profile.port';

/**
 * 学生画像的 **PostgreSQL 仓储 adapter**（`DATABASE_URL` 已配置时的运行时实现）。
 *
 * ## 交付边界
 * - **绑定点只有一个**：`profiles.module.ts` 的 `createProfileRepository()` 按「是否配置数据库」
 *   分流 —— 未配置时内存基线，配置时本文件的 `createLazyPostgresStudentProfileRepository`
 *   （延迟建连）；配置了数据库却拿不到 `SQL_CONNECTION_FACTORY` 时**抛错**，绝不静默退回内存。
 *   本文件本身不带 Nest 装饰器：装配只发生在 Module 的工厂里；
 * - **不引入** `pg` / Prisma / TypeORM 等驱动或 ORM 依赖：本文件只依赖驱动无关的
 *   `SqlExecutor` 端口（`db/ports/sql-executor.port.ts`），驱动只允许出现在 `db/postgres/`；
 * - **不声称生产可用**：能力声明固定为 `backend = postgres`、`persistent = true`、
 *   `productionReady = false`。在解决下方「PII 落地形态」、把会话主体标识收敛为 UUID
 *   并补齐验证证据之前，启动期依赖就绪门禁会把「数据库已配置」的装配判为
 *   `PROFILE_REPOSITORY[DEPENDENCY_NOT_VERIFIED]` 并 fail-closed（`productionReady !== true` 即违规）。
 *
 * ## 安全边界（本文件的四条硬约束）
 * 1. **参数化 SQL**：所有客户端可控的值一律走 `$1…$n` 占位符绑定；进入 SQL 文本的只有模块
 *    常量（表名、列清单），且都经过 `assertSqlIdentifier` 校验，不存在任何
 *    「值 → SQL 文本」的路径；
 * 2. **显式字段映射 + 严格行契约**：数据库行必须满足严格（`.strict()`）的行契约（未知列、
 *    未知 JSON 键、非法枚举、非数组、坏时间戳一律拒绝），再**逐字段显式映射**为领域记录
 *    （列→字段的对应关系由 `POSTGRES_STUDENT_PROFILE_COLUMN_FIELDS` 单一事实来源给出，
 *    并由 `Record<keyof StudentProfile, …>` 在编译期强制完整），最后再过一次
 *    `student-profile.contract.ts` 的读取契约；任何一步不合规都 **fail-closed** 抛错，
 *    绝不把未登记字段、未知状态或半成品记录交给上层；
 * 3. **subject / 归属边界**：`userId` 必须由调用方（service）从服务端会话主体写入，必须是
 *    合法且非空的 UUID（**存储 ID 域约束**，见 `student-profile.port.ts`）；adapter 不生成、
 *    不覆盖归属，并在返回行上复核「返回记录的归属 === 请求取数/写入的归属」，不一致即判
 *    服务端缺陷（`OWNER_VIOLATION`）——他人归属不得回流。`createdAt` 是服务端生命周期字段，
 *    同样复核（`LIFECYCLE_MISMATCH`）；
 * 4. **PII 只按内部存储契约流转**：`studentNo` / `phone` 是高敏感字段，本 adapter 在存储记录上
 *    原样承载（不静默丢弃），但**不把它们写进错误消息**（错误只带字段路径与违规类型），也不做
 *    任何对外投影——对外裁剪属于 `student-profile.contract.ts` 的 `toStudentProfileView`
 *    （`POSTGRES_STUDENT_PROFILE_VIEW_EXCLUDED_COLUMNS` 给出本 adapter 侧不进入公开输出的列清单）。
 *
 * ## PII 落地形态（**本切片未解决**，因此 productionReady 恒为 false）
 * `docs/P1-字段级数据字典.md` 对学号要求「加密存储、唯一索引摘要」，手机号要求「默认掩码展示」。
 * 本 adapter **不做应用层加密**（没有密钥管理/轮换设施，自行发明加密方案会制造无法回退的
 * 数据形态），因此它只按**现有内部存储契约**（`student-profile.contract.ts` 的读取契约 +
 * 字段字典的字段清单）承载明文列；加密与摘要唯一索引属于「启用数据库」切片必须先决定的事，
 * 已登记在 `POSTGRES_STUDENT_PROFILE_REPOSITORY_VERIFICATION_STEPS` 里。
 */

/** 表名：与 docs/P1-字段级数据字典.md 的 `student_profiles` 一致 */
export const POSTGRES_STUDENT_PROFILE_TABLE = 'student_profiles';

/**
 * 列清单：同时定义 `SELECT` 输出列、`INSERT` 列顺序与 `RETURNING` 输出列。
 *
 * 刻意不写 `SELECT *`：存储层新增列（软删除时间、锁定时间、审计字段、更敏感的列）不会因为
 * 本文件没更新就自动流进领域对象；配合行契约的 `.strict()`，未登记列会被显式拒绝而不是被
 * 静默带出。
 *
 * 注意：字段字典里的 `profile_submitted_at` / `profile_locked_at` **不在本清单内**——它们属于
 * 后续「首次提交后锁定 / 管理员代改」切片，且是服务端独占字段（见
 * `student-profile.contract.ts` 的 `FORBIDDEN_PROFILE_FIELDS`）。本 adapter 既不读写它们，
 * 也不用它们做过滤，因此未来迁移新增这两列不会改变本 adapter 的行为。
 */
export const POSTGRES_STUDENT_PROFILE_COLUMNS = [
  'user_id',
  'name',
  'student_no',
  'college',
  'major',
  'grade',
  'phone',
  'skills',
  'programming_level',
  'research_experience',
  'competition_experience',
  'available_time',
  'research_interests',
  'strengths',
  'intended_fields',
  'privacy_consent',
  'created_at',
  'updated_at',
] as const;

/** 列 → 领域字段的唯一事实来源（编译期强制覆盖 `StudentProfile` 的全部字段） */
export const POSTGRES_STUDENT_PROFILE_COLUMN_FIELDS = Object.freeze({
  user_id: 'userId',
  name: 'name',
  student_no: 'studentNo',
  college: 'college',
  major: 'major',
  grade: 'grade',
  phone: 'phone',
  skills: 'skills',
  programming_level: 'programmingLevel',
  research_experience: 'researchExperience',
  competition_experience: 'competitionExperience',
  available_time: 'availableTime',
  research_interests: 'researchInterests',
  strengths: 'strengths',
  intended_fields: 'intendedFields',
  privacy_consent: 'privacyConsent',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
} as const satisfies Record<
  (typeof POSTGRES_STUDENT_PROFILE_COLUMNS)[number],
  keyof StudentProfile
>);

/** 高敏感（PII）列：只按内部存储契约承载，绝不进入错误消息、日志与对外视图 */
export const POSTGRES_STUDENT_PROFILE_PII_COLUMNS: readonly (typeof POSTGRES_STUDENT_PROFILE_COLUMNS)[number][] =
  Object.freeze(['student_no', 'phone']);

/**
 * 本 adapter 侧**不进入公开输出**的列：归属（`user_id`）、高敏感（学号/联系方式）
 * 与隐私同意快照（政策版本/同意时间是服务端处理记录，只写不读）。
 * 对外裁剪由 `toStudentProfileView` 负责，本清单用于机器校验「adapter 不把这几列投影出去」。
 */
export const POSTGRES_STUDENT_PROFILE_VIEW_EXCLUDED_COLUMNS: readonly (typeof POSTGRES_STUDENT_PROFILE_COLUMNS)[number][] =
  Object.freeze(['user_id', 'student_no', 'phone', 'privacy_consent']);

/** 不可被写入覆盖的列：归属与生命周期（`ON CONFLICT` 的 `SET` 子句必须排除它们） */
export const POSTGRES_STUDENT_PROFILE_IMMUTABLE_COLUMNS: readonly (typeof POSTGRES_STUDENT_PROFILE_COLUMNS)[number][] =
  Object.freeze(['user_id', 'created_at']);

/** 仓储能力：持久但**未验证**，因此生产环境仍会被持久化边界守卫拦下 */
export const POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES: ProfileRepositoryCapabilities =
  Object.freeze({
    backend: PROFILE_REPOSITORY_BACKEND_POSTGRES,
    persistent: true,
    productionReady: false,
  });

/**
 * 转成生产可用前必须完成的验证清单（每一项都需要证据，不能只写声明）：
 * 1. 驱动依赖经评估后引入（`docs/P2-开源复用评估.md` 的 Prisma / TypeORM 比较结论）；
 * 2. 对真实 PostgreSQL 的集成测试：建表迁移、覆盖写入（upsert）、按主体取数与唯一性；
 * 3. `student_profiles` 的 schema 草案创建并按 `db/migrations/README.md` 转为迁移并执行验证
 *    （当前 `db/schema-drafts/` 只有小组草案；画像表以 `user_id` 为主键，与草案规则中
 *    「`id uuid PRIMARY KEY`」的写法不同，需要在草案规则层面一并定稿）；
 * 4. 学号加密存储 + 摘要唯一索引、手机号掩码展示的落地形态定稿（见文件头「PII 落地形态」）；
 * 5. `ProfileRepository` 端口改为异步，并同步修改 service / controller 与其测试；
 * 6. 会话主体 `userId` 收敛为 UUID（当前基线是 `u-student-1` 这类安全 ID，不满足存储 ID 域）；
 * 7. 完成 1–6 后，才允许把 `productionReady` 改为 true，并同步删除能力自检
 *    （`assertPostgresStudentProfileRepositoryCapabilities` 会拒绝「未验证就声称生产可用」）。
 */
export const POSTGRES_STUDENT_PROFILE_REPOSITORY_VERIFICATION_STEPS = [
  'driver-dependency-evaluated',
  'integration-tests-against-real-postgres',
  'student-profiles-schema-draft-created-and-promoted-to-migration',
  'pii-storage-decided-for-student-no-and-phone',
  'profile-repository-port-migrated-to-async',
  'session-subject-user-ids-converged-to-uuid',
  'production-ready-capability-flipped-with-evidence',
] as const;

export type PostgresStudentProfileRepositoryErrorCode =
  | 'CAPABILITY_MISDECLARED'
  | 'INVALID_CONFIGURATION'
  | 'EXECUTOR_UNAVAILABLE'
  | 'EXECUTOR_NOT_POSTGRES'
  | 'EXECUTOR_NOT_PERSISTENT'
  | 'INVALID_SUBJECT'
  | 'INVALID_RECORD'
  | 'INVALID_ROW'
  | 'RESULT_SET_VIOLATION'
  | 'OWNER_VIOLATION'
  | 'LIFECYCLE_MISMATCH';

/**
 * adapter 的 fail-closed 错误。
 *
 * `issues` 只承载**字段路径与违规类型**（例如 `user_id`、`student_no(too_small)`、
 * `privacy_consent(unrecognized_keys)`），不承载字段取值，
 * 避免把学号/联系方式等 PII、注入载荷或连接信息写进日志与错误响应。
 */
export class PostgresStudentProfileRepositoryError extends Error {
  readonly code: PostgresStudentProfileRepositoryErrorCode;
  readonly issues: readonly string[];

  constructor(
    code: PostgresStudentProfileRepositoryErrorCode,
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PostgresStudentProfileRepositoryError';
    this.code = code;
    this.issues = [...issues];
  }
}

/**
 * 能力自检：**未验证的实现不得声称生产可用**。
 *
 * 任何环境都会执行（能力声明缺失属于代码缺陷，不能等生产才暴露）。
 * 生产可用性的提升必须与 `POSTGRES_STUDENT_PROFILE_REPOSITORY_VERIFICATION_STEPS` 的证据、
 * 以及本断言的同步修改一起发生。
 */
export function assertPostgresStudentProfileRepositoryCapabilities(
  capabilities: ProfileRepositoryCapabilities = POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES,
): void {
  const issues: string[] = [];
  if (capabilities.backend !== PROFILE_REPOSITORY_BACKEND_POSTGRES) {
    issues.push('backend');
  }
  if (capabilities.persistent !== true) {
    issues.push('persistent');
  }
  if (capabilities.productionReady !== false) {
    issues.push('productionReady');
  }
  if (issues.length > 0) {
    throw new PostgresStudentProfileRepositoryError(
      'CAPABILITY_MISDECLARED',
      `PostgreSQL 画像仓储能力声明不符（backend 必须是 ${PROFILE_REPOSITORY_BACKEND_POSTGRES}、persistent=true、productionReady=false）：未完成驱动集成验证前不得声称生产可用`,
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
    throw new PostgresStudentProfileRepositoryError(
      'INVALID_CONFIGURATION',
      `SQL 标识符不合规（必须是裸小写标识符）：${label}`,
      [label],
    );
  }
  return value;
}

/** 模块加载即校验：表名与列名一旦被改成非标识符形状，直接 fail-closed（不静默拼进 SQL） */
const TABLE_IDENTIFIER = assertSqlIdentifier(POSTGRES_STUDENT_PROFILE_TABLE, 'table');
const COLUMN_LIST = POSTGRES_STUDENT_PROFILE_COLUMNS.map((column) =>
  assertSqlIdentifier(column, 'column'),
).join(', ');

/** 逐列的类型转换：只在「列 → 参数占位」这一步使用，值本身永远不进入 SQL 文本 */
const COLUMN_PARAMETER_CASTS: Partial<
  Record<(typeof POSTGRES_STUDENT_PROFILE_COLUMNS)[number], string>
> = {
  user_id: '::uuid',
  skills: '::text[]',
  available_time: '::jsonb',
  research_interests: '::text[]',
  intended_fields: '::text[]',
  privacy_consent: '::jsonb',
  created_at: '::timestamptz',
  updated_at: '::timestamptz',
};

/** `VALUES ($1::uuid, $2, …)`：占位符与列一一对应，由列清单派生，不会出现数量漂移 */
const UPSERT_VALUES = POSTGRES_STUDENT_PROFILE_COLUMNS.map(
  (column, index) => `$${index + 1}${COLUMN_PARAMETER_CASTS[column] ?? ''}`,
).join(', ');

/** `ON CONFLICT DO UPDATE SET`：排除不可覆盖列（归属与创建时间） */
const UPSERT_UPDATE_COLUMNS = POSTGRES_STUDENT_PROFILE_COLUMNS.filter(
  (column) => !POSTGRES_STUDENT_PROFILE_IMMUTABLE_COLUMNS.includes(column),
);
const UPSERT_UPDATE_SET = UPSERT_UPDATE_COLUMNS.map(
  (column) => `${column} = EXCLUDED.${column}`,
).join(',\n  ');

/**
 * 覆盖写入语句：客户端可控值全部走 `$n`；`ON CONFLICT (user_id) DO UPDATE` 给出与内存基线
 * `Map.set` 相同的「覆盖」语义（而不是静默丢弃或主键冲突抛错），且**不覆盖归属与创建时间**。
 * `RETURNING` 让写入结果可被严格行契约复核（而不是「写完就当成功」）。
 */
const UPSERT_SQL = `INSERT INTO ${TABLE_IDENTIFIER} (
  ${COLUMN_LIST}
) VALUES (${UPSERT_VALUES})
ON CONFLICT (user_id) DO UPDATE SET
  ${UPSERT_UPDATE_SET}
RETURNING ${COLUMN_LIST}`;

/** 按主体取数语句：主体走 `$1::uuid` 绑定；显式列清单，不使用 `SELECT *` */
const SELECT_BY_OWNER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
 WHERE user_id = $1::uuid`;

/**
 * 数据库行契约（**严格**）。
 *
 * `.strict()` 是「字段污染」防线：数据库返回的未登记列（`deleted_at`、`profile_locked_at`、
 * `wechat_open_id`、内部备注…）会让解析失败，而不是被静默丢弃或带进领域对象。
 * 列缺失同样失败（PG 对 SELECT 列表中存在的列一定返回键，缺键说明驱动或 SQL 已被改动）。
 *
 * 枚举闭集与列上的长度约束在这里先拦一道；**内容安全**（如禁止身份证号/密钥的长文本）与
 * 时间格式的最终判定交给 `student-profile.contract.ts`（映射后用 `parseStoredStudentProfile` 复核）。
 */
const postgresStudentProfileRowSchema = z
  .object({
    user_id: uuidSchema,
    name: z.string().min(1).max(50),
    student_no: z.string().min(4).max(32),
    college: z.string().min(1).max(100),
    major: z.string().min(1).max(100),
    grade: z.enum(GRADE_VALUES),
    phone: z.string().min(6).max(20),
    skills: z.array(z.string().min(1)),
    programming_level: z.enum(PROGRAMMING_LEVEL_VALUES),
    research_experience: z.string().max(2000).nullable(),
    competition_experience: z.string().max(2000).nullable(),
    // jsonb 单列先用 unknown 接住，随后用严格版本校验形状
    available_time: z.unknown(),
    research_interests: z.array(z.string().min(1)),
    strengths: z.string().max(1000).nullable(),
    intended_fields: z.array(z.string().min(1)),
    privacy_consent: z.unknown(),
    created_at: z.union([z.date(), z.string()]),
    updated_at: z.union([z.date(), z.string()]),
  })
  .strict();

/** 空余时间：共享 schema 的严格版本（jsonb 出现未登记键即 fail-closed） */
const strictAvailableTimeSchema = availableTimeSchema.strict();

/**
 * 隐私同意快照的**存储形态**：只保存服务端处理记录（政策版本 + 同意时间）。
 *
 * 刻意不复用共享 `privacyConsentSchema`：那是**输入**契约，含门禁条件 `agreed: true`，
 * 不是状态。`.strict()` 因此也拒绝把 `agreed` 当作状态落库/回读（有断言）。
 */
const strictStoredPrivacyConsentSchema = z
  .object({
    policyVersion: trimmedText(1, 40, '隐私政策版本'),
    consentedAt: z.union([z.date(), z.string()]),
  })
  .strict();

/** 写入记录契约：读取契约的严格版本（调用方不得通过领域对象夹带未登记字段） */
const strictWritableProfileSchema = storedStudentProfileSchema.strict();

/** 只保留字段路径与违规类型，绝不含字段取值（PII 不进错误消息） */
function describeIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}(${issue.code})`);
}

function invalidRow(error: z.ZodError, label = 'row'): PostgresStudentProfileRepositoryError {
  return new PostgresStudentProfileRepositoryError(
    'INVALID_ROW',
    `数据库行不符合 postgres 行契约（${label}）`,
    describeIssues(error),
  );
}

/** 时间列 → ISO 字符串；坏时间戳 fail-closed（不产生 `Invalid Date` 之类的半成品） */
function toIsoTimestamp(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PostgresStudentProfileRepositoryError(
      'INVALID_ROW',
      `时间列不是合法时间戳：${label}`,
      [label],
    );
  }
  return date.toISOString();
}

/** 空余时间逐字段复制：不把驱动持有的数组/对象交给上层 */
function copyAvailableTime(availableTime: StoredAvailableTime): StoredAvailableTime {
  return {
    weeklyHours: availableTime.weeklyHours,
    periods: [...availableTime.periods],
    ...(availableTime.note ? { note: availableTime.note } : {}),
  };
}

/** 隐私同意快照逐字段复制：不把驱动的内部引用交给上层，也不夹带门禁字段 */
function copyPrivacyConsent(consent: StoredPrivacyConsent): StoredPrivacyConsent {
  return {
    policyVersion: consent.policyVersion,
    consentedAt: consent.consentedAt,
  };
}

/** 空串归一为「未填写」：与内存基线/service 的 `optionalText` 语义一致，存储层只留有值的可选文本 */
function optionalText(value: string | null): string | undefined {
  return value ? value : undefined;
}

/**
 * 行 → 领域记录：**逐字段显式映射**（不使用展开），再整体过一次读取契约。
 *
 * 顺序刻意如此：先按严格行契约解析（拒绝未登记列 / 未知 JSON 键 / 非法枚举 / 坏类型），
 * 再显式取字段构造新对象（即使行里有额外内容也不会被带出），最后用
 * `parseStoredStudentProfile` 复核共享读取契约（枚举闭集 + ISO 时间 + 内容安全），
 * 任一环节不合规都抛错。
 */
function mapRow(row: unknown): StudentProfile {
  const parsedRow = postgresStudentProfileRowSchema.safeParse(row);
  if (!parsedRow.success) {
    throw invalidRow(parsedRow.error);
  }
  const dbRow = parsedRow.data;

  const parsedAvailableTime = strictAvailableTimeSchema.safeParse(dbRow.available_time);
  if (!parsedAvailableTime.success) {
    throw invalidRow(parsedAvailableTime.error, 'available_time');
  }

  const parsedConsent = strictStoredPrivacyConsentSchema.safeParse(dbRow.privacy_consent);
  if (!parsedConsent.success) {
    throw invalidRow(parsedConsent.error, 'privacy_consent');
  }

  const researchExperience = optionalText(dbRow.research_experience);
  const competitionExperience = optionalText(dbRow.competition_experience);
  const strengths = optionalText(dbRow.strengths);

  const record = {
    userId: dbRow.user_id,
    name: dbRow.name,
    // PII：按内部存储契约原样承载，不做裁剪、不写日志
    studentNo: dbRow.student_no,
    college: dbRow.college,
    major: dbRow.major,
    grade: dbRow.grade,
    phone: dbRow.phone,
    // 数组复制：不把驱动持有的数组交给上层
    skills: [...dbRow.skills],
    programmingLevel: dbRow.programming_level,
    ...(researchExperience ? { researchExperience } : {}),
    ...(competitionExperience ? { competitionExperience } : {}),
    availableTime: copyAvailableTime(parsedAvailableTime.data),
    researchInterests: [...dbRow.research_interests],
    ...(strengths ? { strengths } : {}),
    intendedFields: [...dbRow.intended_fields],
    privacyConsent: {
      policyVersion: parsedConsent.data.policyVersion,
      consentedAt: toIsoTimestamp(parsedConsent.data.consentedAt, 'privacy_consent.consentedAt'),
    },
    createdAt: toIsoTimestamp(dbRow.created_at, 'created_at'),
    updatedAt: toIsoTimestamp(dbRow.updated_at, 'updated_at'),
  };

  const parsedRecord = parseStoredStudentProfile(record);
  if (!parsedRecord.ok) {
    throw new PostgresStudentProfileRepositoryError(
      'INVALID_ROW',
      '数据库行映射后不符合学生画像读取契约',
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
    throw new PostgresStudentProfileRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      '未提供 SQL 执行器：PostgreSQL 画像仓储拒绝在半可用状态下构造或调用',
      ['executor'],
    );
  }
  const candidate = executor as { query?: unknown; capabilities?: unknown };
  if (typeof candidate.query !== 'function') {
    throw new PostgresStudentProfileRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器缺少 query 方法：PostgreSQL 画像仓储拒绝在半可用状态下构造或调用',
      ['executor.query'],
    );
  }
  const capabilities = candidate.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new PostgresStudentProfileRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器未声明能力（backend/persistent/productionReady）',
      ['executor.capabilities'],
    );
  }
  const { backend, persistent } = capabilities as { backend?: unknown; persistent?: unknown };
  if (typeof backend !== 'string' || backend.trim() === '') {
    throw new PostgresStudentProfileRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器的能力声明缺少 backend 标识',
      ['executor.capabilities.backend'],
    );
  }
  if (!/^postgres/iu.test(backend.trim())) {
    throw new PostgresStudentProfileRepositoryError(
      'EXECUTOR_NOT_POSTGRES',
      'SQL 执行器声明的后端不是 PostgreSQL：拒绝把本 adapter 挂到其他存储上',
      ['executor.capabilities.backend'],
    );
  }
  if (persistent !== true) {
    throw new PostgresStudentProfileRepositoryError(
      'EXECUTOR_NOT_PERSISTENT',
      'SQL 执行器声明为非持久后端（内存替身）：PostgreSQL 画像仓储拒绝在其上运行',
      ['executor.capabilities.persistent'],
    );
  }
  return executor as SqlExecutor;
}

/**
 * **存储 ID 域约束**：主体标识必须是合法、非空、且为**规范小写形**的 UUID。
 *
 * 非 UUID 的 `userId`（例如会话基线的 `u-student-1`，或注入式载荷）会让数据库侧 `uuid`
 * 比较退化为「转换失败 / 放弃类型约束」，因此在这里 fail-closed 拒绝，
 * **绝不绑定进 SQL**（错误信息也不回显该值本身）。
 *
 * 为什么连大写也拒绝：归属复核是**逐字节精确比较**（`OWNER_VIOLATION`），而 UUID 文本在
 * 数据库侧是大小写不敏感的。若在这里静默小写化，就会把「归属被改写」与「大小写差异」混成
 * 同一个静默修正；若原样绑定大写，则数据库返回的规范小写形会与本地上限值不一致而误报越权。
 * 因此统一要求规范小写形，由「会话主体标识收敛」切片负责规范化（已登记在验证清单里）。
 */
function requireStorageOwnerId(
  userId: unknown,
  code: PostgresStudentProfileRepositoryErrorCode,
  message: string,
): string {
  const parsed = uuidSchema.safeParse(userId);
  if (!parsed.success || parsed.data === NIL_UUID || parsed.data !== parsed.data.toLowerCase()) {
    throw new PostgresStudentProfileRepositoryError(code, message, ['userId']);
  }
  return parsed.data;
}

/** 写入记录校验：读取契约的严格版本 + 归属必须落在存储 ID 域内（合法且非空 UUID） */
function assertWritableRecord(record: unknown): StudentProfile {
  const parsed = strictWritableProfileSchema.safeParse(record);
  if (!parsed.success) {
    throw new PostgresStudentProfileRepositoryError(
      'INVALID_RECORD',
      '待写入的画像记录不符合读取契约的严格版本（含未登记字段或非法取值）',
      describeIssues(parsed.error),
    );
  }
  requireStorageOwnerId(
    parsed.data.userId,
    'INVALID_RECORD',
    '待写入的画像记录缺少有效归属（归属必须由服务端会话主体写入，且落在存储 ID 域内）',
  );
  return parsed.data;
}

/**
 * 结果集形状 fail-closed：执行器必须返回对象且带 `rows` 数组。
 * 「少字段 / 类型不对」属于驱动或替身实现缺陷，不得被当成「空结果」静默放过
 * （否则会把基础设施故障伪装成「该主体尚无画像」）。
 */
function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new PostgresStudentProfileRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果不是对象（驱动 / 替身实现缺陷）',
      ['result'],
    );
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new PostgresStudentProfileRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果缺少 rows 数组（驱动 / 替身实现缺陷）',
      ['rows'],
    );
  }
  return rows;
}

/**
 * 写入参数：**由列清单派生**（列 → 字段 → 值），因此参数顺序永远与 SQL 占位符一致；
 * `Record<keyof StudentProfile, unknown>` 让「新增领域字段但忘记补参数」成为编译错误。
 */
function writeParameters(record: StudentProfile): readonly unknown[] {
  const values: Record<keyof StudentProfile, unknown> = {
    userId: record.userId,
    name: record.name,
    studentNo: record.studentNo,
    college: record.college,
    major: record.major,
    grade: record.grade,
    phone: record.phone,
    skills: [...record.skills],
    programmingLevel: record.programmingLevel,
    researchExperience: record.researchExperience ?? null,
    competitionExperience: record.competitionExperience ?? null,
    availableTime: copyAvailableTime(record.availableTime),
    researchInterests: [...record.researchInterests],
    strengths: record.strengths ?? null,
    intendedFields: [...record.intendedFields],
    privacyConsent: copyPrivacyConsent(record.privacyConsent),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return POSTGRES_STUDENT_PROFILE_COLUMNS.map(
    (column) => values[POSTGRES_STUDENT_PROFILE_COLUMN_FIELDS[column]],
  );
}

/**
 * 基于 `SqlExecutor` 的 PostgreSQL 学生画像仓储。
 *
 * 构造与每次调用都会重新校验执行器（`assertUsableExecutor`）与自身能力声明，
 * 因此「执行器被换掉 / 被降级」或「能力声明被改写」都会 fail-closed，而不是静默继续。
 * 本类**不是** Nest provider：它不由容器实例化，只由 Module 的工厂
 * （`createProfileRepository` → `createLazyPostgresStudentProfileRepository`）显式构造。
 */
export class PostgresStudentProfileRepository implements AsyncProfileRepository {
  readonly capabilities: ProfileRepositoryCapabilities =
    POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES;

  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    assertPostgresStudentProfileRepositoryCapabilities(this.capabilities);
    this.executor = assertUsableExecutor(executor);
  }

  /** 每次调用前的自检：能力声明与执行器都必须仍然可用 */
  private usableExecutor(): SqlExecutor {
    assertPostgresStudentProfileRepositoryCapabilities(this.capabilities);
    return assertUsableExecutor(this.executor);
  }

  /**
   * 按主体取数：只按 `userId`（服务端会话主体）取一行。
   *
   * - 主体必须落在存储 ID 域内（UUID），否则 `INVALID_SUBJECT`，且不访问数据库；
   * - 未命中返回 `undefined`（不抛错）；
   * - 返回行必须通过严格行契约与读取契约，且**归属必须等于请求取数的主体**
   *   （数据库回流出「他人画像」时判服务端缺陷，不得作为结果返回）；
   * - 主键（`user_id`）不唯一导致返回多行 → 结果集违约，fail-closed。
   */
  async findByUserId(userId: string): Promise<StudentProfile | undefined> {
    const executor = this.usableExecutor();
    const ownerId = requireStorageOwnerId(
      userId,
      'INVALID_SUBJECT',
      '取数主体必须落在存储 ID 域内（合法且非空的 UUID）：非 UUID 的 userId 属于服务端缺陷，不得进入 SQL',
    );

    const result = await executor.query(SELECT_BY_OWNER_SQL, [ownerId]);

    const rows = rowsOf(result);
    if (rows.length === 0) {
      return undefined;
    }
    if (rows.length > 1) {
      throw new PostgresStudentProfileRepositoryError(
        'RESULT_SET_VIOLATION',
        '按主体取数返回了多行：归属主键唯一性被破坏',
        ['user_id'],
      );
    }

    const record = mapRow(rows[0]);
    if (record.userId !== ownerId) {
      // 纵深防御：返回的必须是所请求主体的画像（他人记录不得回流）
      throw new PostgresStudentProfileRepositoryError(
        'OWNER_VIOLATION',
        '返回记录的归属与请求取数的主体不一致（他人画像不得回流）',
        ['user_id'],
      );
    }
    return record;
  }

  /**
   * 覆盖写入一条已由 service 校验并补齐归属 / 时间戳的画像（upsert，与内存基线 `Map.set` 同语义）。
   *
   * - `userId` 必须是服务端会话主体（非法 UUID / 空 UUID / 未登记字段一律拒绝）；
   * - 写入语句返回**恰好一行**（upsert 语义），否则判结果集违约；
   * - 返回行必须能通过严格行契约与读取契约，且**归属**与**创建时间**都必须等于请求写入的记录
   *   （数据库回流出「他人记录」、归属被改写或创建时间被覆盖时判服务端缺陷）。
   */
  async save(profile: StudentProfile): Promise<StudentProfile> {
    const executor = this.usableExecutor();
    const record = assertWritableRecord(profile);

    const result = await executor.query(UPSERT_SQL, writeParameters(record));

    const rows = rowsOf(result);
    if (rows.length !== 1) {
      throw new PostgresStudentProfileRepositoryError(
        'RESULT_SET_VIOLATION',
        '覆盖写入必须恰好返回一行（upsert 语义）：数据库或 SQL 已被改动',
        ['rows'],
      );
    }

    const stored = mapRow(rows[0]);
    if (stored.userId !== record.userId) {
      // 纵深防御：归属被改写或返回了他人记录，属服务端缺陷，不得作为写入结果返回
      throw new PostgresStudentProfileRepositoryError(
        'OWNER_VIOLATION',
        '返回记录的归属与请求写入的归属不一致（他人归属不得回流）',
        ['user_id'],
      );
    }
    if (stored.createdAt !== record.createdAt) {
      // 生命周期字段属于服务端：写入被忽略、被触发器改写或两人并发创建同一条记录时必须显式暴露
      throw new PostgresStudentProfileRepositoryError(
        'LIFECYCLE_MISMATCH',
        '返回记录的创建时间与请求写入的创建时间不一致（创建时间是服务端生命周期字段，不得被覆盖）',
        ['created_at'],
      );
    }
    return stored;
  }
}

/** DI 工厂：把驱动无关的 `SqlExecutor` 装成画像仓储端口实现（本切片**唯一**的换绑点） */
export function createPostgresStudentProfileRepository(executor: SqlExecutor): ProfileRepository {
  return new PostgresStudentProfileRepository(executor);
}

/** 把「主体必须在存储 ID 域内」变成可先于建连执行的断言（供分流点与测试复用） */
export function assertPostgresStudentProfileSubject(userId: unknown): string {
  return requireStorageOwnerId(
    userId,
    'INVALID_SUBJECT',
    '取数主体必须落在存储 ID 域内（合法且非空的 UUID）：非 UUID 的 userId 属于服务端缺陷，不得进入 SQL',
  );
}

/**
 * 延迟建连的画像仓储：**模块装配阶段不碰数据库**。
 *
 * 为什么必须延迟：`SQL_CONNECTION_FACTORY.connect()` 在数据库已配置但执行器未通过 attest 契约时
 * 会抛错。如果在这里急切建连，启动失败会表现为「模块工厂抛了数据库错」，而不是启动期持久化边界
 * 给出的**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED` / `DECLARATION_NOT_SEALED` 等）；
 * 依赖就绪门禁也必须能在**任何连接之前**给出 `PROFILE_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`。
 * 延迟后，判定顺序保持为「配置 → 持久化边界 / 依赖就绪 → 首次真正读库」。
 *
 * 连接只在首次读写时建立并被复用；建立失败不缓存失败结果（下一次调用会重试）。
 * 主体域先判、再建连：非存储 ID 域（非 UUID）的主体不会触发任何数据库连接。
 */
export function createLazyPostgresStudentProfileRepository(
  resolveExecutor: () => Promise<SqlExecutor>,
  capabilities: ProfileRepositoryCapabilities = POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES,
): ProfileRepository {
  assertPostgresStudentProfileRepositoryCapabilities(capabilities);

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
    async findByUserId(userId: string): Promise<StudentProfile | undefined> {
      const ownerId = assertPostgresStudentProfileSubject(userId);
      const resolved = await executor();
      return new PostgresStudentProfileRepository(resolved).findByUserId(ownerId);
    },
    async save(profile: StudentProfile): Promise<StudentProfile> {
      // 主体域先判、再建连：非存储 ID 域的写记录不应该触发任何数据库连接
      assertPostgresStudentProfileSubject(profile.userId);
      const resolved = await executor();
      return new PostgresStudentProfileRepository(resolved).save(profile);
    },
  };
}
