import { z } from 'zod';
import { uuidSchema } from '@rm/shared';
import type { SqlExecutor } from '../../db/ports/sql-executor.port';
import { COMPLIANCE_STATUS_VIEW_FIELDS, parseStoredComplianceRecord } from './compliance.contract';
import {
  COMPLIANCE_REPOSITORY_BACKEND_POSTGRES,
  DATA_RETENTION_STATUS_VALUES,
  EXPORT_AVAILABILITY_STATUS_VALUES,
  PRIVACY_CONSENT_STATUS_VALUES,
  type AsyncComplianceRepository,
  type ComplianceRecord,
  type ComplianceRepository,
  type ComplianceRepositoryCapabilities,
} from './compliance.port';

/**
 * 合规状态（`user_compliance` 读模型）的 **PostgreSQL 仓储 adapter（已接入运行时）**。
 *
 * ## 交付边界（本切片做了什么）
 * - **已绑定**到 `ComplianceModule`：`COMPLIANCE_REPOSITORY` 由 `createComplianceRepository`
 *   按「是否解析出 `DATABASE_URL`」分流 —— 未配置时内存基线，配置且拿到
 *   `SQL_CONNECTION_FACTORY` 时**本 adapter**（延迟建连），配置但没有执行器工厂时**抛错**
 *   （fail-closed，绝不悄悄退回内存存储）。登记表里本切片已从「未装配」组移到
 *   `POSTGRES_BOUND_SLICE_REGISTRY`（`db/persistence/postgres-adapter-registry.ts`）；
 * - **不引入** `pg` / Prisma / TypeORM 等驱动或 ORM 依赖：本文件只依赖驱动无关的
 *   `SqlExecutor` 端口（`db/ports/sql-executor.port.ts`），真实执行器由 `DatabaseModule`
 *   在证据齐全时提供（驱动只允许出现在 `db/postgres/` 驱动层）；
 * - **不声称生产可用**：能力声明固定为 `backend = postgres`、`persistent = true`、
 *   `productionReady = false`。因此「数据库已配置」的装配仍会被启动期的
 *   `DependencyReadinessService` 判 `COMPLIANCE_REPOSITORY[DEPENDENCY_NOT_VERIFIED]` 并终止启动
 *   —— 这正是「生产配置了数据库但依赖不就绪 ⇒ fail-closed」的落点；
 *   把 `productionReady` 提升为 true 需要 `POSTGRES_COMPLIANCE_REPOSITORY_VERIFICATION_STEPS`
 *   里剩余各项的证据（见文末）。
 *
 * ## 端口契约（异步唯一契约）
 * `ComplianceRepository` 已收敛为 Promise 返回（见 `compliance.port.ts`），因此本 adapter
 * 与内存基线实现**同一个**接口：`AsyncComplianceRepository` 只是兼容别名。换绑不再需要第二个
 * 并存契约，service / controller 的 `await` 与授权顺序在异步路径上保持不变。
 *
 * ## 与内存基线的语义对应（逐条可核对）
 * | 内存基线 | 本 adapter |
 * |---|---|
 * | `findByUserId` 只返回该主体名下记录 | `WHERE user_id = $1::uuid`（归属下推）+ 返回行复核归属 |
 * | 无记录返回 `undefined`（不抛错） | 0 行 → `undefined` |
 * | 返回副本（不交内部可变引用） | 每次调用都构造**新的**记录对象（显式逐字段赋值） |
 * | 端口没有写入口（无 create/save/delete/archive） | adapter 同样没有：任何写入 / 删除方法一个都不存在 |
 *
 * 与内存基线的**唯一刻意差异**：内存基线不做读取契约校验（存储层损坏必须能被出口门禁看见），
 * 而数据库实现必须把「存储层不变量」写成**严格行契约**（未知列、未知状态枚举、非 UUID 归属、
 * 字段白名单之外的字段一律拒绝），因为数据库是外部可变状态，行内容可能被任意来源写坏。
 *
 * ## 安全边界（本文件的八条硬约束）
 * 1. **参数化 SQL + 固定标识符**：所有值一律走 `$1…$n` 占位符绑定；进入 SQL 文本的只有模块常量
 *    （表名、列清单、`::uuid` 这类类型转换），且表名与列名都经过 `assertSqlIdentifier` 校验，
 *    不存在任何「值 → SQL 文本」的路径（占位符与参数由同一份列清单派生，不会数量漂移）；
 *    本 adapter 只执行 **`SELECT`**：没有 INSERT / UPDATE / DELETE / DDL 模板，也没有诊断查询；
 * 2. **显式字段映射 + 严格行契约**：数据库行必须满足严格（`.strict()`）的行契约（未知列、
 *    非法枚举、非 UUID 归属一律拒绝），再**逐字段显式映射**为领域记录（列 → 字段的对应关系由
 *    `POSTGRES_COMPLIANCE_COLUMN_FIELDS` 单一事实来源给出，并另由
 *    `POSTGRES_COMPLIANCE_FIELD_COLUMNS` 在编译期强制「每个领域字段都有对应列」），最后再过一次
 *    `compliance.contract.ts` 的读取契约（含**状态自洽**）。任何一步不合规都 **fail-closed** 抛错，
 *    绝不把未登记字段、未知状态或半成品记录交给上层；
 * 3. **归属隔离（服务端 subject owner）**：`ownerUserId` 必须由调用方（service）从服务端会话主体
 *    写入，必须是合法、非空、规范小写形的 UUID（**存储 ID 域约束**）；adapter 不生成、不覆盖归属，
 *    并且**把归属下推进 SQL**（`WHERE user_id = $1`），他人合规状态根本不出库；返回行上再逐条
 *    复核归属（不一致即 `OWNER_VIOLATION`）——他人记录既不出库、也不得回流。
 *    **主体域先判、再建连**：`createLazyPostgresComplianceRepository` 在解析执行器之前就调用
 *    `assertPostgresComplianceSubject`，因此非 UUID 主体既不进 SQL，也不触发任何数据库连接；
 * 4. **结果集唯一性**：本读模型按主体唯一，`findByUserId` 返回多行即 `RESULT_SET_VIOLATION`
 *    （主键 / 唯一约束被破坏），整批 fail-closed，既不静默取首行也不外发；
 * 5. **公开视图只有三个闭集状态**：adapter 只在**内部存储记录**上承载 `ownerUserId`
 *    （不静默丢弃，service 需要它做归属复核），对外裁剪由 `compliance.contract.ts` 的
 *    `toComplianceStatusView` 负责（恰好 `COMPLIANCE_STATUS_VIEW_FIELDS`：`privacyConsent` /
 *    `dataRetention` / `exportAvailability`）。本文件显式声明**存储侧内部列**
 *    （`POSTGRES_COMPLIANCE_INTERNAL_COLUMNS`：同意原文与政策正文、联系方式与身份 PII、
 *    审核与证据字段、内部时间戳与保留期取值、路径 / URL / 存储 key / 产物句柄、原始错误文本、
 *    存储侧簿记）与**公开输出裁剪列**（`POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS`），
 *    并在模块加载期自检「裁剪列、其映射字段名及其驼峰形绝不落在公开视图白名单内」
 *    （`assertComplianceViewExclusion`）以及「内部列与列清单零交集」
 *    （`assertComplianceInternalColumnsAbsent`）；内部列刻意**不进入**列清单，
 *    因此既不进 `SELECT`，也不进领域对象；
 * 6. **内部时间戳不投影**：`created_at` / `updated_at` 是 schema 边界的必备列，但本切片的读取
 *    契约里**没有任何时间字段**，因此它们被登记为**内部列**而不是投影列：`SELECT` 明确列清单、
 *    不使用 `SELECT *`，行契约又是 `.strict()`，所以「内部时间戳随查询外发」在结构上不可能，
 *    且一旦有人把 `created_at` 写进列清单，模块加载期自检与同名 spec 都会失败；
 * 7. **高敏内容只走内部存储契约，绝不进日志与错误消息**：`user_id` 在存储范围内是合法内容，
 *    但**绝不**写进错误消息与日志；错误消息只带字段路径与违规类型，避免把归属标识、同意原文、
 *    手机号、审核意见、证据指针、内部路径与注入载荷写进日志与错误响应；
 * 8. **执行器异常不把原始错误文本带出去**：驱动 / 连接池抛出的异常一律收敛为不含原始文本的
 *    `EXECUTOR_FAILURE`（消息、`issues`、`cause` 都不携带原始错误、SQL、连接信息与字段取值）。
 *    这是本 adapter 相对同族切片的刻意加强：原始错误的定位职责属于显式注册的驱动层，
 *    不得经由业务错误冒泡到 API 响应与日志。
 *
 * ## schema 归属（本切片对齐）
 * 本 adapter 的读模型由**迁移 `0012_user_compliance.sql`** 建立（列清单 = 三个状态列 + 归属列，
 * 其余（`id` / `created_at` / `updated_at`）都是**内部列**，只存在于存储侧、绝不投影）。
 * `db/migrations/0001_bootstrap.sql` 的业务表占位清单里只有**原始同意表** `privacy_consents`；
 * 该迁移已应用因此**不可改写**（校验和），所以本切片不改它，而是在迁移 `0012` 里把
 * 「聚合读模型」显式建出来，并在迁移头部写明与原始同意表的关系 —— 存储侧因此不存在
 * 「同一概念两份真相」的隐性约定：原始同意表是**记录来源**，`user_compliance` 是
 * **服务端派生的读模型**（由同意 / 留存策略 / 导出开关在服务端派生后落库）。
 *
 * ## 尚未解决 / 已登记的前置（因此 productionReady 恒为 false）
 * 剩余前置：会话主体收敛为 UUID（当前基线 `u-student-1` 形不在存储 ID 域内，
 * 因此数据库路径对非 UUID 主体 fail-closed）、`data_retention` / `export_availability` 的
 * **派生口径定稿**（当前由写入方按读模型落库，迁移里的 CHECK 只保证状态自洽）、
 * 以及依赖就绪契约要求的**封存声明 + 集成验证证据**。这些都已登记在
 * `POSTGRES_COMPLIANCE_REPOSITORY_VERIFICATION_STEPS` 里，不能只写声明。
 */

