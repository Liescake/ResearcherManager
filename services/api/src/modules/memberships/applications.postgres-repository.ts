import { z } from 'zod';
import {
  APPLICATION_KIND_VALUES,
  APPLICATION_STATUS_TRANSITIONS,
  APPLICATION_STATUS_VALUES,
  ApplicationStatus,
  uuidSchema,
} from '@rm/shared';
import type { SqlExecutor } from '../../db/ports/sql-executor.port';
import { parseStoredApplication, storedApplicationSchema } from './applications.contract';
import {
  APPLICATION_REPOSITORY_BACKEND_POSTGRES,
  type Application,
  type ApplicationRepositoryCapabilities,
  type AsyncApplicationRepository,
} from './applications.port';

/**
 * 入组申请的 **PostgreSQL 仓储 adapter（首个可验证实现，未接入运行时）**。
 *
 * ## 交付边界（本切片刻意不做的事）
 * - **不绑定**到 `MembershipsModule`：模块仍然只绑定内存基线 `InMemoryApplicationRepository`
 *   （provider 列表与 DI 令牌一字未改），运行时行为与本切片之前逐字节一致（有回归断言，
 *   见同名 spec）；
 * - **不引入** `pg` / Prisma / TypeORM 等驱动或 ORM 依赖：本文件只依赖驱动无关的
 *   `SqlExecutor` 端口（`db/ports/sql-executor.port.ts`），真实执行器由消费方在「启用数据库」
 *   那一步显式提供；
 * - **不声称生产可用**：能力声明固定为 `backend = postgres`、`persistent = true`、
 *   `productionReady = false`。在引入经评估的驱动、完成对真实 PostgreSQL 的集成验证、并把
 *   `join_applications` 从字段字典落成 schema 草案 → 迁移之前，生产启动会被
 *   `PersistenceBoundaryService` 拒绝（`productionReady !== true` 即违规）。
 *
 * ## 为什么先有异步契约
 * 现有 `ApplicationRepository`（`applications.port.ts`）是同步接口；把运行时端口改成 Promise 是
 * 跨模块契约变更（service / controller / 既有 spec 必须一起改），必须与真实驱动引入在同一片
 * 切片完成。因此本文件实现 `AsyncApplicationRepository`（Promise 版，语义与内存基线完全一致），
 * 让「SQL 与映射是否正确」可以在**没有驱动、也没有数据库**的情况下被离线验证。
 *
 * ## 与内存基线的语义对应（逐条可核对）
 * | 内存基线 | 本 adapter |
 * |---|---|
 * | `create` 同 ID 冲突抛错 | `INSERT … ON CONFLICT (id) DO NOTHING` 无返回行 → `CONFLICT` |
 * | `findById` 未命中返回 `undefined` | `WHERE id = $1 AND user_id = $2` 无行 → `undefined` |
 * | `listByUserId` 只返回该主体记录 | `WHERE user_id = $1`（归属下推）+ 逐条归属复核 |
 * | `listByUserAndGroup` 只按字段过滤 | `WHERE user_id = $1 AND group_id = $2`（**无状态谓词**） |
 * | `save` 记录不存在抛错 | 条件写入未命中 + 诊断查询无行 → `NOT_FOUND` |
 *
 * 与内存基线的**唯一刻意差异**：内存基线是「同进程直接覆盖」，因此非法状态转移在存储层没有
 * 拦截点；数据库实现必须防并发与绕过路径，因此把「本次转移是否合法」下推为**条件写入**
 * （前驱集合由共享状态机派生）。所有**合法**转移的语义逐字节一致；**非法**转移一律
 * fail-closed 且不产生任何写入。
 *
 * ## 安全边界（本文件的六条硬约束）
 * 1. **参数化 SQL + 固定标识符**：所有客户端可控的值一律走 `$1…$n` 占位符绑定；进入 SQL 文本的
 *    只有模块常量（表名、列清单、状态机派生的谓词），且都经过 `assertSqlIdentifier` 校验，
 *    不存在任何「值 → SQL 文本」的路径（占位符与参数由同一份列清单派生，不会数量漂移）；
 * 2. **显式字段映射 + 严格行契约**：数据库行必须满足严格（`.strict()`）的行契约（未知列、
 *    非法枚举、非 UUID、坏时间戳一律拒绝），再**逐字段显式映射**为领域记录（列 → 字段的对应
 *    关系由 `POSTGRES_APPLICATION_COLUMN_FIELDS` 单一事实来源给出，并由
 *    `Record<keyof Application, …>` 在编译期强制完整），最后再过一次
 *    `applications.contract.ts` 的读取契约；任何一步不合规都 **fail-closed** 抛错，
 *    绝不把未登记字段、未知状态或半成品记录交给上层；
 * 3. **subject / 归属隔离**：`userId` 必须由调用方（service）从服务端会话主体写入，必须是合法、
 *    非空、规范小写形的 UUID（**存储 ID 域约束**，见 `applications.port.ts`）；adapter
 *    不生成、不覆盖归属，并且**把归属下推进 SQL**：列表、按小组取数与单条读取都只返回请求主体
 *    的记录；返回行上再逐条复核归属（不一致即 `OWNER_VIOLATION`）——他人记录既不出库、
 *    也不得回流；
 * 4. **状态闭集 + 状态转移 fail-closed**：`status` 只接受共享状态机闭集内的取值；`save` 把
 *    「目标状态是否可由当前存储状态到达」派生为 `status::text = ANY($n::text[])` 条件谓词，
 *    非法转移**不命中任何行**、不产生任何写入，并由一次**归属范围内**的诊断查询区分
 *    `NOT_FOUND`（记录不存在/归属不符）与 `TRANSITION_REJECTED`（转移非法）；
 *    `pending` 没有任何前驱，因此 `save` 也**无法把记录写回待审核**；
 * 5. **公开视图不携带归属与审核内部字段**：adapter 只在**内部存储记录**上承载 `userId` /
 *    审核人 / 审核意见 / 审核时间（不静默丢弃），对外裁剪由 `applications.contract.ts` 的
 *    `toApplicationView` 负责（`POSTGRES_APPLICATION_VIEW_EXCLUDED_COLUMNS` 给出本 adapter 侧
 *    不进入公开输出的列清单，`POSTGRES_APPLICATION_REVIEW_INTERNAL_COLUMNS` 给出审核内部列）；
 * 6. **个人级内容只走内部存储契约**：`note`（字段字典：个人级）与 `review_comment`（审核内部记录）
 *    在本人自读范围内是合法内容，因此**不做对外裁剪以外的加工**，但**绝不**写进错误消息与日志；
 *    错误消息**只带字段路径与违规类型**，避免把数据内容或注入载荷写进日志与错误响应。
 *
 * ## 尚未解决 / 已登记的前置（因此 productionReady 恒为 false）
 * `db/migrations/0001_bootstrap.sql` 只在注释里登记了 `join_applications` 的建表计划，
 * 该表既没有 schema 草案也没有迁移；真实 PostgreSQL 的集成验证（建表、`id` 主键冲突、
 * `user_id` 索引、按归属取数与排序、并发状态转移）尚未进行；并发非法转移的对外映射
 * （409 而不是 500）也尚未接入 service。这些都已登记在
 * `POSTGRES_APPLICATION_REPOSITORY_VERIFICATION_STEPS` 里，不能只写声明。
 */

