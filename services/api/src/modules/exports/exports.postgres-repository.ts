import { z } from 'zod';
import { uuidSchema } from '@rm/shared';
import type { SqlExecutor } from '../../db/ports/sql-executor.port';
import {
  EXPORT_MAX_FIELD_COUNT,
  EXPORT_REQUEST_VIEW_FIELDS,
  parseStoredExportRequest,
  storedExportRequestSchema,
} from './exports.contract';
import {
  EXPORT_REPOSITORY_BACKEND_POSTGRES,
  EXPORT_RESOURCE_VALUES,
  EXPORT_STATUS_VALUES,
  EXPORT_TRANSITION_REJECTED,
  ExportRevocationOutcome,
  assertExportKeyset,
  isExportPageLimit,
  type AsyncExportRepository,
  type ExportKeyset,
  type ExportPage,
  type ExportPageWindow,
  type ExportRepositoryCapabilities,
  type ExportRequest,
  type ExportRevocationResult,
  type ExportStatus,
} from './exports.port';
import {
  EXPORT_ENTRY_STATUS,
  EXPORT_REVOCABLE_STATUSES,
  EXPORT_STATUS_TRANSITIONS,
} from './exports.state-machine';

/**
 * 导出请求（`export_jobs`）的 **PostgreSQL 仓储 adapter（已接入运行时）**。
 *
 * ## 交付边界
 * - **已绑定**到 `ExportsModule`：`EXPORT_REPOSITORY` 由 `createExportRepository` 按「是否解析出
 *   `DATABASE_URL`」分流 —— 未配置走内存基线，配置了走本文件的延迟建连工厂
 *   （`createLazyPostgresExportRepository`）；已配置却拿不到执行器工厂时抛错（fail-closed）；
 * - **延迟建连**：装配阶段一次都不碰数据库，因此「数据库已配置但执行器未 attest / 依赖未就绪」
 *   由启动期门禁给出结构化违规，而不是在这里表现为一个数据库连接错误；
 * - **不引入** `pg` / Prisma / TypeORM 等驱动或 ORM 依赖：本文件只依赖驱动无关的
 *   `SqlExecutor` 端口（`db/ports/sql-executor.port.ts`），真实执行器由 `SQL_CONNECTION_FACTORY`
 *   在驱动层提供；
 * - **不声称生产可用**：能力声明固定为 `backend = postgres`、`persistent = true`、
 *   `productionReady = false`。完成 `POSTGRES_EXPORT_REPOSITORY_VERIFICATION_STEPS` 的全部前置、
 *   并取得封存声明与已登记证据之前，生产启动会被 `PersistenceBoundaryService` 与依赖就绪门禁
 *   拒绝（`productionReady !== true` / `DEPENDENCY_NOT_VERIFIED` 即违规）。
 *
 * ## 契约形态
 * 本文件实现 `AsyncExportRepository`（现在是 `ExportRepository` 的**类型别名**：同步与异步两份
 * 契约已收敛为一份，见 `exports.port.ts`）。内存基线与本 adapter 因此实现**同一份**签名，
 * 两条路径的语义由同一组 spec 口径约束，不再存在「同步一份、异步一份」的漂移面。
 *
 * ## 与内存基线的语义对应（逐条可核对）
 * | 内存基线 | 本 adapter |
 * |---|---|
 * | `create` 同 ID 冲突抛错（不静默覆盖） | `INSERT … ON CONFLICT (id) DO NOTHING` 无返回行 → `CONFLICT` |
 * | `save` 未知 id 抛错（不退化成插入） | 条件写入 0 行 → 归属范围内诊断查询 → `NOT_FOUND` |
 * | `save` 归属被改写抛错 | `WHERE id = $1 AND requester_id = $2` 钉住归属 + 返回行逐列复核 → `OWNER_VIOLATION` |
 * | `save` 有效期被改写抛错 | `expires_at` 不在 `SET` 列表（不可变列）+ 返回行逐列复核 → `IDENTITY_MISMATCH` |
 * | `listByOwnerId` 只返回该主体名下记录 | `WHERE requester_id = $1::uuid`（归属下推）+ 逐条复核 |
 * | `listByOwnerIdPage` 键集分页 | `WHERE requester_id = $1::uuid AND (date_trunc($2::text, created_at), id) > ($3::timestamptz, $4::uuid)` + `ORDER BY date_trunc($5::text, created_at) ASC, id ASC` + `LIMIT $6::int`（**没有 OFFSET**） |
 * | `findByIdForOwner` 不存在 / 属于他人都是 `undefined` | `WHERE id = $1::uuid AND requester_id = $2::uuid` → 0 行即 `undefined`（两者不可区分） |
 * | 端口没有删除 / 归档方法 | adapter 同样没有：`delete` / `archive` / `purge` / `truncate` / `upsert` 一个都不存在 |
 *
 * 与内存基线的**唯一刻意差异**：内存基线不做读取契约校验（存储层损坏必须能被出口门禁看见），
 * 而数据库实现必须把「存储层不变量」写成**严格行契约**（未知列、未知资源 / 状态枚举、坏时间戳、
 * 非 UUID 标识、字段白名单之外的字段一律拒绝），因为数据库是外部可变状态，行内容可能被任意来源
 * 写坏。有效期 `NULL` 是这条差异里唯一的**例外**：它在两条实现里都被保留为「字段缺省」，
 * 由上层下载边界统一 fail-closed（见行契约的 `expires_at` 说明）。
 *
 * ## 状态机（`pending -> completed | failed`）在存储层的两条硬约束
 * 1. `create` 只接受**入口状态** `pending`（`EXPORT_ENTRY_STATUS`）；携带终态与产物句柄的记录
 *    不得走创建路径（`INVALID_RECORD`），否则「入口即结论」会绕过状态机与产物生成；
 * 2. `save` 是**条件写入**：`WHERE … AND status::text = ANY($n::text[])`，前驱集合由本模块状态机
 *    `EXPORT_STATUS_TRANSITIONS` 的**逆映射**派生（唯一权威仍是状态机，adapter 不另写一份转移表）。
 *    目标状态没有合法前驱（即 `pending`）时**在访问数据库之前**就 fail-closed（`TRANSITION_REJECTED`，
 *    拒绝路径一个 SQL 都不执行）；目标状态有前驱但存储行不在其中（重复处理 / 并发推进 / 已被改写）
 *    时条件写入命中 0 行，由一次**归属范围内**的诊断查询分类为 `NOT_FOUND` 或
 *    `TRANSITION_REJECTED`，两者都**不产生任何写入**、也不改写既有终态。
 *    两处 `TRANSITION_REJECTED` 都使用端口常量 `EXPORT_TRANSITION_REJECTED`，
 *    因此 service 的写回边界按端口标记把它稳定映射为 409 `STATE_TRANSITION_INVALID`
 *    （并发重复推进对客户端是可见冲突，不是 500）。
 *
 * ## 安全边界（本文件的七条硬约束）
 * 1. **参数化 SQL + 固定标识符**：所有值一律走 `$1…$n` 占位符绑定；进入 SQL 文本的只有模块
 *    常量（表名、列清单、`TRUE` / `ANY` 这类 SQL 关键字），且表名与列名都经过 `assertSqlIdentifier`
 *    校验，不存在任何「值 → SQL 文本」的路径（占位符与参数由同一份列清单派生，不会数量漂移）；
 * 2. **显式字段映射 + 严格行契约**：数据库行必须满足严格（`.strict()`）的行契约（未知列、
 *    非法枚举、非 UUID、坏时间戳、字段白名单之外的字段一律拒绝），再**逐字段显式映射**为领域记录
 *    （列 → 字段的对应关系由 `POSTGRES_EXPORT_COLUMN_FIELDS` 单一事实来源给出，并另由
 *    `POSTGRES_EXPORT_FIELD_COLUMNS` 在编译期强制「每个领域字段都有对应列」），最后再过一次
 *    `exports.contract.ts` 的读取契约；任何一步不合规都 **fail-closed** 抛错，绝不把未登记字段、
 *    未知资源 / 状态或半成品记录交给上层；
 * 3. **归属隔离（服务端 subject owner）**：`ownerUserId` 必须由调用方（service）从服务端会话主体
 *    写入，必须是合法、非空、规范小写形的 UUID（**存储 ID 域约束**）；adapter 不生成、不覆盖归属，
 *    并且**把归属下推进 SQL**：`listByOwnerId` 只返回请求主体的记录，`save` 的 `WHERE` 同时钉住
 *    `id` 与归属（拿他人的作业 ID 也写不中他人数据）；返回行上再逐条复核归属（不一致即
 *    `OWNER_VIOLATION`）——他人作业既不出库、也不得回流；
 * 4. **公开视图不携带归属、产物句柄、服务端有效期与存储侧内部列**：adapter 只在**内部存储记录**上
 *    承载 `ownerUserId` / `artifactId` / `expiresAt`（不静默丢弃，service 需要它们做归属复核、
 *    下载切片关联与过期判定），对外裁剪由 `exports.contract.ts` 的 `toExportRequestView` 负责
 *    （恰好 `EXPORT_REQUEST_VIEW_FIELDS`，其中**没有** `expiresAt`——到期时刻不外发）；
 *    本文件显式声明**存储侧内部列**（`POSTGRES_EXPORT_INTERNAL_COLUMNS`：文件名 / 路径 / 下载地址 /
 *    存储 key / 对象 key / 产物句柄别名 / 文件体 / 内部资源内容与筛选条件 / 原始错误文本 /
 *    下载簿记）与**公开输出裁剪列**（`POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS`），并在模块加载期
 *    自检「裁剪列、其映射字段名及其驼峰形绝不落在公开视图白名单内」
 *    （`assertExportViewExclusion`）以及「内部列与列清单零交集」（`assertExportInternalColumnsAbsent`）；
 *    内部列刻意**不进入**列清单，因此既不进 SELECT / RETURNING，也不进领域对象；
 * 5. **高敏内容只走内部存储契约，绝不进日志与错误消息**：`requester_id` / `artifact_id` /
 *    字段列表在本文件里都是合法存储内容，但**绝不**写进错误消息与日志；错误消息只带字段路径与
 *    违规类型，避免把归属标识、产物句柄、内部路径或注入载荷写进日志与错误响应；
 * 6. **执行器异常不把原始错误文本带出去**：驱动 / 连接池抛出的异常一律收敛为不含原始文本的
 *    `EXECUTOR_FAILURE`（消息、`issues`、`cause` 都不携带原始错误、SQL、连接信息与字段取值）。
 *    这是本 adapter 相对同族切片的**刻意加强**：原始错误的定位职责属于显式注册的驱动层，
 *    不得经由业务错误冒泡到 API 响应与日志；
 * 7. **能力自检 fail-closed**：`productionReady = false` 是硬声明，
 *    `assertPostgresExportRepositoryCapabilities` 会在构造与每次调用前复核，因此「未验证就声称
 *    生产可用」既过不了自检，也过不了 `PersistenceBoundaryService`。
 *
 * ## 尚未解决 / 已登记的前置（因此 productionReady 恒为 false）
 * 本切片已落地的部分：`export_jobs` 的迁移（`0013_export_jobs.sql`，列与
 * `POSTGRES_EXPORT_COLUMNS` 的建表列一致，含 `artifact_id` 与 `fields text[]`；
 * `0015_export_jobs_expiry.sql` 补出服务端有效期列 `expires_at timestamptz`（可空，
 * NULL 由下载边界 fail-closed）与「有效期必须在创建时间之后」的 CHECK）、运行时可换绑的
 * 延迟建连工厂、对真实 PostgreSQL 的集成验证（建表、`id` 主键冲突、按 `requester_id` 取数与排序、
 * 条件写入 0 行、公开视图裁剪、有效期的写入 / 读出 / NULL 往返）。
 * **仍然未完成**：会话主体 `u-student-1` 形不在存储 ID 域内（数据库路径对非 UUID 主体
 * fail-closed）；`productionReady` 的提升还需要封存声明与已登记证据（依赖就绪契约），
 * 这一点**不是**本 adapter 能自行声称的。
 * 剩余项都登记在 `POSTGRES_EXPORT_REPOSITORY_VERIFICATION_STEPS` 里，不能只写声明。
 */