/**
 * 表名：**聚合读模型** `user_compliance`（端口注释里的同一命名）。
 *
 * 与 db schema 边界的关系：已应用迁移 `0001_bootstrap.sql` 的占位清单 / ER 图 / 字段字典里是
 * 原始同意表 `privacy_consents`（`user_id, policy_id, consented_at, withdrawn_at`），不是本表。
 * 该迁移**已应用且不可改写**（校验和），因此本切片不改它，而是由**迁移 `0012_user_compliance.sql`**
 * 把这张服务端派生读模型显式建出来（列清单 = 三个状态列 + 归属列；`id` / `created_at` /
 * `updated_at` 只存在于存储侧、属于内部列）。构建期由 `0012` 的头部注释登记两者的关系：
 * `privacy_consents` 是**记录来源**，`user_compliance` 是由同意 / 留存策略 / 导出开关在服务端
 * 派生后落库的**读模型** —— 因此存储侧不存在「同一概念两份真相」的隐性约定。
 */
export const POSTGRES_COMPLIANCE_TABLE = 'user_compliance';

/**
 * 列清单：同时定义 `SELECT` 输出列与行契约的字段闭集。
 *
 * 刻意不写 `SELECT *`：存储层新增列（同意原文 / 政策正文 / 联系方式 / 审核意见 / 证据指针 /
 * 内部时间戳 / 路径 / URL / 存储 key / 原始错误 / 簿记列）不会因为本文件没更新就自动流进领域对象；
 * 配合行契约的 `.strict()`，未登记列会被显式拒绝而不是被静默带出。
 *
 * 列表里**没有** `created_at` / `updated_at` / `id`：它们属于存储侧内部列
 * （见 `POSTGRES_COMPLIANCE_INTERNAL_COLUMNS`）。读取契约里没有时间与代理主键字段，
 * 因此它们既不进 `SELECT`、也不进领域记录、更不可能进公开视图。
 *
 * 列名以 docs/P2-ER图.md 的 `privacy_consents(user_id, …)` 与 docs/P1-字段级数据字典.md §4
 * 的归属命名（`user_id`）为准：端口把同一概念命名为 `ownerUserId`，因此本 adapter 有且只有一处
 * **非同名映射** `user_id → ownerUserId`（见 `POSTGRES_COMPLIANCE_COLUMN_FIELDS`），
 * 这正是「显式字段映射」要解决的错位。
 */