/** 表名：与 docs/P1-字段级数据字典.md 及 `0001_bootstrap.sql` 注释里的 `join_applications` 一致 */
export const POSTGRES_APPLICATION_TABLE = 'join_applications';

/**
 * 列清单：同时定义 `SELECT` 输出列、`INSERT` 列顺序与 `RETURNING` 输出列。
 *
 * 刻意不写 `SELECT *`：存储层新增列（软删除时间、审计字段、幂等键）不会因为本文件
 * 没更新就自动流进领域对象；配合行契约的 `.strict()`，未登记列会被显式拒绝而不是被静默带出。
 *
 * 审核留痕（`reviewed_by_user_id` / `review_comment` / `reviewed_at`）**在本清单内**：
 * 它们是 `Application` 记录的组成部分，读取契约也校验它们的存储形状。把它们排除在外会让
 * 「已被审核的申请」整行无法读取（行契约 `unknown key` 失败），也会让 `save` 的审核推进静默
 * 丢掉审核人/意见/时间。因此这里**承载**它们，但通过
 * `POSTGRES_APPLICATION_REVIEW_INTERNAL_COLUMNS` + 公开视图裁剪清单明确它们**不进入公开输出**。
 */
export const POSTGRES_APPLICATION_COLUMNS = [
  'id',
  'user_id',
  'group_id',
  'kind',
  'note',
  'status',
  'reviewed_by_user_id',
  'review_comment',
  'reviewed_at',
  'created_at',
  'updated_at',
] as const;

/** 列 → 领域字段的唯一事实来源（编译期强制覆盖 `Application` 的全部字段） */
export const POSTGRES_APPLICATION_COLUMN_FIELDS = Object.freeze({
  id: 'id',
  user_id: 'userId',
  group_id: 'groupId',
  kind: 'kind',
  note: 'note',
  status: 'status',
  reviewed_by_user_id: 'reviewedByUserId',
  review_comment: 'reviewComment',
  reviewed_at: 'reviewedAt',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
} as const satisfies Record<(typeof POSTGRES_APPLICATION_COLUMNS)[number], keyof Application>);

/**
 * 归属列：只在服务端内部流转，同时也是 SQL 归属谓词（`WHERE user_id = $n`）唯一使用的列。
 * 它**不进入**公开视图，也绝不进入错误消息与日志（他人归属不得回流、也不得外泄）。
 */
export const POSTGRES_APPLICATION_OWNER_COLUMNS: readonly (typeof POSTGRES_APPLICATION_COLUMNS)[number][] =
  Object.freeze(['user_id']);

/**
 * 个人级 / 内部记录内容列（字段字典：`note` 个人级；`review_comment` 为审核内部记录）：
 * 在**本人自读**范围内是合法内容，因此不额外裁剪为「不可读」；但**绝不**写进错误消息与日志。
 */
export const POSTGRES_APPLICATION_PII_COLUMNS: readonly (typeof POSTGRES_APPLICATION_COLUMNS)[number][] =
  Object.freeze(['note', 'review_comment']);

/**
 * 审核内部字段：**在本 adapter 的列清单内**（存储记录必须完整承载，否则已审核的申请整行不可读、
 * 且 `save` 会静默丢掉审核留痕），但**必须**出现在公开视图裁剪清单里，绝不进入对外输出。
 */
export const POSTGRES_APPLICATION_REVIEW_INTERNAL_COLUMNS: readonly (typeof POSTGRES_APPLICATION_COLUMNS)[number][] =
  Object.freeze(['reviewed_by_user_id', 'review_comment', 'reviewed_at']);

/**
 * 本 adapter 侧**不进入公开输出**的列：归属 + 全部审核内部字段。
 *
 * 对外裁剪由 `toApplicationView` 负责（逐字段显式赋值、不展开），本清单用于机器校验
 * 「adapter 不把归属与审核留痕投影出去」，与「自读范围下响应里没有可回传的归属/审核信息」
 * 这一契约一致。
 */
export const POSTGRES_APPLICATION_VIEW_EXCLUDED_COLUMNS: readonly (typeof POSTGRES_APPLICATION_COLUMNS)[number][] =
  Object.freeze(['user_id', 'reviewed_by_user_id', 'review_comment', 'reviewed_at']);

/**
 * 写回（`save`）允许变更的列：审核推进与撤回只改这些。
 *
 * 刻意**不含** `id` / `user_id` / `group_id` / `kind` / `created_at`：它们由
 * `POSTGRES_APPLICATION_IMMUTABLE_COLUMNS` 声明为不可变，写回后逐条复核（不一致即
 * `IDENTITY_MISMATCH` / `OWNER_VIOLATION`），因此「改写归属」「把申请搬到别的小组」
 * 「改类型」「改创建时间」四条路径在存储层被关闭，而不是靠调用方自律。
 */
export const POSTGRES_APPLICATION_MUTABLE_COLUMNS = [
  'note',
  'status',
  'reviewed_by_user_id',
  'review_comment',
  'reviewed_at',
  'updated_at',
] as const satisfies readonly (typeof POSTGRES_APPLICATION_COLUMNS)[number][];

/** 不可变列：写回后必须与请求记录逐字节一致（`id`/`user_id` 另有专属错误码） */
export const POSTGRES_APPLICATION_IMMUTABLE_COLUMNS = [
  'id',
  'user_id',
  'group_id',
  'kind',
  'created_at',
] as const satisfies readonly (typeof POSTGRES_APPLICATION_COLUMNS)[number][];

/** 仓储能力：持久但**未验证**，因此生产环境仍会被持久化边界守卫拦下 */
export const POSTGRES_APPLICATION_REPOSITORY_CAPABILITIES: ApplicationRepositoryCapabilities =
  Object.freeze({
    backend: APPLICATION_REPOSITORY_BACKEND_POSTGRES,
    persistent: true,
    productionReady: false,
  });