/** 表名：与 docs/P2-ER图.md、docs/P1-字段级数据字典.md 与 `db/migrations/0001_bootstrap.sql` 的 `export_jobs` 一致 */
export const POSTGRES_EXPORT_TABLE = 'export_jobs';

/**
 * 列清单：同时定义 `SELECT` 输出列、`INSERT` 列顺序、`UPDATE` 的 `RETURNING` 输出列。
 *
 * 刻意不写 `SELECT *`：存储层新增列（文件名 / 路径 / 下载地址 / 存储 key / 对象 key / 产物句柄别名 /
 * 文件体 / 内部资源内容 / 筛选条件 / 原始错误文本 / 下载簿记）不会因为本文件没更新就自动
 * 流进领域对象；配合行契约的 `.strict()`，未登记列会被显式拒绝而不是被静默带出。
 * `expires_at` 与 `revoked_at` 都是**本清单内**的列（共 10 列）：前者是下载边界唯一需要的
 * **服务端有效期**（迁移 `0015` 补出），后者是下载失效与列表呈现唯一需要的**服务端撤销时刻**
 * （迁移 `0016` 补出），因此两者都必须被显式投影出来；它们仍然不进入公开视图
 * （见 `POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS`），
 * 所以「有效期 / 撤销时刻是可读的服务端事实」与「它们不外发」是两件事，
 * 分别由本清单与裁剪清单各管一段。
 *
 * 列名以 docs/P2-ER图.md 的 `export_jobs(id, requester_id, resource, filters, fields, status,
 * expires_at, downloaded_at)` 为准：归属列是 **`requester_id`**，而端口把同一概念命名为
 * `ownerUserId`。因此本 adapter 有且只有一处**非同名映射** `requester_id → ownerUserId`
 * （见 `POSTGRES_EXPORT_COLUMN_FIELDS`），这正是「显式字段映射」要解决的错位；
 * `expires_at → expiresAt` 只是 snake_case → camelCase 的约定形，不是重命名。
 */
export const POSTGRES_EXPORT_COLUMNS = [
  'id',
  'requester_id',
  'resource',
  'fields',
  'status',
  'artifact_id',
  'expires_at',
  'revoked_at',
  'created_at',
  'updated_at',
] as const;

/** 列 → 领域字段的唯一事实来源（编译期强制覆盖 `ExportRequest` 的全部字段） */
export const POSTGRES_EXPORT_COLUMN_FIELDS = Object.freeze({
  id: 'id',
  requester_id: 'ownerUserId',
  resource: 'resource',
  fields: 'fields',
  status: 'status',
  artifact_id: 'artifactId',
  expires_at: 'expiresAt',
  revoked_at: 'revokedAt',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
} as const satisfies Record<(typeof POSTGRES_EXPORT_COLUMNS)[number], keyof ExportRequest>);

/**
 * 领域字段 → 列的**反向**映射：与 `POSTGRES_EXPORT_COLUMN_FIELDS` 构成双射。
 *
 * 为什么两份都要：`satisfies Record<column, keyof ExportRequest>` 只保证「每个列都落在领域字段上」
 * （列 → 字段方向），不能保证「每个领域字段都有列」。反向映射用
 * `satisfies Record<keyof ExportRequest, column>` 补上另一方向，于是「新增领域字段但忘记补列」
 * 与「列名拼错」都成为编译错误，而不是运行期静默丢字段。它同时是本文件判定
 * 「写入记录出现未登记字段」的字段名集合来源。
 */
