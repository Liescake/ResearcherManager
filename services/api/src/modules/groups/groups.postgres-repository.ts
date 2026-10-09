import { z } from 'zod';
import {
  GROUP_STATUS_VALUES,
  GroupStatus,
  isGroupApplicable,
  recruitmentRequirementsSchema,
  uuidSchema,
} from '@rm/shared';
import type { RecruitmentRequirementsInput } from '@rm/shared';
import type { SqlExecutor } from '../../db/ports/sql-executor.port';
import { parseStoredGroup, storedGroupSchema } from './groups.contract';
import {
  GROUP_REPOSITORY_BACKEND_POSTGRES,
  type GroupListWindow,
  type GroupRepository,
  type GroupRepositoryCapabilities,
  type GroupVisibilityQuery,
  type ResearchGroup,
} from './groups.port';

/**
 * 小组的 **PostgreSQL 仓储 adapter（已接入运行时）**。
 *
 * ## 装配位置（唯一换绑点）
 * `groups.module.ts` 的 `createGroupRepository(env, sqlConnectionFactory)` 按「是否解析出
 * `DATABASE_URL`」分流：未配置时内存基线；配置时经 `createLazyPostgresGroupRepository`
 * 绑定本文件的实现（**延迟建连**）。本文件自身不含任何 Nest 装配痕迹（无 `@Injectable` /
 * `@Inject`），装配只发生在 Module 的工厂里 —— 这也正是
 * `db/persistence/postgres-adapter-registry.ts` 的「已绑定切片」规则要求的形状。
 *
 * ## 交付边界（本切片刻意不做的事）
 * - **不引入** `pg` / Prisma / TypeORM 等驱动或 ORM 依赖：本文件只依赖驱动无关的
 *   `SqlExecutor` 端口（`db/ports/sql-executor.port.ts`），驱动只允许出现在 `db/postgres/`
 *   驱动层；
 * - **不声称生产可用**：能力声明固定为 `backend = postgres`、`persistent = true`、
 *   `productionReady = false`。因此在 `NODE_ENV=production` 且已配置数据库时，启动期
 *   `PersistenceBoundaryService` 会以 `BACKEND_NOT_PRODUCTION_READY_IN_PRODUCTION` 拒绝启动，
 *   依赖就绪门禁也会给出 `GROUP_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`（fail-closed）。
 *
 * ## 存储 ID 域（本切片的已登记前置）
 * 端口契约已改为异步（见 `groups.port.ts`），因此本实现可以直接替换内存基线。但
 * `research_groups.id` 是 `uuid`，而会话主体的 `groupIds` / `assignedResourceIds` 目前只保证
 * 是「安全 ID」（例如 `g-1`）而非 UUID。故数据库路径对**资源级可见**的主体是 fail-closed 的：
 * 非 UUID 的可见 ID 在进入 SQL 之前就被拒绝（`INVALID_QUERY`），绝不退化成
 * 「放弃类型约束的 uuid[] 比较」。把会话主体资源标识收敛为 UUID 属于后续切片，也是
 * `productionReady` 仍为 false 的原因之一。
 *
 * ## 安全边界（本文件的四条硬约束）
 * 1. **参数化 SQL**：所有客户端可控的值一律走 `$1…$n` 占位符绑定；进入 SQL 文本的只有
 *    模块常量（表名、列清单、状态字面量），且都经过 `assertSqlIdentifier` / 字面量校验，
 *    不存在任何「值 → SQL 文本」的路径；
 * 2. **显式字段映射 + 严格输出校验**：数据库行必须满足严格（`.strict()`）的行契约
 *    （未知列、未知 JSON 键、非法枚举、非数组、坏时间戳一律拒绝），再逐字段显式映射为领域
 *    记录，最后再过一次 `groups.contract.ts` 的读取契约；任何一步不合规都 **fail-closed** 抛错，
 *    绝不把未登记字段、未知状态或半成品记录交给上层；
 * 3. **subject 边界**（写路径）：`leaderUserId` 必须由调用方（service）从服务端会话主体写入，
 *    必须是合法且非空的 UUID；adapter 不生成、不覆盖归属，并在返回行上复核
 *    「返回记录的负责人 === 请求写入的负责人」，不一致即判服务端缺陷（他人归属不得回流）；
 * 4. **visibility 边界**（读路径）：可见范围只来自 `GroupVisibilityQuery`（服务端判定产物），
 *    `visibleGroupIds` 必须是合法 UUID 且会逐条复核；**即使数据库 / SQL 返回了范围外或非开放
 *    状态的记录，adapter 也会抛错而不是把「别人的小组」交给上层**（纵深防御）。
 *
 * 校验失败的错误消息**只包含字段路径与违规类型**，不包含字段取值，避免把数据内容或注入载荷
 * 写进日志与错误响应。
 */

