import { z } from 'zod';
import { AI_ERROR_CODE_VALUES } from '@rm/ai-adapter';
import {
  MATCHING_MAX_RECOMMENDATIONS,
  MATCHING_REQUEST_ENTRY_STATUS,
  MATCHING_REQUEST_STATUS_VALUES,
  matchingRecommendationItemSchema,
  uuidSchema,
} from '@rm/shared';
import type { MatchingRecommendationItem } from '@rm/shared';
import type { SqlExecutor } from '../../db/ports/sql-executor.port';
import { MATCHING_REQUEST_VIEW_FIELDS, parseStoredMatchingRequest } from './matching.contract';
import type { StoredMatchingRequest } from './matching.contract';
import {
  MATCHING_REPOSITORY_BACKEND_POSTGRES,
  type AsyncMatchingRepository,
  type MatchingAccessScope,
  type MatchingRepository,
  type MatchingRepositoryCapabilities,
  type MatchingRequest,
} from './matching.port';

/**
 * 匹配记录（`ai_match_records`）的 **PostgreSQL 仓储 adapter（未接入运行时）**。
 *
 * ## 交付边界（本切片做的事与不做的事）
 * - **已绑定**到 `MatchingModule`：模块的换绑工厂 `createMatchingRepository` 在
 *   「已解析出 `DATABASE_URL` 且拿到 `SQL_CONNECTION_FACTORY`」时绑定
 *   `createLazyPostgresMatchingRepository`，否则绑定内存基线；已配置数据库却拿不到执行器工厂时
 *   **抛错**（fail-closed，绝不静默退回内存存储）。授权边界随每次访问传入，主体与小组标识都
 *   由 service 从服务端会话与召回产物构造；
 * - **延迟建连**：本文件的工厂只持有 `resolveExecutor`，装配阶段（`NestFactory.create()`）
 *   一次都不碰数据库，因此「数据库已配置但执行器未 attest / 依赖未就绪」由启动期门禁给出
 *   **结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED`、`MATCHING_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`），
 *   而不是在这里表现为一个连接错误；
 * - **不引入** `pg` / Prisma / TypeORM 等驱动或 ORM 依赖：本文件只依赖驱动无关的
 *   `SqlExecutor` 端口（`db/ports/sql-executor.port.ts`），真实执行器由消费方显式提供
 *   （驱动只允许出现在 `db/postgres/` 驱动层）；
 * - **不声称生产可用**：能力声明固定为 `backend = postgres`、`persistent = true`、
 *   `productionReady = false`。真实 PostgreSQL 的集成验证已补齐（见同名集成 spec），但
 *   **存储 ID 域尚未收敛**（会话主体与召回小组标识仍是非 UUID 的安全 ID），因此生产启动仍会被
 *   `PersistenceBoundaryService` 与依赖就绪门禁拒绝（`productionReady !== true` 即违规）。
 *
 * ## 为什么端口已经是异步的
 * 运行时端口 `MatchingRepository`（`matching.port.ts`）本来是同步接口；「同步 → 异步」的迁移与
 * 「接入驱动 + 真库集成验证」被刻意绑定在同一片切片，本切片已一并完成：端口现在自身就是
 * 「异步 + 授权边界」形状，`AsyncMatchingRepository` 只作为该契约的历史别名保留。
 * 因此本文件与内存基线**可互换绑定**，而「SQL 与映射是否正确」仍可离线验证。
 *
 * ## 与内存基线的语义对应（逐条可核对）
 * | 内存基线 | 本 adapter |
 * |---|---|
 * | `create` 同 ID 抛「ID 冲突」 | `INSERT … ON CONFLICT (id) DO NOTHING` 无返回行 → `CONFLICT` |
 * | `save` 未知 ID 抛「不存在，无法更新」 | `UPDATE … WHERE id = $1 AND user_id = $2` 无返回行 → `UPDATE_MISSING` |
 * | `save` 归属不一致抛「归属不一致」 | 归属**下推进 SQL**，与上一行同为 0 行 → 同一个 `UPDATE_MISSING` |
 * | `findById` 返回记录或 `undefined` | 单条取数（0 行 → `undefined`，不抛错） |
 * | `listByUserId` 只返回该主体名下记录 | `WHERE user_id = $1::uuid`（归属下推）+ 返回行复核归属 |
 * | 返回副本（不交内部可变引用） | 每次调用都构造**新的**记录对象（显式逐字段赋值、数组复制） |
 *
 * 与内存基线的**两处刻意差异**（都属强化，且都有同名 spec 固定）：
 * 1. 数据库实现必须把「存储层不变量」写成**严格行契约**（未知列、未知状态、未知降级码、
 *    推荐条目的未登记键、重复小组、状态与条数矛盾一律拒绝），因为数据库是外部可变状态；
 * 2. `create` 只接受**入口态**（`pending`）：状态只能由服务端状态机从入口态推进，
 *    直接落一条终态记录会绕过状态机（内存基线不做这项存储层不变量）。
 *
 * ## 安全边界（本文件的十条硬约束）
 * 1. **参数化 SQL + 固定标识符**：所有值一律走 `$1…$n` 占位符绑定；进入 SQL 文本的只有模块常量
 *    （表名、列清单、`::uuid` / `::jsonb` 这类类型转换），且表名与列名都经过 `assertSqlIdentifier`
 *    校验，不存在任何「值 → SQL 文本」的路径（占位符与参数由同一份列清单派生，不会数量漂移）；
 *    本 adapter 只执行三种语句（`INSERT` / `UPDATE` / `SELECT`），模块加载期即校验（见第 8 条）。
 * 2. **显式字段映射 + 严格行契约**：数据库行必须满足严格（`.strict()`）的行契约，再**逐字段显式
 *    映射**为领域记录（列 → 字段的对应关系由 `POSTGRES_MATCHING_COLUMN_FIELDS` 单一事实来源给出，
 *    并另由 `POSTGRES_MATCHING_FIELD_COLUMNS` 在编译期强制「每个领域字段都有对应列」），最后再过一次
 *    `matching.contract.ts` 的读取契约（状态/条数自洽 + 值级 PII 扫描）。任何一步不合规都
 *    **fail-closed** 抛错，绝不把未登记字段、未知状态或半成品记录交给上层。
 * 3. **AI 输入最小化 / 去标识化**：本 adapter **只接受脱敏输入的 sha256 摘要**
 *    （`input_snapshot_hash`，64 位十六进制），既不接收也无法存储特征原文、提示词、模型原始
 *    请求 / 响应。`POSTGRES_MATCHING_AI_BOUNDARY_COLUMNS` 把「原始 AI 输入 / 特征 / 提示词 /
 *    模型 payload」登记为**内部列**：它们不在列清单里（因此不进 `SELECT` / `INSERT` / `UPDATE`
 *    / `RETURNING`、也不进领域对象），modelayload 与提示词在结构上不可能被本 adapter 写出或读出。
 * 4. **原始模型 payload 与内部评分 / 审核字段不进公开结果**：推荐结果以 **JSON 文本**逐条
 *    四字段白名单（`groupId` / `score` / `reason` / `advice`）序列化后绑定（`::jsonb`），
 *    不依赖驱动的对象隐式编码，也不会把入参对象上的多余键写进库；读取时推荐条目用
 *    `.strict()` 条目契约校验（未登记键一律拒绝，而不是静默丢弃）。内部评分明细
 *    （`POSTGRES_MATCHING_INTERNAL_SCORE_COLUMNS`）与审核字段（`POSTGRES_MATCHING_REVIEW_COLUMNS`）
 *    同样登记为内部列。
 * 5. **公开结果不泄露归属与 PII**：adapter 只在**内部存储记录**上承载 `userId`
 *    （不静默丢弃，service 需要它做归属复核），对外裁剪由 `matching.contract.ts` 的
 *    `toMatchingRequestView` 负责；`POSTGRES_MATCHING_VIEW_EXCLUDED_COLUMNS` 给出本 adapter 侧
 *    不进入公开输出的列，模块加载期自检「裁剪列、其映射字段名及其驼峰形绝不落在
 *    `MATCHING_REQUEST_VIEW_FIELDS` 内」（`assertMatchingViewExclusion`）以及「内部列与列清单
 *    零交集」（`assertMatchingInternalColumnsAbsent`）。
 * 6. **状态 / 降级结果闭集**：`status` 只接受共享状态机闭集，`degradation_code` 只接受
 *    `@rm/ai-adapter` 的错误码闭集；此外强制一条可证明的自洽（`fallbackUsed === false` ⇒
 *    `degradationCode` 必须为空：模型成功路径不产生降级码），并把「`completed` 至少有 1 条、
 *    其余状态必须为空」交给读取契约的 `superRefine` 兜底。反向蕴含（降级 ⇒ 必有码）**不**
 *    强制：入口记录合法地是 `fallbackUsed = true` 且没有降级码。
 * 7. **服务端 subject / group 授权边界**：`scope.ownerUserId` 必须由调用方（service）从服务端
 *    会话主体写入；adapter 不生成、不覆盖归属，并把归属**下推进 SQL**
 *    （`WHERE … user_id = $n::uuid`），他人匹配记录根本不出库；返回行上再逐条复核归属
 *    （不一致即 `OWNER_VIOLATION`）。`scope.authorizedGroupIds` 是服务端资源级判定产物：
 *    记录里的推荐结果一旦出现集合之外的小组，一律 `GROUP_SCOPE_VIOLATION` fail-closed
 *    （**不静默过滤**——过滤会把「存储被污染 / 召回越权」伪装成「这条记录只是少几条推荐」）。
 *    写路径同样校验：越权小组既不出库也不落库，且校验在**进入 SQL 之前**完成（无副作用）。
 * 8. **语句与标识符门禁**：模块加载期校验表名 / 列名是裸小写标识符、四条语句模板只含
 *    `INSERT` / `UPDATE` / `SELECT` 且不含任何 DDL / 删除 / 权限关键字（`assertPostgresMatchingSql`）；
 *    `UPDATE` 的 `SET` 列由「列清单去掉不可变列」派生，并在加载期与显式清单逐项比对，
 *    因此「顺手改掉 `id` / `user_id` / `created_at`」会立即 fail-closed。
 * 9. **高敏内容只走内部存储契约，绝不进日志与错误消息**：错误消息与 `issues` 只带**字段路径与
 *    违规类型**，不带任何取值（归属标识、推荐理由 / 建议原文、小组标识、注入载荷、提示词、
 *    模型 payload、内部评分与审核内容都不外发）。
 * 10. **执行器异常不把原始错误文本带出去**：驱动 / 连接池抛出的异常一律收敛为不含原始文本的
 *    `EXECUTOR_FAILURE`（消息、`issues` 都不携带原始错误、SQL、连接信息、参数与字段取值）。
 *
 * ## 尚未解决 / 已登记的前置（因此 productionReady 恒为 false）
 * `ai_match_records` 已由迁移 `0005_ai_match_records.sql` 建立（列清单与本 adapter 的
 * `POSTGRES_MATCHING_COLUMNS` 逐列一致，状态 / 降级码 / 摘要形状的 CHECK 齐备），真库集成验证
 * （建表与列清单、`id` 主键冲突、按主体取数的归属隔离、跨主体覆盖写入 0 行、jsonb 推荐结果的
 * 闭集与顺序、存储层 CHECK 拦截、内部列未投影）由 `matching-integration.spec.ts` 在真实
 * PostgreSQL 上闭环。**仍然未满足的是存储 ID 域**：会话主体是 `u-student-1` 这类安全 ID，
 * 召回来源返回的候选小组 ID 同样不是 UUID，因此数据库路径对它们 fail-closed（在进入 SQL 之前）。
 * 把它收敛为 UUID 属于后续切片。这些都已登记在
 * `POSTGRES_MATCHING_REPOSITORY_VERIFICATION_STEPS` 里，不能只写声明；已取得证据的步骤登记在
 * `POSTGRES_MATCHING_REPOSITORY_VERIFIED_STEPS` 里，且由能力自检强制「尚未全部完成时不得声称
 * 生产可用、全部完成后不得继续声明未验证」。
 */