export const POSTGRES_EXPORT_FIELD_COLUMNS = Object.freeze({
  id: 'id',
  ownerUserId: 'requester_id',
  resource: 'resource',
  fields: 'fields',
  status: 'status',
  artifactId: 'artifact_id',
  expiresAt: 'expires_at',
  revokedAt: 'revoked_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const satisfies Record<keyof ExportRequest, (typeof POSTGRES_EXPORT_COLUMNS)[number]>);

/**
 * 归属列：只在服务端内部流转，同时也是 SQL 归属谓词（`WHERE requester_id = $1`）唯一使用的列。
 * 它**不进入**公开视图，也绝不进入错误消息与日志（他人归属不得回流、也不得外泄）。
 */
export const POSTGRES_EXPORT_OWNER_COLUMNS: readonly (typeof POSTGRES_EXPORT_COLUMNS)[number][] =
  Object.freeze(['requester_id']);

/**
 * **存储侧内部列**（本 adapter 的列清单里刻意**没有**它们）。
 *
 * 四组，全部来自 docs/P1-字段级数据字典.md / docs/P2-数据约束与迁移设计.md 与「公开视图不泄露」
 * 的交付要求：
 * - **产物位置与文件体**（文件名、路径、下载地址、签名地址、存储 key、对象 key、产物句柄、
 *   文件体 / 摘要）：位置即能力，泄露即等同于交付，因此既不入库到领域对象、也不外发；
 * - **内部资源内容与筛选条件**（资源 ID、资源快照、筛选条件）：字典标注「内部」，且快照可能
 *   含未脱敏的资源内部字段（例如画像 / 成果的归属与证据文件指针）；
 * - **原始错误文本**（失败原因、错误消息、堆栈）：可能含内部路径、连接串与字段取值；
 * - **存储侧簿记**（下载时间、软删除时间、幂等键）：属于存储实现细节与后续切片，
 *   不属于本切片对外契约。
 *
 * 注意 `expires_at` **不在**本清单里：有效期不再是「没有写入方的簿记列」——它由 service 在
 * 创建入口用服务端时钟写入、由下载边界读取判定，因此是**列清单内的真实列**
 * （迁移 `0015_export_jobs_expiry.sql` 补出）。它仍然**不进入公开视图**，因此被登记进
 * `POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS`（见下），而不是留在这里变成「既不投影也不用」的假声明。
 *
 * 它们**不进 SELECT / RETURNING / INSERT / UPDATE**，因此既不进领域记录、也不进公开视图；
 * 把它们显式登记出来，是为了让「不泄露文件路径 / URL / 存储 key / 产物句柄 / 内部资源字段 /
 * 原始错误 / PII」成为**可机器校验**的边界，而不是「恰好没查」。
 */
export const POSTGRES_EXPORT_INTERNAL_COLUMNS = Object.freeze([
  'file_name',
  'file_path',
  'download_url',
  'signed_url',
  'storage_key',
  'object_key',
  'artifact_handle',
  'content',
  'checksum',
  'resource_id',
  'resource_snapshot',
  'filters',
  'error_message',
  'failure_reason',
  'stack_trace',
  'downloaded_at',
  'deleted_at',
  'idempotency_key',
] as const);
export type PostgresExportInternalColumn = (typeof POSTGRES_EXPORT_INTERNAL_COLUMNS)[number];

/**
 * 高敏列：**归属 + 服务端有效期 + 全部存储侧内部列**（与 `POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS`
 * 同源，只少一个 `artifact_id`）。
 *
 * 立场是 **fail-closed**：凡**不进入公开视图**的列一律按高敏处理——归属标识、产物位置与文件体
 * （位置即能力）、文件摘要、内部资源标识与快照、筛选条件、原始错误文本（可能含内部路径与连接
 * 信息），以及存储侧簿记（下载时间 / 软删除时间 / 幂等键），都**绝不**写进错误消息与日志。
 *
 * `expires_at` 也在这里：到期时刻本身不是个人信息，但本切片**不外发**它（公开视图白名单里没有
 * `expiresAt`），按「凡不进入公开视图的列一律按高敏处理」这一 fail-closed 口径与其余裁剪列一并
 * 登记，避免出现「既不投影、又没登记」的暗列。
 *
 * 它们在**存储**范围内是合法内容，因此不裁剪为「不可读」（本 adapter 根本不投影这些列）；
 * 这里把内部列**整体**登记为高敏，是为了让「高敏声明覆盖全部内部列」成为**可机器校验**的边界
 * （同名 spec 逐列断言），而不是靠人工逐列比对——任何新增的内部列都会自动进入本清单，
 * 不会被漏登记。
 */
export const POSTGRES_EXPORT_PII_COLUMNS: readonly string[] = Object.freeze([
  'requester_id',
  'expires_at',
  'revoked_at',
  ...POSTGRES_EXPORT_INTERNAL_COLUMNS,
]);

/**
 * 本 adapter 侧**不进入公开输出**的列：归属（`requester_id → ownerUserId`）+ 产物句柄
 * （`artifact_id → artifactId`）+ 服务端有效期（`expires_at → expiresAt`）+ 全部存储侧内部列。
 *
 * 对外裁剪由 `toExportRequestView` 负责（逐字段显式赋值、不展开），本清单用于机器校验
 * 「adapter 不把归属、产物句柄、有效期与内部列投影出去」。把 `expires_at` 登记进来还有一层
 * 具体作用：`findExportViewExclusionLeaks` 会同时探测列名、其驼峰形与映射字段名，
 * 因此「顺手把 `expiresAt` 加进公开视图」这类改动会在模块加载期就 fail-closed。
 * 注意 `resource` / `fields` / `status` / `created_at` / `updated_at` **不在**本清单里：
 * 它们是公开视图白名单的组成部分。
 */
export const POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS: readonly string[] = Object.freeze([
  'requester_id',
  'artifact_id',
  'expires_at',
  'revoked_at',
  ...POSTGRES_EXPORT_INTERNAL_COLUMNS,
] as const);

/**
 * 写回（`save`）允许变更的列：状态机推进只改这些（`status` 是结论，`artifact_id` 是产物句柄，
 * `updated_at` 是服务端时钟）。
 *
 * 刻意**不含** `id` / `requester_id` / `resource` / `fields` / `created_at` / `expires_at`：
 * 它们由 `POSTGRES_EXPORT_IMMUTABLE_COLUMNS` 声明为不可变，写回后逐条复核（不一致即
 * `IDENTITY_MISMATCH` / `OWNER_VIOLATION`），因此「改写归属」「改导出资源」「改字段白名单」
 * 「改创建时间」「改有效期」五条路径在存储层被关闭，而不是靠调用方自律。
 * 有效期尤其不能落在可变列里：允许改写它等于允许把已过期的交付物「续期」回可下载状态。
 */
export const POSTGRES_EXPORT_MUTABLE_COLUMNS = [
  'status',
  'artifact_id',
  'updated_at',
] as const satisfies readonly (typeof POSTGRES_EXPORT_COLUMNS)[number][];

/**
 * **撤销写入**（`revokeForOwner`）允许变更的列：**恰好两列**。
 *
 * `revoked_at` 是撤销事实本身，`updated_at` 是服务端时钟；刻意**不含** `status` /
 * `artifact_id` / `created_at` / `expires_at` / `resource` / `fields` / `id` / `requester_id`：
 * 撤销不是状态机转移，也不删除产物、不改写交付范围与有效期 —— 它只把「这条导出已被本人取回」
 * 记在独立列上。因此「撤销顺手改写结论 / 句柄 / 有效期」在存储层没有可用的改写路径。
 *
 * 与 `POSTGRES_EXPORT_MUTABLE_COLUMNS`（状态机写回的 `save`）**刻意分开**：
 * `revoked_at` **不得**出现在 `save` 的 `SET` 列表里，否则一次并发的 `pending -> completed`
 * 写回就能把撤销事实清空（那正是「并发撤销 / 完成」下撤销必须胜出的反面）。
 */
export const POSTGRES_EXPORT_REVOKE_COLUMNS = [
  'revoked_at',
  'updated_at',
] as const satisfies readonly (typeof POSTGRES_EXPORT_COLUMNS)[number][];

/** 不可变列：写回后必须与请求记录逐字节一致（`id`/`requester_id` 另有专属错误码） */
export const POSTGRES_EXPORT_IMMUTABLE_COLUMNS = [
  'id',
  'requester_id',
  'resource',
  'fields',
  'expires_at',
  'revoked_at',
  'created_at',
] as const satisfies readonly (typeof POSTGRES_EXPORT_COLUMNS)[number][];

/**
 * **本 adapter 与端口上都不存在的删除 / 归档 / 覆盖插入入口**（本切片不提供「删除导出记录」的能力，
 * 见 `exports.port.ts` 的端口说明）。
 *
 * 该清单是「导出记录删除能力不存在」的可机器校验形态：spec 会逐名断言这些方法在 adapter 实例与
 * 端口类型上都不存在，因此任何「顺手加一个 delete / archive / upsert」的改动都会失败。
 * `save` 不在本清单里：它是端口既有方法，语义被限定为「按 id + 归属条件写入的终态推进」。
 */
export const POSTGRES_EXPORT_FORBIDDEN_METHODS: readonly string[] = Object.freeze([
  'delete',
  'remove',
  'archive',
  'purge',
  'truncate',
  'upsert',
  'insertOrUpdate',
]);

/** 仓储能力：持久但**未验证**，因此生产环境仍会被持久化边界守卫拦下 */
export const POSTGRES_EXPORT_REPOSITORY_CAPABILITIES: ExportRepositoryCapabilities = Object.freeze({
  backend: EXPORT_REPOSITORY_BACKEND_POSTGRES,
  persistent: true,
  productionReady: false,
});

/**
 * **仍未完成**的生产准入前置（每一项都需要证据，不能只写声明）。
 *
 * 本切片已经关闭的前置（证据在仓库里，不是声明）：
 * - 驱动依赖经评估后引入（官方 `pg`，只允许出现在 `db/postgres/` 驱动层）；
 * - `export_jobs` 落成**迁移** `db/migrations/0013_export_jobs.sql`（列与 `POSTGRES_EXPORT_COLUMNS`
 *   逐列一致，`uuid` 主键 / 归属、`resource` 与 `status` 闭集 CHECK、`fields text[]`、
 *   `artifact_id` 与状态自洽的跨字段 CHECK、`(requester_id, created_at, id)` 取数索引）；
 * - 列名与字段字典对齐（归属列 `requester_id` → 端口字段 `ownerUserId`，只有这一处非同名映射）；
 * - `fields` 列类型与驱动对齐（`text[]`，往返一致且顺序稳定）；
 * - `ExportRepository` 端口收敛为**唯一一份异步契约**（service / controller 与其测试同时改）；
 * - 对真实 PostgreSQL 的集成测试（`db/postgres/__tests__/exports-integration.spec.ts`）：
 *   建表迁移、`id` 主键冲突、按 `requester_id` 取数与全序、条件写入 0 行、归属不出库；
 * - 公开视图裁剪对**真实查询**复核（`SELECT` 列表恰好是公开列，内部列一列都不在结果里）；
 * - 执行器异常收敛为不含原始文本的 `EXECUTOR_FAILURE`，并由统一错误出口映射为 500
 *   `INTERNAL_ERROR`（原始文本只由驱动层记录）；
 * - `save` 的 `TRANSITION_REJECTED` 由 service 的写回边界按**端口标记**
 *   `EXPORT_TRANSITION_REJECTED` 稳定映射为 409 `STATE_TRANSITION_INVALID`
 *   （与状态机门禁同一个出口；`NOT_FOUND` / `OWNER_VIOLATION` / 行契约与执行器故障仍是 500，
 *   由 `exports.controller.spec.ts` 的写回边界用例固定）。
 *
 * 仍然未完成的两项（因此 `productionReady` 恒为 false）：
 * 1. 会话主体 `ownerUserId` 收敛为 UUID：当前会话基线是 `u-student-1` 这类安全 ID，
 *    不满足存储 ID 域，数据库路径对它 fail-closed（`INVALID_SUBJECT`，且在解析执行器之前）；
 * 2. 取得**封存声明 + 已登记验证证据**后，才允许把 `productionReady` 改为 true
 *    （`assertPostgresExportRepositoryCapabilities` 会拒绝「未验证就声称生产可用」；
 *    封存与证据由依赖就绪契约判定，不是本 adapter 能自行声称的）。
 */
export const POSTGRES_EXPORT_REPOSITORY_VERIFICATION_STEPS = [
  'session-subject-owner-ids-converged-to-uuid',
  'production-ready-capability-flipped-with-evidence',
] as const;

export type PostgresExportRepositoryErrorCode =
  | 'CAPABILITY_MISDECLARED'
  | 'INVALID_CONFIGURATION'
  | 'EXECUTOR_UNAVAILABLE'
  | 'EXECUTOR_NOT_POSTGRES'
  | 'EXECUTOR_NOT_PERSISTENT'
  | 'EXECUTOR_FAILURE'
  | 'INVALID_SUBJECT'
  | 'INVALID_ID'
  | 'INVALID_RECORD'
  | 'INVALID_ROW'
  | 'RESULT_SET_VIOLATION'
  | 'CONFLICT'
  | 'IDENTITY_MISMATCH'
  | 'OWNER_VIOLATION'
  | 'NOT_FOUND'
  | 'INVALID_WINDOW'
  | 'TRANSITION_REJECTED';

/**
 * adapter 的 fail-closed 错误。
 *
 * `issues` 只承载**字段路径与违规类型**（例如 `requester_id`、`status(invalid_enum_value)`、
 * `created_at(invalid_date)`），不承载字段取值，避免把归属标识、产物句柄、字段列表、内部路径、
 * 注入载荷或连接信息写进日志与错误响应。`EXECUTOR_FAILURE` 更进一步：连原始错误的文本与
 * `cause` 都不携带（见类注释第 6 条）。
 */
export class PostgresExportRepositoryError extends Error {
  readonly code: PostgresExportRepositoryErrorCode;
  readonly issues: readonly string[];

  constructor(
    code: PostgresExportRepositoryErrorCode,
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PostgresExportRepositoryError';
    this.code = code;
    this.issues = [...issues];
  }
}

/**
 * 能力自检：**未验证的实现不得声称生产可用**。
 *
 * 任何环境都会执行（能力声明缺失属于代码缺陷，不能等生产才暴露）。
 * 生产可用性的提升必须与 `POSTGRES_EXPORT_REPOSITORY_VERIFICATION_STEPS` 的证据、
 * 以及本断言的同步修改一起发生。
 */
export function assertPostgresExportRepositoryCapabilities(
  capabilities: ExportRepositoryCapabilities = POSTGRES_EXPORT_REPOSITORY_CAPABILITIES,
): void {
  const issues: string[] = [];
  if (capabilities.backend !== EXPORT_REPOSITORY_BACKEND_POSTGRES) {
    issues.push('backend');
  }
  if (capabilities.persistent !== true) {
    issues.push('persistent');
  }
  if (capabilities.productionReady !== false) {
    issues.push('productionReady');
  }
  if (issues.length > 0) {
    throw new PostgresExportRepositoryError(
      'CAPABILITY_MISDECLARED',
      `PostgreSQL 导出仓储能力声明不符（backend 必须是 ${EXPORT_REPOSITORY_BACKEND_POSTGRES}、persistent=true、productionReady=false）：未完成驱动集成验证前不得声称生产可用`,
      issues,
    );
  }
}

/** 下划线列名 → 驼峰形：用于把「内部列不得进入公开视图」的判定扩展到字段名方向 */
function camelCase(column: string): string {
  return column.replace(/_([a-z0-9])/gu, (_match, char: string) => char.toUpperCase());
}

/**
 * 公开视图裁剪的**泄漏检测**（纯函数，便于逐条用例固定）。
 *
 * 对每个「本 adapter 声明为不进入公开输出」的列，检查公开视图白名单里是否出现了：
 * 该列名本身、它映射到的领域字段名（例如 `requester_id → ownerUserId`）、或它的**驼峰形**
 * （例如内部列 `file_path → filePath`、`download_url → downloadUrl`）。返回空数组表示无泄漏。
 *
 * 驼峰形这一项是本 adapter 相对同族切片的**刻意加强**：内部列不在列清单里，因此没有
 * `列 → 字段` 映射可查，只比列名会漏掉「视图里直接写 `filePath` / `storageKey`」这类泄漏。
 */
export function findExportViewExclusionLeaks(viewFields: readonly string[]): readonly string[] {
  const declared = new Set(viewFields);
  const columnFields: Record<string, string | undefined> = POSTGRES_EXPORT_COLUMN_FIELDS;
  const leaks: string[] = [];
  for (const column of POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS) {
    for (const candidate of [column, camelCase(column), columnFields[column]]) {
      if (candidate !== undefined && declared.has(candidate)) {
        leaks.push(candidate);
      }
    }
  }
  return [...new Set(leaks)];
}

/**
 * 模块加载期自检：**公开视图白名单不得包含归属、产物句柄或存储侧内部列**。
 *
 * 只要有一个泄漏项，本断言立即 fail-closed，避免「悄悄把归属 / 产物句柄 / 文件名 / 路径 / URL /
 * 存储 key / 内部资源内容 / 原始错误投影出去」这类改动通过测试。
 */
export function assertExportViewExclusion(viewFields: readonly string[]): void {
  const leaks = findExportViewExclusionLeaks(viewFields);
  if (leaks.length > 0) {
    throw new PostgresExportRepositoryError(
      'CAPABILITY_MISDECLARED',
      '公开视图白名单包含归属、产物句柄或存储侧内部列：不得把归属 / 产物句柄 / 文件名 / 路径 / URL / 存储 key / 对象 key / 文件体 / 内部资源字段 / 筛选条件 / 原始错误投影出去',
      leaks,
    );
  }
}

/**
 * 内部列与列清单的**交集检测**（纯函数）。
 *
 * 内部列一旦被写进列清单，就会自动进入 `SELECT` / `RETURNING` / `INSERT` 并流进领域对象与
 * 公开视图。返回非空表示「本不该投影的列被投影了」。
 */
export function findExportInternalColumnOverlaps(
  columns: readonly string[] = POSTGRES_EXPORT_COLUMNS,
): readonly string[] {
  const declared = new Set<string>(columns);
  return POSTGRES_EXPORT_INTERNAL_COLUMNS.filter((column) => declared.has(column));
}

/** 模块加载期自检：内部列与列清单必须零交集（见 `findExportInternalColumnOverlaps`） */
export function assertExportInternalColumnsAbsent(
  columns: readonly string[] = POSTGRES_EXPORT_COLUMNS,
): void {
  const overlaps = findExportInternalColumnOverlaps(columns);
  if (overlaps.length > 0) {
    throw new PostgresExportRepositoryError(
      'CAPABILITY_MISDECLARED',
      '列清单包含存储侧内部列：文件名 / 路径 / URL / 存储 key / 对象 key / 产物句柄 / 文件体 / 内部资源字段 / 筛选条件 / 原始错误 / 簿记列不得进入任何被执行的 SQL',
      overlaps,
    );
  }
}

/** 模块加载即校验：视图白名单、内部列与列清单三者必须一致（见上面两个断言） */
assertExportViewExclusion(EXPORT_REQUEST_VIEW_FIELDS);
assertExportInternalColumnsAbsent();

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
    throw new PostgresExportRepositoryError(
      'INVALID_CONFIGURATION',
      `SQL 标识符不合规（必须是裸小写标识符）：${label}`,
      [label],
    );
  }
  return value;
}

/** 模块加载即校验：表名与列名一旦被改成非标识符形状，直接 fail-closed（不静默拼进 SQL） */
const TABLE_IDENTIFIER = assertSqlIdentifier(POSTGRES_EXPORT_TABLE, 'table');
const COLUMN_LIST = POSTGRES_EXPORT_COLUMNS.map((column) =>
  assertSqlIdentifier(column, 'column'),
).join(', ');

/** 逐列的类型转换：只在「列 → 参数占位」这一步使用，值本身永远不进入 SQL 文本 */
const COLUMN_PARAMETER_CASTS: Partial<Record<(typeof POSTGRES_EXPORT_COLUMNS)[number], string>> = {
  id: '::uuid',
  requester_id: '::uuid',
  artifact_id: '::uuid',
  expires_at: '::timestamptz',
  revoked_at: '::timestamptz',
  created_at: '::timestamptz',
  updated_at: '::timestamptz',
};

/**
 * `VALUES ($1::uuid, $2::uuid, …)`：占位符与列一一对应，由列清单派生，不会出现数量漂移。
 *
 * `fields` 刻意**不加**类型转换：字典把它标注为 JSON（`text[]` 与 `jsonb` 都可能），
 * 两种列类型都接受驱动传来的 JS 字符串数组，加错转换反而会拒掉合法写入；
 * 列类型定稿后须复核往返一致（已登记在验证清单第 5 项）。
 */
const INSERT_VALUES = POSTGRES_EXPORT_COLUMNS.map(
  (column, index) => `$${index + 1}${COLUMN_PARAMETER_CASTS[column] ?? ''}`,
).join(', ');