/** 表名：必须与 `db/schema-drafts/0001_research_groups.draft.sql` 的 `-- target-table:` 一致 */
export const POSTGRES_GROUP_TABLE = 'research_groups';

/**
 * 列清单：同时定义 `SELECT` 输出列与 `INSERT` 的列顺序。
 *
 * 刻意不写 `SELECT *`：存储层新增列（软删除时间、审计字段、高敏感字段）不会因为本文件没更新
 * 就自动流进领域对象；配合行契约的 `.strict()`，未登记列会被显式拒绝而不是被静默带出。
 */
export const POSTGRES_GROUP_COLUMNS = [
  'id',
  'name',
  'description',
  'research_directions',
  'recruitment_requirements',
  'leader_user_id',
  'status',
  'created_at',
  'updated_at',
] as const;

/**
 * **内部列**：存储层存在、但既不进 `SELECT` / `RETURNING`，也不进领域对象。
 *
 * `deleted_at` 是软删除标记，只被可见性谓词使用（`deleted_at IS NULL`）。把它登记在这里
 * 而不是塞进 `POSTGRES_GROUP_COLUMNS`，是为了让「迁移的列清单 = 输出列 + 内部列」成为一条
 * 可机器判定的等式（见 `groups-integration.spec.ts` 的双向核对）：既不允许迁移偷偷多列，
 * 也不允许内部列悄悄流进领域对象。
 */
export const POSTGRES_GROUP_INTERNAL_COLUMNS = ['deleted_at'] as const;

/** 仓储能力：持久但**未验证**，因此生产环境仍会被持久化边界守卫拦下 */
export const POSTGRES_GROUP_REPOSITORY_CAPABILITIES: GroupRepositoryCapabilities = Object.freeze({
  backend: GROUP_REPOSITORY_BACKEND_POSTGRES,
  persistent: true,
  productionReady: false,
});

/**
 * 转成生产可用前必须完成的验证清单（每一项都需要证据，不能只写声明）：
 * 1. 驱动依赖经评估后引入（`docs/P2-开源复用评估.md` 的 Prisma / TypeORM 比较结论）——已由
 *    `db/postgres/` 驱动层 + 官方 `pg` 依赖完成；
 * 2. 对真实 PostgreSQL 的集成测试：建表迁移、唯一名索引、软删除过滤、可见性过滤与分页窗口
 *    （见 `db/postgres/__tests__/groups-integration.spec.ts`）；
 * 3. `db/schema-drafts/` 草案按 `db/migrations/README.md` 转为迁移并执行验证——已落地为
 *    `db/migrations/0011_research_groups.sql`；
 * 4. `GroupRepository` 端口改为异步，并同步修改 service / controller 与其测试——已完成；
 * 5. **仍缺**：会话主体的 `groupIds` / `assignedResourceIds` 收敛为 UUID（否则资源级可见的
 *    主体在数据库路径上 fail-closed）；
 * 6. 完成 1–5 后，才允许把 `productionReady` 改为 true，并同步删除能力自检
 *    （`assertPostgresGroupRepositoryCapabilities` 会拒绝「未验证就声称生产可用」）。
 */
export const POSTGRES_GROUP_REPOSITORY_VERIFICATION_STEPS = [
  'driver-dependency-evaluated',
  'integration-tests-against-real-postgres',
  'schema-draft-promoted-to-migration',
  'group-repository-port-migrated-to-async',
  'production-ready-capability-flipped-with-evidence',
] as const;

export type PostgresGroupRepositoryErrorCode =
  | 'CAPABILITY_MISDECLARED'
  | 'INVALID_CONFIGURATION'
  | 'EXECUTOR_UNAVAILABLE'
  | 'EXECUTOR_NOT_POSTGRES'
  | 'EXECUTOR_NOT_PERSISTENT'
  | 'INVALID_QUERY'
  | 'INVALID_WINDOW'
  | 'INVALID_RECORD'
  | 'INVALID_ROW'
  | 'RESULT_SET_VIOLATION'
  | 'CONFLICT'
  | 'IDENTITY_MISMATCH'
  | 'VISIBILITY_VIOLATION';

/**
 * adapter 的 fail-closed 错误。
 *
 * `issues` 只承载**字段路径与违规类型**（例如 `id(uuid)`、`leader_user_id`），
 * 不承载字段取值，避免把数据内容、注入载荷或连接信息写进日志。
 */