/** 表名：与 docs/P1-字段级数据字典.md / docs/P2-ER图.md 的 `ai_match_records` 一致 */
export const POSTGRES_MATCHING_TABLE = 'ai_match_records';

/**
 * 列清单：同时定义 `SELECT` 输出列、`INSERT` 列顺序与 `UPDATE` 的可写列来源。
 *
 * 刻意不写 `SELECT *`：存储层新增列（原始 AI 输入 / 特征 / 提示词 / 模型 payload、PII、
 * 内部评分与审核字段、软删除与簿记列）不会因为本文件没更新就自动流进领域对象；配合行契约的
 * `.strict()`，未登记列会被显式拒绝而不是被静默带出。
 *
 * 列名以字段字典的 `ai_match_records` 行为准；端口把归属命名为 `userId`，因此本 adapter 有且
 * 只有一处**非同名映射** `user_id → userId`（见 `POSTGRES_MATCHING_COLUMN_FIELDS`）。
 */
export const POSTGRES_MATCHING_COLUMNS = [
  'id',
  'user_id',
  'status',
  'profile_version',
  'input_snapshot_hash',
  'recommendations',
  'model_version',
  'prompt_version',
  'fallback_used',
  'degradation_code',
  'created_at',
  'updated_at',
] as const;

/** 列 → 领域字段的唯一事实来源（编译期强制覆盖 `MatchingRequest` 的全部字段） */
export const POSTGRES_MATCHING_COLUMN_FIELDS = Object.freeze({
  id: 'id',
  user_id: 'userId',
  status: 'status',
  profile_version: 'profileVersion',
  input_snapshot_hash: 'inputSnapshotHash',
  recommendations: 'recommendations',
  model_version: 'modelVersion',
  prompt_version: 'promptVersion',
  fallback_used: 'fallbackUsed',
  degradation_code: 'degradationCode',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
} as const satisfies Record<(typeof POSTGRES_MATCHING_COLUMNS)[number], keyof MatchingRequest>);

/**
 * 领域字段 → 列的**反向**映射：与 `POSTGRES_MATCHING_COLUMN_FIELDS` 构成双射。
 *
 * 为什么两份都要：`satisfies Record<column, keyof MatchingRequest>` 只保证「每个列都落在领域
 * 字段上」（列 → 字段方向），不能保证「每个领域字段都有列」。反向映射用
 * `satisfies Record<keyof MatchingRequest, column>` 补上另一方向，于是「新增领域字段但忘记补列」
 * 与「列名拼错」都成为编译错误，而不是运行期静默丢字段。
 */