/**
 * 创建语句：客户端可控值全部走 `$n`；`ON CONFLICT (id) DO NOTHING` 让**主键冲突显式暴露**
 * （与内存基线 `create` 抛「导出请求 ID 冲突」同语义：ID 由服务端生成，冲突属于服务端缺陷，
 * 不得静默覆盖、也没有任何可覆盖的列）。
 * 刻意**没有** `DO UPDATE`：本端口只提供创建，任何「写入即改写」都会绕过状态机与产物生成。
 * `RETURNING` 让创建结果可被严格行契约复核（而不是「写完就当成功」）。
 */
const INSERT_SQL = `INSERT INTO ${TABLE_IDENTIFIER} (
  ${COLUMN_LIST}
) VALUES (${INSERT_VALUES})
ON CONFLICT (id) DO NOTHING
RETURNING ${COLUMN_LIST}`;

/**
 * `date_trunc` 的**截断字段**（排序与边界判定统一使用它）。
 *
 * 它**以参数绑定**（`date_trunc($n::text, created_at)`），而不是写成 SQL 字面量：本 adapter 的
 * 既有硬约定是「SQL 文本只由模块常量与 `$n` 占位符构成、文本里零引号」（同名 spec 的
 * `expectParameterizedSql` 会拒绝任何 `'` / `"` / `;` / `*` / `--`）。把字段名走参数既保留了
 * 这条约定，又让「截断粒度」成为一处可核对的常量。
 */
export const POSTGRES_EXPORT_TRUNCATION_FIELD = 'milliseconds';

/**
 * **按毫秒粒度构造排序子句**（`ORDER BY date_trunc($n::text, created_at) ASC, id ASC`）——
 * 排序键是**毫秒粒度的键集全序**，与内存基线的 `compareExportKeysets` 逐条一致
 * （见 `exports.port.ts`）。
 *
 * 为什么时间分量必须按毫秒截断、而且**排序与边界谓词必须用同一个表达式**：
 * `timestamptz` 在存储侧可以有微秒精度，而领域记录的 `createdAt` 是 ISO 毫秒形态
 * （驱动读回的 `Date` 也只有毫秒）。若按**原始**列排序、却用毫秒截断后的值做边界，
 * 边界行自己的真实值严格大于被截断的边界值，于是它会在下一页**被再次取出**
 * —— 相邻两页重复同一行；反过来若只在排序里截断、边界谓词用原始列，则会**漏行**
 * （同一毫秒桶内按主键定序的行会被原始列序排除）。因此两者必须是同一个表达式。
 *
 * 代价：该表达式无法借用 `idx_export_jobs_requester_created` 的**排序**能力
 * （复合索引仍用于 `requester_id` 的定位，随后对本人名下的少量行排序）。
 * 这是刻意用「可判定的一致性」换取的：分页的正确性不能依赖「存储里恰好没有亚毫秒行」。
 * 本切片**不加** `OFFSET` / `FETCH`：分页窗口由 `LIMIT` 表达。
 *
 * 为什么是一个函数而不是常量：`ORDER BY` 与 `WHERE` 的边界谓词必须使用**同一个**截断表达式
 * （否则会重复或漏行），但本仓库的执行器把「同一占位符序号出现两次」判为
 * `PARAMETER_SLOT_DUPLICATE` 并拒绝执行 —— 因此续页语句的 `ORDER BY` 必须换一个序号。
 * 由这一个工厂函数给出排序子句，保证「同一表达式、不同占位符」这点不会因为手抄而漂移。
 */
function orderByMillisecondKeyset(truncationSlot: number): string {
  return `ORDER BY date_trunc($${truncationSlot}::text, created_at) ASC, id ASC`;
}

/**
 * 按主体取数：主体走 `$1::uuid` 绑定，**归属下推进 SQL**（他人导出请求既不出库也不回流）；
 * 显式列清单，不使用 `SELECT *`。**无窗口**：结果集大小由 SQL 决定（没有 `LIMIT`），
 * HTTP 路由已不再使用它（列表走下面的窗口语句），它保留为端口既有的完整读取能力。
 */
const SELECT_BY_OWNER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE requester_id = $1::uuid
  ${orderByMillisecondKeyset(2)}`;

/**
 * **键集分页：首页**（没有边界谓词）。
 *
 * `LIMIT $3::int` 的取值恒为「已校验的页大小 + 1」：多取一行只为判定 `hasNext`，
 * 多取的那一行在返回到领域层之前被丢弃。每个占位符只出现一次（本仓库的执行器把
 * 「同一序号出现两次」判为 `PARAMETER_SLOT_DUPLICATE`），因此截断字段、边界时间与页大小
 * 各占**独立**占位符。
 */
const SELECT_PAGE_FIRST_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE requester_id = $1::uuid
  ${orderByMillisecondKeyset(2)}
  LIMIT $3::int`;

/**
 * **键集分页：续页**（带 `(created_at, id)` 边界）。
 *
 * - 边界是**严格大于**（行构造器比较），因此边界行本身不会在下一页重复出现；
 * - 归属谓词与边界谓词都是参数占位符：归属、边界键值**不参与 SQL 文本**；
 * - WHERE 与 ORDER BY 使用**同一个**截断表达式（见 `orderByMillisecondKeyset` 的说明），
 *   否则会重复或漏行；两处的截断字段各占一个占位符（执行器拒绝重复序号）；
 * - 没有 `OFFSET`：位移分页在并发写入下会重复或遗漏行。
 */
const SELECT_PAGE_AFTER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE requester_id = $1::uuid
    AND (date_trunc($2::text, created_at), id) > ($3::timestamptz, $4::uuid)
  ${orderByMillisecondKeyset(5)}
  LIMIT $6::int`;

/**
 * 按「主键 + 归属」取**单条**记录（下载切片的取数语句）。
 *
 * `WHERE id = $1::uuid AND requester_id = $2::uuid`：两个条件都是**参数占位符**，
 * 归属**不参与 SQL 文本**；因此「拿他人的作业 ID」查不到任何行，与「不存在」是同一个空结果集
 * （`mapScopedRows` 之后的单行判定把两者收敛为同一个 `undefined`，不可区分）。
 * 显式列清单，不使用 `SELECT *`；`LIMIT 2` 只为让「主键唯一性被破坏」可判定为结果集违约
 * （正常最多 1 行），不是分页窗口。
 */
const SELECT_BY_ID_FOR_OWNER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE id = $1::uuid AND requester_id = $2::uuid
  LIMIT 2`;

/** `save` 的 SET 片段：由可变列清单派生，占位符从 `$3` 起（`$1`/`$2` 留给 WHERE 的 id/归属） */
const UPDATE_SET_LIST = POSTGRES_EXPORT_MUTABLE_COLUMNS.map(
  (column, index) => `${column} = $${index + 3}${COLUMN_PARAMETER_CASTS[column] ?? ''}`,
).join(', ');

/** 状态转移谓词的占位符序号：可变列之后紧随其后 */
const UPDATE_PREDECESSOR_PARAMETER = POSTGRES_EXPORT_MUTABLE_COLUMNS.length + 3;

/**
 * 写回语句：**条件写入**。`WHERE` 同时钉住 `id`、归属与「状态必须落在目标状态的合法前驱集合内」
 * 三件事：
 * - `id + requester_id` ⇒ 拿他人作业的 ID 也写不中他人数据（归属隔离强化）；
 * - `status::text = ANY($n::text[])` ⇒ 非法状态转移（重复处理 / 终态再推进）**一行都不会被写入**，
 *   并且并发重复推进时只有第一个请求能命中（第二个 0 行 → `TRANSITION_REJECTED`），
 *   不会覆盖既有终态。
 *
 * `status` 是列引用而非值，因此这里对列做 `::text` 转换：迁移尚未落成（`status` 可能是 `text`
 * 或枚举类型），转换让谓词与列类型声明无关，同时不影响 `id` 主键索引的命中。
 */
const UPDATE_SQL = `UPDATE ${TABLE_IDENTIFIER}
  SET ${UPDATE_SET_LIST}
  WHERE id = $1::uuid AND requester_id = $2::uuid AND status::text = ANY($${UPDATE_PREDECESSOR_PARAMETER}::text[])
  RETURNING ${COLUMN_LIST}`;

/**
 * 失败分类用的诊断查询：**只在条件写入 0 行时执行**，且同样被 `id + 归属` 双重限定，
 * 因此它只读取「请求主体自己的那条记录」的状态，不做任何跨归属探测、也不回显状态取值。
 */
const SELECT_STATUS_FOR_OWNER_SQL = `SELECT status
  FROM ${TABLE_IDENTIFIER}
  WHERE id = $1::uuid AND requester_id = $2::uuid`;

/** 撤销语句的 `SET` 片段：由 `POSTGRES_EXPORT_REVOKE_COLUMNS` 派生（**恰好两列**） */
const UPDATE_REVOKE_SET_LIST = POSTGRES_EXPORT_REVOKE_COLUMNS.map(
  (column, index) => `${column} = $${index + 3}${COLUMN_PARAMETER_CASTS[column] ?? ''}`,
).join(', ');

/** 可撤销前驱集合的占位符序号：`$1`/`$2` 是 WHERE 的 id/归属，其后是撤销 SET 的两列 */
const UPDATE_REVOKE_PREDECESSOR_PARAMETER = POSTGRES_EXPORT_REVOKE_COLUMNS.length + 3;

/**
 * **本人撤销**语句：与状态机写回（`UPDATE_SQL`）并列的第二条条件 `UPDATE`。
 *
 * `WHERE` 同时钉住四件事：
 * - `id = $1::uuid` 与 `requester_id = $2::uuid` ⇒ 拿他人的记录 ID 一行都写不中（与「不存在」
 *   返回同一个空结果集，不可区分）；
 * - `status::text = ANY($n::text[])` ⇒ 只有**可撤销结论**（`EXPORT_REVOCABLE_STATUSES`：
 *   `pending` / `completed`）能被写中；`failed` 结论一行都写不中（**不可撤销**），
 *   这条谓词与迁移 0016 的 CHECK `export_jobs_revoked_at_matches_status` 同语义；
 * - `revoked_at IS NULL` ⇒ **已撤销的记录写不中**（重复撤销幂等，**不改写**既有撤销时刻 ——
 *   撤销是单调事实，NULL → 时刻只能发生一次）。
 *
 * `SET` **只有** `revoked_at` / `updated_at`：不改写 `status` / `artifact_id` / `created_at` /
 * `expires_at` / `resource` / `fields`（不删除产物、不推进状态机、不续期）。
 * `RETURNING` 让写入结果能被严格行契约与逐列复核（而不是「写完就当成功」）。
 */
const UPDATE_REVOKE_SQL = `UPDATE ${TABLE_IDENTIFIER}
  SET ${UPDATE_REVOKE_SET_LIST}
  WHERE id = $1::uuid AND requester_id = $2::uuid AND status::text = ANY($${UPDATE_REVOKE_PREDECESSOR_PARAMETER}::text[]) AND revoked_at IS NULL
  RETURNING ${COLUMN_LIST}`;

/**
 * 时间列契约：只接受驱动返回的 `Date` 或 **ISO 8601 datetime 字符串**。
 *
 * 刻意**不**用「任意字符串 + `new Date()` 归一」：那会把 `2026/01/05` 这类非法存储值静默修成
 * 合法 ISO，让「非法时间」变成「被悄悄修正」。非法形状一律 fail-closed（`INVALID_ROW`）。
 */
const postgresExportTimestampSchema = z.union([z.date(), z.string().datetime()]);

/**
 * 数据库行契约（**严格**）。
 *
 * `.strict()` 是「字段污染」防线：数据库返回的未登记列（文件名、路径、下载地址、签名地址、
 * 存储 key、对象 key、产物句柄别名、文件体、内部资源快照、筛选条件、原始错误、有效期与下载簿记、
 * 幂等键）会让解析失败，而不是被静默丢弃或带进领域对象。列缺失同样失败（PG 对 SELECT 列表中
 * 存在的列一定返回键，缺键说明驱动或 SQL 已被改动）。
 *
 * 存储标识列使用 `storageUuidSchema`（规范小写、非空）：它把「存储层不变量」写成行契约。
 * `resource` / `status` 用**闭集**校验，因此未知资源或未知状态在这里就被拦下（一律 fail-closed，
 * 不会当成合法值返回给上层）。`fields` 必须是**字符串数组**（字典的 JSON 列在 `text[]` 与 `jsonb`
 * 下的自然形态），元素形状与「必须是该资源白名单子集且不重复」由读取契约兜底。
 *
 * `expires_at` 是可空的（与迁移 `0015` 的列一致）：`NULL` **不是**行契约违规，而是
 * 「这条记录没有服务端写入的有效期」这一 **fail-closed** 存储形态。它因此被映射成「领域记录里
 * 没有 `expiresAt`」，由下载边界统一拒绝（与「不存在 / 跨主体 / 未完成 / 产物缺失」同一出口），
 * 而**不是**在这里判成 `INVALID_ROW`：那会把稳定的 404 变成 500，反而泄露「这条记录存在」。
 * 非空时必须满足严格时间契约（`Date` 或 ISO datetime 字符串），非法形态仍 fail-closed。
 */