export class PostgresGroupRepositoryError extends Error {
  readonly code: PostgresGroupRepositoryErrorCode;
  readonly issues: readonly string[];

  constructor(
    code: PostgresGroupRepositoryErrorCode,
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PostgresGroupRepositoryError';
    this.code = code;
    this.issues = [...issues];
  }
}

/**
 * 能力自检：**未验证的实现不得声称生产可用**。
 *
 * 任何环境都会执行（能力声明缺失属于代码缺陷，不能等生产才暴露）。
 * 生产可用性的提升必须与 `POSTGRES_GROUP_REPOSITORY_VERIFICATION_STEPS` 的证据、
 * 以及本断言的同步修改一起发生。
 */
export function assertPostgresGroupRepositoryCapabilities(
  capabilities: GroupRepositoryCapabilities = POSTGRES_GROUP_REPOSITORY_CAPABILITIES,
): void {
  const issues: string[] = [];
  if (capabilities.backend !== GROUP_REPOSITORY_BACKEND_POSTGRES) {
    issues.push('backend');
  }
  if (capabilities.persistent !== true) {
    issues.push('persistent');
  }
  if (capabilities.productionReady !== false) {
    issues.push('productionReady');
  }
  if (issues.length > 0) {
    throw new PostgresGroupRepositoryError(
      'CAPABILITY_MISDECLARED',
      `PostgreSQL 小组仓储能力声明不符（backend 必须是 ${GROUP_REPOSITORY_BACKEND_POSTGRES}、persistent=true、productionReady=false）：未完成驱动集成验证前不得声称生产可用`,
      issues,
    );
  }
}

/** 空 UUID：合法 UUID 但不是可用负责人，写路径一律拒绝 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** 已登记枚举字面量：只允许这种形状的值被拼进 SQL 文本 */
const SQL_BARE_LITERAL = /^[a-z][a-z0-9_]*$/u;

function sqlTextLiteral(value: string): string {
  if (!SQL_BARE_LITERAL.test(value)) {
    throw new PostgresGroupRepositoryError(
      'INVALID_CONFIGURATION',
      'SQL 字面量不合规：只允许裸标识符形状的枚举值',
      ['status'],
    );
  }
  return `'${value}'`;
}

/** SQL 标识符白名单：只允许小写字母开头的裸标识符，杜绝用「列名 / 表名」夹带 SQL 片段 */
const SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/u;

function assertSqlIdentifier(value: string, label: string): string {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new PostgresGroupRepositoryError(
      'INVALID_CONFIGURATION',
      `SQL 标识符不合规（必须是裸小写标识符）：${label}`,
      [label],
    );
  }
  return value;
}

/** 模块加载即校验：表名与列名一旦被改成非标识符形状，直接 fail-closed（不静默拼进 SQL） */
const TABLE_IDENTIFIER = assertSqlIdentifier(POSTGRES_GROUP_TABLE, 'table');
const COLUMN_LIST = POSTGRES_GROUP_COLUMNS.map((column) =>
  assertSqlIdentifier(column, 'column'),
).join(', ');

/**
 * 可见性谓词（与内存基线 `InMemoryGroupRepository.visible()` 语义逐条对齐）：
 * 1. `deleted_at IS NULL`：软删除行不参与取数；
 * 2. `status = 'open'`：等价于共享 `isGroupApplicable`，暂停/关闭的小组不在本端点展示；
 * 3. `$1::boolean OR id = ANY($2::uuid[])`：`includeAllOpenGroups` 为真时不过滤，
 *    否则只取服务端逐条判定通过的小组；空数组时 `ANY('{}')` 恒为 false，
 *    **不会意外放大可见范围**（不是「空数组 = 不过滤」）。
 *
 * 列表与计数**共用本常量**（有断言），避免「总数」与「当前页」来自两套语义而导致分页元数据失真。
 */
export const POSTGRES_GROUP_VISIBILITY_PREDICATE = [
  'deleted_at IS NULL',
  `status = ${sqlTextLiteral(GroupStatus.Open)}`,
  '($1::boolean OR id = ANY($2::uuid[]))',
].join('\n  AND ');

/** 写入语句：客户端可控值全部走 `$n`；`ON CONFLICT (id) DO NOTHING` 让主键冲突显式暴露 */
const INSERT_SQL = `INSERT INTO ${TABLE_IDENTIFIER} (
  ${COLUMN_LIST}
) VALUES ($1, $2, $3, $4::text[], $5::jsonb, $6, $7, $8::timestamptz, $9::timestamptz)
ON CONFLICT (id) DO NOTHING
RETURNING ${COLUMN_LIST}`;

