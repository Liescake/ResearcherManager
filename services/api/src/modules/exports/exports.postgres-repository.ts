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
  type AsyncExportRepository,
  type ExportRepositoryCapabilities,
  type ExportRequest,
  type ExportStatus,
} from './exports.port';
import { EXPORT_ENTRY_STATUS, EXPORT_STATUS_TRANSITIONS } from './exports.state-machine';

/**
 * 导出请求（`export_jobs`）的 **PostgreSQL 仓储 adapter（未接入运行时）**。
 *
 * ## 交付边界（本切片刻意不做的事）
 * - **不绑定**到 `ExportsModule`：模块仍然只绑定内存基线 `InMemoryExportRepository`
 *   （provider 列表与 DI 令牌一字未改），运行时行为与本切片之前逐字节一致（有回归断言）；
 * - **不切换内存 provider**：`EXPORT_REPOSITORY` 的运行时绑定、持久化登记表与启动装配都不引用
 *   本文件；换绑属于「启用数据库」那一步，且必须与驱动引入、集成验证一起发生；
 * - **不引入** `pg` / Prisma / TypeORM 等驱动或 ORM 依赖：本文件只依赖驱动无关的
 *   `SqlExecutor` 端口（`db/ports/sql-executor.port.ts`），真实执行器由消费方在「启用数据库」
 *   那一步显式提供；
 * - **不声称生产可用**：能力声明固定为 `backend = postgres`、`persistent = true`、
 *   `productionReady = false`。在引入经评估的驱动、完成对真实 PostgreSQL 的集成验证、并把
 *   `export_jobs` 从字段字典落成 schema 草案 → 迁移之前，生产启动会被 `PersistenceBoundaryService`
 *   拒绝（`productionReady !== true` 即违规）。
 *
 * ## 为什么先有异步契约
 * 现有 `ExportRepository`（`exports.port.ts`）是同步接口；把运行时端口改成 Promise 是跨模块契约
 * 变更（service / controller / 既有 spec 必须一起改），必须与真实驱动引入在同一片切片完成。
 * 因此本文件实现 `AsyncExportRepository`（Promise 版，语义与内存基线完全一致），让「SQL 与映射
 * 是否正确」可以在**没有驱动、也没有数据库**的情况下被离线验证。
 *
 * ## 与内存基线的语义对应（逐条可核对）
 * | 内存基线 | 本 adapter |
 * |---|---|
 * | `create` 同 ID 冲突抛错（不静默覆盖） | `INSERT … ON CONFLICT (id) DO NOTHING` 无返回行 → `CONFLICT` |
 * | `save` 未知 id 抛错（不退化成插入） | 条件写入 0 行 → 归属范围内诊断查询 → `NOT_FOUND` |
 * | `save` 归属被改写抛错 | `WHERE id = $1 AND requester_id = $2` 钉住归属 + 返回行逐列复核 → `OWNER_VIOLATION` |
 * | `listByOwnerId` 只返回该主体名下记录 | `WHERE requester_id = $1::uuid`（归属下推）+ 逐条复核 |
 * | 端口没有删除 / 归档方法 | adapter 同样没有：`delete` / `archive` / `purge` / `truncate` / `upsert` 一个都不存在 |
 *
 * 与内存基线的**唯一刻意差异**：内存基线不做读取契约校验（存储层损坏必须能被出口门禁看见），
 * 而数据库实现必须把「存储层不变量」写成**严格行契约**（未知列、未知资源 / 状态枚举、坏时间戳、
 * 非 UUID 标识、字段白名单之外的字段一律拒绝），因为数据库是外部可变状态，行内容可能被任意来源
 * 写坏。
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
 * 4. **公开视图不携带归属、产物句柄与存储侧内部列**：adapter 只在**内部存储记录**上承载
 *    `ownerUserId` 与 `artifactId`（不静默丢弃，service 需要它们做归属复核与下载切片关联），
 *    对外裁剪由 `exports.contract.ts` 的 `toExportRequestView` 负责（恰好 `EXPORT_REQUEST_VIEW_FIELDS`）；
 *    本文件显式声明**存储侧内部列**（`POSTGRES_EXPORT_INTERNAL_COLUMNS`：文件名 / 路径 / 下载地址 /
 *    存储 key / 对象 key / 产物句柄 / 文件体 / 内部资源内容与筛选条件 / 原始错误文本 / 有效期与
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
 * `db/migrations/0001_bootstrap.sql` 的业务表占位清单里**有** `export_jobs`，但该表既没有 schema
 * 草案也没有迁移；`docs/P2-ER图.md` 的最小字段列表里没有 `artifact_id`（本切片端口需要它承载
 * 产物句柄），`docs/P1-字段级数据字典.md` 把 `fields` / `filters` 标注为 JSON（本 adapter 的行契约
 * 要求驱动把它解析为**字符串数组**，`text[]` 与 `jsonb` 的自然形态都满足）；真实 PostgreSQL 的
 * 集成验证（建表、`id` 主键冲突、按 `requester_id` 取数与排序、并发重复推进只有一次命中、
 * 存储层不产生未授权改写）尚未进行；会话主体 `u-student-1` 形也不在存储 ID 域内；端口早先注释里的
 * 表名 `export_requests` 与占位清单 / ER 图的 `export_jobs` 需要一次性对齐。
 * 这些都已登记在 `POSTGRES_EXPORT_REPOSITORY_VERIFICATION_STEPS` 里，不能只写声明。
 */