const postgresExportRowSchema = z
  .object({
    id: storageUuidSchema,
    requester_id: storageUuidSchema,
    resource: z.enum(EXPORT_RESOURCE_VALUES),
    fields: z.array(z.string().min(1).max(64)).min(1).max(EXPORT_MAX_FIELD_COUNT),
    status: z.enum(EXPORT_STATUS_VALUES),
    artifact_id: storageUuidSchema.nullable(),
    expires_at: postgresExportTimestampSchema.nullable(),
    revoked_at: postgresExportTimestampSchema.nullable(),
    created_at: postgresExportTimestampSchema,
    updated_at: postgresExportTimestampSchema,
  })
  .strict();

/** 诊断查询的行契约：只取状态列，同样严格（多列/缺列都算驱动或 SQL 被改动） */
const postgresExportStatusRowSchema = z.object({ status: z.enum(EXPORT_STATUS_VALUES) }).strict();

/** 写入记录允许出现的字段名集合：由「领域字段 → 列」双射派生（单一事实来源，不会漂移） */
const WRITABLE_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.keys(POSTGRES_EXPORT_FIELD_COLUMNS),
);

/** 只保留字段路径与违规类型，绝不含字段取值（归属、产物句柄与字段列表不进错误消息） */
function describeIssues(error: z.ZodError): readonly string[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      // 只列出**字段名**（不是字段取值）：让「契约漂移 / 字段污染」可定位，同时不泄露数据
      return issue.keys.map((key) => `${key}(unexpected)`);
    }
    return [`${issue.path.join('.') || '(root)'}(${issue.code})`];
  });
}

function invalidRow(error: z.ZodError, label = 'row'): PostgresExportRepositoryError {
  return new PostgresExportRepositoryError(
    'INVALID_ROW',
    `数据库行不符合 postgres 行契约（${label}）`,
    describeIssues(error),
  );
}

/** 时间列 → ISO 字符串；坏时间戳 fail-closed（不产生 `Invalid Date` 之类的半成品） */
function toIsoTimestamp(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PostgresExportRepositoryError('INVALID_ROW', `时间列不是合法时间戳：${label}`, [
      label,
    ]);
  }
  return date.toISOString();
}

/**
 * 目标状态的**合法前驱集合**：由本模块状态机 `EXPORT_STATUS_TRANSITIONS` 的**逆映射**派生
 * （顺序取自 `EXPORT_STATUS_VALUES`，保证 SQL 参数逐字节可复现）。
 *
 * 为什么用逆映射而不是在 adapter 里再写一份转移表：状态机的唯一权威是
 * `exports.state-machine.ts`（`assertExportTransition` / `canTransitionExport`）；这里只做**求逆**，
 * 因此状态机新增/删除转移时，条件写入的谓词自动跟随，不会出现「两套状态机」。
 * 注意 `pending` 没有前驱：本函数返回空集合，`save` 因此**在访问数据库之前**就拒绝它
 * （导出请求的入口状态不可回写为结论）。
 */
export function exportStatusPredecessors(status: ExportStatus): readonly ExportStatus[] {
  return EXPORT_STATUS_VALUES.filter((from) => EXPORT_STATUS_TRANSITIONS[from].includes(status));
}

/**
 * 行 → 领域记录：**逐字段显式映射**（不使用展开），再整体过一次读取契约。
 *
 * 顺序刻意如此：先按严格行契约解析（拒绝未登记列 / 未知枚举 / 坏 UUID / 坏时间戳 / 坏形状），
 * 再显式取字段构造新对象（即使行里有额外内容也不会被带出），最后用 `parseStoredExportRequest`
 * 复核共享读取契约（枚举闭集 + ISO 时间 + 字段白名单子集与去重 + 状态与产物句柄自洽 + 字段闭集），
 * 任一环节不合规都抛错。
 */
function mapRow(row: unknown): ExportRequest {
  const parsedRow = postgresExportRowSchema.safeParse(row);
  if (!parsedRow.success) {
    throw invalidRow(parsedRow.error);
  }
  const dbRow = parsedRow.data;

  const record: ExportRequest = {
    id: dbRow.id,
    // 归属：adapter 只承载，不生成、不覆盖；对外由 toExportRequestView 裁剪
    ownerUserId: dbRow.requester_id,
    resource: dbRow.resource,
    fields: [...dbRow.fields],
    status: dbRow.status,
    // 产物句柄：仅 completed 存在，adapter 只承载不外发（公开视图白名单里没有它）
    ...(dbRow.artifact_id === null ? {} : { artifactId: dbRow.artifact_id }),
    // 服务端有效期：`NULL` 映射为**字段缺省**（不是空串、不是任意哨兵值），
    // 因此「有没有有效期」在领域层是一个明确的二值事实，下载边界据此 fail-closed。
    // 非空值统一归一为 UTC ISO（`toIsoTimestamp` 走 `toISOString()`），与写入侧同形态。
    ...(dbRow.expires_at === null
      ? {}
      : { expiresAt: toIsoTimestamp(dbRow.expires_at, 'expires_at') }),
    // 服务端撤销时刻：`NULL` 同样映射为**字段缺省**（= 未被撤销），因此「有没有被撤销」在
    // 领域层是一个明确的二值事实（下载边界与列表派生状态都据此判定）。
    ...(dbRow.revoked_at === null
      ? {}
      : { revokedAt: toIsoTimestamp(dbRow.revoked_at, 'revoked_at') }),
    createdAt: toIsoTimestamp(dbRow.created_at, 'created_at'),
    updatedAt: toIsoTimestamp(dbRow.updated_at, 'updated_at'),
  };

  const parsedRecord = parseStoredExportRequest(record);
  if (!parsedRecord.ok) {
    throw new PostgresExportRepositoryError(
      'INVALID_ROW',
      '数据库行映射后不符合导出读取契约',
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
    throw new PostgresExportRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      '未提供 SQL 执行器：PostgreSQL 导出仓储拒绝在半可用状态下构造或调用',
      ['executor'],
    );
  }
  const candidate = executor as { query?: unknown; capabilities?: unknown };
  if (typeof candidate.query !== 'function') {
    throw new PostgresExportRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器缺少 query 方法：PostgreSQL 导出仓储拒绝在半可用状态下构造或调用',
      ['executor.query'],
    );
  }
  const capabilities = candidate.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new PostgresExportRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器未声明能力（backend/persistent/productionReady）',
      ['executor.capabilities'],
    );
  }
  const { backend, persistent } = capabilities as { backend?: unknown; persistent?: unknown };
  if (typeof backend !== 'string' || backend.trim() === '') {
    throw new PostgresExportRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器的能力声明缺少 backend 标识',
      ['executor.capabilities.backend'],
    );
  }
  if (!/^postgres/iu.test(backend.trim())) {
    throw new PostgresExportRepositoryError(
      'EXECUTOR_NOT_POSTGRES',
      'SQL 执行器声明的后端不是 PostgreSQL：拒绝把本 adapter 挂到其他存储上',
      ['executor.capabilities.backend'],
    );
  }
  if (persistent !== true) {
    throw new PostgresExportRepositoryError(
      'EXECUTOR_NOT_PERSISTENT',
      'SQL 执行器声明为非持久后端（内存替身）：PostgreSQL 导出仓储拒绝在其上运行',
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
  code: PostgresExportRepositoryErrorCode,
  message: string,
  label: string,
): string {
  if (!isStorageUuid(value)) {
    throw new PostgresExportRepositoryError(code, message, [label]);
  }
  return value;
}

/**
 * 服务端主体：会话解析值，非法即服务端缺陷（不得静默按「查不到」处理）。
 *
 * 导出为公开的**存储 ID 域断言**，供延迟建连工厂在**解析执行器之前**调用：
 * 非 UUID 主体既不进 SQL，也不触发任何数据库连接。
 */
export function assertPostgresExportSubject(ownerUserId: unknown): string {
  return requireStorageUuid(
    ownerUserId,
    'INVALID_SUBJECT',
    '取数主体必须落在存储 ID 域内（合法且非空的规范小写 UUID）：非 UUID 的 ownerUserId 属于服务端缺陷，不得进入 SQL',
    'ownerUserId',
  );
}

/**
 * 记录 ID：单条取数（下载切片）的**记录标识**复核，与主体使用同一份存储 ID 域判定。
 *
 * 路由参数在进入本 adapter 之前就已由 service 做过形态校验；这里再判一次是纵深防御：
 * 非 UUID / 空 UUID / 非规范小写一律 fail-closed（`INVALID_ID`）且**绝不绑定进 SQL**，
 * 错误信息也不回显该值（错误只带字段名 `id`）。它同样在**解析执行器之前**被调用，
 * 因此非法 ID 既不进 SQL、也不触发任何数据库连接。
 */
export function assertPostgresExportRecordId(id: unknown): string {
  return requireStorageUuid(
    id,
    'INVALID_ID',
    '记录 ID 必须落在存储 ID 域内（合法且非空的规范小写 UUID）：非法 ID 属于服务端缺陷，不得进入 SQL',
    'id',
  );
}

/**
 * 撤销时刻的存储域自检：必须是 **UTC ISO 8601**（`Z` 结尾）形态。
 *
 * 该值只由 service 用服务端时钟派生（`new Date(Date.now()).toISOString()`），因此形态非法
 * 属于服务端缺陷；它会被绑定进 `$3::timestamptz`，一旦形态不合规，绑定就退化为
 * 「让数据库去做字符串转换」，而不是在**进 SQL 之前** fail-closed。
 * 错误只带字段标签，不回显取值（时间戳本身不进错误消息）。
 */
export function assertPostgresExportRevocationTimestamp(revokedAt: unknown): string {
  if (typeof revokedAt !== 'string' || !z.string().datetime().safeParse(revokedAt).success) {
    throw new PostgresExportRepositoryError(
      'INVALID_RECORD',
      '撤销时刻必须是 UTC ISO 8601 形态（服务端缺陷），不得进入 SQL',
      ['revokedAt'],
    );
  }
  return revokedAt;
}

/**
 * 撤销写入的**逐列复核**（`RETURNING` 行回到领域层之前）。
 *
 * 条件写入的 `WHERE` 已经保证「只有本人、可撤销结论、未撤销过的行」会被写中，因此这里的复核
 * 针对的是**纵深风险**（SQL 被改写、触发器、驱动串行错位）：
 * - 主键与归属必须等于请求入参（`IDENTITY_MISMATCH` / `OWNER_VIOLATION`）；
 * - 撤销时刻与服务端时钟写入的 `updated_at` 必须逐字节等于请求值（不得被存储侧改写）；
 * - `status` 必须仍落在**可撤销前驱集合**内（撤销不得改写结论；越界即 `IDENTITY_MISMATCH`）；
 * - `revokedAt` 必须存在（否则这次「撤销」什么也没写）。
 * 复核失败一律 fail-closed 抛错，且错误只带列名，不带任何取值。
 */
function assertRevocationRoundTrip(
  requested: { readonly id: string; readonly ownerUserId: string; readonly revokedAt: string },
  stored: ExportRequest,
): void {
  if (stored.id !== requested.id) {
    throw new PostgresExportRepositoryError(
      'IDENTITY_MISMATCH',
      '撤销返回记录的主键与请求不一致（他人记录不得作为撤销结果回流）',
      ['id'],
    );
  }
  if (stored.ownerUserId !== requested.ownerUserId) {
    throw new PostgresExportRepositoryError(
      'OWNER_VIOLATION',
      '撤销返回记录的归属与请求不一致（他人归属不得回流）',
      ['requester_id'],
    );
  }
  if (stored.revokedAt !== requested.revokedAt) {
    throw new PostgresExportRepositoryError(
      'IDENTITY_MISMATCH',
      '撤销返回记录的 revoked_at 与请求写入的撤销时刻不一致（撤销时刻不得被改写）',
      ['revoked_at'],
    );
  }
  if (stored.updatedAt !== requested.revokedAt) {
    throw new PostgresExportRepositoryError(
      'IDENTITY_MISMATCH',
      '撤销返回记录的 updated_at 与请求写入的服务端时钟不一致（写入结果不得被改写）',
      ['updated_at'],
    );
  }
  if (!EXPORT_REVOCABLE_STATUSES.includes(stored.status)) {
    throw new PostgresExportRepositoryError(
      'IDENTITY_MISMATCH',
      '撤销返回记录的 status 不在可撤销前驱集合内（撤销不得改写结论）',
      ['status'],
    );
  }
}

/**
 * 分页**键集边界**的存储域自检：主键必须落在存储 ID 域（`uuid`）、时间分量必须是 UTC ISO 8601。
 *
 * 游标本身已由签名保护（客户端改不动），这里仍然判一次是纵深防御：边界值会被绑定进
 * `$2::timestamptz` / `$3::uuid`，一旦形态不合规，绑定就退化为「让数据库去做字符串比较 /
 * 转换失败」，而不是在**进 SQL 之前** fail-closed。错误只带字段标签，不回显边界取值。
 */
export function assertPostgresExportKeyset(keyset: unknown): ExportKeyset {
  try {
    assertExportKeyset(keyset);
  } catch {
    throw new PostgresExportRepositoryError(
      'INVALID_WINDOW',
      '分页键集边界必须是 (createdAt, id) 两个非空字符串（服务端缺陷），不得进入 SQL',
      ['after'],
    );
  }
  const candidate = keyset as ExportKeyset;
  assertPostgresExportRecordId(candidate.id);
  if (!z.string().datetime().safeParse(candidate.createdAt).success) {
    throw new PostgresExportRepositoryError(
      'INVALID_WINDOW',
      '分页键集边界的时间分量必须是 UTC ISO 8601 形态（服务端缺陷），不得进入 SQL',
      ['after.createdAt'],
    );
  }
  return candidate;
}

/**
 * 分页窗口的存储域自检（**取数之前**执行）：`limit` 必须落在 `EXPORT_PAGE_MAX_LIMIT` 内。
 *
 * 为什么窗口也要在 adapter 侧再判一次：`LIMIT` 的值来自调用方，若只信任上层校验，
 * 「按客户端提交的行数取数」这条路径在存储层就是敞开的（例如将来有人新增一条调用链）。
 * 非法窗口一律 `INVALID_WINDOW` 且**一个 SQL 都不执行**，绝不把越界值夹到上界继续。
 */
export function assertPostgresExportPageWindow(window: unknown): ExportPageWindow {
  if (typeof window !== 'object' || window === null || Array.isArray(window)) {
    throw new PostgresExportRepositoryError(
      'INVALID_WINDOW',
      '分页窗口必须是对象（服务端缺陷），不得进入 SQL',
      ['window'],
    );
  }
  const candidate = window as { readonly limit?: unknown; readonly after?: unknown };
  if (!isExportPageLimit(candidate.limit)) {
    throw new PostgresExportRepositoryError(
      'INVALID_WINDOW',
      '分页窗口的 limit 必须是服务端闭集内的正整数（服务端缺陷），不得进入 SQL',
      ['limit'],
    );
  }
  if (candidate.after === undefined) {
    return { limit: candidate.limit };
  }
  return { limit: candidate.limit, after: assertPostgresExportKeyset(candidate.after) };
}

/**
 * 写入记录校验：字段名闭集（未登记字段 → `(unexpected)`）+ 读取契约（含资源 / 状态两个枚举闭集、
 * 字段白名单子集与去重、状态与产物句柄自洽、ISO 时间）+ 存储 ID 域。
 *
 * 这里刻意把字段名闭集比对做在契约解析**前面**：拒绝而不是剥离，且能给出与读取契约可区分的
 * 错误码 `INVALID_RECORD`；随后用共享读取契约（其内部对象本身就是 `.strict()`）复核形状与不变式。
 */
function assertWritableRecord(record: unknown): ExportRequest {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new PostgresExportRepositoryError(
      'INVALID_RECORD',
      '待写入的导出请求不是对象：拒绝把非记录值交给写入路径',
      ['(root)'],
    );
  }
  const unexpected = Object.keys(record).filter((key) => !WRITABLE_FIELD_NAMES.has(key));
  if (unexpected.length > 0) {
    // 只列字段名，不回显取值；拒绝而不是静默剥离
    throw new PostgresExportRepositoryError(
      'INVALID_RECORD',
      '待写入的导出请求含未登记字段（字段污染）：拒绝写入',
      unexpected.map((key) => `${key}(unexpected)`),
    );
  }

  const parsed = storedExportRequestSchema.safeParse(record);
  if (!parsed.success) {
    throw new PostgresExportRepositoryError(
      'INVALID_RECORD',
      '待写入的导出请求不符合读取契约（含非法枚举取值、非法时间、非法形态或字段不在服务端白名单内）',
      describeIssues(parsed.error),
    );
  }
  const writable: ExportRequest = parsed.data;
  const identifierColumns: readonly (readonly [string, string])[] = [
    ['id', writable.id],
    ['ownerUserId', writable.ownerUserId],
    ...(writable.artifactId === undefined ? [] : [['artifactId', writable.artifactId] as const]),
  ];
  for (const [label, value] of identifierColumns) {
    requireStorageUuid(
      value,
      'INVALID_RECORD',
      '待写入的导出请求含不在存储 ID 域内的标识（必须是合法且非空的规范小写 UUID）',
      label,
    );
  }
  return writable;
}