/** 列表语句：可见性谓词与计数共用；窗口下推为 `LIMIT/OFFSET`，不做内存切片 */
const LIST_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
 WHERE ${POSTGRES_GROUP_VISIBILITY_PREDICATE}
 ORDER BY created_at ASC, id ASC
 LIMIT $3 OFFSET $4`;

/** 计数语句：`COUNT(*)` 恒返回一行；转 bigint 避免大表计数溢出到 double */
const COUNT_SQL = `SELECT COUNT(*)::bigint AS total
  FROM ${TABLE_IDENTIFIER}
 WHERE ${POSTGRES_GROUP_VISIBILITY_PREDICATE}`;

/**
 * 数据库行契约（**严格**）。
 *
 * `.strict()` 是「字段污染」防线：数据库返回的未登记列（`deleted_at`、`leader_email`、
 * 内部备注…）会让解析失败，而不是被静默丢弃或带进领域对象。
 * 列缺失同样失败（PG 对 SELECT 列表中存在的列一定返回键，缺键说明驱动或 SQL 已被改动）。
 */
const postgresGroupRowSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(100),
    description: z.string().max(5000).nullable(),
    research_directions: z.array(z.string().min(1)).min(1),
    // jsonb 单列先用 unknown 接住，随后用共享 schema 的严格版本校验形状
    recruitment_requirements: z.unknown(),
    leader_user_id: uuidSchema,
    status: z.enum(GROUP_STATUS_VALUES),
    created_at: z.union([z.date(), z.string()]),
    updated_at: z.union([z.date(), z.string()]),
  })
  .strict();

/** 招募要求：共享 schema 的严格版本（jsonb 出现未登记键即 fail-closed） */
const strictRecruitmentRequirementsSchema = recruitmentRequirementsSchema.strict();

/** 写入记录契约：读取契约的严格版本（调用方不得通过领域对象夹带未登记字段） */
const strictWritableGroupSchema = storedGroupSchema.strict();

/** 只保留字段路径与违规类型，绝不含字段取值 */
function describeIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}(${issue.code})`);
}

function invalidRow(error: z.ZodError, label = 'row'): PostgresGroupRepositoryError {
  return new PostgresGroupRepositoryError(
    'INVALID_ROW',
    `数据库行不符合 postgres 行契约（${label}）`,
    describeIssues(error),
  );
}

/** 时间列 → ISO 字符串；坏时间戳 fail-closed（不产生 `Invalid Date` 之类的半成品） */
function toIsoTimestamp(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PostgresGroupRepositoryError('INVALID_ROW', `时间列不是合法时间戳：${label}`, [
      label,
    ]);
  }
  return date.toISOString();
}

/** 招募要求逐字段复制：不把驱动的内部引用交给上层 */
function copyRequirements(
  requirements: RecruitmentRequirementsInput,
): RecruitmentRequirementsInput {
  return {
    ...(requirements.skills ? { skills: [...requirements.skills] } : {}),
    ...(requirements.grades ? { grades: [...requirements.grades] } : {}),
    ...(requirements.minWeeklyHours !== undefined
      ? { minWeeklyHours: requirements.minWeeklyHours }
      : {}),
    ...(requirements.headcount !== undefined ? { headcount: requirements.headcount } : {}),
    ...(requirements.note ? { note: requirements.note } : {}),
  };
}

/**
 * 行 → 领域记录：**逐字段显式映射**（不使用展开），再整体过一次读取契约。
 *
 * 顺序刻意如此：先按严格行契约解析（拒绝未登记列 / 非法类型），再显式取字段构造新对象
 * （即使行里有额外内容也不会被带出），最后用 `parseStoredGroup` 复核共享读取契约
 * （枚举闭集 + ISO 时间格式），任一环节不合规都抛错。
 */