/**
 * 转成生产可用前必须完成的验证清单（每一项都需要证据，不能只写声明）：
 * 1. 驱动依赖经评估后引入（`docs/P2-开源复用评估.md` 的 Prisma / TypeORM 比较结论）；
 * 2. 对真实 PostgreSQL 的集成测试：建表迁移、`id` 主键冲突、按 `user_id` / `(user_id, group_id)`
 *    取数与排序、**并发状态转移**（两个撤回请求只有一个能命中条件写入）；
 * 3. `join_applications` 的 schema 草案创建并按 `db/migrations/README.md` 转为迁移并执行验证
 *    （当前 `db/migrations/0001_bootstrap.sql` 只在注释里登记了该表；同组未终态唯一性约束必须
 *    在这一步落成**部分唯一索引**，因为本 adapter 不做唯一性判定）；
 * 4. `ApplicationRepository` 端口改为异步：service / controller 与其测试一起改；
 * 5. 会话主体 `userId` 收敛为 UUID（当前基线是 `u-student-1` 这类安全 ID，不满足存储 ID 域）；
 * 6. 请求体中的 UUID 字段（`groupId`）收敛为**规范小写形**：客户端可提交大写 UUID，
 *    而存储层不变量是规范小写（见 `requireStorageUuid`），未收敛时写路径会 fail-closed；
 * 7. `save` 的 `TRANSITION_REJECTED` 在 service 层映射为 409 `STATE_TRANSITION_INVALID`
 *    （并发重复撤回是客户端可见冲突，不是服务端缺陷，不得直接冒泡为 500）；
 * 8. 完成 1–7 后，才允许把 `productionReady` 改为 true，并同步删除能力自检
 *    （`assertPostgresApplicationRepositoryCapabilities` 会拒绝「未验证就声称生产可用」）。
 */
export const POSTGRES_APPLICATION_REPOSITORY_VERIFICATION_STEPS = [
  'driver-dependency-evaluated',
  'integration-tests-against-real-postgres',
  'join-applications-schema-draft-created-and-promoted-to-migration',
  'application-repository-port-migrated-to-async',
  'session-subject-user-ids-converged-to-uuid',
  'request-uuid-fields-normalized-to-canonical-lowercase',
  'state-transition-rejection-mapped-to-409',
  'production-ready-capability-flipped-with-evidence',
] as const;

export type PostgresApplicationRepositoryErrorCode =
  | 'CAPABILITY_MISDECLARED'
  | 'INVALID_CONFIGURATION'
  | 'EXECUTOR_UNAVAILABLE'
  | 'EXECUTOR_NOT_POSTGRES'
  | 'EXECUTOR_NOT_PERSISTENT'
  | 'INVALID_SUBJECT'
  | 'INVALID_IDENTIFIER'
  | 'INVALID_RECORD'
  | 'INVALID_ROW'
  | 'RESULT_SET_VIOLATION'
  | 'CONFLICT'
  | 'IDENTITY_MISMATCH'
  | 'OWNER_VIOLATION'
  | 'NOT_FOUND'
  | 'TRANSITION_REJECTED';

/**
 * adapter 的 fail-closed 错误。
 *
 * `issues` 只承载**字段路径与违规类型**（例如 `user_id`、`note(too_big)`、
 * `status(invalid_enum_value)`），不承载字段取值，避免把归属标识、备注/审核意见原文、
 * 注入载荷或连接信息写进日志与错误响应。
 */
export class PostgresApplicationRepositoryError extends Error {
  readonly code: PostgresApplicationRepositoryErrorCode;
  readonly issues: readonly string[];

  constructor(
    code: PostgresApplicationRepositoryErrorCode,
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PostgresApplicationRepositoryError';
    this.code = code;
    this.issues = [...issues];
  }
}

/**
 * 能力自检：**未验证的实现不得声称生产可用**。
 *
 * 任何环境都会执行（能力声明缺失属于代码缺陷，不能等生产才暴露）。
 * 生产可用性的提升必须与 `POSTGRES_APPLICATION_REPOSITORY_VERIFICATION_STEPS` 的证据、
 * 以及本断言的同步修改一起发生。
 */
export function assertPostgresApplicationRepositoryCapabilities(
  capabilities: ApplicationRepositoryCapabilities = POSTGRES_APPLICATION_REPOSITORY_CAPABILITIES,
): void {
  const issues: string[] = [];
  if (capabilities.backend !== APPLICATION_REPOSITORY_BACKEND_POSTGRES) {
    issues.push('backend');
  }
  if (capabilities.persistent !== true) {
    issues.push('persistent');
  }
  if (capabilities.productionReady !== false) {
    issues.push('productionReady');
  }
  if (issues.length > 0) {
    throw new PostgresApplicationRepositoryError(
      'CAPABILITY_MISDECLARED',
      `PostgreSQL 入组申请仓储能力声明不符（backend 必须是 ${APPLICATION_REPOSITORY_BACKEND_POSTGRES}、persistent=true、productionReady=false）：未完成驱动集成验证前不得声称生产可用`,
      issues,
    );
  }
}

/** 空 UUID：合法 UUID 但不是可用主体，读写路径一律拒绝 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * 存储 ID 域判定（单一事实来源）：合法 UUID **且**非空 **且** 规范小写形。
 *
 * 归属与范围复核是逐字节精确比较（`OWNER_VIOLATION`），而 UUID 文本在数据库侧大小写不敏感：
 * 若静默小写化，就会把「归属被改写」与「大小写差异」混成同一种静默修正；若原样绑定大写，
 * 数据库返回的规范小写形态又会与本地值不一致而误报越权。因此统一要求规范小写形。
 */
function isStorageUuid(value: unknown): value is string {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success && parsed.data !== NIL_UUID && parsed.data === parsed.data.toLowerCase();
}

/** 行契约里的存储标识列：形状 = 存储 ID 域（规范小写、非空），与写入侧同一判定 */
const storageUuidSchema = uuidSchema.refine(isStorageUuid, '必须是规范小写形的非空 UUID');

/** SQL 标识符白名单：只允许小写字母开头的裸标识符，杜绝用「列名 / 表名」夹带 SQL 片段 */
const SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/u;

function assertSqlIdentifier(value: string, label: string): string {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new PostgresApplicationRepositoryError(
      'INVALID_CONFIGURATION',
      `SQL 标识符不合规（必须是裸小写标识符）：${label}`,
      [label],
    );
  }
  return value;
}

/** 模块加载即校验：表名与列名一旦被改成非标识符形状，直接 fail-closed（不静默拼进 SQL） */
const TABLE_IDENTIFIER = assertSqlIdentifier(POSTGRES_APPLICATION_TABLE, 'table');
const COLUMN_LIST = POSTGRES_APPLICATION_COLUMNS.map((column) =>
  assertSqlIdentifier(column, 'column'),
).join(', ');