/**
 * 入口状态门禁（`create` 专用）：**入口恒为 `pending`**，且**入口不得携带撤销事实**。
 *
 * 允许「创建即终态」会让调用方绕过状态机与产物生成（记录声称 `completed` 却没有产物、
 * 或声称 `failed` 却没有尝试过），因此这里 fail-closed，而不是把结论当成入口事实接受。
 * 同理，`revokedAt` 只允许由 `revokeForOwner` 在记录**已存在**之后写入：
 * 创建时就带撤销时刻意味着「一出生就已被取回」，那同样是一条没有发生过的事实。
 */
function assertEntryRecord(record: ExportRequest): ExportRequest {
  if (record.status !== EXPORT_ENTRY_STATUS) {
    throw new PostgresExportRepositoryError(
      'INVALID_RECORD',
      '创建路径只接受入口状态 pending：终态结论不得作为入口事实写入',
      ['status(entry_state_required)'],
    );
  }
  if (record.revokedAt !== undefined) {
    throw new PostgresExportRepositoryError(
      'INVALID_RECORD',
      '创建路径不接受撤销时刻：撤销只能由 revokeForOwner 在记录存在之后写入',
      ['revokedAt(entry_forbidden)'],
    );
  }
  return record;
}

/**
 * 结果集形状 fail-closed：执行器必须返回对象且带 `rows` 数组。
 * 「少字段 / 类型不对」属于驱动或替身实现缺陷，不得被当成「空结果」静默放过
 * （否则会把基础设施故障伪装成「该主体尚无导出请求」）。
 */
function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new PostgresExportRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果不是对象（驱动 / 替身实现缺陷）',
      ['result'],
    );
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new PostgresExportRepositoryError(
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
    throw new PostgresExportRepositoryError('NOT_FOUND', scope, ['id']);
  }
  if (rows.length > 1) {
    throw new PostgresExportRepositoryError(
      'RESULT_SET_VIOLATION',
      '按主键取数返回了多行：主键唯一性被破坏',
      ['id'],
    );
  }
  return rows[0];
}

/**
 * 执行一次 SQL 并返回行集。
 *
 * **执行器异常的信息卫生**：驱动 / 连接池抛出的异常一律收敛为不含原始文本的 `EXECUTOR_FAILURE`
 * ——不携带原始消息、不携带 `cause`、不携带 SQL 与参数。理由：驱动异常文本可能包含连接串、
 * 文件路径、SQL 片段与字段取值，而本 adapter 的错误会冒泡到 API 层的 500 路径；原始错误的
 * 定位职责属于显式注册的驱动层（它可以在自己的边界内记录），不得经由业务错误外发。
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
    throw new PostgresExportRepositoryError(
      'EXECUTOR_FAILURE',
      'SQL 执行失败：原始驱动错误不得外发（错误文本、SQL、连接信息与字段取值都不进入本错误）',
      ['executor'],
    );
  }
  return rowsOf(result);
}

/**
 * 写入参数：**由列清单派生**（列 → 字段 → 值），因此参数顺序永远与 SQL 占位符一致；
 * `Record<keyof ExportRequest, unknown>` 让「新增领域字段但忘记补参数」成为编译错误。
 * 缺失的可选字段（`artifactId` / `expiresAt`）写 `NULL`（而不是 `undefined` 或省略列）。
 * `fields` 传数组副本（不把调用方的可变引用交给驱动），顺序原样保留。
 */