/** 表名：与 docs/P2-ER图.md、docs/P1-字段级数据字典.md 与 `db/migrations/0001_bootstrap.sql` 的 `export_jobs` 一致 */
export const POSTGRES_EXPORT_TABLE = 'export_jobs';

/**
 * 列清单：同时定义 `SELECT` 输出列、`INSERT` 列顺序、`UPDATE` 的 `RETURNING` 输出列。
 *
 * 刻意不写 `SELECT *`：存储层新增列（文件名 / 路径 / 下载地址 / 存储 key / 对象 key / 产物句柄 /
 * 文件体 / 内部资源内容 / 筛选条件 / 原始错误文本 / 有效期与下载簿记）不会因为本文件没更新就自动
 * 流进领域对象；配合行契约的 `.strict()`，未登记列会被显式拒绝而不是被静默带出。
 *
 * 列名以 docs/P2-ER图.md 的 `export_jobs(id, requester_id, resource, filters, fields, status,
 * expires_at, downloaded_at)` 为准：归属列是 **`requester_id`**，而端口把同一概念命名为
 * `ownerUserId`。因此本 adapter 有且只有一处**非同名映射** `requester_id → ownerUserId`
 * （见 `POSTGRES_EXPORT_COLUMN_FIELDS`），这正是「显式字段映射」要解决的错位。
 */
export const POSTGRES_EXPORT_COLUMNS = [
  'id',
  'requester_id',
  'resource',
  'fields',
  'status',
  'artifact_id',
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
 * - **存储侧簿记**（有效期、下载时间、软删除时间、幂等键）：属于存储实现细节与后续切片，
 *   不属于本切片对外契约。
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
  'expires_at',
  'downloaded_at',
  'deleted_at',
  'idempotency_key',
] as const);
export type PostgresExportInternalColumn = (typeof POSTGRES_EXPORT_INTERNAL_COLUMNS)[number];

/**
 * 高敏列（字典标注「内部 / 高敏感」或可指纹化 / 可据以取回产物）：在本 adapter 的**存储**范围内
 * 是合法内容，因此不裁剪为「不可读」；但**绝不**写进错误消息与日志。
 * 内部列里的产物位置、文件体、内部资源内容与原始错误本 adapter 根本不投影（见上面的内部列清单）。
 */
export const POSTGRES_EXPORT_PII_COLUMNS: readonly string[] = Object.freeze([
  'requester_id',
  'file_name',
  'file_path',
  'download_url',
  'signed_url',
  'storage_key',
  'object_key',
  'artifact_handle',
  'content',
  'resource_snapshot',
  'filters',
  'error_message',
  'failure_reason',
  'stack_trace',
]);

/**
 * 本 adapter 侧**不进入公开输出**的列：归属（`requester_id → ownerUserId`）+ 产物句柄
 * （`artifact_id → artifactId`）+ 全部存储侧内部列。
 *
 * 对外裁剪由 `toExportRequestView` 负责（逐字段显式赋值、不展开），本清单用于机器校验
 * 「adapter 不把归属、产物句柄与内部列投影出去」。注意 `resource` / `fields` / `status` /
 * `created_at` / `updated_at` **不在**本清单里：它们是公开视图白名单的组成部分。
 */