/** 逐列的类型转换：只在「列 → 参数占位」这一步使用，值本身永远不进入 SQL 文本 */
const COLUMN_PARAMETER_CASTS: Partial<
  Record<(typeof POSTGRES_APPLICATION_COLUMNS)[number], string>
> = {
  id: '::uuid',
  user_id: '::uuid',
  group_id: '::uuid',
  reviewed_by_user_id: '::uuid',
  reviewed_at: '::timestamptz',
  created_at: '::timestamptz',
  updated_at: '::timestamptz',
};

/** `VALUES ($1::uuid, $2::uuid, …)`：占位符与列一一对应，由列清单派生，不会出现数量漂移 */
const INSERT_VALUES = POSTGRES_APPLICATION_COLUMNS.map(
  (column, index) => `$${index + 1}${COLUMN_PARAMETER_CASTS[column] ?? ''}`,
).join(', ');

/**
 * 写入语句：客户端可控值全部走 `$n`；`ON CONFLICT (id) DO NOTHING` 让**主键冲突显式暴露**
 * （与内存基线 `create` 抛「入组申请 ID 冲突」同语义：入库记录 ID 由服务端生成，
 * 冲突属于服务端缺陷，不得静默覆盖、也没有任何可覆盖的列）。
 * 刻意**没有** `DO UPDATE`：本端口只提供创建，任何「写入即改写」都会绕过状态机与留痕切片。
 * `RETURNING` 让写入结果可被严格行契约复核（而不是「写完就当成功」）。
 *
 * 注意：这里**没有**任何「同用户同小组未终态唯一性」的子查询或约束（本 adapter 不理解终态语义，
 * 见 `listByUserAndGroup`）；该约束属于 service 判定 + 后续迁移的部分唯一索引。
 */
const INSERT_SQL = `INSERT INTO ${TABLE_IDENTIFIER} (
  ${COLUMN_LIST}
) VALUES (${INSERT_VALUES})
ON CONFLICT (id) DO NOTHING
RETURNING ${COLUMN_LIST}`;

/**
 * 排序键：`created_at ASC, id ASC`——与内存基线的插入顺序一致（service 在 append 时写入
 * `createdAt = now`），并给出逐页稳定、可复现的**全序**（后续键集分页所需的稳定排序键）。
 * 本切片**不加** `LIMIT/OFFSET`：端口还没有分页窗口，adapter 自行截断会让结果与内存基线语义
 * 不一致（同名 spec 有边界断言）。
 */
const ORDER_BY = 'ORDER BY created_at ASC, id ASC';

/**
 * 按主体取数：主体走 `$1::uuid` 绑定，**归属下推进 SQL**（他人记录既不出库也不回流）；
 * 显式列清单，不使用 `SELECT *`。
 */
const SELECT_BY_OWNER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE user_id = $1::uuid
  ${ORDER_BY}`;

/**
 * 按（主体, 目标小组）取数：两个谓词都由调用方以参数传入，**没有状态谓词**——「未终态」是共享
 * 状态机的语义，仓储不理解它（因此重复申请判定必须由 service 用 `isApplicationTerminal` 完成，
 * 并由后续迁移的部分唯一索引兜底）。
 */
const SELECT_BY_OWNER_AND_GROUP_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE user_id = $1::uuid AND group_id = $2::uuid
  ${ORDER_BY}`;

/**
 * 单条读取：`id` 与 `user_id` **同时**作为谓词，因此「只按资源 ID 命中就返回他人申请」这条路径
 * 在本 adapter 里不存在。
 */