function mapRow(row: unknown): ResearchGroup {
  const parsedRow = postgresGroupRowSchema.safeParse(row);
  if (!parsedRow.success) {
    throw invalidRow(parsedRow.error);
  }
  const dbRow = parsedRow.data;

  const parsedRequirements = strictRecruitmentRequirementsSchema.safeParse(
    dbRow.recruitment_requirements,
  );
  if (!parsedRequirements.success) {
    throw invalidRow(parsedRequirements.error, 'recruitment_requirements');
  }

  const record = {
    id: dbRow.id,
    name: dbRow.name,
    ...(dbRow.description ? { description: dbRow.description } : {}),
    // 数组复制：不把驱动持有的数组交给上层
    researchDirections: [...dbRow.research_directions],
    recruitmentRequirements: copyRequirements(parsedRequirements.data),
    leaderUserId: dbRow.leader_user_id,
    status: dbRow.status,
    createdAt: toIsoTimestamp(dbRow.created_at, 'created_at'),
    updatedAt: toIsoTimestamp(dbRow.updated_at, 'updated_at'),
  };

  const parsedRecord = parseStoredGroup(record);
  if (!parsedRecord.ok) {
    throw new PostgresGroupRepositoryError(
      'INVALID_ROW',
      '数据库行映射后不符合小组读取契约',
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
    throw new PostgresGroupRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      '未提供 SQL 执行器：PostgreSQL 小组仓储拒绝在半可用状态下构造或调用',
      ['executor'],
    );
  }
  const candidate = executor as { query?: unknown; capabilities?: unknown };
  if (typeof candidate.query !== 'function') {
    throw new PostgresGroupRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器缺少 query 方法：PostgreSQL 小组仓储拒绝在半可用状态下构造或调用',
      ['executor.query'],
    );
  }
  const capabilities = candidate.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new PostgresGroupRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器未声明能力（backend/persistent/productionReady）',
      ['executor.capabilities'],
    );
  }
  const { backend, persistent } = capabilities as { backend?: unknown; persistent?: unknown };
  if (typeof backend !== 'string' || backend.trim() === '') {
    throw new PostgresGroupRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器的能力声明缺少 backend 标识',
      ['executor.capabilities.backend'],
    );
  }
  if (!/^postgres/iu.test(backend.trim())) {
    throw new PostgresGroupRepositoryError(
      'EXECUTOR_NOT_POSTGRES',
      'SQL 执行器声明的后端不是 PostgreSQL：拒绝把本 adapter 挂到其他存储上',
      ['executor.capabilities.backend'],
    );
  }
  if (persistent !== true) {
    throw new PostgresGroupRepositoryError(
      'EXECUTOR_NOT_PERSISTENT',
      'SQL 执行器声明为非持久后端（内存替身）：PostgreSQL 小组仓储拒绝在其上运行',
      ['executor.capabilities.persistent'],
    );
  }
  return executor as SqlExecutor;
}

/** 可见性查询的 fail-closed 校验：形状、类型、UUID；返回值是**副本**，且已去重 */
export function assertPostgresGroupVisibilityQuery(query: unknown): GroupVisibilityQuery {
  if (typeof query !== 'object' || query === null) {
    throw new PostgresGroupRepositoryError('INVALID_QUERY', '可见性查询必须是对象', ['query']);
  }
  const candidate = query as { includeAllOpenGroups?: unknown; visibleGroupIds?: unknown };
  if (typeof candidate.includeAllOpenGroups !== 'boolean') {
    throw new PostgresGroupRepositoryError(
      'INVALID_QUERY',
      '可见性查询的 includeAllOpenGroups 必须是布尔值（集合级判定产物）',
      ['includeAllOpenGroups'],
    );
  }
  if (!Array.isArray(candidate.visibleGroupIds)) {
    throw new PostgresGroupRepositoryError(
      'INVALID_QUERY',
      '可见性查询的 visibleGroupIds 必须是数组（服务端逐条判定产物）',
      ['visibleGroupIds'],
    );
  }
  const visibleGroupIds: string[] = [];
  for (const [index, value] of candidate.visibleGroupIds.entries()) {
    const parsed = uuidSchema.safeParse(value);
    if (!parsed.success) {
      // 非 UUID 的可见 ID 属于服务端缺陷：它会让 `uuid[]` 转换失败或退化为「放弃类型约束」，
      // 因此在这里 fail-closed，绝不绑定进 SQL（错误信息也不回显该值本身）。
      throw new PostgresGroupRepositoryError(
        'INVALID_QUERY',
        'visibleGroupIds 必须全部是合法 UUID（非 UUID 的可见 ID 属于服务端缺陷）',
        [`visibleGroupIds.${index}`],
      );
    }
    visibleGroupIds.push(parsed.data);
  }
  return {
    includeAllOpenGroups: candidate.includeAllOpenGroups,
    // 去重是集合语义：`ANY` 与内存基线的 `includes` 都不关心重复项
    visibleGroupIds: [...new Set(visibleGroupIds)],
  };
}