export const POSTGRES_MATCHING_FIELD_COLUMNS = Object.freeze({
  id: 'id',
  userId: 'user_id',
  status: 'status',
  profileVersion: 'profile_version',
  inputSnapshotHash: 'input_snapshot_hash',
  recommendations: 'recommendations',
  modelVersion: 'model_version',
  promptVersion: 'prompt_version',
  fallbackUsed: 'fallback_used',
  degradationCode: 'degradation_code',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const satisfies Record<keyof MatchingRequest, (typeof POSTGRES_MATCHING_COLUMNS)[number]>);

/**
 * 存储记录的**字段闭集**（顶层键）：写路径与行映射都必须恰好落在这组字段上。
 *
 * 它与 `POSTGRES_MATCHING_FIELD_COLUMNS` 在模块加载期逐项比对（见
 * `assertMatchingRequestFieldsAligned`），因此「新增字段只改一处」会立即 fail-closed。
 */
export const POSTGRES_MATCHING_REQUEST_FIELDS = [
  'id',
  'userId',
  'status',
  'profileVersion',
  'inputSnapshotHash',
  'recommendations',
  'modelVersion',
  'promptVersion',
  'fallbackUsed',
  'degradationCode',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof MatchingRequest)[];

/**
 * 归属列：只在服务端内部流转，同时也是 SQL 归属谓词（`WHERE user_id = $n`）唯一使用的列。
 * 它**不进入**公开视图（`MATCHING_REQUEST_VIEW_FIELDS` 里没有 `userId`），也绝不进入错误消息
 * 与日志（他人归属不得回流，也不得外泄）。
 */
export const POSTGRES_MATCHING_OWNER_COLUMNS: readonly (typeof POSTGRES_MATCHING_COLUMNS)[number][] =
  Object.freeze(['user_id']);

/**
 * **不可变列**：只能在 `INSERT` 时写入，之后任何 `UPDATE` 都不得改写。
 *
 * `id` 是服务端生成的主键；`user_id` 是归属（改写归属等于把记录「过户」给他人）；
 * `created_at` 是记录身份的一部分。三者在模块加载期与 `UPDATE` 的 `SET` 列显式比对，
 * 因此「顺手把 id / user_id / created_at 加进 UPDATE」会 fail-closed。
 */
export const POSTGRES_MATCHING_IMMUTABLE_COLUMNS = ['id', 'user_id', 'created_at'] as const;

/**
 * **AI 边界列**（本 adapter 的列清单里刻意**没有**它们）：原始 AI 输入与模型侧原文。
 *
 * - 输入侧：脱敏前的特征快照、学生画像原文、候选小组原始载荷、提示词正文、schema 提示；
 * - 输出侧：模型原始响应、原始 JSON、provider 请求 / 响应体、完成文本。
 *
 * 本 adapter 只接受脱敏输入的 **sha256 摘要**（`input_snapshot_hash`），因此这些列在结构上
 * 既不可能被写入、也不可能被 `SELECT` 出来；把它们显式登记出来，是为了让「AI 输入最小化 /
 * 去标识化」与「原始模型 payload 不外发」成为**可机器校验**的边界，而不是「恰好没查」。
 */
export const POSTGRES_MATCHING_AI_BOUNDARY_COLUMNS = Object.freeze([
  'ai_input',
  'ai_input_snapshot',
  'input_snapshot',
  'input_features',
  'feature_bundle',
  'student_features',
  'student_profile',
  'profile_snapshot',
  'raw_input',
  'raw_input_snapshot',
  'prompt_input',
  'prompt_text',
  'prompt_body',
  'system_prompt',
  'user_prompt',
  'schema_hint',
  'model_payload',
  'model_output',
  'model_response',
  'raw_response',
  'raw_model_output',
  'response_payload',
  'request_payload',
  'provider_request',
  'provider_response',
  'completion',
  'raw_json',
] as const);

/**
 * **PII 列**（本 adapter 的列清单里刻意**没有**它们）：持份人标识与画像原文。
 *
 * 姓名、学号、手机号、邮箱、证件号、微信标识、口令类字段，以及画像的自由文本摘要
 * （经历 / 优势）——泄露即等同于交付个人敏感信息，既不入领域对象、也不外发。
 */
export const POSTGRES_MATCHING_PII_COLUMNS = Object.freeze([
  'name',
  'real_name',
  'student_no',
  'student_number',
  'sno',
  'phone',
  'mobile',
  'telephone',
  'email',
  'id_card',
  'id_number',
  'wechat_openid',
  'wechat_unionid',
  'openid',
  'unionid',
  'password',
  'token',
  'secret',
  'experience_summary',
  'strengths_summary',
  'raw_experience',
] as const);

/**
 * **内部评分列**（本 adapter 的列清单里刻意**没有**它们）：规则降级与模型排序的内部明细。
 *
 * 公开视图里允许出现的是推荐条目的 `score`（0—100 的对外匹配分，白名单四字段之一）；
 * 这里登记的是**产生该分数**的内部明细（原始模型分、排序分、权重、分项得分、命中 / 缺失技能、
 * 时间缺口、年级与名额判定），它们不进入领域对象，更不进入公开结果。
 */
export const POSTGRES_MATCHING_INTERNAL_SCORE_COLUMNS = Object.freeze([
  'internal_score',
  'raw_score',
  'model_score',
  'match_score',
  'ranking_score',
  'fallback_score',
  'score_breakdown',
  'score_detail',
  'score_details',
  'direction_score',
  'skill_score',
  'confidence',
  'confidence_score',
  'weight',
  'weights',
  'matched_skills',
  'missing_skills',
  'hours_shortfall',
  'grade_matched',
  'capacity_ok',
] as const);

/**
 * **审核列**（本 adapter 的列清单里刻意**没有**它们）：审核 / 审批 / 管理端备注。
 *
 * 匹配记录的学生自服务切片里没有审核环节；管理端 `/admin/matching-records` 与留痕属于后续
 * 切片。这些列一旦混进列清单，就会把内部审核意见与审核人标识带进学生侧响应，因此显式登记。
 */
export const POSTGRES_MATCHING_REVIEW_COLUMNS = Object.freeze([
  'review_status',
  'review_note',
  'review_comment',
  'reviewer_id',
  'reviewer_user_id',
  'reviewed_at',
  'admin_note',
  'audit_note',
  'approval_status',
  'approved_by',
  'approved_at',
  'rejected_reason',
  'decision',
  'decision_reason',
] as const);

/**
 * **存储侧簿记与派生来源列**（本 adapter 的列清单里刻意**没有**它们）：幂等键、版本、租户、
 * 账期、软删除、供应商调用 id、用量与错误原文。
 */
export const POSTGRES_MATCHING_BOOKKEEPING_COLUMNS = Object.freeze([
  'version',
  'etag',
  'idempotency_key',
  'idempotent_key',
  'tenant_id',
  'source',
  'derivation',
  'deleted_at',
  'archived_at',
  'purged_at',
  'request_id',
  'trace_id',
  'run_id',
  'model_call_id',
  'provider_request_id',
  'provider_response_id',
  'tokens_used',
  'prompt_tokens',
  'completion_tokens',
  'cost',
  'latency_ms',
  'duration_ms',
  'attempts',
  'retry_count',
  'created_by',
  'updated_by',
  'deleted_by',
  'error_message',
  'failure_reason',
  'stack_trace',
  'last_error',
] as const);

/**
 * **存储侧内部列**：AI 边界列 + PII + 内部评分 + 审核 + 簿记的并集。
 *
 * 它们**不进 `SELECT` / `INSERT` / `UPDATE` / `RETURNING`**，因此既不进领域记录、也不进公开
 * 视图；把它们显式登记出来，是为了让「公开结果不泄露 userId、原始模型 payload、PII、
 * 内部评分与审核字段」成为可机器校验的边界（模块加载期零交集自检 + 同名 spec）。
 */
export const POSTGRES_MATCHING_INTERNAL_COLUMNS = Object.freeze([
  ...POSTGRES_MATCHING_AI_BOUNDARY_COLUMNS,
  ...POSTGRES_MATCHING_PII_COLUMNS,
  ...POSTGRES_MATCHING_INTERNAL_SCORE_COLUMNS,
  ...POSTGRES_MATCHING_REVIEW_COLUMNS,
  ...POSTGRES_MATCHING_BOOKKEEPING_COLUMNS,
] as const);

/**
 * 本 adapter 侧**不进入公开输出**的列：归属（`user_id`）+ 脱敏输入的摘要
 * （`input_snapshot_hash`：属内部处理记录，公开视图里没有该字段）+ 全部内部列。
 *
 * 对外裁剪由 `toMatchingRequestView` 负责（逐字段显式赋值、不展开）；本清单用于机器校验
 * 「adapter 不把归属、快照摘要、原始模型 payload、PII、内部评分与审核字段投影出去」。
 */
export const POSTGRES_MATCHING_VIEW_EXCLUDED_COLUMNS = Object.freeze([
  'user_id',
  'input_snapshot_hash',
  ...POSTGRES_MATCHING_INTERNAL_COLUMNS,
] as const);

/** 仓储能力：持久但**未验证**，因此生产环境仍会被持久化边界守卫拦下 */
export const POSTGRES_MATCHING_REPOSITORY_CAPABILITIES: MatchingRepositoryCapabilities =
  Object.freeze({
    backend: MATCHING_REPOSITORY_BACKEND_POSTGRES,
    persistent: true,
    productionReady: false,
  });

/**
 * 转成生产可用前必须完成的验证清单（每一项都需要证据，不能只写声明）：
 * 1. 驱动依赖经评估后引入（`docs/P2-开源复用评估.md` 的 Prisma / TypeORM 比较结论）；
 * 2. 对真实 PostgreSQL 的集成测试：建表迁移、`id` 主键冲突、`user_id` 索引、按主体取数排序、
 *    jsonb 推荐结果的闭集与顺序，以及**存储层不产生跨主体读取**（他人匹配记录不出库）；
 * 3. `ai_match_records` 的 schema 草案创建并按 `db/schema-drafts/README.md` 的规范转成迁移并执行
 *    验证（当前 `db/migrations/0001_bootstrap.sql` 只在注释里登记该表，`db/schema-drafts/` 里
 *    没有对应草案）；
 * 4. `MatchingRepository` 端口改为异步：service / controller 与其测试一起改，并且每次访问都要
 *    构造 `MatchingAccessScope`（服务端 subject + 服务端已授权小组集合）；
 * 5. 会话主体 `userId` 与推荐结果里的 `groupId` **一起**收敛为 UUID（当前基线是 `u-student-1`
 *    这类安全 ID，不满足存储 ID 域）；
 * 6. 内部列不投影对真实查询复核：确认没有任何原始 AI 输入 / 提示词 / 模型 payload、PII、
 *    内部评分明细或审核字段随 `SELECT`、`RETURNING` 或错误信息外发；
 * 7. 完成 1–6 后，才允许把 `productionReady` 改为 true，并同步删除能力自检
 *    （`assertPostgresMatchingRepositoryCapabilities` 会拒绝「未验证就声称生产可用」）。
 */
export const POSTGRES_MATCHING_REPOSITORY_VERIFICATION_STEPS = [
  'driver-dependency-evaluated',
  'integration-tests-against-real-postgres',
  'ai-match-records-schema-draft-created-and-promoted-to-migration',
  'matching-repository-port-migrated-to-async',
  'session-subject-and-recommendation-group-ids-converged-to-uuid',
  'internal-columns-not-projected-verified-against-real-queries',
  'production-ready-capability-flipped-with-evidence',
] as const;

/**
 * **已取得证据**的验证步骤（上面清单的子集，逐项都有可核对的证据）：
 * - `driver-dependency-evaluated`：官方 `pg` 驱动已授权且只允许出现在 `db/postgres/` 驱动层
 *   （见 `postgres-adapter-registry.ts` 的 `AUTHORIZED_POSTGRES_DRIVER_PACKAGES`）；
 * - `integration-tests-against-real-postgres`：`matching-integration.spec.ts` 在真实 PostgreSQL 上
 *   执行迁移与读写闭环（未配置 `TEST_DATABASE_URL` 时整个套件明确 skip，绝不伪造通过）；
 * - `ai-match-records-schema-draft-created-and-promoted-to-migration`：`ai_match_records` 由迁移
 *   `0005_ai_match_records.sql` 建立，列清单与本 adapter 的列清单逐列一致；
 * - `matching-repository-port-migrated-to-async`：运行时端口 `MatchingRepository` 已是
 *   「异步 + 授权边界」形状（`AsyncMatchingRepository` 仅作为历史别名）；
 * - `internal-columns-not-projected-verified-against-real-queries`：真库列清单**恰好**是 12 个
 *   输出列（无任何原始 AI 输入 / 提示词 / 模型 payload / PII / 内部评分 / 审核 / 簿记列），
 *   且取值只进参数、SQL 文本由模块常量派生。
 *
 * 仍待完成：`session-subject-and-recommendation-group-ids-converged-to-uuid`（会话主体与召回
 * 小组标识仍是非 UUID 的安全 ID，数据库路径对它们 fail-closed）与
 * `production-ready-capability-flipped-with-evidence`。两者未完成前
 * `productionReady` 必须保持 `false`（由能力自检强制）。
 */
export const POSTGRES_MATCHING_REPOSITORY_VERIFIED_STEPS = [
  'driver-dependency-evaluated',
  'integration-tests-against-real-postgres',
  'ai-match-records-schema-draft-created-and-promoted-to-migration',
  'matching-repository-port-migrated-to-async',
  'internal-columns-not-projected-verified-against-real-queries',
] as const satisfies readonly (typeof POSTGRES_MATCHING_REPOSITORY_VERIFICATION_STEPS)[number][];

export type PostgresMatchingRepositoryErrorCode =
  | 'CAPABILITY_MISDECLARED'
  | 'INVALID_CONFIGURATION'
  | 'EXECUTOR_UNAVAILABLE'
  | 'EXECUTOR_NOT_POSTGRES'
  | 'EXECUTOR_NOT_PERSISTENT'
  | 'EXECUTOR_FAILURE'
  | 'INVALID_SCOPE'
  | 'INVALID_SUBJECT'
  | 'INVALID_RECORD_ID'
  | 'INVALID_RECORD'
  | 'INVALID_ROW'
  | 'RESULT_SET_VIOLATION'
  | 'CONFLICT'
  | 'UPDATE_MISSING'
  | 'IDENTITY_MISMATCH'
  | 'OWNER_VIOLATION'
  | 'GROUP_SCOPE_VIOLATION';

/**
 * adapter 的 fail-closed 错误。
 *
 * `issues` 只承载**字段路径与违规类型**（例如 `user_id`、`status(invalid_enum_value)`、
 * `recommendations.0.groupId`），不承载字段取值，避免把归属标识、推荐理由 / 建议原文、
 * 小组标识、提示词、模型 payload、内部评分、审核内容、注入载荷或连接信息写进日志与错误响应。
 * `EXECUTOR_FAILURE` 更进一步：连原始错误的文本与 `cause` 都不携带（见类注释第 10 条）。
 */
export class PostgresMatchingRepositoryError extends Error {
  readonly code: PostgresMatchingRepositoryErrorCode;
  readonly issues: readonly string[];

  constructor(
    code: PostgresMatchingRepositoryErrorCode,
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PostgresMatchingRepositoryError';
    this.code = code;
    this.issues = [...issues];
  }
}

/**
 * 能力自检：**未验证的实现不得声称生产可用**。
 *
 * 任何环境都会执行（能力声明缺失属于代码缺陷，不能等生产才暴露）。
 * 生产可用性的提升必须与 `POSTGRES_MATCHING_REPOSITORY_VERIFICATION_STEPS` 的证据、
 * 以及本断言的同步修改一起发生。
 */
export function assertPostgresMatchingRepositoryCapabilities(
  capabilities: MatchingRepositoryCapabilities = POSTGRES_MATCHING_REPOSITORY_CAPABILITIES,
): void {
  const issues: string[] = [];
  if (capabilities.backend !== MATCHING_REPOSITORY_BACKEND_POSTGRES) {
    issues.push('backend');
  }
  if (capabilities.persistent !== true) {
    issues.push('persistent');
  }
  if (capabilities.productionReady !== false) {
    issues.push('productionReady');
  }

  // 验证清单与能力声明必须同步：登记为「已完成」的步骤必须是清单里的成员，
  // 且**尚有未完成步骤时不得声称生产可用、全部完成后不得继续声明未验证**（避免陈旧声明）。
  const declared = new Set<string>(POSTGRES_MATCHING_REPOSITORY_VERIFICATION_STEPS);
  const unknown = POSTGRES_MATCHING_REPOSITORY_VERIFIED_STEPS.filter((step) => !declared.has(step));
  if (unknown.length > 0) {
    issues.push('verifiedSteps');
  }
  const verified = new Set<string>(POSTGRES_MATCHING_REPOSITORY_VERIFIED_STEPS);
  const pending = POSTGRES_MATCHING_REPOSITORY_VERIFICATION_STEPS.filter(
    (step) => !verified.has(step),
  );
  if (pending.length === 0 && capabilities.productionReady !== true) {
    // 清单全部完成却仍声明「未验证」= 陈旧声明：必须与 productionReady 的翻转同时更新
    issues.push('productionReady');
  }
  if (pending.length > 0 && capabilities.productionReady === true) {
    issues.push('productionReady');
  }

  if (issues.length > 0) {
    throw new PostgresMatchingRepositoryError(
      'CAPABILITY_MISDECLARED',
      `PostgreSQL 匹配仓储能力声明不符（backend 必须是 ${MATCHING_REPOSITORY_BACKEND_POSTGRES}、persistent=true，且 productionReady 必须与验证清单的完成状态一致）：未完成驱动集成验证前不得声称生产可用`,
      [...new Set(issues)],
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
 * 该列名本身、它映射到的领域字段名（例如 `user_id → userId`）、或它的**驼峰形**
 * （例如 `input_snapshot_hash → inputSnapshotHash`、`internal_score → internalScore`）。
 * 返回空数组表示无泄漏。
 */
export function findMatchingViewExclusionLeaks(viewFields: readonly string[]): readonly string[] {
  const declared = new Set(viewFields);
  const columnFields: Record<string, string | undefined> = POSTGRES_MATCHING_COLUMN_FIELDS;
  const leaks: string[] = [];
  for (const column of POSTGRES_MATCHING_VIEW_EXCLUDED_COLUMNS) {
    for (const candidate of [column, camelCase(column), columnFields[column]]) {
      if (candidate !== undefined && declared.has(candidate)) {
        leaks.push(candidate);
      }
    }
  }
  return [...new Set(leaks)];
}

/**
 * 模块加载期自检：**公开视图白名单不得包含归属、快照摘要或任何内部列**。
 *
 * 只要有一个泄漏项，本断言立即 fail-closed，避免「悄悄把 userId、原始 AI 输入 / 提示词 /
 * 模型 payload、PII、内部评分明细或审核字段投影出去」这类改动通过测试。
 */
export function assertMatchingViewExclusion(viewFields: readonly string[]): void {
  const leaks = findMatchingViewExclusionLeaks(viewFields);
  if (leaks.length > 0) {
    throw new PostgresMatchingRepositoryError(
      'CAPABILITY_MISDECLARED',
      '公开视图白名单包含归属、脱敏快照摘要或存储侧内部列：不得把 userId、原始 AI 输入 / 提示词 / 模型 payload、PII、内部评分或审核字段投影出去',
      leaks,
    );
  }
}

/**
 * 内部列与列清单的**交集检测**（纯函数）。
 *
 * 内部列一旦被写进列清单，就会自动进入 `SELECT` / `INSERT` / `UPDATE` 并流进领域对象与公开视图。
 * 返回非空表示「本不该投影的列被投影了」。
 */
export function findMatchingInternalColumnOverlaps(
  columns: readonly string[] = POSTGRES_MATCHING_COLUMNS,
): readonly string[] {
  const declared = new Set<string>(columns);
  return POSTGRES_MATCHING_INTERNAL_COLUMNS.filter((column) => declared.has(column));
}

/** 模块加载期自检：内部列与列清单必须零交集（见 `findMatchingInternalColumnOverlaps`） */
export function assertMatchingInternalColumnsAbsent(
  columns: readonly string[] = POSTGRES_MATCHING_COLUMNS,
): void {
  const overlaps = findMatchingInternalColumnOverlaps(columns);
  if (overlaps.length > 0) {
    throw new PostgresMatchingRepositoryError(
      'CAPABILITY_MISDECLARED',
      '列清单包含存储侧内部列：原始 AI 输入 / 特征 / 提示词 / 模型 payload、PII、内部评分、审核与簿记列不得进入任何被执行的 SQL',
      overlaps,
    );
  }
}

/** 本 adapter 允许出现的语句种类（写入 + 取数；没有任何 DDL / 删除 / 权限语句） */
export const POSTGRES_MATCHING_WRITABLE_STATEMENTS: readonly string[] = Object.freeze([
  'INSERT',
  'UPDATE',
  'SELECT',
]);

/** 绝不允许出现在 SQL 文本里的关键字（删除 / DDL / 权限 / 批量导入 / 服务端过程） */
export const POSTGRES_MATCHING_FORBIDDEN_SQL_KEYWORDS: readonly string[] = Object.freeze([
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
  'VACUUM',
  'REINDEX',
  'CALL',
]);

/**
 * 模块加载期自检：**本 adapter 只执行写入与取数三类语句**。
 *
 * 校验的是**SQL 模板常量本身**：任何 `DELETE` / DDL / 权限 / `CALL` 关键字一旦进入语句文本，
 * 模块加载即 fail-closed，而不是等运行时才发现「匹配切片顺手带了一个删除或改表语句」。
 */
export function assertPostgresMatchingSql(sql: string): void {
  const upper = sql.toUpperCase();
  for (const keyword of POSTGRES_MATCHING_FORBIDDEN_SQL_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, 'u').test(upper)) {
      throw new PostgresMatchingRepositoryError(
        'INVALID_CONFIGURATION',
        `SQL 文本包含本切片不允许的关键字（只允许 ${POSTGRES_MATCHING_WRITABLE_STATEMENTS.join(' / ')}）`,
        [keyword.toLowerCase()],
      );
    }
  }
  if (
    !POSTGRES_MATCHING_WRITABLE_STATEMENTS.some((statement) =>
      new RegExp(`\\b${statement}\\b`, 'u').test(upper),
    )
  ) {
    throw new PostgresMatchingRepositoryError(
      'INVALID_CONFIGURATION',
      'SQL 文本不是本切片允许的语句（INSERT / UPDATE / SELECT）',
      ['sql'],
    );
  }
}

/** SQL 标识符白名单：只允许小写字母开头的裸标识符，杜绝用「列名 / 表名」夹带 SQL 片段 */
const SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/u;

function assertSqlIdentifier(value: string, label: string): string {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new PostgresMatchingRepositoryError(
      'INVALID_CONFIGURATION',
      `SQL 标识符不合规（必须是裸小写标识符）：${label}`,
      [label],
    );
  }
  return value;
}

/** 模块加载即校验：表名与列名一旦被改成非标识符形状，直接 fail-closed（不静默拼进 SQL） */
const TABLE_IDENTIFIER = assertSqlIdentifier(POSTGRES_MATCHING_TABLE, 'table');
const COLUMN_LIST = POSTGRES_MATCHING_COLUMNS.map((column) =>
  assertSqlIdentifier(column, 'column'),
).join(', ');

/** 逐列的类型转换：只在「列 → 参数占位」这一步使用，值本身永远不进入 SQL 文本 */
const COLUMN_PARAMETER_CASTS: Partial<Record<(typeof POSTGRES_MATCHING_COLUMNS)[number], string>> =
  {
    id: '::uuid',
    user_id: '::uuid',
    profile_version: '::integer',
    recommendations: '::jsonb',
    created_at: '::timestamptz',
    updated_at: '::timestamptz',
  };

/** `VALUES ($1::uuid, $2::uuid, …)`：占位符与列一一对应，由列清单派生，不会出现数量漂移 */
const INSERT_VALUES = POSTGRES_MATCHING_COLUMNS.map(
  (column, index) => `$${index + 1}${COLUMN_PARAMETER_CASTS[column] ?? ''}`,
).join(', ');

/**
 * 写入语句：客户端可控值全部走 `$n`；`ON CONFLICT (id) DO NOTHING` 让**主键冲突显式暴露**
 * （与内存基线 `create` 抛「匹配请求 ID 冲突」同语义：记录 ID 由服务端生成，冲突属于服务端
 * 缺陷，不得静默覆盖）。`RETURNING` 让写入结果可被严格行契约复核（而不是「写完就当成功」）。
 */
const INSERT_SQL = `INSERT INTO ${TABLE_IDENTIFIER} (
  ${COLUMN_LIST}
) VALUES (${INSERT_VALUES})
ON CONFLICT (id) DO NOTHING
RETURNING ${COLUMN_LIST}`;

/**
 * `UPDATE` 的 `SET` 列：**由列清单去掉不可变列派生**，占位符从 `$3` 起（`$1` = id、`$2` = 归属）。
 *
 * 派生而非手写，是为了让「新增列」自动进入可写列、并让「不可变列」在结构上无法被改写；
 * 模块加载期还会把派生结果与显式清单逐项比对（见 `assertMatchingUpdateColumnsAligned`）。
 */
const UPDATE_SET_COLUMNS = POSTGRES_MATCHING_COLUMNS.filter(
  (column) => !(POSTGRES_MATCHING_IMMUTABLE_COLUMNS as readonly string[]).includes(column),
);

const UPDATE_ASSIGNMENTS = UPDATE_SET_COLUMNS.map(
  (column, index) => `${column} = $${index + 3}${COLUMN_PARAMETER_CASTS[column] ?? ''}`,
).join(',\n  ');

/**
 * 覆盖写入语句：**归属下推进 SQL**（`WHERE id = $1 AND user_id = $2`），因此他人记录永远不会被
 * 本语句改写；`SET` 里没有 `id` / `user_id` / `created_at`，记录身份与创建时间在语句层面不可变。
 *
 * 0 行同时覆盖两种服务端缺陷（ID 不存在 / 记录不属于该主体），统一抛 `UPDATE_MISSING`：
 * 前者与内存基线同语义，后者是刻意的**不区分**（否则调用方可以据错误码探测他人记录是否存在）。
 */
const UPDATE_SQL = `UPDATE ${TABLE_IDENTIFIER} SET
  ${UPDATE_ASSIGNMENTS}
WHERE id = $1::uuid AND user_id = $2::uuid
RETURNING ${COLUMN_LIST}`;

/**
 * 单条取数语句：**记录 ID 与归属同时命中**才返回（归属下推进 SQL，他人记录不出库）。
 * 两个参数都走 `$n::uuid` 绑定；显式列清单，不使用 `SELECT *`。
 */
const SELECT_BY_ID_FOR_OWNER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE id = $1::uuid AND user_id = $2::uuid`;

/**
 * 按主体取数语句：主体走 `$1::uuid` 绑定；显式列清单，不使用 `SELECT *`。
 * 排序固定为 `created_at ASC, id ASC`：与内存基线的插入顺序一致，并给出稳定、可复现的顺序，
 * 避免数据库返回顺序漂移。
 */
const SELECT_BY_OWNER_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE user_id = $1::uuid
  ORDER BY created_at ASC, id ASC`;

/** 模块加载即校验：四条语句模板只含 INSERT / UPDATE / SELECT，且不含任何被禁关键字 */
for (const sql of [INSERT_SQL, UPDATE_SQL, SELECT_BY_ID_FOR_OWNER_SQL, SELECT_BY_OWNER_SQL]) {
  assertPostgresMatchingSql(sql);
}

/**
 * 模块加载期自检：`SET` 列必须恰好是「列清单去掉不可变列」。
 *
 * 显式清单与派生结果逐项比对：任何人手工删掉一个可写列（例如悄悄不再更新 `updated_at`）
 * 或把不可变列写回来，模块加载都会 fail-closed。
 */
function assertMatchingUpdateColumnsAligned(): void {
  const expected = [
    'status',
    'profile_version',
    'input_snapshot_hash',
    'recommendations',
    'model_version',
    'prompt_version',
    'fallback_used',
    'degradation_code',
    'updated_at',
  ] as const;
  if (UPDATE_SET_COLUMNS.join(',') !== expected.join(',')) {
    throw new PostgresMatchingRepositoryError(
      'INVALID_CONFIGURATION',
      'UPDATE 的可写列与「列清单去掉不可变列」不一致：不可变列（id / user_id / created_at）不得出现在 SET 中',
      ['update_columns'],
    );
  }
}

/**
 * 模块加载期自检：存储记录的**字段闭集**与字段 → 列映射必须同源同序。
 *
 * 两份声明都只允许在同一处新增字段；只改一处（例如加了列但没加字段闭集）会立即 fail-closed。
 */
function assertMatchingRequestFieldsAligned(): void {
  if (
    Object.keys(POSTGRES_MATCHING_FIELD_COLUMNS).join(',') !==
    POSTGRES_MATCHING_REQUEST_FIELDS.join(',')
  ) {
    throw new PostgresMatchingRepositoryError(
      'INVALID_CONFIGURATION',
      '存储记录的字段闭集与「字段 → 列」映射不一致：新增字段必须同时登记在两处',
      ['request_fields'],
    );
  }
}

assertMatchingUpdateColumnsAligned();
assertMatchingRequestFieldsAligned();

/** 模块加载即校验：公开视图白名单与内部列边界（见上面两个断言） */
assertMatchingViewExclusion(MATCHING_REQUEST_VIEW_FIELDS);
assertMatchingInternalColumnsAbsent();

/** 空 UUID：合法 UUID 但不是可用主体 / 资源，读写路径一律拒绝 */
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

function requireStorageUuid(
  value: unknown,
  code: PostgresMatchingRepositoryErrorCode,
  message: string,
  label: string,
): string {
  if (!isStorageUuid(value)) {
    throw new PostgresMatchingRepositoryError(code, message, [label]);
  }
  return value;
}

/** 行契约里的存储标识列：形状 = 存储 ID 域（规范小写、非空），与写入侧同一判定 */
const storageUuidSchema = uuidSchema.refine(isStorageUuid, '必须是规范小写形的非空 UUID');

/**
 * 推荐条目契约（**严格**）：本切片只允许 `groupId` / `score` / `reason` / `advice` 四条。
 *
 * 共享 `matchingRecommendationItemSchema` 是普通对象（zod 默认静默剥离未知键），因此这里用
 * `.strict()` 做「字段污染」防线：模型原始 payload、内部评分明细或审核字段一旦混进推荐条目，
 * 整条记录 fail-closed，而不是被静默丢弃后照常外发。
 */
const strictRecommendationItemSchema = matchingRecommendationItemSchema.strict();

/** 推荐列表：条数上限与共享契约一致；条目为严格形，且不做本地重排（JSON 数组顺序即语义顺序） */
const strictRecommendationListSchema = z
  .array(strictRecommendationItemSchema)
  .max(MATCHING_MAX_RECOMMENDATIONS);

/**
 * 数据库行契约（**严格**）。
 *
 * `.strict()` 是「字段污染」防线：数据库返回的未登记列（原始 AI 输入 / 提示词 / 模型 payload、
 * PII、内部评分、审核字段、软删除与簿记列）会让解析失败，而不是被静默丢弃或带进领域对象。
 * 列缺失同样失败（PG 对 SELECT 列表中存在的列一定返回键，缺键说明驱动或 SQL 已被改动）。
 *
 * `recommendations` 用 `unknown` 接住（jsonb 可能被驱动解析成数组，也可能以文本返回），
 * 形状由 `assertStoredMatchingValue` 用严格条目契约一次性判定，不做局部宽松。
 *
 * 文本列先按**原样长度**收口（不 trim）：读取契约随后再按 trim 后的长度与内容安全复核，
 * 因此「靠首尾空白绕过长度的存储值」在行契约就被拒绝，而不会在映射时被静默修正。
 */
const postgresMatchingRowSchema = z
  .object({
    id: storageUuidSchema,
    user_id: storageUuidSchema,
    status: z.enum(MATCHING_REQUEST_STATUS_VALUES),
    profile_version: z.number().int().min(1).max(1_000_000).nullable(),
    input_snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/u, '输入快照摘要必须是 sha256 十六进制'),
    recommendations: z.unknown(),
    model_version: z.string().min(1).max(64),
    prompt_version: z.string().min(1).max(64),
    fallback_used: z.boolean(),
    degradation_code: z.enum(AI_ERROR_CODE_VALUES).nullable(),
    created_at: z.union([z.date(), z.string()]),
    updated_at: z.union([z.date(), z.string()]),
  })
  .strict();