function writeParameters(record: ExportRequest): readonly unknown[] {
  const values: Record<keyof ExportRequest, unknown> = {
    id: record.id,
    ownerUserId: record.ownerUserId,
    resource: record.resource,
    fields: [...record.fields],
    status: record.status,
    artifactId: record.artifactId ?? null,
    expiresAt: record.expiresAt ?? null,
    revokedAt: record.revokedAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return POSTGRES_EXPORT_COLUMNS.map((column) => values[POSTGRES_EXPORT_COLUMN_FIELDS[column]]);
}

/**
 * 写回参数：`$1`/`$2` 是 WHERE 的 `id`/归属，其后按**可变列清单**顺序给出值，
 * 最后一个参数是目标状态的合法前驱集合（条件谓词）。占位符与参数由同一份清单派生。
 */
function saveParameters(
  record: ExportRequest,
  predecessors: readonly string[],
): readonly unknown[] {
  const values: Record<(typeof POSTGRES_EXPORT_MUTABLE_COLUMNS)[number], unknown> = {
    status: record.status,
    artifact_id: record.artifactId ?? null,
    updated_at: record.updatedAt,
  };
  return [
    record.id,
    record.ownerUserId,
    ...POSTGRES_EXPORT_MUTABLE_COLUMNS.map((column) => values[column]),
    [...predecessors],
  ];
}

/** 字段列表逐元素比较（顺序有意义：契约把顺序固定为服务端白名单顺序） */
function sameFields(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((field, index) => field === right[index]);
}

/**
 * 写入后的**逐列复核**（写入语句不含这些不可变列，因此理论上它们不可能变化）。
 *
 * 复核是为了拦住「存储层触发器 / SQL 被改写 / 驱动串行错位」这类纵深风险，并让「改写归属」
 * 有专属错误码：`id` → `IDENTITY_MISMATCH`、`requester_id` → `OWNER_VIOLATION`，
 * 其余 `POSTGRES_EXPORT_IMMUTABLE_COLUMNS`（`resource` / `fields` / `expires_at` / `created_at`）
 * 以及本次写入的 `status` / `artifact_id` / `updated_at` → `IDENTITY_MISMATCH`。
 * 列清单与实现的对应关系由同名 spec 的**逐列行为断言**钉住（翻转任一列都会失败）。
 * `expires_at` 的复核对本切片尤其重要：有效期的**唯一写入时机是创建**，
 * 写回语句的 `SET` 里没有它，因此一旦它变化就说明存储被旁路改写过——那正是「把已过期交付物
 * 续期」的实现方式，必须 fail-closed。
 */
function assertWriteRoundTrip(requested: ExportRequest, stored: ExportRequest): void {
  if (stored.id !== requested.id) {
    throw new PostgresExportRepositoryError(
      'IDENTITY_MISMATCH',
      '返回记录的主键与请求写入的主键不一致（他人记录不得作为写入结果回流）',
      ['id'],
    );
  }
  if (stored.ownerUserId !== requested.ownerUserId) {
    throw new PostgresExportRepositoryError(
      'OWNER_VIOLATION',
      '返回记录的归属与请求写入的归属不一致（他人归属不得回流）',
      ['requester_id'],
    );
  }
  for (const [column, requestedValue, storedValue] of [
    ['resource', requested.resource, stored.resource],
    ['status', requested.status, stored.status],
    ['artifact_id', requested.artifactId, stored.artifactId],
    ['expires_at', requested.expiresAt, stored.expiresAt],
    ['created_at', requested.createdAt, stored.createdAt],
    ['updated_at', requested.updatedAt, stored.updatedAt],
  ] as const) {
    if (storedValue !== requestedValue) {
      throw new PostgresExportRepositoryError(
        'IDENTITY_MISMATCH',
        `返回记录的 ${column} 与请求写入的值不一致（不可变列 / 写入结果不得被改写）`,
        [column],
      );
    }
  }
  if (!sameFields(requested.fields, stored.fields)) {
    throw new PostgresExportRepositoryError(
      'IDENTITY_MISMATCH',
      '返回记录的 fields 与请求写入的字段白名单不一致（导出范围不得被改写）',
      ['fields'],
    );
  }

  // **撤销事实是单调的**：它不参与上面对 `save` 写入值的逐列比较，因为撤销可能与状态机推进
  // 并发发生（一次并发的本人撤销会在 `save` 的 `SET` 之外把 `revoked_at` 置上；`save` 的
  // SET 列表里没有该列，因此它**绝不会**被这次写回清空 —— 这正是「并发撤销 / 完成时撤销胜出」
  // 的实现形态）。唯一被禁止的是**撤销事实被清空或改写**：请求里已经带着撤销时刻时，
  // 存储返回值必须逐字节相等；请求里没有撤销时刻时，返回值带上撤销时刻是合法且期望的结果
  // （并发的撤销刚刚发生），调用方据此在公开视图里呈现 `revoked`。
  if (requested.revokedAt !== undefined && stored.revokedAt !== requested.revokedAt) {
    throw new PostgresExportRepositoryError(
      'IDENTITY_MISMATCH',
      '返回记录的 revoked_at 与请求写入的撤销时刻不一致（撤销事实不得被清空或改写）',
      ['revoked_at'],
    );
  }
}

/**
 * 基于 `SqlExecutor` 的 PostgreSQL 导出请求仓储。
 *
 * 构造与每次调用都会重新校验执行器（`assertUsableExecutor`）与自身能力声明，因此「执行器被换掉 /
 * 被降级」或「能力声明被改写」都会 fail-closed，而不是静默继续。
 * 本类**不是** Nest provider（不带任何 Nest 装饰器）：容器里绑定的是
 * `createLazyPostgresExportRepository` 返回的延迟建连包装，本类只承载「拿到执行器之后」的
 * SQL 与行映射语义，因而可以在没有驱动、也没有数据库的情况下被离线验证。
 */
export class PostgresExportRepository implements AsyncExportRepository {
  readonly capabilities: ExportRepositoryCapabilities = POSTGRES_EXPORT_REPOSITORY_CAPABILITIES;

  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    assertPostgresExportRepositoryCapabilities(this.capabilities);
    this.executor = assertUsableExecutor(executor);
  }

  /** 每次调用前的自检：能力声明与执行器都必须仍然可用 */
  private usableExecutor(): SqlExecutor {
    assertPostgresExportRepositoryCapabilities(this.capabilities);
    return assertUsableExecutor(this.executor);
  }

  /**
   * 取数结果的行映射 + 归属复核（列表路径共用，避免语义漂移）。
   *
   * 两层 fail-closed：
   * - 每条行都必须通过严格行契约与读取契约（`mapRow`）；
   * - 同一记录不得在结果集里出现两次（`RESULT_SET_VIOLATION`，主键唯一性被破坏）；
   * - 归属必须等于请求主体（`OWNER_VIOLATION`）：仓储的过滤行为**不作为安全边界**，
   *   返回了不该返回的记录即判服务端缺陷，整批 fail-closed，既不静默过滤也不外发。
   */
  private mapScopedRows(rows: readonly unknown[], ownerId: string): readonly ExportRequest[] {
    const records = rows.map((row) => mapRow(row));

    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id)) {
        throw new PostgresExportRepositoryError(
          'RESULT_SET_VIOLATION',
          '返回结果包含重复的导出请求 ID：结果集违反取数契约',
          ['id'],
        );
      }
      seen.add(record.id);
      if (record.ownerUserId !== ownerId) {
        throw new PostgresExportRepositoryError(
          'OWNER_VIOLATION',
          '返回了请求主体之外的导出请求（他人记录不得回流）',
          ['requester_id'],
        );
      }
    }
    return records;
  }

  /**
   * 创建一条已由调用方校验并补齐归属 / 入口状态 / 字段 / 时间戳的记录。
   *
   * - `ownerUserId` 必须是服务端会话主体（非法 UUID / 空 UUID / 非规范小写 / 未登记字段一律拒绝）；
   * - 状态必须是入口状态 `pending`（`assertEntryRecord`）：创建即终态被拒绝，不访问数据库；
   * - 主键冲突（`ON CONFLICT DO NOTHING` 无返回行）显式抛 `CONFLICT`，与内存基线同语义，
   *   不静默覆盖；
   * - 返回行必须能通过严格行契约与读取契约，且**主键、归属与其余列**都必须等于请求写入的记录
   *   （数据库回流出「他人记录」或字段被改写时判服务端缺陷）。
   */
  async create(request: ExportRequest): Promise<ExportRequest> {
    const executor = this.usableExecutor();
    const writable = assertEntryRecord(assertWritableRecord(request));

    const rows = await runQuery(executor, INSERT_SQL, writeParameters(writable));

    if (rows.length === 0) {
      // 主键冲突（ON CONFLICT DO NOTHING）属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new PostgresExportRepositoryError(
        'CONFLICT',
        '导出请求 ID 冲突：创建未返回任何行（主键已存在）',
        ['id'],
      );
    }
    if (rows.length > 1) {
      throw new PostgresExportRepositoryError(
        'RESULT_SET_VIOLATION',
        '创建语句返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const created = mapRow(rows[0]);
    assertWriteRoundTrip(writable, created);
    return created;
  }

  /**
   * 写回一条已由 service 校验、且已完成**合法状态转移**的完整记录（状态机推进）。
   *
   * 判定顺序（被测试固定）：
   * 1. 记录必须满足读取契约的严格版本，且存储标识列落在存储 ID 域内（否则 `INVALID_RECORD`，
   *    不访问数据库）；未知资源 / 未知状态取值在这里就被闭集拦下；
   * 2. 目标状态必须有**合法前驱**（由状态机逆映射派生）。没有前驱（目标 = 入口状态 `pending`）
   *    时立即 `TRANSITION_REJECTED`，**一个 SQL 都不执行**；
   * 3. **条件写入**：`WHERE id = $1 AND requester_id = $2 AND status::text = ANY($n)`。命中即写入
   *    成功；未命中说明三种可能之一，用一次**归属范围内**的诊断查询区分：
   *    - 诊断无行 ⇒ `NOT_FOUND`（记录不存在，或归属不符——与内存基线「记录不存在时拒绝写入」
   *      同语义，且不外泄「该 ID 属于他人」这一事实）；
   *    - 诊断有行（状态合法但不在目标状态的前驱集合内）⇒ `TRANSITION_REJECTED`，**没有任何写入**；
   *    - 诊断多行 ⇒ 结果集违约（主键唯一性被破坏）。
   * 4. 命中后复核不可变列（`id` / 归属 / `resource` / `fields` / `created_at` 与写入的 `status` /
   *    `artifact_id` / `updated_at`）：不一致分别判 `IDENTITY_MISMATCH` / `OWNER_VIOLATION`。
   *
   * `TRANSITION_REJECTED` 在服务端是**客户端可见冲突**（重复处理同一请求 / 并发推进）而不是缺陷：
   * 两处拒绝都使用端口常量 `EXPORT_TRANSITION_REJECTED`，service 的写回边界因此把它稳定映射为
   * 409 `STATE_TRANSITION_INVALID`（与状态机门禁同一个出口），而不是 500。
   */
  async save(request: ExportRequest): Promise<ExportRequest> {
    const executor = this.usableExecutor();
    const writable = assertWritableRecord(request);
    const predecessors = exportStatusPredecessors(writable.status);
    if (predecessors.length === 0) {
      // 目标状态没有合法前驱（入口状态 pending）：非法转换，拒绝路径不产生任何 SQL
      throw new PostgresExportRepositoryError(
        EXPORT_TRANSITION_REJECTED,
        '非法状态转移：目标状态没有任何合法前驱（导出请求的入口状态不可回写为结论），写入被拒绝且不产生任何更改',
        ['status'],
      );
    }

    const rows = await runQuery(executor, UPDATE_SQL, saveParameters(writable, predecessors));

    if (rows.length === 0) {
      // 0 行 ⇒ 不存在 / 归属不符 / 非法状态转移：用一次归属范围内的诊断查询分类，然后抛错
      throw await this.classifyUnwrittenSave(executor, writable);
    }
    if (rows.length > 1) {
      throw new PostgresExportRepositoryError(
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
   * 该查询只按 `id + 归属` 取 `status` 一列，因此既不跨归属探测，也不回显状态取值、
   * 不泄露他人导出请求是否存在。
   */
  private async classifyUnwrittenSave(
    executor: SqlExecutor,
    writable: ExportRequest,
  ): Promise<PostgresExportRepositoryError> {
    const rows = await runQuery(executor, SELECT_STATUS_FOR_OWNER_SQL, [
      writable.id,
      writable.ownerUserId,
    ]);
    if (rows.length === 0) {
      return new PostgresExportRepositoryError(
        'NOT_FOUND',
        '导出请求不存在（或不属于该主体），拒绝写入：创建必须走 create 路径',
        ['id'],
      );
    }
    const current = singleRow(rows, '导出请求不存在（或不属于该主体），拒绝写入');
    const parsedStatus = postgresExportStatusRowSchema.safeParse(current);
    if (!parsedStatus.success) {
      throw invalidRow(parsedStatus.error, 'status');
    }
    return new PostgresExportRepositoryError(
      EXPORT_TRANSITION_REJECTED,
      '非法状态转移：当前存储状态不是目标状态的合法前驱（记录已到终态，或已被并发推进），写入被拒绝且不产生任何更改',
      ['status'],
    );
  }

  /**
   * 按服务端主体取数（本人导出请求列表与状态）。
   *
   * - 主体必须落在存储 ID 域内，否则 `INVALID_SUBJECT`，且不访问数据库；
   * - 归属下推进 SQL（`WHERE requester_id = $1`），他人导出请求不会出库；每条返回记录都会
   *   **逐条复核**归属：返回了不该返回的记录即判服务端缺陷并 fail-closed（`OWNER_VIOLATION`）；
   * - 重复主键同样判结果集违约（避免同一记录在列表里出现两次而放大影响）；
   * - 无记录返回空数组（`[]`），不是 `undefined`，且不抛错；
   * - 不做任何本地截断：结果集大小由 SQL 决定（本切片端口没有分页窗口，`ORDER_BY` 只固定全序）。
   */
  async listByOwnerId(ownerUserId: string): Promise<readonly ExportRequest[]> {
    const executor = this.usableExecutor();
    const ownerId = assertPostgresExportSubject(ownerUserId);

    const rows = await runQuery(executor, SELECT_BY_OWNER_SQL, [
      ownerId,
      POSTGRES_EXPORT_TRUNCATION_FIELD,
    ]);
    return this.mapScopedRows(rows, ownerId);
  }

  /**
   * 按服务端主体取**一页**记录（`GET /me/exports` 的唯一取数入口，键集分页）。
   *
   * 判定顺序（被测试固定）：
   * 1. 能力与执行器自检（构造后被降级 / 能力声明被改写都会 fail-closed）；
   * 2. 主体与窗口都在**进入 SQL 之前**判定：非 UUID 主体 `INVALID_SUBJECT`、越界 `limit` 或
   *    非法键集边界 `INVALID_WINDOW` —— 拒绝路径一个 SQL 都不执行（`executor.calls` 为空）；
   * 3. 按窗口选一条固定语句（首页 / 续页），归属与边界键值**只出现在参数里**；
   * 4. `LIMIT = limit + 1` 判定 `hasNext`：取到 `limit + 1` 行即后面还有行，多取的行被丢弃，
   *    因此 `records.length <= limit` 恒成立；
   * 5. 返回行逐条过严格行契约、读取契约与归属复核（`mapScopedRows`），
   *    重复主键 / 他人记录 / 损坏行一律 fail-closed（绝不「过滤掉继续返回」）。
   *
   * 本方法**不**返回游标串（游标是 API 层的密码学凭据），也不返回任何近似总数：
   * `hasNext` 与 `records` 来自**同一次**取数快照。
   */
  async listByOwnerIdPage(ownerUserId: string, window: ExportPageWindow): Promise<ExportPage> {
    const executor = this.usableExecutor();
    const ownerId = assertPostgresExportSubject(ownerUserId);
    const { limit, after } = assertPostgresExportPageWindow(window);

    // 多取一行判定 hasNext（与内存基线同构）；越界 / 非法窗口已在上一步拒绝
    const probeLimit = limit + 1;
    const rows =
      after === undefined
        ? await runQuery(executor, SELECT_PAGE_FIRST_SQL, [
            ownerId,
            POSTGRES_EXPORT_TRUNCATION_FIELD,
            probeLimit,
          ])
        : await runQuery(executor, SELECT_PAGE_AFTER_SQL, [
            ownerId,
            POSTGRES_EXPORT_TRUNCATION_FIELD,
            after.createdAt,
            after.id,
            POSTGRES_EXPORT_TRUNCATION_FIELD,
            probeLimit,
          ]);

    const hasNext = rows.length > limit;
    const records = this.mapScopedRows(hasNext ? rows.slice(0, limit) : rows, ownerId);
    return { records, hasNext };
  }

  /**
   * 按「主键 + 归属」取单条记录（下载切片的取数入口）。
   *
   * 判定顺序：
   * 1. 记录 ID 与主体都必须落在**存储 ID 域**内，否则 `INVALID_ID` / `INVALID_SUBJECT`，
   *    且**一个 SQL 都不执行**（非法标识既不进 SQL、也不建连）；
   * 2. `WHERE id = $1::uuid AND requester_id = $2::uuid`：两个值都是参数占位符，
   *    归属**下推进 SQL**；「记录不存在」与「记录属于他人」返回的都是**空结果集**，
   *    因此本方法对两者返回同一个 `undefined`，调用方无法据此区分（不泄露存在性）；
   * 3. 每条返回行都要过严格行契约 + 读取契约，并**逐条复核归属**（`mapScopedRows`：
   *    返回了主体之外的记录即 `OWNER_VIOLATION`，整批 fail-closed）；
   * 4. 多行（本应由 `LIMIT 2` 暴露的主键唯一性破坏）判 `RESULT_SET_VIOLATION`。
   *
   * 执行器异常同样收敛为不含原始文本的 `EXECUTOR_FAILURE`（`runQuery`）。
   */
  async findByIdForOwner(id: string, ownerUserId: string): Promise<ExportRequest | undefined> {
    const executor = this.usableExecutor();
    const recordId = assertPostgresExportRecordId(id);
    const ownerId = assertPostgresExportSubject(ownerUserId);

    const rows = await runQuery(executor, SELECT_BY_ID_FOR_OWNER_SQL, [recordId, ownerId]);
    const records = this.mapScopedRows(rows, ownerId);

    if (records.length === 0) {
      // 「不存在」与「属于他人」在这里**不可区分**：这是端口契约要求的安全属性
      return undefined;
    }
    if (records.length > 1) {
      throw new PostgresExportRepositoryError(
        'RESULT_SET_VIOLATION',
        '按主键取数返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }
    return records[0];
  }

  /**
   * **本人撤销**（`POST /me/exports/:exportId/revoke` 的唯一写入入口）。
   *
   * 判定顺序（与内存基线逐条一致，且被测试固定）：
   * 1. 能力与执行器自检；
   * 2. 记录 ID、主体与撤销时刻都在**进入 SQL 之前**判定：非 UUID 主键 `INVALID_ID`、
   *    非 UUID 主体 `INVALID_SUBJECT`、非 UTC ISO 撤销时刻 `INVALID_RECORD` ——
   *    拒绝路径**一个 SQL 都不执行**；
   * 3. `UPDATE_REVOKE_SQL`：条件写入，`WHERE` 钉住 `id + 归属 + 可撤销前驱集合 + revoked_at IS NULL`，
   *    `SET` 只有 `revoked_at` / `updated_at`（不写结论、不动产物句柄、不改有效期、不删行）；
   * 4. 命中 1 行 ⇒ 严格行契约 + 撤销逐列复核 ⇒ `revoked`；
   * 5. 0 行 ⇒ 一次**归属范围内**的诊断取数（`SELECT_BY_ID_FOR_OWNER_SQL`，`LIMIT 2`）分类：
   *    - 0 行 ⇒ `undefined`（记录不存在**或属于他人**：两者不可区分，不泄露存在性）；
   *    - 行已带撤销时刻 ⇒ `already-revoked`（幂等；**既有撤销时刻逐字节不变**）；
   *    - 行未带撤销时刻 ⇒ `not-revocable`（结论是 `failed`：不可撤销，**没有任何写入**）；
   *    - 多行 ⇒ `RESULT_SET_VIOLATION`（主键唯一性被破坏，不得静默取第一条）。
   *
   * 与 `save` 的并发关系：`save` 的 `SET` 列表里**没有** `revoked_at`，因此并发完成写回
   * 既不会清空撤销事实，也不会被本方法的条件谓词挡住（`pending` 与 `completed` 都是合法前驱）；
   * 反过来，并发撤销之后 `save`（`pending -> completed`）仍然可以写回，记录因此同时是
   * `completed` 与已撤销 —— 下载边界按「已撤销优先」统一拒绝，撤销事实**胜出**。
   */
  async revokeForOwner(
    id: string,
    ownerUserId: string,
    revokedAt: string,
  ): Promise<ExportRevocationResult | undefined> {
    const executor = this.usableExecutor();
    const recordId = assertPostgresExportRecordId(id);
    const ownerId = assertPostgresExportSubject(ownerUserId);
    const revoked = assertPostgresExportRevocationTimestamp(revokedAt);

    const rows = await runQuery(executor, UPDATE_REVOKE_SQL, [
      recordId,
      ownerId,
      revoked,
      // `updated_at` 与 `revoked_at` 取**同一个**服务端时钟读数（同一次读取派生两个占位符），
      // 因此「撤销时刻」与「记录更新时间」不会因为两次时钟读取的漂移而不一致。
      revoked,
      [...EXPORT_REVOCABLE_STATUSES],
    ]);

    if (rows.length === 0) {
      return this.classifyUnwrittenRevocation(executor, recordId, ownerId);
    }
    if (rows.length > 1) {
      throw new PostgresExportRepositoryError(
        'RESULT_SET_VIOLATION',
        '撤销语句返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const record = mapRow(rows[0]);
    assertRevocationRoundTrip({ id: recordId, ownerUserId: ownerId, revokedAt: revoked }, record);
    return { outcome: ExportRevocationOutcome.Revoked, record };
  }

  /**
   * 撤销条件写入 0 行时的分类：**归属范围内**按主键取数（`LIMIT 2`），据此给出
   * `undefined`（不存在 / 属于他人）/ `already-revoked`（已撤销，幂等）/ `not-revocable`
   * （不可撤销结论）。
   *
   * 该查询与 `findByIdForOwner` 共用同一条语句与同一份行映射，因此「他人记录不出库」
   * 与「不存在与属于他人不可区分」两条性质在这里同样成立：本方法**不会**因为
   * 「记录存在但不属于本主体」而给出任何与「不存在」不同的结果。
   */
  private async classifyUnwrittenRevocation(
    executor: SqlExecutor,
    recordId: string,
    ownerId: string,
  ): Promise<ExportRevocationResult | undefined> {
    const rows = await runQuery(executor, SELECT_BY_ID_FOR_OWNER_SQL, [recordId, ownerId]);
    const records = this.mapScopedRows(rows, ownerId);

    if (records.length === 0) {
      // 「不存在」与「属于他人」在这里**不可区分**：这是端口契约要求的安全属性
      return undefined;
    }
    if (records.length > 1) {
      throw new PostgresExportRepositoryError(
        'RESULT_SET_VIOLATION',
        '撤销诊断取数返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }
    const record = records[0];
    if (record === undefined) {
      return undefined;
    }
    return record.revokedAt === undefined
      ? { outcome: ExportRevocationOutcome.NotRevocable, record }
      : { outcome: ExportRevocationOutcome.AlreadyRevoked, record };
  }
}

/**
 * **延迟建连**的 PostgreSQL 导出仓储：模块换绑工厂（`createExportRepository`）返回的实现。
 *
 * 为什么必须延迟：装配阶段（`NestFactory.create()`）**一次都不能碰数据库**。否则
 * 「数据库已配置但 SQL 执行器未 attest / 依赖未就绪」就会在这里表现为一个**连接错误**，
 * 而启动期门禁（`PersistenceBoundaryService` + 依赖就绪契约）就轮不到给出结构化违规。
 * 本工厂因此只持有 `resolveExecutor`，第一次真正取数时才解析执行器并建连；
 * 连接结果被缓存，且**失败不缓存**（下一次调用会重新解析，避免一次瞬时故障把端口永久钉死）。
 *
 * 判定顺序（与 `listByOwnerId` 同一口径，且被 `exports.binding.spec.ts` 固定）：
 * 1. 能力自检（未验证的实现不得声称生产可用）；
 * 2. **存储 ID 域先判**：非 UUID 主体在解析执行器**之前**就被拒绝 —— 既不进 SQL、也不建连；
 * 3. 解析执行器并构造 `PostgresExportRepository`，由其执行严格行契约与逐列复核。
 *
 * 执行器解析失败（例如拿到 fail-closed 的未验证驱动工厂）时，错误**原样抛出**：
 * 它是基础设施故障，不是业务结论，且其消息由驱动层构造（本文件不追加任何连接信息）。
 */
export function createLazyPostgresExportRepository(
  resolveExecutor: () => Promise<SqlExecutor>,
  capabilities: ExportRepositoryCapabilities = POSTGRES_EXPORT_REPOSITORY_CAPABILITIES,
): AsyncExportRepository {
  assertPostgresExportRepositoryCapabilities(capabilities);

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
    async create(request: ExportRequest): Promise<ExportRequest> {
      // 归属先判、再建连：写入路径的归属同样只来自服务端主体
      assertPostgresExportSubject(request.ownerUserId);
      return new PostgresExportRepository(await executor()).create(request);
    },
    async save(request: ExportRequest): Promise<ExportRequest> {
      assertPostgresExportSubject(request.ownerUserId);
      return new PostgresExportRepository(await executor()).save(request);
    },
    async listByOwnerId(ownerUserId: string): Promise<readonly ExportRequest[]> {
      const ownerId = assertPostgresExportSubject(ownerUserId);
      return new PostgresExportRepository(await executor()).listByOwnerId(ownerId);
    },
    async listByOwnerIdPage(ownerUserId: string, window: ExportPageWindow): Promise<ExportPage> {
      // 主体与窗口都先判、再建连：非法标识与越界页大小不会触发任何数据库连接
      const ownerId = assertPostgresExportSubject(ownerUserId);
      assertPostgresExportPageWindow(window);
      return new PostgresExportRepository(await executor()).listByOwnerIdPage(ownerId, window);
    },
    async findByIdForOwner(id: string, ownerUserId: string): Promise<ExportRequest | undefined> {
      // 记录 ID 与归属都先判、再建连：非法标识不会触发任何数据库连接
      const recordId = assertPostgresExportRecordId(id);
      assertPostgresExportSubject(ownerUserId);
      return new PostgresExportRepository(await executor()).findByIdForOwner(recordId, ownerUserId);
    },
    async revokeForOwner(
      id: string,
      ownerUserId: string,
      revokedAt: string,
    ): Promise<ExportRevocationResult | undefined> {
      // 记录 ID、归属与撤销时刻都先判、再建连：非法输入既不进 SQL，也不触发任何数据库连接
      const recordId = assertPostgresExportRecordId(id);
      const ownerId = assertPostgresExportSubject(ownerUserId);
      const revoked = assertPostgresExportRevocationTimestamp(revokedAt);
      return new PostgresExportRepository(await executor()).revokeForOwner(
        recordId,
        ownerId,
        revoked,
      );
    },
  };
}