export const POSTGRES_COMPLIANCE_COLUMNS = [
  'user_id',
  'privacy_consent',
  'data_retention',
  'export_availability',
] as const;

/** 列 → 领域字段的唯一事实来源（编译期强制覆盖 `ComplianceRecord` 的全部字段） */
export const POSTGRES_COMPLIANCE_COLUMN_FIELDS = Object.freeze({
  user_id: 'ownerUserId',
  privacy_consent: 'privacyConsent',
  data_retention: 'dataRetention',
  export_availability: 'exportAvailability',
} as const satisfies Record<(typeof POSTGRES_COMPLIANCE_COLUMNS)[number], keyof ComplianceRecord>);

/**
 * 领域字段 → 列的**反向**映射：与 `POSTGRES_COMPLIANCE_COLUMN_FIELDS` 构成双射。
 *
 * 为什么两份都要：`satisfies Record<column, keyof ComplianceRecord>` 只保证「每个列都落在领域
 * 字段上」（列 → 字段方向），不能保证「每个领域字段都有列」。反向映射用
 * `satisfies Record<keyof ComplianceRecord, column>` 补上另一方向，于是「新增领域字段但忘记补列」
 * 与「列名拼错」都成为编译错误，而不是运行期静默丢字段。它同时是本文件判定
 * 「公开视图白名单不得含归属」的字段名集合来源。
 */
export const POSTGRES_COMPLIANCE_FIELD_COLUMNS = Object.freeze({
  ownerUserId: 'user_id',
  privacyConsent: 'privacy_consent',
  dataRetention: 'data_retention',
  exportAvailability: 'export_availability',
} as const satisfies Record<keyof ComplianceRecord, (typeof POSTGRES_COMPLIANCE_COLUMNS)[number]>);

/**
 * 归属列：只在服务端内部流转，同时也是 SQL 归属谓词（`WHERE user_id = $1`）唯一使用的列。
 * 它**不进入**公开视图，也绝不进入错误消息与日志（他人归属不得回流、也不得外泄）。
 */
export const POSTGRES_COMPLIANCE_OWNER_COLUMNS: readonly (typeof POSTGRES_COMPLIANCE_COLUMNS)[number][] =
  Object.freeze(['user_id']);

/**
 * **存储侧内部列**（本 adapter 的列清单里刻意**没有**它们）。
 *
 * 七组，全部来自「公开视图不泄露」的交付要求与 docs/P1-字段级数据字典.md / docs/P2-ER图.md
 * 对同意、证据与联系方式的标注：
 * - **同意 / 政策原文与版本**（同意正文、政策正文、政策版本、同意与撤回时间）：原文与版本属于
 *   用户可读但**不属于本端点**的内容（本端点只回答三个状态枚举），撤回时间属内部时间戳；
 * - **联系方式与身份 PII**（姓名、学号、手机号、邮箱、证件号、微信标识）：泄露即等同于交付
 *   个人敏感信息，既不入领域对象、也不外发；
 * - **审核与证据**（审核状态 / 意见 / 审核人 / 审核时间、证据文件指针与证据 URL）：属后续切片的
 *   内部流程字段，且证据指针可据以取回文件；
 * - **内部时间戳与保留期取值**（创建 / 更新 / 删除 / 到期 / 保留至 / 清理时间）：本端点的响应里
 *   没有时间戳，期限取值由 `docs/P2-隐私留存矩阵.md` 约束「须由责任人批准后配置」，不外发；
 * - **路径 / URL / 存储 key / 产物与导出句柄**（文件路径、下载地址、签名地址、存储 key、对象 key、
 *   产物句柄、导出作业 ID）：位置即能力，泄露即等同于交付；
 * - **原始错误文本**（失败原因、错误消息、堆栈）：可能含内部路径、连接串与字段取值；
 * - **存储侧簿记与派生来源**（代理主键 `id`、版本、幂等键、派生来源与租户列）：属存储实现细节
 *   与后续切片，不属于本切片的对外契约。
 *
 * 它们**不进 `SELECT`**，因此既不进领域记录、也不进公开视图；把它们显式登记出来，
 * 是为了让「不泄露 userId 之外的内部时间戳、路径 / URL / 存储 key、同意原文、审核 / 证据字段与
 * PII」成为**可机器校验**的边界，而不是「恰好没查」。
 */