/** 只保留字段路径与违规类型，绝不含字段取值（归属、推荐原文与提示词不进错误消息） */
function describeIssues(error: z.ZodError, prefix = ''): readonly string[] {
  return error.issues.flatMap((issue) => {
    const path = [prefix, issue.path.join('.')].filter((part) => part !== '').join('.');
    if (issue.code === 'unrecognized_keys') {
      // 只列出**字段名**（不是字段取值）：让「契约漂移 / 字段污染」可定位，同时不泄露数据
      return issue.keys.map((key) => `${path ? `${path}.` : ''}${key}(unexpected)`);
    }
    return [`${path || '(root)'}(${issue.code})`];
  });
}

function invalidRow(error: z.ZodError, label = 'row'): PostgresMatchingRepositoryError {
  return new PostgresMatchingRepositoryError(
    'INVALID_ROW',
    `数据库行不符合 postgres 行契约（${label}）`,
    describeIssues(error),
  );
}

/** 时间列 → ISO 字符串；坏时间戳 fail-closed（不产生 `Invalid Date` 之类的半成品） */
function toIsoTimestamp(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PostgresMatchingRepositoryError('INVALID_ROW', `时间列不是合法时间戳：${label}`, [
      label,
    ]);
  }
  return date.toISOString();
}

/**
 * jsonb 列归一：驱动可能已把 `jsonb` 解析成数组，也可能原样返回文本。
 *
 * 文本形态由本 adapter **自己解析**（不依赖驱动的隐式解码），解析失败即 `INVALID_ROW`
 * ——数据库里的推荐结果不可读属于服务端缺陷，不得当成「没有推荐」放过。
 */
function normalizeJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new PostgresMatchingRepositoryError(
      'INVALID_ROW',
      '推荐结果列的 jsonb 文本无法解析（驱动 / 存储层缺陷）',
      ['recommendations(parse_failed)'],
    );
  }
}

/**
 * 存储记录校验（读路径与写路径共用同一套不变量）。
 *
 * 顺序刻意如此：字段闭集 → 推荐条目严格契约（拒绝条目内未登记键）→ 共享读取契约
 * （枚举闭集 + 状态/条数自洽 + 值级 PII 扫描）→ 降级码自洽 → 推荐小组不重复。
 * 任何一步不合规都 fail-closed，且错误 `issues` 只含字段路径与违规类型。
 */
function assertStoredMatchingValue(
  raw: unknown,
  code: 'INVALID_ROW' | 'INVALID_RECORD',
  label: string,
): StoredMatchingRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PostgresMatchingRepositoryError(code, `${label}必须是对象`, ['(root)']);
  }
  const declared = new Set<string>(POSTGRES_MATCHING_REQUEST_FIELDS);
  const unexpected = Object.keys(raw as Record<string, unknown>).filter(
    (key) => !declared.has(key),
  );
  if (unexpected.length > 0) {
    // 服务端独占 / 内部字段（原始模型 payload、内部评分、审核字段）不得经记录对象夹带
    throw new PostgresMatchingRepositoryError(
      code,
      `${label}包含字段闭集之外的字段`,
      unexpected.map((key) => `${key}(unexpected)`),
    );
  }

  const parsedRecommendations = strictRecommendationListSchema.safeParse(
    (raw as { recommendations?: unknown }).recommendations,
  );
  if (!parsedRecommendations.success) {
    throw new PostgresMatchingRepositoryError(
      code,
      `${label}的推荐结果不符合条目闭集（只允许 groupId / score / reason / advice 四条字段）`,
      describeIssues(parsedRecommendations.error, 'recommendations'),
    );
  }

  const parsed = parseStoredMatchingRequest(raw);
  if (!parsed.ok) {
    throw new PostgresMatchingRepositoryError(
      code,
      `${label}不符合匹配记录读取契约（状态闭集、状态与条数自洽、摘要与时间格式、推荐文本无个人标识）`,
      parsed.issues.map((issue) => `${issue.path}(${issue.kind})`),
    );
  }

  const value = parsed.value;
  assertMatchingFallbackConsistency(value, code);

  const seen = new Set<string>();
  const duplicates: string[] = [];
  value.recommendations.forEach((item, index) => {
    if (seen.has(item.groupId)) {
      duplicates.push(`recommendations.${index}.groupId`);
    }
    seen.add(item.groupId);
  });
  if (duplicates.length > 0) {
    // 上游适配层已把「同一小组被重复推荐」判为非法输出，因此存储层出现重复即属记录被改写
    throw new PostgresMatchingRepositoryError(
      code,
      `${label}的推荐结果出现重复小组（同一小组不得被重复推荐）`,
      duplicates,
    );
  }

  return value;
}