/** 窗口的 fail-closed 校验：只校验类型与整数性，不校验业务上下界（由共享 paginationSchema 负责） */
export function assertPostgresGroupListWindow(window: unknown): GroupListWindow {
  if (typeof window !== 'object' || window === null) {
    throw new PostgresGroupRepositoryError('INVALID_WINDOW', '取数窗口必须是对象', ['window']);
  }
  const candidate = window as { offset?: unknown; limit?: unknown };
  for (const key of ['offset', 'limit'] as const) {
    const value = candidate[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new PostgresGroupRepositoryError(
        'INVALID_WINDOW',
        `取数窗口的 ${key} 必须是非负安全整数（服务端缺陷，不得进入 SQL）`,
        [key],
      );
    }
  }
  return { offset: candidate.offset as number, limit: candidate.limit as number };
}

/** 写入记录校验：读取契约的严格版本 + 归属必须是可用 UUID（非空） */
function assertWritableRecord(record: unknown): ResearchGroup {
  const parsed = strictWritableGroupSchema.safeParse(record);
  if (!parsed.success) {
    throw new PostgresGroupRepositoryError(
      'INVALID_RECORD',
      '待写入的小组记录不符合读取契约的严格版本（含未登记字段或非法取值）',
      describeIssues(parsed.error),
    );
  }
  if (parsed.data.leaderUserId === NIL_UUID) {
    throw new PostgresGroupRepositoryError(
      'INVALID_RECORD',
      '待写入的小组记录缺少有效负责人（空 UUID）：负责人必须由服务端会话主体写入',
      ['leaderUserId'],
    );
  }
  return parsed.data;
}

/**
 * 结果集形状 fail-closed：执行器必须返回对象且带 `rows` 数组。
 * 「少字段 / 类型不对」属于驱动或替身实现缺陷，不得被当成「空结果」静默放过
 * （否则会把基础设施故障伪装成「没有可见小组」）。
 */
function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new PostgresGroupRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果不是对象（驱动 / 替身实现缺陷）',
      ['result'],
    );
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new PostgresGroupRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果缺少 rows 数组（驱动 / 替身实现缺陷）',
      ['rows'],
    );
  }
  return rows;
}

/** 从 `COUNT(*)::bigint` 的返回值解析出安全整数（字符串 / 数字 / bigint 均接受） */
function parseCount(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PostgresGroupRepositoryError('INVALID_ROW', '计数结果不是非负安全整数', ['total']);
    }
    return value;
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PostgresGroupRepositoryError('INVALID_ROW', '计数结果超出安全整数范围', ['total']);
    }
    return Number(value);
  }
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  throw new PostgresGroupRepositoryError(
    'INVALID_ROW',
    '计数结果不是可解析的非负整数（不接受 NaN / 负数 / 小数 / 非数字文本）',
    ['total'],
  );
}

/**
 * 基于 `SqlExecutor` 的 PostgreSQL 小组仓储。
 *
 * 构造与每次调用都会重新校验执行器（`assertUsableExecutor`）与自身能力声明，
 * 因此「执行器被换掉 / 被降级」或「能力声明被改写」都会 fail-closed，而不是静默继续。
 * 本类**不是** Nest provider：装配只发生在 `groups.module.ts` 的工厂里
 * （`createLazyPostgresGroupRepository` 持有它，并在每次调用时按需构造）。
 */