export const POSTGRES_COMPLIANCE_INTERNAL_COLUMNS = Object.freeze([
  'consent_text',
  'consent_body',
  'consent_version',
  'policy_id',
  'policy_version',
  'policy_text',
  'policy_body',
  'consented_at',
  'withdrawn_at',
  'name',
  'student_no',
  'student_number',
  'phone',
  'mobile',
  'email',
  'id_card',
  'id_number',
  'wechat_openid',
  'wechat_unionid',
  'review_status',
  'review_note',
  'review_comment',
  'reviewer_id',
  'reviewed_at',
  'evidence_file_id',
  'evidence_id',
  'evidence_url',
  'created_at',
  'updated_at',
  'deleted_at',
  'expires_at',
  'retention_until',
  'purged_at',
  'archived_at',
  'file_path',
  'download_url',
  'signed_url',
  'storage_key',
  'object_key',
  'artifact_id',
  'artifact_handle',
  'export_job_id',
  'error_message',
  'failure_reason',
  'stack_trace',
  'last_error',
  'id',
  'version',
  'etag',
  'idempotency_key',
  'source',
  'derivation',
  'tenant_id',
] as const);
export type PostgresComplianceInternalColumn =
  (typeof POSTGRES_COMPLIANCE_INTERNAL_COLUMNS)[number];

/**
 * **高敏与内部列清单**（= 归属列 + **全部**存储侧内部列的并集）。
 *
 * 语义：本清单里的任何一列都**绝不进入公开输出**，也**绝不写进错误消息与日志**。
 * 它承担两个可机器校验的用途：
 * - **覆盖归属映射**（`user_id → ownerUserId`）：归属只在服务端内部流转，既不投影也不外发；
 * - **覆盖 `POSTGRES_COMPLIANCE_INTERNAL_COLUMNS` 的全部内部列**：同意原文与政策正文、
 *   联系方式与身份 PII、审核与证据字段、内部时间戳与保留期取值、路径 / URL / 存储 key /
 *   产物与导出句柄、原始错误文本，以及存储侧簿记与派生来源列（代理主键、版本、幂等键、租户列）。
 *
 * 其中真正的高敏 PII（同意原文、姓名 / 学号 / 手机号 / 邮箱 / 证件号、微信标识、审核意见、
 * 证据指针、路径与 URL）与「仅为存储实现细节」的簿记列刻意**合并为同一份清单**：它们的共同
 * 不变量是「不得出现在公开输出、错误消息与日志里」，因此合并后只要漏登记一列就会被同一组
 * 断言拦下，不会出现「标为簿记列就顺手投影出去」的缝隙。
 *
 * 三个公开状态列（`privacy_consent` / `data_retention` / `export_availability`）**不在**本清单内，
 * 也不在 `POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS` 内：它们恰好是公开视图白名单本身。
 */
export const POSTGRES_COMPLIANCE_PII_COLUMNS: readonly string[] = Object.freeze([
  'user_id',
  ...POSTGRES_COMPLIANCE_INTERNAL_COLUMNS,
]);

/**
 * 本 adapter 侧**不进入公开输出**的列：归属（`user_id → ownerUserId`）+ 全部存储侧内部列。
 *
 * 对外裁剪由 `toComplianceStatusView` 负责（逐字段显式赋值、不展开），本清单用于机器校验
 * 「adapter 不把归属、内部时间戳、同意原文、审核 / 证据字段与 PII 投影出去」。
 * 注意 `privacy_consent` / `data_retention` / `export_availability` **不在**本清单里：
 * 它们恰好是公开视图白名单的三个状态枚举。
 */
export const POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS: readonly string[] = Object.freeze([
  'user_id',
  ...POSTGRES_COMPLIANCE_INTERNAL_COLUMNS,
] as const);

/**
 * **本 adapter 与端口上都不存在的写入 / 删除 / 覆盖插入入口**（本切片在类型层面就无法
 * 借读取路径改写合规事实，见 `compliance.port.ts` 的端口说明）。
 *
 * 该清单是「合规事实写入能力不存在」的可机器校验形态：spec 会逐名断言这些方法在 adapter 实例与
 * 端口类型上都不存在，因此任何「顺手加一个 save / archive / upsert」的改动都会失败。
 */
export const POSTGRES_COMPLIANCE_FORBIDDEN_METHODS: readonly string[] = Object.freeze([
  'create',
  'save',
  'insert',
  'update',
  'delete',
  'remove',
  'archive',
  'purge',
  'truncate',
  'upsert',
  'insertOrUpdate',
]);

/** 本 adapter 允许出现的语句种类：**只有 `SELECT`**（只读端口的可机器校验形态） */
export const POSTGRES_COMPLIANCE_READ_ONLY_STATEMENTS: readonly string[] = Object.freeze([
  'SELECT',
]);

/** 绝不允许出现在 SQL 文本里的关键字（写入 / DDL / 权限 / 批量导出） */
export const POSTGRES_COMPLIANCE_FORBIDDEN_SQL_KEYWORDS: readonly string[] = Object.freeze([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'TRUNCATE',
  'ALTER',
  'DROP',
  'GRANT',
  'REVOKE',
  'COPY',
  'CREATE',
]);

/** 仓储能力：持久但**未验证**，因此生产环境仍会被持久化边界守卫拦下 */
export const POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES: ComplianceRepositoryCapabilities =
  Object.freeze({
    backend: COMPLIANCE_REPOSITORY_BACKEND_POSTGRES,
    persistent: true,
    productionReady: false,
  });