/**
 * 状态 / 降级结果的**可证明自洽**：`fallbackUsed === false` ⇒ `degradationCode` 必须为空。
 *
 * 依据：`invokeMatchingWithFallback` 的成功路径不产生 `errorCode`（`buildResult(…, false)` 且
 * 返回对象里没有 `errorCode`），service 也只在登记在案的错误码上写入降级码。反向蕴含刻意**不**
 * 强制：入口记录合法地是 `fallbackUsed = true` 且没有降级码（尚未调用模型）。
 */
function assertMatchingFallbackConsistency(
  value: { readonly fallbackUsed: boolean; readonly degradationCode?: unknown },
  code: 'INVALID_ROW' | 'INVALID_RECORD',
): void {
  if (value.fallbackUsed === false && value.degradationCode !== undefined) {
    throw new PostgresMatchingRepositoryError(
      code,
      '记录声明未降级却携带降级原因码：非降级结果的 degradationCode 必须为空',
      ['degradationCode'],
    );
  }
}

/**
 * 授权边界（`MatchingAccessScope`）的 fail-closed 校验。
 *
 * 形状与取值都必须显式合法：对象、只允许 `ownerUserId` / `authorizedGroupIds` 两个键、
 * 主体落在存储 ID 域内、小组集合逐条是存储 ID 域内的 UUID（去重按集合语义）。
 * 任何不合规都在**进入 SQL 之前**拒绝（错误信息不回显取值），因此不存在「半个边界」被使用。
 */
export function assertMatchingAccessScope(scope: unknown): MatchingAccessScope {
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    throw new PostgresMatchingRepositoryError(
      'INVALID_SCOPE',
      '授权边界必须是对象（服务端 subject + 已授权小组集合）',
      ['scope'],
    );
  }
  const declared = new Set(['ownerUserId', 'authorizedGroupIds']);
  const unexpected = Object.keys(scope as Record<string, unknown>).filter(
    (key) => !declared.has(key),
  );
  if (unexpected.length > 0) {
    throw new PostgresMatchingRepositoryError(
      'INVALID_SCOPE',
      '授权边界包含闭集之外的字段（客户端可控字段一律不得进入边界）',
      unexpected.map((key) => `${key}(unexpected)`),
    );
  }

  const candidate = scope as { ownerUserId?: unknown; authorizedGroupIds?: unknown };
  const ownerUserId = requireStorageUuid(
    candidate.ownerUserId,
    'INVALID_SUBJECT',
    '取数 / 写入主体必须落在存储 ID 域内（合法且非空的规范小写 UUID）：非 UUID 的 ownerUserId 属于服务端缺陷，不得进入 SQL',
    'ownerUserId',
  );
  if (!Array.isArray(candidate.authorizedGroupIds)) {
    throw new PostgresMatchingRepositoryError(
      'INVALID_SCOPE',
      '授权边界的小组集合必须是数组（服务端资源级判定产物）',
      ['authorizedGroupIds'],
    );
  }
  const authorizedGroupIds: string[] = [];
  for (const [index, value] of candidate.authorizedGroupIds.entries()) {
    authorizedGroupIds.push(
      requireStorageUuid(
        value,
        'INVALID_SCOPE',
        '已授权小组 ID 必须全部是存储 ID 域内的 UUID（非 UUID 的可见小组标识属于服务端缺陷，不得进入 SQL）',
        `authorizedGroupIds.${index}`,
      ),
    );
  }
  return { ownerUserId, authorizedGroupIds: [...new Set(authorizedGroupIds)] };
}

/**
 * 推荐结果的小组授权边界：记录里的每个 `groupId` 都必须落在服务端已判定可见的集合内。
 *
 * 与归属复核同理，这是**纵深防御**：召回本应只产出已授权小组，因此越权小组出现即说明存储被
 * 改写或召回越权。刻意**不**把它下推进 SQL 做过滤——过滤会把「记录被污染」伪装成「这条记录
 * 只是少几条推荐」，而且 jsonb 包含关系下推会让「多行 / 越权」不再 fail-closed。
 */
function assertRecommendationsWithinScope(
  recommendations: readonly MatchingRecommendationItem[],
  access: MatchingAccessScope,
  code: PostgresMatchingRepositoryErrorCode,
): void {
  const authorized = new Set(access.authorizedGroupIds);
  const violations = recommendations.flatMap((item, index) =>
    authorized.has(item.groupId) ? [] : [`recommendations.${index}.groupId`],
  );
  if (violations.length > 0) {
    throw new PostgresMatchingRepositoryError(
      code,
      '推荐结果包含授权范围之外的小组（他人小组既不得落库也不得出库）；错误信息不回显小组标识',
      violations,
    );
  }
}