export class PostgresGroupRepository implements GroupRepository {
  readonly capabilities: GroupRepositoryCapabilities = POSTGRES_GROUP_REPOSITORY_CAPABILITIES;

  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    assertPostgresGroupRepositoryCapabilities(this.capabilities);
    this.executor = assertUsableExecutor(executor);
  }

  /** 每次调用前的自检：能力声明与执行器都必须仍然可用 */
  private usableExecutor(): SqlExecutor {
    assertPostgresGroupRepositoryCapabilities(this.capabilities);
    return assertUsableExecutor(this.executor);
  }

  /**
   * 写入一条已由 service 校验并补齐负责人 / 状态的记录。
   *
   * - `leaderUserId` 必须是服务端会话主体（空 UUID / 非法 UUID / 未登记字段一律拒绝）；
   * - 主键冲突（`ON CONFLICT DO NOTHING` 无返回行）显式抛错，不静默覆盖；
   * - 返回行必须能通过严格行契约与读取契约，且**主键与负责人**都必须等于请求写入的记录
   *   （数据库回流出「他人记录」或归属被改写时判服务端缺陷）。
   */
  async create(group: ResearchGroup): Promise<ResearchGroup> {
    const executor = this.usableExecutor();
    const record = assertWritableRecord(group);

    const result = await executor.query(INSERT_SQL, [
      record.id,
      record.name,
      record.description ?? null,
      [...record.researchDirections],
      copyRequirements(record.recruitmentRequirements),
      record.leaderUserId,
      record.status,
      record.createdAt,
      record.updatedAt,
    ]);

    const rows = rowsOf(result);
    if (rows.length === 0) {
      // 主键冲突（ON CONFLICT DO NOTHING）属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new PostgresGroupRepositoryError('CONFLICT', `小组 ID 冲突: ${record.id}`, ['id']);
    }
    if (rows.length > 1) {
      throw new PostgresGroupRepositoryError(
        'RESULT_SET_VIOLATION',
        '写入语句返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const created = mapRow(rows[0]);
    if (created.id !== record.id) {
      // 纵深防御：返回的必须是刚写入的那条记录（主键一致），否则可能是他人记录
      throw new PostgresGroupRepositoryError(
        'IDENTITY_MISMATCH',
        '返回记录的主键与请求写入的主键不一致（他人记录不得作为写入结果回流）',
        ['id'],
      );
    }
    if (created.leaderUserId !== record.leaderUserId) {
      // 纵深防御：归属被改写或返回了他人记录，属服务端缺陷，不得作为写入结果返回
      throw new PostgresGroupRepositoryError(
        'IDENTITY_MISMATCH',
        '返回记录的负责人与请求写入的负责人不一致（他人归属不得回流）',
        ['leader_user_id'],
      );
    }
    return created;
  }

  /**
   * 返回对调用方可见的开放小组（分页窗口内）。
   *
   * 可见范围完全来自 `query`（服务端判定产物）；窗口下推为 `LIMIT/OFFSET`。
   * 返回结果会被**逐条复核**：非开放状态、不在判定范围内、行数超过窗口或出现重复 id
   * 都判服务端缺陷并 fail-closed，避免「SQL 写错 / 被改写」把别人的小组交给上层。
   */
  async listVisibleGroups(
    query: GroupVisibilityQuery,
    window: GroupListWindow,
  ): Promise<readonly ResearchGroup[]> {
    const executor = this.usableExecutor();
    const visibility = assertPostgresGroupVisibilityQuery(query);
    const { offset, limit } = assertPostgresGroupListWindow(window);

    const result = await executor.query(LIST_SQL, [
      visibility.includeAllOpenGroups,
      [...visibility.visibleGroupIds],
      limit,
      offset,
    ]);

    const rows = rowsOf(result);
    if (rows.length > limit) {
      throw new PostgresGroupRepositoryError(
        'RESULT_SET_VIOLATION',
        '返回行数超过取数窗口：窗口下推失效（数据库或 SQL 已被改动）',
        ['limit'],
      );
    }

    const records = rows.map((row) => mapRow(row));
    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id)) {
        throw new PostgresGroupRepositoryError(
          'RESULT_SET_VIOLATION',
          '返回结果包含重复小组 ID：结果集违反取数契约',
          ['id'],
        );
      }
      seen.add(record.id);
      if (!isGroupApplicable(record.status)) {
        throw new PostgresGroupRepositoryError(
          'VISIBILITY_VIOLATION',
          '返回了非开放状态的小组（本端点只输出开放小组）',
          ['status'],
        );
      }
      if (!visibility.includeAllOpenGroups && !visibility.visibleGroupIds.includes(record.id)) {
        throw new PostgresGroupRepositoryError(
          'VISIBILITY_VIOLATION',
          '返回了授权判定范围之外的小组（越权取数不得回流）',
          ['id'],
        );
      }
    }
    return records;
  }

  /**
   * 可见小组总数（不受窗口影响）。
   *
   * 与 `listVisibleGroups` 共用同一套谓词；`COUNT(*)` 恒返回一行，因此「没有返回行」
   * 属服务端缺陷（fail-closed），不会静默当成 0。
   */
  async countVisibleGroups(query: GroupVisibilityQuery): Promise<number> {
    const executor = this.usableExecutor();
    const visibility = assertPostgresGroupVisibilityQuery(query);

    const result = await executor.query(COUNT_SQL, [
      visibility.includeAllOpenGroups,
      [...visibility.visibleGroupIds],
    ]);

    const rows = rowsOf(result);
    if (rows.length !== 1) {
      throw new PostgresGroupRepositoryError(
        'INVALID_ROW',
        '计数语句必须恰好返回一行（COUNT 语义）',
        ['rows'],
      );
    }
    const row = rows[0] as { total?: unknown } | undefined;
    return parseCount(row?.total);
  }
}

/** DI 工厂：把驱动无关的 `SqlExecutor` 装成小组仓储端口实现（本切片的换绑点之一） */
export function createPostgresGroupRepository(executor: SqlExecutor): GroupRepository {
  return new PostgresGroupRepository(executor);
}