/**
 * 转成生产可用前必须完成的验证清单（每一项都需要证据，不能只写声明）。
 *
 * **本切片已完成**：1（官方 `pg` 驱动经评估并显式声明，只允许出现在 `db/postgres/` 驱动层）、
 * 2（对真实 PostgreSQL 的集成验证：迁移建表、列清单、按 `user_id` 取数、唯一性约束、
 * 存储层不产生跨主体读取 —— 见 `db/postgres/__tests__/compliance-integration.spec.ts`）、
 * 3（`user_compliance` 由迁移 `0012_user_compliance.sql` 建立并在真库上核对）、
 * 6（运行时端口收敛为异步唯一契约，service / controller 与其测试一起改）。
 *
 * **仍然未完成**（因此 `productionReady` 恒为 false，生产装配必然 fail-closed）：
 * 5. `data_retention` / `export_availability` 的**派生口径定稿**：它们不在原始同意表的字段列表里，
 *    当前由写入方按读模型落库，迁移里的 CHECK 只保证「导出可用 ⇒ 已同意且未过保留期」这条
 *    单向蕴含；「实时联表派生」还是「服务端派生后落库」仍需定稿；
 * 7. 会话主体 `ownerUserId` 收敛为 UUID（当前基线是 `u-student-1` 这类安全 ID，不满足存储 ID 域，
 *    因此数据库路径对非 UUID 主体 fail-closed）；
 * 8. 内部列不投影对真实查询复核（真实库上已核对 `SELECT` 只取四列、内部列不出库，见集成 spec；
 *    仍需在**生产查询路径**上复核日志与错误信息）；
 * 9. 完成 1–8 后，才允许把 `productionReady` 改为 true，并同步删除能力自检
 *    （`assertPostgresComplianceRepositoryCapabilities` 会拒绝「未验证就声称生产可用」），
 *    同时按依赖就绪契约登记封存声明与集成验证证据。
 */
export const POSTGRES_COMPLIANCE_REPOSITORY_VERIFICATION_STEPS = [
  'driver-dependency-evaluated',
  'integration-tests-against-real-postgres',
  'user-compliance-schema-draft-created-and-promoted-to-migration',
  'user-compliance-table-name-aligned-with-bootstrap-placeholder-list',
  'retention-and-export-availability-derivation-defined',
  'compliance-repository-port-migrated-to-async',
  'session-subject-owner-ids-converged-to-uuid',
  'internal-columns-not-projected-verified-against-real-queries',
  'production-ready-capability-flipped-with-evidence',
] as const;

export type PostgresComplianceRepositoryErrorCode =
  | 'CAPABILITY_MISDECLARED'
  | 'INVALID_CONFIGURATION'
  | 'EXECUTOR_UNAVAILABLE'
  | 'EXECUTOR_NOT_POSTGRES'
  | 'EXECUTOR_NOT_PERSISTENT'
  | 'EXECUTOR_FAILURE'
  | 'INVALID_SUBJECT'
  | 'INVALID_ROW'
  | 'RESULT_SET_VIOLATION'
  | 'OWNER_VIOLATION';

/**
 * adapter 的 fail-closed 错误。
 *
 * `issues` 只承载**字段路径与违规类型**（例如 `user_id`、`privacy_consent(invalid_enum_value)`），
 * 不承载字段取值，避免把归属标识、同意原文、手机号、审核意见、证据指针、内部路径、注入载荷或
 * 连接信息写进日志与错误响应。`EXECUTOR_FAILURE` 更进一步：连原始错误的文本与 `cause` 都不携带
 * （见类注释第 8 条）。
 */
export class PostgresComplianceRepositoryError extends Error {
  readonly code: PostgresComplianceRepositoryErrorCode;
  readonly issues: readonly string[];

  constructor(
    code: PostgresComplianceRepositoryErrorCode,
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PostgresComplianceRepositoryError';
    this.code = code;
    this.issues = [...issues];
  }
}

/**
 * 能力自检：**未验证的实现不得声称生产可用**。
 *
 * 任何环境都会执行（能力声明缺失属于代码缺陷，不能等生产才暴露）。
 * 生产可用性的提升必须与 `POSTGRES_COMPLIANCE_REPOSITORY_VERIFICATION_STEPS` 的证据、
 * 以及本断言的同步修改一起发生。
 */