const SELECT_BY_ID_FOR_OWNER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE id = $1::uuid AND user_id = $2::uuid`;

/** `save` 的 SET 片段：由可变列清单派生，占位符从 `$3` 起（`$1`/`$2` 留给 WHERE 的 id/user_id） */
const UPDATE_SET_LIST = POSTGRES_APPLICATION_MUTABLE_COLUMNS.map(
  (column, index) => `${column} = $${index + 3}${COLUMN_PARAMETER_CASTS[column] ?? ''}`,
).join(', ');

/** 状态转移谓词的占位符序号：可变列之后紧随其后 */
const UPDATE_PREDECESSOR_PARAMETER = POSTGRES_APPLICATION_MUTABLE_COLUMNS.length + 3;

/**
 * 写回语句：**条件写入**。`WHERE` 同时钉住 `id`、`user_id` 与「状态必须落在目标状态的合法前驱
 * 集合内」三件事：
 * - `id + user_id` ⇒ 拿他人记录的 ID 也写不中他人数据（归属隔离强化）；
 * - `status::text = ANY($n::text[])` ⇒ 非法状态转移**一行都不会被写入**，并且并发重复撤回时
 *   只有第一个请求能命中（第二个 0 行 → `TRANSITION_REJECTED`），不会覆盖既有终态。
 *
 * `status` 是列引用而非值，因此这里对列做 `::text` 转换：迁移尚未落成（`status` 可能是 `text`
 * 或枚举类型），转换让谓词与列类型声明无关，同时不影响 `id` 主键索引的命中。
 */
const UPDATE_SQL = `UPDATE ${TABLE_IDENTIFIER}
  SET ${UPDATE_SET_LIST}
  WHERE id = $1::uuid AND user_id = $2::uuid AND status::text = ANY($${UPDATE_PREDECESSOR_PARAMETER}::text[])
  RETURNING ${COLUMN_LIST}`;

/**
 * 失败分类用的诊断查询：**只在条件写入 0 行时执行**，且同样被 `id + user_id` 双重限定，
 * 因此它只读取「请求主体自己的那条记录」的状态，不做任何跨归属探测、也不回显状态取值。
 */
const SELECT_STATUS_FOR_OWNER_SQL = `SELECT status
  FROM ${TABLE_IDENTIFIER}
  WHERE id = $1::uuid AND user_id = $2::uuid`;

/**
 * 数据库行契约（**严格**）。
 *
 * `.strict()` 是「字段污染」防线：数据库返回的未登记列（`deleted_at`、`audit_event_id`、
 * `idempotency_key`、`membership_id`、PII 别名…）会让解析失败，而不是被静默丢弃或带进领域对象。
 * 列缺失同样失败（PG 对 SELECT 列表中存在的列一定返回键，缺键说明驱动或 SQL 已被改动）。
 *
 * 存储标识列使用 `storageUuidSchema`（规范小写、非空）：它把「存储层不变量」写成行契约，
 * 也让 `findById` 的「域外查询键必然无命中」成为可证明的结论而不是约定。
 *
 * 枚举闭集与列上的形状约束在这里先拦一道；**内容安全**与时间格式的最终判定交给
 * `applications.contract.ts`（映射后用 `parseStoredApplication` 复核）。
 */
const postgresApplicationRowSchema = z
  .object({
    id: storageUuidSchema,
    user_id: storageUuidSchema,
    group_id: storageUuidSchema,
    kind: z.enum(APPLICATION_KIND_VALUES),
    note: z.string().max(1000).nullable(),
    status: z.enum(APPLICATION_STATUS_VALUES),
    reviewed_by_user_id: storageUuidSchema.nullable(),
    review_comment: z.string().max(500).nullable(),
    reviewed_at: z.union([z.date(), z.string()]).nullable(),
    created_at: z.union([z.date(), z.string()]),
    updated_at: z.union([z.date(), z.string()]),
  })
  .strict();

/** 诊断查询的行契约：只取状态列，同样严格（多列/缺列都算驱动或 SQL 被改动） */
const postgresApplicationStatusRowSchema = z
  .object({ status: z.enum(APPLICATION_STATUS_VALUES) })
  .strict();

/** 写入记录契约：读取契约的严格版本（调用方不得通过领域对象夹带未登记字段） */
const strictWritableApplicationSchema = storedApplicationSchema.strict();

/** 只保留字段路径与违规类型，绝不含字段取值（归属、备注与审核意见原文不进错误消息） */
function describeIssues(error: z.ZodError): readonly string[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      // 只列出**字段名**（不是字段取值）：让「契约漂移 / 字段污染」可定位，同时不泄露数据
      return issue.keys.map((key) => `${key}(unexpected)`);
    }
    return [`${issue.path.join('.') || '(root)'}(${issue.code})`];
  });
}

function invalidRow(error: z.ZodError, label = 'row'): PostgresApplicationRepositoryError {
  return new PostgresApplicationRepositoryError(
    'INVALID_ROW',
    `数据库行不符合 postgres 行契约（${label}）`,
    describeIssues(error),
  );
}

/** 时间列 → ISO 字符串；坏时间戳 fail-closed（不产生 `Invalid Date` 之类的半成品） */
function toIsoTimestamp(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PostgresApplicationRepositoryError('INVALID_ROW', `时间列不是合法时间戳：${label}`, [
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
 * 目标状态的**合法前驱集合**：由共享状态机 `APPLICATION_STATUS_TRANSITIONS` 的**逆映射**派生
 * （顺序取自 `APPLICATION_STATUS_VALUES`，保证 SQL 参数逐字节可复现）。
 *
 * 为什么用逆映射而不是在 adapter 里再写一份转移表：状态机的唯一权威是 `@rm/shared`
 * （`assertApplicationTransition` / `canTransitionApplication`）；这里只做**求逆**，
 * 因此共享状态机新增/删除转移时，条件写入的谓词自动跟随，不会出现「两套状态机」。
 * 注意 `pending` 没有前驱：本函数返回空集合，条件写入因此永不命中——`save` 无法把记录写回待审核。
 */
export function applicationStatusPredecessors(
  status: ApplicationStatus,
): readonly ApplicationStatus[] {
  return APPLICATION_STATUS_VALUES.filter((from) =>
    APPLICATION_STATUS_TRANSITIONS[from].includes(status),
  );
}

/**
 * 行 → 领域记录：**逐字段显式映射**（不使用展开），再整体过一次读取契约。
 *
 * 顺序刻意如此：先按严格行契约解析（拒绝未登记列 / 未知枚举 / 坏 UUID / 坏时间戳 / 坏形状），
 * 再显式取字段构造新对象（即使行里有额外内容也不会被带出），最后用 `parseStoredApplication`
 * 复核共享读取契约（枚举闭集 + ISO 时间 + 内容安全 + 长度），任一环节不合规都抛错。
 */
function mapRow(row: unknown): Application {
  const parsedRow = postgresApplicationRowSchema.safeParse(row);
  if (!parsedRow.success) {
    throw invalidRow(parsedRow.error);
  }
  const dbRow = parsedRow.data;

  const note = optionalText(dbRow.note);
  const reviewedByUserId = optionalText(dbRow.reviewed_by_user_id);
  const reviewComment = optionalText(dbRow.review_comment);

  const application = {
    id: dbRow.id,
    // 归属：adapter 只承载，不生成、不覆盖；对外由 toApplicationView 裁剪
    userId: dbRow.user_id,
    groupId: dbRow.group_id,
    kind: dbRow.kind,
    ...(note ? { note } : {}),
    status: dbRow.status,
    // 审核留痕：在内部存储记录上承载（不静默丢弃），但绝不进入公开视图
    ...(reviewedByUserId ? { reviewedByUserId } : {}),
    ...(reviewComment ? { reviewComment } : {}),
    ...(dbRow.reviewed_at === null
      ? {}
      : { reviewedAt: toIsoTimestamp(dbRow.reviewed_at, 'reviewed_at') }),
    createdAt: toIsoTimestamp(dbRow.created_at, 'created_at'),
    updatedAt: toIsoTimestamp(dbRow.updated_at, 'updated_at'),
  };

  const parsedRecord = parseStoredApplication(application);
  if (!parsedRecord.ok) {
    throw new PostgresApplicationRepositoryError(
      'INVALID_ROW',
      '数据库行映射后不符合入组申请读取契约',
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
    throw new PostgresApplicationRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      '未提供 SQL 执行器：PostgreSQL 入组申请仓储拒绝在半可用状态下构造或调用',
      ['executor'],
    );
  }
  const candidate = executor as { query?: unknown; capabilities?: unknown };
  if (typeof candidate.query !== 'function') {
    throw new PostgresApplicationRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器缺少 query 方法：PostgreSQL 入组申请仓储拒绝在半可用状态下构造或调用',
      ['executor.query'],
    );
  }
  const capabilities = candidate.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new PostgresApplicationRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器未声明能力（backend/persistent/productionReady）',
      ['executor.capabilities'],
    );
  }
  const { backend, persistent } = capabilities as { backend?: unknown; persistent?: unknown };
  if (typeof backend !== 'string' || backend.trim() === '') {
    throw new PostgresApplicationRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器的能力声明缺少 backend 标识',
      ['executor.capabilities.backend'],
    );
  }
  if (!/^postgres/iu.test(backend.trim())) {
    throw new PostgresApplicationRepositoryError(
      'EXECUTOR_NOT_POSTGRES',
      'SQL 执行器声明的后端不是 PostgreSQL：拒绝把本 adapter 挂到其他存储上',
      ['executor.capabilities.backend'],
    );
  }
  if (persistent !== true) {
    throw new PostgresApplicationRepositoryError(
      'EXECUTOR_NOT_PERSISTENT',
      'SQL 执行器声明为非持久后端（内存替身）：PostgreSQL 入组申请仓储拒绝在其上运行',
      ['executor.capabilities.persistent'],
    );
  }
  return executor as SqlExecutor;
}

/**
 * **存储 ID 域约束**：主体与记录内的存储标识必须是合法、非空、且为**规范小写形**的 UUID。
 *
 * 非 UUID 的标识（例如会话基线的 `u-student-1`，或注入式载荷）会让数据库侧 `uuid`
 * 比较退化为「转换失败 / 放弃类型约束」，因此在这里 fail-closed 拒绝，
 * **绝不绑定进 SQL**（错误信息也不回显该值本身）。
 */
function requireStorageUuid(
  value: unknown,
  code: PostgresApplicationRepositoryErrorCode,
  message: string,
  label: string,
): string {
  if (!isStorageUuid(value)) {
    throw new PostgresApplicationRepositoryError(code, message, [label]);
  }
  return value;
}

/** 服务端主体：会话解析值，非法即服务端缺陷（不得静默按「查不到」处理） */
function requireSubject(userId: unknown): string {
  return requireStorageUuid(
    userId,
    'INVALID_SUBJECT',
    '取数主体必须落在存储 ID 域内（合法且非空的规范小写 UUID）：非 UUID 的 userId 属于服务端缺陷，不得进入 SQL',
    'userId',
  );
}

/**
 * 查询谓词标识（例如 `groupId`）：谓词无法正确回答时**必须 fail-closed**。
 *
 * 为什么不像单条读取那样「域外即视为不存在」：`listByUserAndGroup` 的结果会被 service 直接
 * 读成「该小组没有未终态申请」，一个被拒绝的谓词若退化成空集，就会把「无法判定」伪装成
 * 「判定为无重复」——那正是重复申请边界的漏洞所在。
 */
function requireFilterIdentifier(value: unknown, label: string): string {
  return requireStorageUuid(
    value,
    'INVALID_IDENTIFIER',
    `${label} 必须落在存储 ID 域内（合法且非空的规范小写 UUID）：谓词无法正确回答时必须 fail-closed`,
    label,
  );
}

/** 写入记录校验：读取契约的严格版本 + 存储标识列必须落在存储 ID 域内 */
function assertWritableRecord(record: unknown): Application {
  const parsed = strictWritableApplicationSchema.safeParse(record);
  if (!parsed.success) {
    throw new PostgresApplicationRepositoryError(
      'INVALID_RECORD',
      '待写入的入组申请不符合读取契约的严格版本（含未登记字段或非法取值）',
      describeIssues(parsed.error),
    );
  }
  const writable = parsed.data;
  for (const [label, value] of [
    ['id', writable.id],
    ['user_id', writable.userId],
    ['group_id', writable.groupId],
  ] as const) {
    requireStorageUuid(
      value,
      'INVALID_RECORD',
      '待写入的入组申请含不在存储 ID 域内的标识（必须是合法且非空的规范小写 UUID）',
      label,
    );
  }
  if (writable.reviewedByUserId !== undefined) {
    requireStorageUuid(
      writable.reviewedByUserId,
      'INVALID_RECORD',
      '待写入的入组申请含不在存储 ID 域内的审核人标识',
      'reviewed_by_user_id',
    );
  }
  return writable;
}

/**
 * 结果集形状 fail-closed：执行器必须返回对象且带 `rows` 数组。
 * 「少字段 / 类型不对」属于驱动或替身实现缺陷，不得被当成「空结果」静默放过
 * （否则会把基础设施故障伪装成「该主体尚无申请」）。
 */
function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new PostgresApplicationRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果不是对象（驱动 / 替身实现缺陷）',
      ['result'],
    );
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new PostgresApplicationRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果缺少 rows 数组（驱动 / 替身实现缺陷）',
      ['rows'],
    );
  }
  return rows;
}

/** 单行结果：0 行 → `NOT_FOUND`；多行 → 结果集违约（主键唯一性被破坏） */
function singleRow(rows: readonly unknown[], scope: string): unknown {
  if (rows.length === 0) {
    throw new PostgresApplicationRepositoryError('NOT_FOUND', scope, ['id']);
  }
  if (rows.length > 1) {
    throw new PostgresApplicationRepositoryError(
      'RESULT_SET_VIOLATION',
      '按主键取数返回了多行：主键唯一性被破坏',
      ['id'],
    );
  }
  return rows[0];
}

/**
 * 写入参数：**由列清单派生**（列 → 字段 → 值），因此参数顺序永远与 SQL 占位符一致；
 * `Record<keyof Application, unknown>` 让「新增领域字段但忘记补参数」成为编译错误。
 * 缺失的可选字段写 `NULL`（而不是 `undefined` 或省略列），空串同样归一为 `NULL`。
 */
function writeParameters(record: Application): readonly unknown[] {
  const values: Record<keyof Application, unknown> = {
    id: record.id,
    userId: record.userId,
    groupId: record.groupId,
    kind: record.kind,
    note: optionalText(record.note ?? null) ?? null,
    status: record.status,
    reviewedByUserId: optionalText(record.reviewedByUserId ?? null) ?? null,
    reviewComment: optionalText(record.reviewComment ?? null) ?? null,
    reviewedAt: optionalText(record.reviewedAt ?? null) ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return POSTGRES_APPLICATION_COLUMNS.map(
    (column) => values[POSTGRES_APPLICATION_COLUMN_FIELDS[column]],
  );
}

/**
 * 写回参数：`$1`/`$2` 是 WHERE 的 `id`/`user_id`，其后按**可变列清单**顺序给出值，
 * 最后一个参数是目标状态的合法前驱集合（条件谓词）。占位符与参数由同一份清单派生。
 */
function saveParameters(record: Application, predecessors: readonly string[]): readonly unknown[] {
  const values: Record<(typeof POSTGRES_APPLICATION_MUTABLE_COLUMNS)[number], unknown> = {
    note: optionalText(record.note ?? null) ?? null,
    status: record.status,
    reviewed_by_user_id: optionalText(record.reviewedByUserId ?? null) ?? null,
    review_comment: optionalText(record.reviewComment ?? null) ?? null,
    reviewed_at: optionalText(record.reviewedAt ?? null) ?? null,
    updated_at: record.updatedAt,
  };
  return [
    record.id,
    record.userId,
    ...POSTGRES_APPLICATION_MUTABLE_COLUMNS.map((column) => values[column]),
    [...predecessors],
  ];
}

/**
 * 写回后的**逐列复核**（写回语句不含这些不可变列，因此理论上它们不可能变化）。
 *
 * 复核是为了拦住「存储层触发器 / SQL 被改写 / 驱动串行错位」这类纵深风险，并让「改写归属」
 * 有专属错误码：`id` → `IDENTITY_MISMATCH`、`user_id` → `OWNER_VIOLATION`、
 * 其余 `POSTGRES_APPLICATION_IMMUTABLE_COLUMNS`（`group_id` / `kind` / `created_at`）
 * 以及本次写入的 `status` / `updated_at` → `IDENTITY_MISMATCH`。
 * 列清单与实现的对应关系由同名 spec 的**逐列行为断言**钉住（翻转任一列都会失败）。
 */
function assertWriteRoundTrip(requested: Application, stored: Application): void {
  if (stored.id !== requested.id) {
    throw new PostgresApplicationRepositoryError(
      'IDENTITY_MISMATCH',
      '返回记录的主键与请求写入的主键不一致（他人记录不得作为写入结果回流）',
      ['id'],
    );
  }
  if (stored.userId !== requested.userId) {
    throw new PostgresApplicationRepositoryError(
      'OWNER_VIOLATION',
      '返回记录的归属与请求写入的归属不一致（他人归属不得回流）',
      ['user_id'],
    );
  }
  for (const [column, requestedValue, storedValue] of [
    ['group_id', requested.groupId, stored.groupId],
    ['kind', requested.kind, stored.kind],
    ['created_at', requested.createdAt, stored.createdAt],
    ['status', requested.status, stored.status],
    ['updated_at', requested.updatedAt, stored.updatedAt],
  ] as const) {
    if (storedValue !== requestedValue) {
      throw new PostgresApplicationRepositoryError(
        'IDENTITY_MISMATCH',
        `返回记录的 ${column} 与请求写入的值不一致（不可变列 / 写入结果不得被改写）`,
        [column],
      );
    }
  }
}

/**
 * 基于 `SqlExecutor` 的 PostgreSQL 入组申请仓储。
 *
 * 构造与每次调用都会重新校验执行器（`assertUsableExecutor`）与自身能力声明，
 * 因此「执行器被换掉 / 被降级」或「能力声明被改写」都会 fail-closed，而不是静默继续。
 * 本类**不是** Nest provider（不带任何 Nest 装饰器），也未在任何模块中注册。
 */
export class PostgresApplicationRepository implements AsyncApplicationRepository {
  readonly capabilities: ApplicationRepositoryCapabilities =
    POSTGRES_APPLICATION_REPOSITORY_CAPABILITIES;

  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    assertPostgresApplicationRepositoryCapabilities(this.capabilities);
    this.executor = assertUsableExecutor(executor);
  }

  /** 每次调用前的自检：能力声明与执行器都必须仍然可用 */
  private usableExecutor(): SqlExecutor {
    assertPostgresApplicationRepositoryCapabilities(this.capabilities);
    return assertUsableExecutor(this.executor);
  }

  /** 取数结果的行映射 + 归属/范围复核（列表路径共用，避免两处语义漂移） */
  private mapScopedRows(
    rows: readonly unknown[],
    ownerId: string,
    groupId?: string,
  ): readonly Application[] {
    const records = rows.map((row) => mapRow(row));

    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id)) {
        throw new PostgresApplicationRepositoryError(
          'RESULT_SET_VIOLATION',
          '返回结果包含重复的申请 ID：结果集违反取数契约',
          ['id'],
        );
      }
      seen.add(record.id);
      if (record.userId !== ownerId) {
        throw new PostgresApplicationRepositoryError(
          'OWNER_VIOLATION',
          '返回了请求主体之外的入组申请（他人记录不得回流）',
          ['user_id'],
        );
      }
      if (groupId !== undefined && record.groupId !== groupId) {
        throw new PostgresApplicationRepositoryError(
          'RESULT_SET_VIOLATION',
          '返回了请求小组之外的入组申请：结果集违反取数契约',
          ['group_id'],
        );
      }
    }
    return records;
  }

  /**
   * 写入一条已由 service 校验并补齐归属 / 类型 / 初始状态的记录。
   *
   * - `userId` 必须是服务端会话主体（非法 UUID / 空 UUID / 非规范小写 / 未登记字段一律拒绝）；
   * - 主键冲突（`ON CONFLICT DO NOTHING` 无返回行）显式抛 `CONFLICT`，与内存基线同语义，
   *   不静默覆盖；
   * - 返回行必须能通过严格行契约与读取契约，且**主键、归属与其余不可变列**都必须等于请求写入的
   *   记录（数据库回流出「他人记录」或字段被改写时判服务端缺陷）。
   */
  async create(application: Application): Promise<Application> {
    const executor = this.usableExecutor();
    const writable = assertWritableRecord(application);

    const result = await executor.query(INSERT_SQL, writeParameters(writable));

    const rows = rowsOf(result);
    if (rows.length === 0) {
      // 主键冲突（ON CONFLICT DO NOTHING）属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new PostgresApplicationRepositoryError(
        'CONFLICT',
        '入组申请 ID 冲突：写入未返回任何行（主键已存在）',
        ['id'],
      );
    }
    if (rows.length > 1) {
      throw new PostgresApplicationRepositoryError(
        'RESULT_SET_VIOLATION',
        '写入语句返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const created = mapRow(rows[0]);
    assertWriteRoundTrip(writable, created);
    return created;
  }

  /**
   * 单条读取（本人申请）。
   *
   * - 主体必须落在存储 ID 域内，否则 `INVALID_SUBJECT`，且不访问数据库；
   * - 资源 ID **不进入 SQL**：域外的查询键（非 UUID / 非规范小写 / 空 UUID）直接返回
   *   `undefined`（`undefined` 即「该主体名下不存在此申请」⇒ service 404）。依据是行契约钉住的
   *   存储层不变量——规范小写 UUID——因此域外查询键在合规存储里**必然无命中**；
   * - 归属下推进 SQL（`WHERE id = $1 AND user_id = $2`）：他人的申请既不出库，也不存在
   *   「只按资源 ID 命中就返回」的路径；返回行仍会复核主键与归属（纵深防御）；
   * - 多行返回判结果集违约（主键唯一性被破坏）。
   */
  async findById(applicationId: string, ownerUserId: string): Promise<Application | undefined> {
    const executor = this.usableExecutor();
    const ownerId = requireSubject(ownerUserId);
    if (!isStorageUuid(applicationId)) {
      // 域外查询键：不访问数据库、也不抛错（「不存在」是确定结论，而不是服务端缺陷）
      return undefined;
    }

    const result = await executor.query(SELECT_BY_ID_FOR_OWNER_SQL, [applicationId, ownerId]);
    const rows = rowsOf(result);
    if (rows.length === 0) {
      return undefined;
    }
    if (rows.length > 1) {
      throw new PostgresApplicationRepositoryError(
        'RESULT_SET_VIOLATION',
        '按主键取数返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const record = mapRow(rows[0]);
    if (record.id !== applicationId) {
      throw new PostgresApplicationRepositoryError(
        'IDENTITY_MISMATCH',
        '返回记录的主键与请求查询的主键不一致',
        ['id'],
      );
    }
    if (record.userId !== ownerId) {
      throw new PostgresApplicationRepositoryError(
        'OWNER_VIOLATION',
        '返回了请求主体之外的入组申请（他人记录不得回流）',
        ['user_id'],
      );
    }
    return record;
  }

  /**
   * 按服务端主体取数（本人列表）。
   *
   * - 主体必须落在存储 ID 域内，否则 `INVALID_SUBJECT`，且不访问数据库；
   * - 归属下推进 SQL（`WHERE user_id = $1`），他人记录不会出库；每条返回记录都会**逐条复核
   *   归属**：返回了他人记录即判服务端缺陷并 fail-closed；
   * - 重复主键同样判结果集违约（避免同一记录在列表里出现两次而放大影响）；
   * - 无记录返回空数组（`[]`），不是 `undefined`，且不抛错；
   * - 不做任何本地截断：结果集大小由 SQL 决定（本切片端口没有分页窗口，`ORDER_BY` 只固定全序）。
   */
  async listByUserId(userId: string): Promise<readonly Application[]> {
    const executor = this.usableExecutor();
    const ownerId = requireSubject(userId);

    const result = await executor.query(SELECT_BY_OWNER_SQL, [ownerId]);
    return this.mapScopedRows(rowsOf(result), ownerId);
  }

  /**
   * 按（服务端主体, 目标小组）取数：供 service 判定「同用户同小组只能有一个未终态的入组申请」。
   *
   * - 主体与小组标识都必须落在存储 ID 域内，否则 fail-closed（`INVALID_SUBJECT` /
   *   `INVALID_IDENTIFIER`）：谓词无法正确回答时**不得**退化成空集，否则「无法判定」会被
   *   service 读成「判定为无重复申请」；
   * - 两个谓词都下推进 SQL（`WHERE user_id = $1 AND group_id = $2`），**没有状态谓词**：
   *   「未终态」是共享状态机的语义，adapter 不理解它，也不做唯一性判定（重复申请的拦截点是
   *   service 的 `isApplicationTerminal` 过滤 + 后续迁移的部分唯一索引）；
   * - 返回行逐条复核归属与小组（不一致分别 `OWNER_VIOLATION` / `RESULT_SET_VIOLATION`）；
   * - 重复主键判结果集违约；无记录返回 `[]`。
   */
  async listByUserAndGroup(userId: string, groupId: string): Promise<readonly Application[]> {
    const executor = this.usableExecutor();
    const ownerId = requireSubject(userId);
    const targetGroupId = requireFilterIdentifier(groupId, 'groupId');

    const result = await executor.query(SELECT_BY_OWNER_AND_GROUP_SQL, [ownerId, targetGroupId]);
    return this.mapScopedRows(rowsOf(result), ownerId, targetGroupId);
  }

  /**
   * 写回一条已由 service 校验、且已完成**合法状态转移**的完整记录（撤回 / 后续审核推进）。
   *
   * 判定顺序（被测试固定）：
   * 1. 记录必须满足读取契约的严格版本，且存储标识列落在存储 ID 域内（否则 `INVALID_RECORD`，
   *    不访问数据库）；未知状态取值在这里就被闭集拦下；
   * 2. **条件写入**：`WHERE id = $1 AND user_id = $2 AND status::text = ANY($n)`，其中前驱集合由
   *    共享状态机逆映射派生。命中即写入成功；未命中说明三种可能之一，用一次**归属范围内**的
   *    诊断查询区分：
   *    - 诊断无行 ⇒ `NOT_FOUND`（记录不存在，或归属不符——与内存基线「记录不存在时拒绝写入」
   *      同语义，且不外泄「该 ID 属于他人」这一事实）；
   *    - 诊断有行（状态合法但不在目标状态的前驱集合内）⇒ `TRANSITION_REJECTED`，**没有任何写入**；
   *    - 诊断多行 ⇒ 结果集违约（主键唯一性被破坏）。
   * 3. 命中后复核不可变列（`id` / `user_id` / `group_id` / `kind` / `created_at` 与写入的
   *    `status` / `updated_at`）：不一致分别判 `IDENTITY_MISMATCH` / `OWNER_VIOLATION`。
   *
   * `TRANSITION_REJECTED` 在服务端是**客户端可见冲突**（并发重复撤回）而不是缺陷：切换到数据库
   * 的那一片切片必须把它映射为 409 `STATE_TRANSITION_INVALID`（已登记在验证清单第 7 项）。
   */
  async save(application: Application): Promise<Application> {
    const executor = this.usableExecutor();
    const writable = assertWritableRecord(application);
    const predecessors = applicationStatusPredecessors(writable.status);

    const result = await executor.query(UPDATE_SQL, saveParameters(writable, predecessors));

    const rows = rowsOf(result);
    if (rows.length === 0) {
      // 0 行 ⇒ 不存在 / 归属不符 / 非法状态转移：用一次归属范围内的诊断查询分类，然后抛错
      throw await this.classifyUnwrittenSave(executor, writable);
    }
    if (rows.length > 1) {
      throw new PostgresApplicationRepositoryError(
        'RESULT_SET_VIOLATION',
        '写回语句返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const saved = mapRow(rows[0]);
    assertWriteRoundTrip(writable, saved);
    return saved;
  }

  /**
   * 条件写入 0 行时的失败分类：**归属范围内**读取当前状态，返回要抛的错误。
   *
   * 该查询只按 `id + user_id` 取 `status` 一列，因此既不跨归属探测，也不回显状态取值、
   * 不泄露他人申请是否存在。
   */
  private async classifyUnwrittenSave(
    executor: SqlExecutor,
    writable: Application,
  ): Promise<PostgresApplicationRepositoryError> {
    const diagnostic = await executor.query(SELECT_STATUS_FOR_OWNER_SQL, [
      writable.id,
      writable.userId,
    ]);
    const rows = rowsOf(diagnostic);
    if (rows.length === 0) {
      return new PostgresApplicationRepositoryError(
        'NOT_FOUND',
        '入组申请不存在（或不属于该主体），拒绝写入：插入必须走 create 路径',
        ['id'],
      );
    }
    const current = singleRow(rows, '入组申请不存在（或不属于该主体），拒绝写入');
    const parsedStatus = postgresApplicationStatusRowSchema.safeParse(current);
    if (!parsedStatus.success) {
      throw invalidRow(parsedStatus.error, 'status');
    }
    return new PostgresApplicationRepositoryError(
      'TRANSITION_REJECTED',
      '非法状态转移：当前存储状态不是目标状态的合法前驱，写入被拒绝（不产生任何更改）',
      ['status'],
    );
  }
}