export const POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS: readonly string[] = Object.freeze([
  'requester_id',
  'artifact_id',
  ...POSTGRES_EXPORT_INTERNAL_COLUMNS,
] as const);

/**
 * 写回（`save`）允许变更的列：状态机推进只改这些（`status` 是结论，`artifact_id` 是产物句柄，
 * `updated_at` 是服务端时钟）。
 *
 * 刻意**不含** `id` / `requester_id` / `resource` / `fields` / `created_at`：它们由
 * `POSTGRES_EXPORT_IMMUTABLE_COLUMNS` 声明为不可变，写回后逐条复核（不一致即
 * `IDENTITY_MISMATCH` / `OWNER_VIOLATION`），因此「改写归属」「改导出资源」「改字段白名单」
 * 「改创建时间」四条路径在存储层被关闭，而不是靠调用方自律。
 */
export const POSTGRES_EXPORT_MUTABLE_COLUMNS = [
  'status',
  'artifact_id',
  'updated_at',
] as const satisfies readonly (typeof POSTGRES_EXPORT_COLUMNS)[number][];

/** 不可变列：写回后必须与请求记录逐字节一致（`id`/`requester_id` 另有专属错误码） */
export const POSTGRES_EXPORT_IMMUTABLE_COLUMNS = [
  'id',
  'requester_id',
  'resource',
  'fields',
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
 * 转成生产可用前必须完成的验证清单（每一项都需要证据，不能只写声明）：
 * 1. 驱动依赖经评估后引入（`docs/P2-开源复用评估.md` 的 Prisma / TypeORM 比较结论）；
 * 2. 对真实 PostgreSQL 的集成测试：建表迁移、`id` 主键冲突、按 `requester_id` 取数与排序、
 *    **并发重复推进**（两个请求只有一个能命中条件写入）、非法转移不产生写入；
 * 3. `export_jobs` 的 schema 草案创建并按 `db/migrations/README.md` 转为迁移并执行验证
 *    （当前 `db/migrations/0001_bootstrap.sql` 只在占位清单注释里提到 `export_jobs`，没有建表语句）；
 * 4. 列名与字段字典一次性对齐：归属列是 `requester_id`（端口字段 `ownerUserId`），
 *    `artifact_id` 需补入字典与迁移（`docs/P2-ER图.md` 的最小字段列表里没有它），
 *    本文件早先的 `export_requests` 旧名统一为 `export_jobs`；
 * 5. `fields` 列类型与驱动对齐：字典标注 JSON，本 adapter 的行契约要求驱动把它解析为**字符串数组**
 *    （`text[]` 与 `jsonb` 的自然形态都满足），列类型定稿后须复核往返一致与顺序稳定；
 * 6. `ExportRepository` 端口改为异步：service / controller 与其测试一起改；
 * 7. 会话主体 `ownerUserId` 收敛为 UUID（当前基线是 `u-student-1` 这类安全 ID，不满足存储 ID 域）；
 * 8. `save` 的 `TRANSITION_REJECTED` 在 service 层映射为 409 `STATE_TRANSITION_INVALID`
 *    （重复处理是客户端可见冲突，不是服务端缺陷，不得直接冒泡为 500）；
 * 9. 执行器异常（`EXECUTOR_FAILURE`）在 service 层映射为 500，且原始错误文本只由驱动层记录，
 *    不得进入响应与业务日志；
 * 10. 公开视图裁剪对真实查询复核：确认没有任何内部列（文件名 / 路径 / URL / 存储 key / 对象 key /
 *    产物句柄 / 文件体 / 内部资源内容 / 筛选条件 / 原始错误 / 簿记）随 SELECT 或错误信息外发；
 * 11. 完成 1–10 后，才允许把 `productionReady` 改为 true，并同步删除能力自检
 *    （`assertPostgresExportRepositoryCapabilities` 会拒绝「未验证就声称生产可用」）。
 */
export const POSTGRES_EXPORT_REPOSITORY_VERIFICATION_STEPS = [
  'driver-dependency-evaluated',
  'integration-tests-against-real-postgres',
  'export-jobs-schema-draft-created-and-promoted-to-migration',
  'export-jobs-column-names-aligned-with-field-dictionary',
  'export-fields-column-type-aligned-with-driver',
  'export-repository-port-migrated-to-async',
  'session-subject-owner-ids-converged-to-uuid',
  'state-transition-rejection-mapped-to-409',
  'executor-failure-mapped-to-500-without-raw-text',
  'public-view-exclusion-verified-against-real-queries',
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
 * 排序键：`created_at ASC, id ASC`——与内存基线的创建顺序一致（service 在 create 时写入
 * `createdAt = now`），并给出逐页稳定、可复现的**全序**（后续键集分页所需的稳定排序键）。
 * 本切片**不加** `LIMIT/OFFSET`：端口还没有分页窗口，adapter 自行截断会让结果与内存基线语义
 * 不一致（同名 spec 有边界断言）。
 */
const ORDER_BY = 'ORDER BY created_at ASC, id ASC';

/**
 * 按主体取数：主体走 `$1::uuid` 绑定，**归属下推进 SQL**（他人导出请求既不出库也不回流）；
 * 显式列清单，不使用 `SELECT *`。
 */
const SELECT_BY_OWNER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE requester_id = $1::uuid
  ${ORDER_BY}`;

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
 */
const postgresExportRowSchema = z
  .object({
    id: storageUuidSchema,
    requester_id: storageUuidSchema,
    resource: z.enum(EXPORT_RESOURCE_VALUES),
    fields: z.array(z.string().min(1).max(64)).min(1).max(EXPORT_MAX_FIELD_COUNT),
    status: z.enum(EXPORT_STATUS_VALUES),
    artifact_id: storageUuidSchema.nullable(),
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

/** 服务端主体：会话解析值，非法即服务端缺陷（不得静默按「查不到」处理） */
function requireSubject(ownerUserId: unknown): string {
  return requireStorageUuid(
    ownerUserId,
    'INVALID_SUBJECT',
    '取数主体必须落在存储 ID 域内（合法且非空的规范小写 UUID）：非 UUID 的 ownerUserId 属于服务端缺陷，不得进入 SQL',
    'ownerUserId',
  );
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
 * 入口状态门禁（`create` 专用）：**入口恒为 `pending`**。
 *
 * 允许「创建即终态」会让调用方绕过状态机与产物生成（记录声称 `completed` 却没有产物、
 * 或声称 `failed` 却没有尝试过），因此这里 fail-closed，而不是把结论当成入口事实接受。
 */
function assertEntryRecord(record: ExportRequest): ExportRequest {
  if (record.status !== EXPORT_ENTRY_STATUS) {
    throw new PostgresExportRepositoryError(
      'INVALID_RECORD',
      '创建路径只接受入口状态 pending：终态结论不得作为入口事实写入',
      ['status(entry_state_required)'],
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
 * 缺失的可选字段（`artifactId`）写 `NULL`（而不是 `undefined` 或省略列）。
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
 * 其余 `POSTGRES_EXPORT_IMMUTABLE_COLUMNS`（`resource` / `fields` / `created_at`）以及本次写入的
 * `status` / `artifact_id` / `updated_at` → `IDENTITY_MISMATCH`。
 * 列清单与实现的对应关系由同名 spec 的**逐列行为断言**钉住（翻转任一列都会失败）。
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
}

/**
 * 基于 `SqlExecutor` 的 PostgreSQL 导出请求仓储。
 *
 * 构造与每次调用都会重新校验执行器（`assertUsableExecutor`）与自身能力声明，因此「执行器被换掉 /
 * 被降级」或「能力声明被改写」都会 fail-closed，而不是静默继续。
 * 本类**不是** Nest provider（不带任何 Nest 装饰器），也未在任何模块中注册。
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
   * 切换到数据库的那一片切片必须把它映射为 409 `STATE_TRANSITION_INVALID`
   * （已登记在验证清单第 8 项）。
   */
  async save(request: ExportRequest): Promise<ExportRequest> {
    const executor = this.usableExecutor();
    const writable = assertWritableRecord(request);
    const predecessors = exportStatusPredecessors(writable.status);
    if (predecessors.length === 0) {
      // 目标状态没有合法前驱（入口状态 pending）：非法转换，拒绝路径不产生任何 SQL
      throw new PostgresExportRepositoryError(
        'TRANSITION_REJECTED',
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
      'TRANSITION_REJECTED',
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
    const ownerId = requireSubject(ownerUserId);

    const rows = await runQuery(executor, SELECT_BY_OWNER_SQL, [ownerId]);
    return this.mapScopedRows(rows, ownerId);
  }
}