/**
 * 把「负责人必须落在存储 ID 域内」变成可**先于建连**执行的断言（供分流点、service 与测试复用）。
 *
 * 写路径的负责人是服务端会话主体（`subject.userId`），`research_groups.leader_user_id` 是 `uuid`。
 * 非 UUID（例如会话基线的 `u-student-1`）或空 UUID 都不是可用负责人：延迟建连的实现必须在
 * 解析执行器**之前**判定它，否则一个不合法的会话主体会先触发一次数据库连接、再在 adapter 里被拒绝——
 * 那既浪费连接，也让「主体域判定发生在任何连接之前」这条性质无法被测试固定。
 * 错误信息只含字段路径，不含主体取值。
 */
export function assertPostgresGroupLeaderSubject(leaderUserId: unknown): string {
  const parsed = uuidSchema.safeParse(leaderUserId);
  if (!parsed.success) {
    throw new PostgresGroupRepositoryError(
      'INVALID_RECORD',
      '负责人必须由服务端会话主体写入且必须是合法 UUID：非存储 ID 域的主体拒绝进入数据库路径',
      ['leaderUserId'],
    );
  }
  if (parsed.data === NIL_UUID) {
    throw new PostgresGroupRepositoryError(
      'INVALID_RECORD',
      '负责人是空 UUID（不是可用主体）：拒绝进入数据库路径',
      ['leaderUserId'],
    );
  }
  return parsed.data;
}

/** 待写记录的主体域：`leaderUserId` 必须先于建连通过 `assertPostgresGroupLeaderSubject` */
function leaderSubjectOf(record: unknown): string {
  if (typeof record !== 'object' || record === null) {
    throw new PostgresGroupRepositoryError('INVALID_RECORD', '待写入的小组记录必须是对象', [
      'record',
    ]);
  }
  return assertPostgresGroupLeaderSubject((record as { leaderUserId?: unknown }).leaderUserId);
}

/**
 * 延迟建连的 PostgreSQL 小组仓储：**模块装配阶段不碰数据库**。
 *
 * 为什么必须延迟：`SQL_CONNECTION_FACTORY.connect()` 在数据库已配置但执行器未通过 attest 契约时
 * 会抛错。如果在这里急切建连，启动失败会表现为「模块工厂抛了数据库错」，而不是启动期持久化边界
 * 给出的**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED` / `DECLARATION_NOT_SEALED` 等）；
 * 依赖就绪门禁也必须能在**任何连接之前**给出 `GROUP_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`。
 * 延迟后，判定顺序保持为「配置 → 持久化边界 / 依赖就绪 → 首次真正读库」。
 *
 * 连接只在首次读写时建立并被复用；建立失败不缓存失败结果（下一次调用会重试）。
 *
 * **存储 ID 域先判、再建连**：可见范围与负责人必须落在 UUID 域内，因此
 * `visibleGroupIds` 里的非 UUID 标识、以及非 UUID 的负责人，都会在解析执行器**之前**被拒绝，
 * 不会触发任何数据库连接（`INVALID_QUERY` / `INVALID_RECORD`）。
 */
export function createLazyPostgresGroupRepository(
  resolveExecutor: () => Promise<SqlExecutor>,
  capabilities: GroupRepositoryCapabilities = POSTGRES_GROUP_REPOSITORY_CAPABILITIES,
): GroupRepository {
  assertPostgresGroupRepositoryCapabilities(capabilities);

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
    async create(group: ResearchGroup): Promise<ResearchGroup> {
      // 主体域先判、再建连：非法负责人的记录不应该触发任何数据库连接
      leaderSubjectOf(group);
      const resolved = await executor();
      return new PostgresGroupRepository(resolved).create(group);
    },
    async listVisibleGroups(
      query: GroupVisibilityQuery,
      window: GroupListWindow,
    ): Promise<readonly ResearchGroup[]> {
      // 可见 ID 域与窗口形状先判、再建连（两者都是服务端判定产物，非法即服务端缺陷）
      const visibility = assertPostgresGroupVisibilityQuery(query);
      const listWindow = assertPostgresGroupListWindow(window);
      const resolved = await executor();
      return new PostgresGroupRepository(resolved).listVisibleGroups(visibility, listWindow);
    },
    async countVisibleGroups(query: GroupVisibilityQuery): Promise<number> {
      const visibility = assertPostgresGroupVisibilityQuery(query);
      const resolved = await executor();
      return new PostgresGroupRepository(resolved).countVisibleGroups(visibility);
    },
  };
}