export function assertPostgresComplianceRepositoryCapabilities(
  capabilities: ComplianceRepositoryCapabilities = POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES,
): void {
  const issues: string[] = [];
  if (capabilities.backend !== COMPLIANCE_REPOSITORY_BACKEND_POSTGRES) {
    issues.push('backend');
  }
  if (capabilities.persistent !== true) {
    issues.push('persistent');
  }
  if (capabilities.productionReady !== false) {
    issues.push('productionReady');
  }
  if (issues.length > 0) {
    throw new PostgresComplianceRepositoryError(
      'CAPABILITY_MISDECLARED',
      `PostgreSQL 合规仓储能力声明不符（backend 必须是 ${COMPLIANCE_REPOSITORY_BACKEND_POSTGRES}、persistent=true、productionReady=false）：未完成驱动集成验证前不得声称生产可用`,
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
 * 该列名本身、它映射到的领域字段名（例如 `user_id → ownerUserId`）、或它的**驼峰形**
 * （例如内部列 `phone → phone`、`consent_text → consentText`）。返回空数组表示无泄漏。
 *
 * 驼峰形这一项是本 adapter 相对同族切片的刻意加强：内部列不在列清单里，因此没有
 * `列 → 字段` 映射可查，只比列名会漏掉「视图里直接写 `consentText` / `reviewNote`」这类泄漏。
 */
export function findComplianceViewExclusionLeaks(viewFields: readonly string[]): readonly string[] {
  const declared = new Set(viewFields);
  const columnFields: Record<string, string | undefined> = POSTGRES_COMPLIANCE_COLUMN_FIELDS;
  const leaks: string[] = [];
  for (const column of POSTGRES_COMPLIANCE_VIEW_EXCLUDED_COLUMNS) {
    for (const candidate of [column, camelCase(column), columnFields[column]]) {
      if (candidate !== undefined && declared.has(candidate)) {
        leaks.push(candidate);
      }
    }
  }
  return [...new Set(leaks)];
}

/**
 * 模块加载期自检：**公开视图白名单不得包含归属或存储侧内部列**。
 *
 * 只要有一个泄漏项，本断言立即 fail-closed，避免「悄悄把 userId、同意原文、手机号、审核意见、
 * 证据指针、内部时间戳、路径 / URL / 存储 key 投影出去」这类改动通过测试。
 */
export function assertComplianceViewExclusion(viewFields: readonly string[]): void {
  const leaks = findComplianceViewExclusionLeaks(viewFields);
  if (leaks.length > 0) {
    throw new PostgresComplianceRepositoryError(
      'CAPABILITY_MISDECLARED',
      '公开视图白名单包含归属或存储侧内部列：不得把 userId、同意原文、政策正文、联系方式与 PII、审核 / 证据字段、内部时间戳、路径 / URL / 存储 key 或原始错误投影出去',
      leaks,
    );
  }
}

/**
 * 内部列与列清单的**交集检测**（纯函数）。
 *
 * 内部列一旦被写进列清单，就会自动进入 `SELECT` 并流进领域对象与公开视图。
 * 返回非空表示「本不该投影的列被投影了」。
 */
export function findComplianceInternalColumnOverlaps(
  columns: readonly string[] = POSTGRES_COMPLIANCE_COLUMNS,
): readonly string[] {
  const declared = new Set<string>(columns);
  return POSTGRES_COMPLIANCE_INTERNAL_COLUMNS.filter((column) => declared.has(column));
}

/** 模块加载期自检：内部列与列清单必须零交集（见 `findComplianceInternalColumnOverlaps`） */
export function assertComplianceInternalColumnsAbsent(
  columns: readonly string[] = POSTGRES_COMPLIANCE_COLUMNS,
): void {
  const overlaps = findComplianceInternalColumnOverlaps(columns);
  if (overlaps.length > 0) {
    throw new PostgresComplianceRepositoryError(
      'CAPABILITY_MISDECLARED',
      '列清单包含存储侧内部列：同意原文 / 政策正文、联系方式与 PII、审核 / 证据字段、内部时间戳、路径 / URL / 存储 key、原始错误与簿记列不得进入任何被执行的 SQL',
      overlaps,
    );
  }
}

/**
 * 模块加载期自检：**本 adapter 只能执行 `SELECT`**。
 *
 * 对列清单以「每个列都只出现在一条语句里」的形态做保守校验成本过高，因此这里校验的是
 * **SQL 模板常量本身**：任何 INSERT / UPDATE / DELETE / DDL / 权限关键字一旦进入语句文本，
 * 模块加载即 fail-closed，而不是等运行时才发现「读取切片顺手带了一个写语句」。
 */
export function assertComplianceReadOnlySql(sql: string): void {
  const upper = sql.toUpperCase();
  for (const keyword of POSTGRES_COMPLIANCE_FORBIDDEN_SQL_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, 'u').test(upper)) {
      throw new PostgresComplianceRepositoryError(
        'INVALID_CONFIGURATION',
        `SQL 文本包含只读切片不允许的关键字（本 adapter 只允许 ${POSTGRES_COMPLIANCE_READ_ONLY_STATEMENTS.join(' / ')}）`,
        [keyword.toLowerCase()],
      );
    }
  }
  if (!/\bSELECT\b/u.test(upper)) {
    throw new PostgresComplianceRepositoryError(
      'INVALID_CONFIGURATION',
      'SQL 文本不是 SELECT 语句：只读切片不得执行其它语句',
      ['sql'],
    );
  }
}

/** 空 UUID：合法 UUID 但不是可用主体，取数路径一律拒绝 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * 存储 ID 域判定（单一事实来源）：合法 UUID **且**非空 **且** 规范小写形。
 *
 * 归属复核是逐字节精确比较（`OWNER_VIOLATION`），而 UUID 文本在数据库侧大小写不敏感：
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
    throw new PostgresComplianceRepositoryError(
      'INVALID_CONFIGURATION',
      `SQL 标识符不合规（必须是裸小写标识符）：${label}`,
      [label],
    );
  }
  return value;
}

/** 模块加载即校验：表名与列名一旦被改成非标识符形状，直接 fail-closed（不静默拼进 SQL） */
const TABLE_IDENTIFIER = assertSqlIdentifier(POSTGRES_COMPLIANCE_TABLE, 'table');
const COLUMN_LIST = POSTGRES_COMPLIANCE_COLUMNS.map((column) =>
  assertSqlIdentifier(column, 'column'),
).join(', ');

/**
 * 按服务端主体取数：主体走 `$1::uuid` 绑定，**归属下推进 SQL**（他人合规状态既不出库也不回流）；
 * 显式列清单，不使用 `SELECT *`。
 *
 * 刻意**没有** `ORDER BY` / `LIMIT` / `OFFSET`：本读模型按主体唯一（`findByUserId` 至多一行），
 * 结果集唯一性由 adapter 显式复核（多行即 `RESULT_SET_VIOLATION`），因此不需要排序，
 * 也不做任何本地截断。
 */
const SELECT_BY_USER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE user_id = $1::uuid`;

/** 模块加载即校验：只读语句门禁（见 `assertComplianceReadOnlySql`） */
assertComplianceReadOnlySql(SELECT_BY_USER_SQL);

/** 模块加载即校验：视图白名单、内部列与列清单三者必须一致（见上面两个断言） */
assertComplianceViewExclusion(COMPLIANCE_STATUS_VIEW_FIELDS);
assertComplianceInternalColumnsAbsent();

/**
 * 数据库行契约（**严格**）。
 *
 * `.strict()` 是「字段污染」防线：数据库返回的未登记列（同意原文、政策正文、联系方式与 PII、
 * 审核 / 证据字段、内部时间戳、路径 / URL / 存储 key、原始错误与簿记列）会让解析失败，
 * 而不是被静默丢弃或带进领域对象。列缺失同样失败（PG 对 SELECT 列表中存在的列一定返回键，
 * 缺键说明驱动或 SQL 已被改动）。
 *
 * 存储标识列使用 `storageUuidSchema`（规范小写、非空）：它把「存储层不变量」写成行契约。
 * 三个状态列用**闭集**校验，因此未知状态取值在这里就被拦下（一律 fail-closed，
 * 不会当成合法值返回给上层）；状态之间的**自洽**由读取契约的 superRefine 兜底。
 */
const postgresComplianceRowSchema = z
  .object({
    user_id: storageUuidSchema,
    privacy_consent: z.enum(PRIVACY_CONSENT_STATUS_VALUES),
    data_retention: z.enum(DATA_RETENTION_STATUS_VALUES),
    export_availability: z.enum(EXPORT_AVAILABILITY_STATUS_VALUES),
  })
  .strict();

/** 只保留字段路径与违规类型，绝不含字段取值（归属、同意原文与 PII 不进错误消息） */
function describeIssues(error: z.ZodError): readonly string[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      // 只列出**字段名**（不是字段取值）：让「契约漂移 / 字段污染」可定位，同时不泄露数据
      return issue.keys.map((key) => `${key}(unexpected)`);
    }
    return [`${issue.path.join('.') || '(root)'}(${issue.code})`];
  });
}

function invalidRow(error: z.ZodError, label = 'row'): PostgresComplianceRepositoryError {
  return new PostgresComplianceRepositoryError(
    'INVALID_ROW',
    `数据库行不符合 postgres 行契约（${label}）`,
    describeIssues(error),
  );
}

/**
 * 行 → 领域记录：**逐字段显式映射**（不使用展开），再整体过一次读取契约。
 *
 * 顺序刻意如此：先按严格行契约解析（拒绝未登记列 / 未知状态枚举 / 坏 UUID 归属），
 * 再显式取字段构造**新对象**（即使行里有额外内容也不会被带出，同时保证每次调用返回新副本），
 * 最后用 `parseStoredComplianceRecord` 复核共享读取契约（字段闭集 + 枚举闭集 + 主体形态 +
 * 状态自洽：`exportAvailability = available` 必须由「已生效的同意」与「仍在保留期内」支撑），
 * 任一环节不合规都抛错。
 */
function mapRow(row: unknown): ComplianceRecord {
  const parsedRow = postgresComplianceRowSchema.safeParse(row);
  if (!parsedRow.success) {
    throw invalidRow(parsedRow.error);
  }
  const dbRow = parsedRow.data;

  const record: ComplianceRecord = {
    // 归属：adapter 只承载，不生成、不覆盖；对外由 toComplianceStatusView 裁剪
    ownerUserId: dbRow.user_id,
    privacyConsent: dbRow.privacy_consent,
    dataRetention: dbRow.data_retention,
    exportAvailability: dbRow.export_availability,
  };

  const parsedRecord = parseStoredComplianceRecord(record);
  if (!parsedRecord.ok) {
    throw new PostgresComplianceRepositoryError(
      'INVALID_ROW',
      '数据库行映射后不符合合规状态读取契约（含状态不自洽：未生效的同意 / 已过的保留期不得声明导出可用）',
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
    throw new PostgresComplianceRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      '未提供 SQL 执行器：PostgreSQL 合规仓储拒绝在半可用状态下构造或调用',
      ['executor'],
    );
  }
  const candidate = executor as { query?: unknown; capabilities?: unknown };
  if (typeof candidate.query !== 'function') {
    throw new PostgresComplianceRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器缺少 query 方法：PostgreSQL 合规仓储拒绝在半可用状态下构造或调用',
      ['executor.query'],
    );
  }
  const capabilities = candidate.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new PostgresComplianceRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器未声明能力（backend/persistent/productionReady）',
      ['executor.capabilities'],
    );
  }
  const { backend, persistent } = capabilities as { backend?: unknown; persistent?: unknown };
  if (typeof backend !== 'string' || backend.trim() === '') {
    throw new PostgresComplianceRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器的能力声明缺少 backend 标识',
      ['executor.capabilities.backend'],
    );
  }
  if (!/^postgres/iu.test(backend.trim())) {
    throw new PostgresComplianceRepositoryError(
      'EXECUTOR_NOT_POSTGRES',
      'SQL 执行器声明的后端不是 PostgreSQL：拒绝把本 adapter 挂到其他存储上',
      ['executor.capabilities.backend'],
    );
  }
  if (persistent !== true) {
    throw new PostgresComplianceRepositoryError(
      'EXECUTOR_NOT_PERSISTENT',
      'SQL 执行器声明为非持久后端（内存替身）：PostgreSQL 合规仓储拒绝在其上运行',
      ['executor.capabilities.persistent'],
    );
  }
  return executor as SqlExecutor;
}

/**
 * **存储 ID 域约束**：主体必须是合法、非空、且为**规范小写形**的 UUID。
 *
 * 非 UUID 的标识（例如会话基线的 `u-student-1`，或注入式载荷）会让数据库侧 `uuid`
 * 比较退化为「转换失败 / 放弃类型约束」，因此在这里 fail-closed 拒绝，
 * **绝不绑定进 SQL**（错误信息也不回显该值本身）。
 *
 * 导出（而不是文件内私有）是为了让**延迟建连的换绑工厂**能在解析执行器**之前**调用它：
 * 「服务端主体不落在存储 ID 域」必须在**任何数据库连接之前**就被判定，否则一个不合法的会话
 * 主体会先触发一次连接、再在 adapter 里被拒绝 —— 那既浪费连接，也让「主体域判定发生在
 * 任何连接之前」这条性质无法被测试固定。
 */
export function assertPostgresComplianceSubject(ownerUserId: unknown): string {
  if (!isStorageUuid(ownerUserId)) {
    throw new PostgresComplianceRepositoryError(
      'INVALID_SUBJECT',
      '取数主体必须落在存储 ID 域内（合法且非空的规范小写 UUID）：非 UUID 的 ownerUserId 属于服务端缺陷，不得进入 SQL',
      ['ownerUserId'],
    );
  }
  return ownerUserId;
}

/**
 * 结果集形状 fail-closed：执行器必须返回对象且带 `rows` 数组。
 * 「少字段 / 类型不对」属于驱动或替身实现缺陷，不得被当成「空结果」静默放过
 * （否则会把基础设施故障伪装成「该主体尚无合规记录」）。
 */
function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new PostgresComplianceRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果不是对象（驱动 / 替身实现缺陷）',
      ['result'],
    );
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new PostgresComplianceRepositoryError(
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
    throw new PostgresComplianceRepositoryError(
      'EXECUTOR_FAILURE',
      'SQL 执行失败：原始驱动错误不得外发（错误文本、SQL、连接信息与字段取值都不进入本错误）',
      ['executor'],
    );
  }
  return rowsOf(result);
}

/**
 * 基于 `SqlExecutor` 的 PostgreSQL 合规状态仓储（**只读**）。
 *
 * 构造与每次调用都会重新校验执行器（`assertUsableExecutor`）与自身能力声明，因此「执行器被换掉 /
 * 被降级」或「能力声明被改写」都会 fail-closed，而不是静默继续。
 * 本类**不是** Nest provider（不带任何 Nest 装饰器），也未在任何模块中注册。
 */
export class PostgresComplianceRepository implements AsyncComplianceRepository {
  readonly capabilities: ComplianceRepositoryCapabilities =
    POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES;

  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    assertPostgresComplianceRepositoryCapabilities(this.capabilities);
    this.executor = assertUsableExecutor(executor);
  }

  /** 每次调用前的自检：能力声明与执行器都必须仍然可用 */
  private usableExecutor(): SqlExecutor {
    assertPostgresComplianceRepositoryCapabilities(this.capabilities);
    return assertUsableExecutor(this.executor);
  }

  /**
   * 按服务端主体取数（本人合规状态）。
   *
   * - 主体必须落在存储 ID 域内，否则 `INVALID_SUBJECT`，且不访问数据库；
   * - 归属下推进 SQL（`WHERE user_id = $1`），他人合规状态不会出库；返回记录会**复核**归属：
   *   返回了不该返回的记录即判服务端缺陷并 fail-closed（`OWNER_VIOLATION`），既不静默过滤也不外发；
   * - 结果集出现多行即 `RESULT_SET_VIOLATION`（本读模型按主体唯一，主键 / 唯一约束被破坏时
   *   不得静默取首行）；
   * - 无记录返回 `undefined`（与内存基线同语义，由 service 按 fail-closed 处理），不抛错；
   * - 返回的是**每次新构造**的记录对象：不把数据库行或内部可变引用交给调用方。
   */
  async findByUserId(ownerUserId: string): Promise<ComplianceRecord | undefined> {
    const executor = this.usableExecutor();
    const ownerId = assertPostgresComplianceSubject(ownerUserId);

    const rows = await runQuery(executor, SELECT_BY_USER_SQL, [ownerId]);

    if (rows.length === 0) {
      return undefined;
    }
    if (rows.length > 1) {
      throw new PostgresComplianceRepositoryError(
        'RESULT_SET_VIOLATION',
        '按主体取数返回了多行：合规状态读模型按主体唯一，唯一性约束被破坏',
        ['user_id'],
      );
    }

    const record = mapRow(rows[0]);
    if (record.ownerUserId !== ownerId) {
      throw new PostgresComplianceRepositoryError(
        'OWNER_VIOLATION',
        '返回了请求主体之外的合规状态（他人记录不得回流）',
        ['user_id'],
      );
    }
    return record;
  }
}

/** DI 工厂：把驱动无关的 `SqlExecutor` 装成合规状态仓储端口实现（本切片的换绑点之一） */
export function createPostgresComplianceRepository(executor: SqlExecutor): ComplianceRepository {
  return new PostgresComplianceRepository(executor);
}

/**
 * 延迟建连的 PostgreSQL 合规状态仓储：**模块装配阶段不碰数据库**。
 *
 * 为什么必须延迟：`SQL_CONNECTION_FACTORY.connect()` 在数据库已配置但执行器未通过 attest 契约时
 * 会抛错。如果在这里急切建连，启动失败会表现为「模块工厂抛了数据库错」，而不是启动期持久化边界
 * 给出的**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED` / `DECLARATION_NOT_SEALED` 等）；
 * 依赖就绪门禁也必须能在**任何连接之前**给出 `COMPLIANCE_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`。
 * 延迟后，判定顺序保持为「配置 → 持久化边界 / 依赖就绪 → 首次真正读库」。
 *
 * 连接只在首次读取时建立并被复用；建立失败**不缓存**失败结果（下一次调用会重试）。
 *
 * **存储 ID 域先判、再建连**：服务端主体必须落在 UUID 域内，因此非 UUID 的会话主体
 * （基线的 `u-student-1`）会在解析执行器**之前**被拒绝（`INVALID_SUBJECT`），
 * 不会触发任何数据库连接。
 */
export function createLazyPostgresComplianceRepository(
  resolveExecutor: () => Promise<SqlExecutor>,
  capabilities: ComplianceRepositoryCapabilities = POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES,
): ComplianceRepository {
  assertPostgresComplianceRepositoryCapabilities(capabilities);

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
    async findByUserId(ownerUserId: string): Promise<ComplianceRecord | undefined> {
      // 主体域先判、再建连：非存储 ID 域的主体不应该触发任何数据库连接
      const ownerId = assertPostgresComplianceSubject(ownerUserId);
      const resolved = await executor();
      return new PostgresComplianceRepository(resolved).findByUserId(ownerId);
    },
  };
}