/** 存储记录 → 领域记录：**逐字段显式映射**（不使用展开），数组逐条复制 */
function toDomainRecord(value: StoredMatchingRequest): MatchingRequest {
  return {
    id: value.id,
    // 归属：adapter 只承载，不生成、不覆盖；对外由 toMatchingRequestView 裁剪
    userId: value.userId,
    status: value.status,
    ...(value.profileVersion !== undefined ? { profileVersion: value.profileVersion } : {}),
    inputSnapshotHash: value.inputSnapshotHash,
    recommendations: value.recommendations.map((item) => ({
      groupId: item.groupId,
      score: item.score,
      reason: item.reason,
      advice: item.advice,
    })),
    modelVersion: value.modelVersion,
    promptVersion: value.promptVersion,
    fallbackUsed: value.fallbackUsed,
    ...(value.degradationCode !== undefined ? { degradationCode: value.degradationCode } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/**
 * 行 → 领域记录：严格行契约 → 逐字段显式映射 → 记录级不变量 → 小组授权边界。
 *
 * 每次调用都构造**新对象**（不把数据库行的引用、也不把驱动持有的数组交给调用方）。
 */
function mapRow(row: unknown, access: MatchingAccessScope): MatchingRequest {
  const parsedRow = postgresMatchingRowSchema.safeParse(row);
  if (!parsedRow.success) {
    throw invalidRow(parsedRow.error);
  }
  const dbRow = parsedRow.data;

  const value = assertStoredMatchingValue(
    {
      id: dbRow.id,
      userId: dbRow.user_id,
      status: dbRow.status,
      ...(dbRow.profile_version !== null ? { profileVersion: dbRow.profile_version } : {}),
      inputSnapshotHash: dbRow.input_snapshot_hash,
      recommendations: normalizeJsonColumn(dbRow.recommendations),
      modelVersion: dbRow.model_version,
      promptVersion: dbRow.prompt_version,
      fallbackUsed: dbRow.fallback_used,
      ...(dbRow.degradation_code !== null ? { degradationCode: dbRow.degradation_code } : {}),
      createdAt: toIsoTimestamp(dbRow.created_at, 'created_at'),
      updatedAt: toIsoTimestamp(dbRow.updated_at, 'updated_at'),
    },
    'INVALID_ROW',
    '数据库行映射后的匹配记录',
  );

  assertRecommendationsWithinScope(value.recommendations, access, 'GROUP_SCOPE_VIOLATION');
  return toDomainRecord(value);
}

/**
 * 写入记录校验：字段闭集 + 读取契约（严格） + 存储 ID 域 + （创建时）**入口态**。
 *
 * 为什么创建时连入口态也要在存储层判定：状态只能由服务端状态机从入口态推进；直接 `INSERT` 一条
 * 终态记录会绕过状态机（内存基线不做这项存储层不变量，属本 adapter 的刻意强化）。覆盖写入
 * （`save`）承载的正是「入口态 → 终态」的推进结果，因此**不**要求入口态，但状态仍必须是闭集取值
 * 且与推荐条数自洽（由读取契约校验）。
 *
 * `id` 与归属在**进入 SQL 之前**判定，因此非规范形 / 空 UUID 的拒绝不会留下任何已写入的行。
 */
function assertWritableRecord(
  request: unknown,
  options: { readonly requireEntryStatus: boolean },
): StoredMatchingRequest {
  const value = assertStoredMatchingValue(request, 'INVALID_RECORD', '待写入的匹配记录');
  requireStorageUuid(
    value.id,
    'INVALID_RECORD',
    '待写入的匹配记录缺少有效记录 ID（ID 必须由服务端生成，且是规范小写形的非空 UUID）',
    'id',
  );
  requireStorageUuid(
    value.userId,
    'INVALID_RECORD',
    '待写入的匹配记录缺少有效归属（归属必须由服务端会话主体写入，且落在存储 ID 域内）',
    'userId',
  );
  if (options.requireEntryStatus && value.status !== MATCHING_REQUEST_ENTRY_STATUS) {
    throw new PostgresMatchingRepositoryError(
      'INVALID_RECORD',
      '待写入的匹配记录不是入口态：创建只能写入入口状态，终态只能由状态机推进',
      ['status'],
    );
  }
  return value;
}

/**
 * 写入参数：**由列清单派生**（列 → 字段 → 值），因此参数顺序永远与 SQL 占位符一致；
 * `Record<keyof MatchingRequest, unknown>` 让「新增领域字段但忘记补参数」成为编译错误。
 *
 * 推荐结果以 **JSON 文本**绑定（`::jsonb` 转换），且序列化时**逐条只取四条白名单字段**：
 * 既不依赖驱动对对象的隐式编码，也不可能把入参对象上的多余键写进库。
 */
function parameterMap(value: StoredMatchingRequest): Record<keyof MatchingRequest, unknown> {
  return {
    id: value.id,
    userId: value.userId,
    status: value.status,
    profileVersion: value.profileVersion ?? null,
    inputSnapshotHash: value.inputSnapshotHash,
    recommendations: JSON.stringify(
      value.recommendations.map((item) => ({
        groupId: item.groupId,
        score: item.score,
        reason: item.reason,
        advice: item.advice,
      })),
    ),
    modelVersion: value.modelVersion,
    promptVersion: value.promptVersion,
    fallbackUsed: value.fallbackUsed,
    degradationCode: value.degradationCode ?? null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function insertParameters(value: StoredMatchingRequest): readonly unknown[] {
  const values = parameterMap(value);
  return POSTGRES_MATCHING_COLUMNS.map((column) => values[POSTGRES_MATCHING_COLUMN_FIELDS[column]]);
}

function updateParameters(value: StoredMatchingRequest): readonly unknown[] {
  const values = parameterMap(value);
  return [
    value.id,
    value.userId,
    ...UPDATE_SET_COLUMNS.map((column) => values[POSTGRES_MATCHING_COLUMN_FIELDS[column]]),
  ];
}

/**
 * 执行器 fail-closed 校验：没有执行器、执行器不像 PostgreSQL、或声明为**非持久**
 * （内存替身）时一律拒绝，而不是「先跑起来再说」。
 */
function assertUsableExecutor(executor: unknown): SqlExecutor {
  if (typeof executor !== 'object' || executor === null) {
    throw new PostgresMatchingRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      '未提供 SQL 执行器：PostgreSQL 匹配仓储拒绝在半可用状态下构造或调用',
      ['executor'],
    );
  }
  const candidate = executor as { query?: unknown; capabilities?: unknown };
  if (typeof candidate.query !== 'function') {
    throw new PostgresMatchingRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器缺少 query 方法：PostgreSQL 匹配仓储拒绝在半可用状态下构造或调用',
      ['executor.query'],
    );
  }
  const capabilities = candidate.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new PostgresMatchingRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器未声明能力（backend/persistent/productionReady）',
      ['executor.capabilities'],
    );
  }
  const { backend, persistent } = capabilities as { backend?: unknown; persistent?: unknown };
  if (typeof backend !== 'string' || backend.trim() === '') {
    throw new PostgresMatchingRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器的能力声明缺少 backend 标识',
      ['executor.capabilities.backend'],
    );
  }
  if (!/^postgres/iu.test(backend.trim())) {
    throw new PostgresMatchingRepositoryError(
      'EXECUTOR_NOT_POSTGRES',
      'SQL 执行器声明的后端不是 PostgreSQL：拒绝把本 adapter 挂到其他存储上',
      ['executor.capabilities.backend'],
    );
  }
  if (persistent !== true) {
    throw new PostgresMatchingRepositoryError(
      'EXECUTOR_NOT_PERSISTENT',
      'SQL 执行器声明为非持久后端（内存替身）：PostgreSQL 匹配仓储拒绝在其上运行',
      ['executor.capabilities.persistent'],
    );
  }
  return executor as SqlExecutor;
}

/**
 * 结果集形状 fail-closed：执行器必须返回对象且带 `rows` 数组。
 * 「少字段 / 类型不对」属于驱动或替身实现缺陷，不得被当成「空结果」静默放过
 * （否则会把基础设施故障伪装成「该主体尚无匹配记录」）。
 */
function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new PostgresMatchingRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果不是对象（驱动 / 替身实现缺陷）',
      ['result'],
    );
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new PostgresMatchingRepositoryError(
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
    throw new PostgresMatchingRepositoryError(
      'EXECUTOR_FAILURE',
      'SQL 执行失败：原始驱动错误不得外发（错误文本、SQL、连接信息、参数与字段取值都不进入本错误）',
      ['executor'],
    );
  }
  return rowsOf(result);
}

/**
 * 基于 `SqlExecutor` 的 PostgreSQL 匹配记录仓储。
 *
 * 构造与每次调用都会重新校验执行器（`assertUsableExecutor`）与自身能力声明，因此「执行器被
 * 换掉 / 被降级」或「能力声明被改写」都会 fail-closed，而不是静默继续。
 * 本类**不是** Nest provider（不带任何 Nest 装饰器），也未在任何模块中注册。
 */
export class PostgresMatchingRepository implements AsyncMatchingRepository {
  readonly capabilities: MatchingRepositoryCapabilities = POSTGRES_MATCHING_REPOSITORY_CAPABILITIES;

  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    assertPostgresMatchingRepositoryCapabilities(this.capabilities);
    this.executor = assertUsableExecutor(executor);
  }

  /** 每次调用前的自检：能力声明与执行器都必须仍然可用 */
  private usableExecutor(): SqlExecutor {
    assertPostgresMatchingRepositoryCapabilities(this.capabilities);
    return assertUsableExecutor(this.executor);
  }

  /**
   * 写入一条已由 service 补齐归属 / 状态 / 摘要与时间戳的**入口**记录。
   *
   * - 授权边界与记录都必须合法：`scope.ownerUserId` 必须等于记录归属（否则 `OWNER_VIOLATION`），
   *   记录 ID / 归属必须落在存储 ID 域内，状态必须是入口态，推荐结果必须在已授权小组集合内；
   *   任何不合规都在**进入 SQL 之前**拒绝，因此拒绝不会留下任何已写入的行；
   * - 主键冲突（`ON CONFLICT DO NOTHING` 无返回行）显式抛 `CONFLICT`，与内存基线同语义，
   *   不静默覆盖；
   * - 返回行必须能通过严格行契约与读取契约，且**主键与归属**都必须等于请求写入的记录
   *   （数据库回流出「他人记录」或归属被改写时判服务端缺陷）。
   */
  async create(request: MatchingRequest, scope: MatchingAccessScope): Promise<MatchingRequest> {
    const executor = this.usableExecutor();
    const access = assertMatchingAccessScope(scope);
    const writable = assertWritableRecord(request, { requireEntryStatus: true });
    this.assertOwnerMatches(writable.userId, access.ownerUserId);
    assertRecommendationsWithinScope(writable.recommendations, access, 'GROUP_SCOPE_VIOLATION');

    const rows = await runQuery(executor, INSERT_SQL, insertParameters(writable));

    if (rows.length === 0) {
      // 主键冲突（ON CONFLICT DO NOTHING）属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new PostgresMatchingRepositoryError(
        'CONFLICT',
        '匹配请求 ID 冲突：写入未返回任何行（主键已存在）',
        ['id'],
      );
    }
    if (rows.length > 1) {
      throw new PostgresMatchingRepositoryError(
        'RESULT_SET_VIOLATION',
        '写入语句返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const created = mapRow(rows[0], access);
    this.assertIdentityMatches(created.id, writable.id, 'id', '主键');
    this.assertOwnerMatches(created.userId, writable.userId);
    return created;
  }

  /**
   * 覆盖写入状态机推进结果。
   *
   * - 归属下推进 SQL（`WHERE id = $1 AND user_id = $2`），因此他人记录永远不会被本语句改写；
   * - `SET` 列不含 `id` / `user_id` / `created_at`：记录身份与创建时间不可改写；
   * - 0 行统一抛 `UPDATE_MISSING`（ID 不存在 / 不属于该主体 / 归属被改写），**不区分**原因，
   *   避免调用方用错误码探测他人记录是否存在；
   * - 返回行必须通过严格行契约与读取契约，且主键、归属与**创建时间**都必须与请求一致
   *   （数据库回流出「他人记录」、归属被改写或 SQL 被改动时判服务端缺陷）。
   */
  async save(request: MatchingRequest, scope: MatchingAccessScope): Promise<MatchingRequest> {
    const executor = this.usableExecutor();
    const access = assertMatchingAccessScope(scope);
    const writable = assertWritableRecord(request, { requireEntryStatus: false });
    this.assertOwnerMatches(writable.userId, access.ownerUserId);
    assertRecommendationsWithinScope(writable.recommendations, access, 'GROUP_SCOPE_VIOLATION');

    const rows = await runQuery(executor, UPDATE_SQL, updateParameters(writable));

    if (rows.length === 0) {
      throw new PostgresMatchingRepositoryError(
        'UPDATE_MISSING',
        '匹配请求不存在、不属于该主体或归属已被改写：覆盖写入未命中任何行（不区分原因，避免用存在性探测他人资源）',
        ['id', 'user_id'],
      );
    }
    if (rows.length > 1) {
      throw new PostgresMatchingRepositoryError(
        'RESULT_SET_VIOLATION',
        '覆盖写入返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const saved = mapRow(rows[0], access);
    this.assertIdentityMatches(saved.id, writable.id, 'id', '主键');
    this.assertOwnerMatches(saved.userId, writable.userId);
    if (Date.parse(saved.createdAt) !== Date.parse(writable.createdAt)) {
      // 创建时间不在 SET 列里，返回行必须仍等于请求的记录身份
      throw new PostgresMatchingRepositoryError(
        'IDENTITY_MISMATCH',
        '返回记录的创建时间与请求不一致：记录创建时间不可改写',
        ['created_at'],
      );
    }
    return saved;
  }

  /**
   * 按「记录 ID + 服务端主体归属」取单条记录。
   *
   * - 授权边界与记录 ID 都必须落在存储 ID 域内，否则在**不访问数据库**的情况下 fail-closed；
   * - 归属下推进 SQL：他人记录不会出库；未命中（不存在、或存在但不属于该主体）统一返回
   *   `undefined`——调用方据此判 404，且**不区分**两种情形，避免用存在性探测他人资源；
   * - 返回行必须通过严格行契约、读取契约与小组授权边界，且主键与归属都必须等于请求取值
   *   （数据库回流出「他人记录」或 SQL 被改动时判服务端缺陷）；
   * - 主键不唯一导致返回多行 → 结果集违约，fail-closed。
   */
  async findById(
    requestId: string,
    scope: MatchingAccessScope,
  ): Promise<MatchingRequest | undefined> {
    const executor = this.usableExecutor();
    const access = assertMatchingAccessScope(scope);
    const id = requireStorageUuid(
      requestId,
      'INVALID_RECORD_ID',
      '记录 ID 必须落在存储 ID 域内（合法且非空的规范小写 UUID）：非 UUID 的资源标识属于服务端缺陷，不得进入 SQL',
      'requestId',
    );

    const rows = await runQuery(executor, SELECT_BY_ID_FOR_OWNER_SQL, [id, access.ownerUserId]);

    if (rows.length === 0) {
      return undefined;
    }
    if (rows.length > 1) {
      throw new PostgresMatchingRepositoryError(
        'RESULT_SET_VIOLATION',
        '按记录 ID 取数返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const found = mapRow(rows[0], access);
    this.assertIdentityMatches(found.id, id, 'id', '主键');
    this.assertOwnerMatches(found.userId, access.ownerUserId);
    return found;
  }

  /**
   * 按服务端主体取数（列表）。
   *
   * - 主体必须落在存储 ID 域内，否则 `INVALID_SUBJECT`，且不访问数据库；
   * - 每条返回记录都会**逐条复核**归属与小组授权边界：返回了他人记录或越权小组即判服务端缺陷
   *   并 fail-closed，绝不把「别人的匹配记录」当作本主体列表的一项交给上层（纵深防御）；
   * - 重复主键同样判结果集违约（避免同一记录在列表里出现两次而放大影响）；
   * - 无记录返回空数组（`[]`），不是 `undefined`，且不抛错。
   */
  async listByUserId(scope: MatchingAccessScope): Promise<readonly MatchingRequest[]> {
    const executor = this.usableExecutor();
    const access = assertMatchingAccessScope(scope);

    const rows = await runQuery(executor, SELECT_BY_OWNER_SQL, [access.ownerUserId]);

    const records = rows.map((row) => mapRow(row, access));
    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id)) {
        throw new PostgresMatchingRepositoryError(
          'RESULT_SET_VIOLATION',
          '返回结果包含重复的匹配请求 ID：结果集违反取数契约',
          ['id'],
        );
      }
      seen.add(record.id);
      this.assertOwnerMatches(record.userId, access.ownerUserId);
    }
    return records;
  }

  /** 归属复核（纵深防御）：返回记录 / 写入记录的归属必须与本次访问的服务端主体一致 */
  private assertOwnerMatches(actual: string, expected: string): void {
    if (actual !== expected) {
      throw new PostgresMatchingRepositoryError(
        'OWNER_VIOLATION',
        '记录的归属与本次访问的服务端主体不一致（他人记录既不出库也不得回流）',
        ['user_id'],
      );
    }
  }

  /** 主键复核（纵深防御）：返回记录的主键必须等于本次请求的资源标识 */
  private assertIdentityMatches(
    actual: string,
    expected: string,
    label: string,
    what: string,
  ): void {
    if (actual !== expected) {
      throw new PostgresMatchingRepositoryError(
        'IDENTITY_MISMATCH',
        `${what}与请求不一致（他人记录不得作为本次结果回流）`,
        [label],
      );
    }
  }
}

/**
 * 写入参数的**连接前判定**（延迟建连包装与 `PostgresMatchingRepository` 共用同一口径）：
 * 授权边界 → 记录可写性 → 归属一致 → 推荐结果在已授权小组集合内。任何一步不合规都在
 * **解析执行器之前** fail-closed，因此拒绝不会建立连接、也不会留下任何已写入的行。
 */
function assertWritableAccess(
  request: unknown,
  scope: unknown,
  options: { readonly requireEntryStatus: boolean },
): MatchingAccessScope {
  const access = assertMatchingAccessScope(scope);
  const writable = assertWritableRecord(request, options);
  if (writable.userId !== access.ownerUserId) {
    throw new PostgresMatchingRepositoryError(
      'OWNER_VIOLATION',
      '记录的归属与本次访问的服务端主体不一致（他人记录既不出库也不得回流）',
      ['user_id'],
    );
  }
  assertRecommendationsWithinScope(writable.recommendations, access, 'GROUP_SCOPE_VIOLATION');
  return access;
}

/**
 * **延迟建连**的 PostgreSQL 匹配仓储：模块换绑工厂（`createMatchingRepository`）返回的实现。
 *
 * 为什么必须延迟：装配阶段（`NestFactory.create()`）**一次都不能碰数据库**。否则
 * 「数据库已配置但 SQL 执行器未 attest / 依赖未就绪」就会在这里表现为一个**连接错误**，
 * 而启动期门禁（`PersistenceBoundaryService` + 依赖就绪契约）就轮不到给出结构化违规。
 * 本工厂因此只持有 `resolveExecutor`，第一次真正访问时才解析执行器并建连；连接结果被缓存，
 * 且**失败不缓存**（下一次调用会重新解析，避免一次瞬时故障把端口永久钉死）。
 *
 * 判定顺序（与 `matching.binding.spec.ts` 固定的一致）：
 * 1. 能力自检（未验证的实现不得声称生产可用，且完成状态必须与验证清单同步）；
 * 2. **授权边界与存储 ID 域先判**：非 UUID 主体 / 小组标识、越权推荐、非入口态记录都在解析
 *    执行器**之前**被拒绝 —— 既不进 SQL、也不建连；
 * 3. 解析执行器并构造 `PostgresMatchingRepository`，由其再执行严格行契约与逐列复核
 *    （纵深防御：同一组不变量在包装层与实现层各判一次）。
 *
 * 执行器解析失败（例如拿到 fail-closed 的未验证驱动工厂）时，错误**原样抛出**：
 * 它是基础设施故障，不是业务结论，且其消息由驱动层构造（本文件不追加任何连接信息）。
 */
export function createLazyPostgresMatchingRepository(
  resolveExecutor: () => Promise<SqlExecutor>,
  capabilities: MatchingRepositoryCapabilities = POSTGRES_MATCHING_REPOSITORY_CAPABILITIES,
): MatchingRepository {
  assertPostgresMatchingRepositoryCapabilities(capabilities);

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
    async create(request: MatchingRequest, scope: MatchingAccessScope): Promise<MatchingRequest> {
      const access = assertWritableAccess(request, scope, { requireEntryStatus: true });
      return new PostgresMatchingRepository(await executor()).create(request, access);
    },
    async save(request: MatchingRequest, scope: MatchingAccessScope): Promise<MatchingRequest> {
      const access = assertWritableAccess(request, scope, { requireEntryStatus: false });
      return new PostgresMatchingRepository(await executor()).save(request, access);
    },
    async findById(
      requestId: string,
      scope: MatchingAccessScope,
    ): Promise<MatchingRequest | undefined> {
      const access = assertMatchingAccessScope(scope);
      const id = requireStorageUuid(
        requestId,
        'INVALID_RECORD_ID',
        '记录 ID 必须落在存储 ID 域内（合法且非空的规范小写 UUID）：非 UUID 的资源标识属于服务端缺陷，不得进入 SQL',
        'requestId',
      );
      return new PostgresMatchingRepository(await executor()).findById(id, access);
    },
    async listByUserId(scope: MatchingAccessScope): Promise<readonly MatchingRequest[]> {
      const access = assertMatchingAccessScope(scope);
      return new PostgresMatchingRepository(await executor()).listByUserId(access);
    },
  };
}
