import { z } from 'zod';
import { uuidSchema } from '@rm/shared';
import type { SqlExecutor } from '../../db/ports/sql-executor.port';
import {
  AUDIT_EVENT_VIEW_FIELDS,
  ipHashSchema,
  parseStoredAuditEvent,
  storedAuditEventSchema,
} from './audit.contract';
import {
  AUDIT_EVENT_TYPE_VALUES,
  AUDIT_REPOSITORY_BACKEND_POSTGRES,
  AUDIT_RESOURCE_TYPE_VALUES,
  AUDIT_RESULT_VALUES,
} from './audit.port';
import type {
  AsyncAuditRepository,
  AuditEvent,
  AuditRepository,
  AuditRepositoryCapabilities,
} from './audit.port';

/**
 * 不可变业务审计记录的 **PostgreSQL 仓储 adapter（已按「是否配置数据库」接入运行时）**。
 *
 * ## 交付边界（本切片刻意不做的事）
 * - **装配由业务模块的工厂决定**：`AuditModule` 经 `createAuditRepository` 按
 *   `resolveAppDatabaseConfig` 的分流结果绑定实现 —— 未配置 `DATABASE_URL` 时绑定内存基线
 *   `InMemoryAuditRepository`，配置时绑定本文件经 `createLazyPostgresAuditRepository`
 *   构造的实现（**延迟建连**，装配阶段一次都不碰数据库）。adapter 本身仍**不带**任何 Nest
 *   装饰器：依赖注入元数据只允许出现在 Module 的工厂里；
 * - **不引入** `pg` / Prisma / TypeORM 等驱动或 ORM 依赖：本文件只依赖驱动无关的
 *   `SqlExecutor` 端口（`db/ports/sql-executor.port.ts`），真实执行器由 `SQL_CONNECTION_FACTORY`
 *   在数据库已配置且执行器 attest 事实齐全时提供；
 * - **不声称生产可用**：能力声明固定为 `backend = postgres`、`persistent = true`、
 *   `productionReady = false`。`audit_logs` 已由迁移 `0009` 建立（含存储层仅追加触发器），
 *   真实 PostgreSQL 集成验证也已由 `db/postgres/__tests__/audit-integration.spec.ts` 覆盖；
 *   但生产准入还要求**封存声明 + 已登记的验证证据**（`persistence/dependency-readiness.ts`），
 *   且会话主体标识尚未收敛为 UUID，因此在补齐这些证据前，生产启动仍会被
 *   `PersistenceBoundaryService` / `DependencyReadinessService` 拒绝。
 *
 * ## 异步契约
 * 端口 `AuditRepository` 本身就是异步契约（内存基线与本 adapter 同语义、可互为替换）。
 * 本文件实现 `AsyncAuditRepository`（`AuditRepository` 的等价历史别名），让「SQL 与映射是否正确」
 * 可以在**没有驱动、也没有数据库**的情况下被离线验证，并让换绑与回退都是整步操作。
 *
 * ## 与内存基线的语义对应（逐条可核对）
 * | 内存基线 | 本 adapter |
 * |---|---|
 * | `append` 同 ID 冲突抛错（不静默覆盖） | `INSERT … ON CONFLICT (id) DO NOTHING` 无返回行 → `CONFLICT` |
 * | `listVisibleByActor` 只返回「主体本人 且 本人可见」 | `WHERE actor_user_id = $1 AND self_visible = TRUE`（归属与可见性下推）+ 逐条复核 |
 * | 记录不可变（返回冻结副本） | 只追加、没有任何改写 / 删除语句的路径；SQL 只含 `INSERT` 与 `SELECT` |
 * | 端口没有改写/删除方法 | adapter 同样没有：`update` / `delete` / `remove` / `save` / `archive` / `upsert` 一个都不存在 |
 *
 * 与内存基线的**唯一刻意差异**：内存基线不做读取契约校验（存储层损坏必须能被出口门禁看见），
 * 而数据库实现必须把「存储层不变量」写成**严格行契约**（未知列、未知枚举、坏时间戳、非 UUID
 * 标识、非 sha256 的 `ipHash` 一律拒绝），因为数据库是外部可变状态，行内容可能被任意来源写坏。
 *
 * ## 安全边界（本文件的六条硬约束）
 * 1. **参数化 SQL + 固定标识符**：所有值一律走 `$1…$n` 占位符绑定；进入 SQL 文本的只有模块
 *    常量（表名、列清单、`TRUE` 这类 SQL 关键字），且表名与列名都经过 `assertSqlIdentifier`
 *    校验，不存在任何「值 → SQL 文本」的路径（占位符与参数由同一份列清单派生，不会数量漂移）；
 * 2. **显式字段映射 + 严格行契约**：数据库行必须满足严格（`.strict()`）的行契约（未知列、
 *    非法枚举、非 UUID、坏时间戳、非 sha256 哈希一律拒绝），再**逐字段显式映射**为领域记录
 *    （列 → 字段的对应关系由 `POSTGRES_AUDIT_COLUMN_FIELDS` 单一事实来源给出，并另由
 *    `POSTGRES_AUDIT_FIELD_COLUMNS` 在编译期强制「每个领域字段都有对应列」），最后再过一次
 *    `audit.contract.ts` 的读取契约；任何一步不合规都 **fail-closed** 抛错，绝不把未登记字段、
 *    未知事件类型或半成品记录交给上层；
 * 3. **actor / 归属隔离**：`actorUserId` 必须由调用方（service）从服务端会话主体写入，必须是
 *    合法、非空、规范小写形的 UUID（**存储 ID 域约束**，见 `audit.port.ts`）；adapter 不生成、
 *    不覆盖归属，并且**把归属下推进 SQL**：`listVisibleByActor` 只返回请求主体的记录；返回行上
 *    再逐条复核归属（不一致即 `OWNER_VIOLATION`）——他人事件既不出库、也不得回流；
 * 4. **仅追加，不可更新 / 删除**：端口与实现都没有改写入口，执行的 SQL 只有
 *    `INSERT … ON CONFLICT (id) DO NOTHING` 与 `SELECT`；主键冲突显式抛 `CONFLICT`（ID 由服务端
 *    生成，冲突属于服务端缺陷，不得静默覆盖），因此「业务 API 删除或改写审计」在存储层也无可
 *    命中语句；
 * 5. **公开视图不携带归属、关联 ID、网络归属、可见性口径与资源标识，也不携带存储侧内部列**：
 *    adapter 只在**内部存储记录**上承载 `actorUserId`（不静默丢弃），对外裁剪由
 *    `audit.contract.ts` 的 `toAuditEventView` 负责；本文件显式声明**存储侧内部列**
 *    （`POSTGRES_AUDIT_INTERNAL_COLUMNS`：请求头、user-agent、明文 IP / 对端地址、路径、URL、
 *    方法、内部 payload、改前/改后快照、理由、完整性 / 序列 / 软删除 / 幂等字段）与
 *    **公开输出裁剪列**（`POSTGRES_AUDIT_VIEW_EXCLUDED_COLUMNS`），并在模块加载期自检
 *    「裁剪列及其映射字段绝不落在公开视图白名单内」（`assertAuditViewExclusion`）；
 *    内部列刻意**不进入**列清单，因此既不进 SELECT / RETURNING，也不进领域对象；
 * 6. **高敏内容只走内部存储契约，绝不进日志与错误消息**：`actor_user_id` / `ip_hash` / `summary`
 *    在本文件里都是合法存储内容，但**绝不**写进错误消息与日志；错误消息只带字段路径与违规类型，
 *    避免把归属标识、摘要原文、注入载荷或连接信息写进日志与错误响应。
 *
 * ## 已落地 / 仍未解决（因此 productionReady 恒为 false）
 * 已落地（都有可机器核对的证据）：
 * - 官方 `pg` 驱动经评估引入，且只出现在 `db/postgres/` 驱动层（本文件仍只依赖 `SqlExecutor`）；
 * - `audit_logs` 由迁移 `0009_audit_logs.sql` 建立，列清单与本文件 `POSTGRES_AUDIT_COLUMNS` 一一对应，
 *   并由**触发器**在存储层拒绝业务侧改写 / 删除（仅追加不再只依赖 adapter 缺方法）；
 * - 真实 PostgreSQL 集成验证：`db/postgres/__tests__/audit-integration.spec.ts`（建表、追加、
 *   按归属取数与排序、主键冲突、归属 / 可见性隔离、存储层拒绝改写与删除、模块换绑工厂）；
 * - 端口已迁移为异步契约（内存基线与本 adapter 同步改）。
 *
 * 仍未解决（因此 `productionReady` 必须保持 false）：
 * - 本实现尚未在依赖就绪登记表里登记**封存声明与验证证据**（`persistence/dependency-readiness.ts`），
 *   数据库已配置 / 生产环境下启动会被门禁拒绝（这正是要求的 fail-closed 行为）；
 * - 会话主体 `u-student-1` 形仍不在存储 ID 域内：绑定数据库实现时，非 UUID 主体会被
 *   `assertPostgresAuditSubject` 在进入 SQL 之前 fail-closed 拒绝；
 * - 列名（尤其是字典里的 `action`）与字段字典的关系、公开视图裁剪对真实查询的复核仍需随
 *   会话主体收敛一起完成。
 * 这些都已登记在 `POSTGRES_AUDIT_REPOSITORY_VERIFICATION_STEPS` 里，不能只写声明。
 */

/** 表名：与 docs/P2-架构与数据设计.md §2 的 `audit_logs`（不可变业务审计记录）一致 */
export const POSTGRES_AUDIT_TABLE = 'audit_logs';

/**
 * 列清单：同时定义 `SELECT` 输出列、`INSERT` 列顺序与 `RETURNING` 输出列。
 *
 * 刻意不写 `SELECT *`：存储层新增列（请求头、user-agent、明文 IP / 对端地址、路径、URL、方法、
 * 内部 payload、改前/改后快照、理由、完整性哈希、序列号、软删除时间、幂等键）不会因为本文件
 * 没更新就自动流进领域对象；配合行契约的 `.strict()`，未登记列会被显式拒绝而不是被静默带出。
 *
 * 列名以 docs/P1-字段级数据字典.md §4 为准：字典把「受控操作字典」一列命名为 **`action`**，
 * 而端口把同一概念命名为 `type`（`AuditEventType`）。因此本 adapter 有且只有一处**非同名映射**
 * `action → type`（见 `POSTGRES_AUDIT_COLUMN_FIELDS`），这正是「显式字段映射」要解决的错位，
 * 而不是靠字符串截断猜测。
 */
export const POSTGRES_AUDIT_COLUMNS = [
  'id',
  'actor_user_id',
  'action',
  'result',
  'resource_type',
  'resource_id',
  'summary',
  'self_visible',
  'request_id',
  'ip_hash',
  'occurred_at',
] as const;

/** 列 → 领域字段的唯一事实来源（编译期强制覆盖 `AuditEvent` 的全部字段） */
export const POSTGRES_AUDIT_COLUMN_FIELDS = Object.freeze({
  id: 'id',
  actor_user_id: 'actorUserId',
  action: 'type',
  result: 'result',
  resource_type: 'resourceType',
  resource_id: 'resourceId',
  summary: 'summary',
  self_visible: 'selfVisible',
  request_id: 'requestId',
  ip_hash: 'ipHash',
  occurred_at: 'occurredAt',
} as const satisfies Record<(typeof POSTGRES_AUDIT_COLUMNS)[number], keyof AuditEvent>);

/**
 * 领域字段 → 列的**反向**映射：与 `POSTGRES_AUDIT_COLUMN_FIELDS` 构成双射。
 *
 * 为什么两份都要：`satisfies Record<column, keyof AuditEvent>` 只保证「每个列都落在领域字段上」
 * （列 → 字段方向），不能保证「每个领域字段都有列」。反向映射用
 * `satisfies Record<keyof AuditEvent, column>` 补上另一方向，于是「新增领域字段但忘记补列」
 * 与「列名拼错」都成为编译错误，而不是运行期静默丢字段。它同时是本文件判定
 * 「写入记录出现未登记字段」的字段名集合来源。
 */
export const POSTGRES_AUDIT_FIELD_COLUMNS = Object.freeze({
  id: 'id',
  actorUserId: 'actor_user_id',
  type: 'action',
  result: 'result',
  resourceType: 'resource_type',
  resourceId: 'resource_id',
  summary: 'summary',
  selfVisible: 'self_visible',
  requestId: 'request_id',
  ipHash: 'ip_hash',
  occurredAt: 'occurred_at',
} as const satisfies Record<keyof AuditEvent, (typeof POSTGRES_AUDIT_COLUMNS)[number]>);

/**
 * 归属列：只在服务端内部流转，同时也是 SQL 归属谓词（`WHERE actor_user_id = $1`）唯一使用的列。
 * 它**不进入**公开视图，也绝不进入错误消息与日志（他人归属不得回流、也不得外泄）。
 */
export const POSTGRES_AUDIT_OWNER_COLUMNS: readonly (typeof POSTGRES_AUDIT_COLUMNS)[number][] =
  Object.freeze(['actor_user_id']);

/**
 * **存储侧内部列**（本 adapter 的列清单里刻意**没有**它们）。
 *
 * 三组，全部来自 docs/P1-字段级数据字典.md §4 与「公开视图不泄露」的交付要求：
 * - **原始请求元数据**（明文 IP / 对端地址、请求头、user-agent、路径、URL、方法）：可指纹化、
 *   可关联到具体网络会话，因此既不入库到领域对象、也不外发；
 * - **高敏内容与快照**（内部 payload、改前 / 改后、理由）：字典标注「高敏感 / 敏感值掩码或加密」；
 * - **内部审计机制字段**（完整性哈希、前序哈希、序列号、软删除时间、幂等键）：属于存储实现细节，
 *   不属于对外契约。
 *
 * 它们**不进 SELECT / RETURNING / INSERT**，因此既不进领域记录、也不进公开视图；把它们显式
 * 登记出来，是为了让「不泄露请求头 / IP / 路径 / URL / payload / 内部审计字段」成为
 * **可机器校验**的边界，而不是「恰好没查」。
 */
export const POSTGRES_AUDIT_INTERNAL_COLUMNS = Object.freeze([
  'ip',
  'peer_address',
  'request_headers',
  'user_agent',
  'request_path',
  'request_url',
  'request_method',
  'payload',
  'before',
  'after',
  'reason',
  'integrity_hash',
  'prev_hash',
  'sequence',
  'deleted_at',
  'idempotency_key',
] as const);
export type PostgresAuditInternalColumn = (typeof POSTGRES_AUDIT_INTERNAL_COLUMNS)[number];

/**
 * 高敏列（字典标注「高敏感」或可指纹化）：在本 adapter 的**存储**范围内是合法内容，
 * 因此不裁剪为「不可读」；但**绝不**写进错误消息与日志。
 * 内部列里的明文 IP / 请求头 / payload / 快照等本 adapter 根本不投影（见上面的内部列清单）。
 */
export const POSTGRES_AUDIT_PII_COLUMNS: readonly string[] = Object.freeze([
  'actor_user_id',
  'ip_hash',
  'summary',
  'ip',
  'peer_address',
  'request_headers',
  'user_agent',
  'payload',
  'before',
  'after',
  'reason',
]);

/**
 * 本 adapter 侧**不进入公开输出**的列：归属 + 关联 ID + 网络归属哈希 + 可见性口径 + 资源标识
 * + 全部存储侧内部列。
 *
 * 对外裁剪由 `toAuditEventView` 负责（逐字段显式赋值、不展开），本清单用于机器校验
 * 「adapter 不把归属、网络归属、可见性口径与内部列投影出去」。注意 `action` **不在**本清单里：
 * 它映射到公开视图里的 `type`（事件类型是摘要的一部分），因此不属于「裁剪列」。
 */
export const POSTGRES_AUDIT_VIEW_EXCLUDED_COLUMNS: readonly string[] = Object.freeze([
  'actor_user_id',
  'request_id',
  'ip_hash',
  'self_visible',
  'resource_id',
  ...POSTGRES_AUDIT_INTERNAL_COLUMNS,
] as const);

/**
 * **本 adapter 与端口上都不存在的改写 / 删除入口**（审计只追加：docs/P2-架构与数据设计.md
 * 「审计日志采用追加写入，业务 API 不提供删除或更新」）。
 *
 * 该清单是「审计删除能力不存在」的可机器校验形态：spec 会逐名断言这些方法在 adapter 实例与
 * 端口类型上都不存在，因此任何「顺手加一个 save / delete / upsert」的改动都会失败。
 */
export const POSTGRES_AUDIT_FORBIDDEN_METHODS: readonly string[] = Object.freeze([
  'save',
  'update',
  'delete',
  'remove',
  'archive',
  'purge',
  'truncate',
  'upsert',
  'insertOrUpdate',
]);

/** 仓储能力：持久但**未验证**，因此生产环境仍会被持久化边界守卫拦下 */
export const POSTGRES_AUDIT_REPOSITORY_CAPABILITIES: AuditRepositoryCapabilities = Object.freeze({
  backend: AUDIT_REPOSITORY_BACKEND_POSTGRES,
  persistent: true,
  productionReady: false,
});

/**
 * 转成生产可用前必须完成的验证清单（每一项都需要证据，不能只写声明）。
 *
 * 状态标注（本切片的进展；`productionReady` 仍为 false，因为**前 5 项已落地不等于生产准入**）：
 * 1. 驱动依赖经评估后引入（`docs/P2-开源复用评估.md` 的 Prisma / TypeORM 比较结论）——**已落地**：
 *    官方 `pg` 已显式声明且只出现在 `db/postgres/` 驱动层；
 * 2. 对真实 PostgreSQL 的集成测试：建表迁移、`id` 主键冲突、按 `actor_user_id` 取数与排序、
 *    归属 / 可见性隔离、存储层拒绝改写与删除 ——**已落地**：
 *    `db/postgres/__tests__/audit-integration.spec.ts`（需 `TEST_DATABASE_URL`，未配置时明确 skip）；
 * 3. `audit_logs` 由迁移 `0009_audit_logs.sql` 建出并执行验证（列名与字段字典一次性对齐，
 *    含 `action` ↔ 端口 `type` 的对应关系）——**已落地**；
 * 4. **存储层禁止改写**：审计表用触发器拒绝业务侧的改写 / 删除 / 整表截断
 *    （`audit_logs_reject_mutation`），使「仅追加」不只是 adapter 缺方法，而是数据库也拒绝——**已落地**；
 * 5. `AuditRepository` 端口改为异步：service / controller 与其测试一起改——**已落地**；
 * 6. 会话主体 `actorUserId` 收敛为 UUID（当前基线是 `u-student-1` 这类安全 ID，不满足存储 ID 域）
 *    ——**未落地**：绑定数据库实现时非 UUID 主体被 `assertPostgresAuditSubject` fail-closed 拒绝；
 * 7. 公开视图裁剪对真实查询复核：确认没有任何内部列（请求头 / IP / 路径 / URL / payload /
 *    快照 / 理由 / 完整性字段）随 SELECT 或错误信息外发 ——**部分落地**（离线用例 + 真库列清单核对），
 *    仍随第 6 项一起做最终复核；
 * 8. 在依赖就绪登记表里登记**封存声明与验证证据**（`persistence/dependency-readiness.ts`）——**未落地**；
 * 9. 完成 6–8 后，才允许把 `productionReady` 改为 true，并同步删除能力自检
 *    （`assertPostgresAuditRepositoryCapabilities` 会拒绝「未验证就声称生产可用」）。
 */
export const POSTGRES_AUDIT_REPOSITORY_VERIFICATION_STEPS = [
  'driver-dependency-evaluated',
  'integration-tests-against-real-postgres',
  'audit-logs-schema-draft-created-and-promoted-to-migration',
  'append-only-enforced-at-storage-layer',
  'audit-repository-port-migrated-to-async',
  'session-subject-actor-ids-converged-to-uuid',
  'audit-column-names-aligned-with-field-dictionary',
  'public-view-exclusion-verified-against-real-queries',
  'production-ready-capability-flipped-with-evidence',
] as const;

export type PostgresAuditRepositoryErrorCode =
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
  | 'OWNER_VIOLATION'
  | 'VISIBILITY_VIOLATION';

/**
 * adapter 的 fail-closed 错误。
 *
 * `issues` 只承载**字段路径与违规类型**（例如 `actor_user_id`、`action(invalid_enum_value)`、
 * `occurred_at(invalid_date)`），不承载字段取值，避免把归属标识、摘要原文、网络归属哈希、
 * 内部 payload、注入载荷或连接信息写进日志与错误响应。
 */
export class PostgresAuditRepositoryError extends Error {
  readonly code: PostgresAuditRepositoryErrorCode;
  readonly issues: readonly string[];

  constructor(
    code: PostgresAuditRepositoryErrorCode,
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PostgresAuditRepositoryError';
    this.code = code;
    this.issues = [...issues];
  }
}

/**
 * 能力自检：**未验证的实现不得声称生产可用**。
 *
 * 任何环境都会执行（能力声明缺失属于代码缺陷，不能等生产才暴露）。
 * 生产可用性的提升必须与 `POSTGRES_AUDIT_REPOSITORY_VERIFICATION_STEPS` 的证据、
 * 以及本断言的同步修改一起发生。
 */
export function assertPostgresAuditRepositoryCapabilities(
  capabilities: AuditRepositoryCapabilities = POSTGRES_AUDIT_REPOSITORY_CAPABILITIES,
): void {
  const issues: string[] = [];
  if (capabilities.backend !== AUDIT_REPOSITORY_BACKEND_POSTGRES) {
    issues.push('backend');
  }
  if (capabilities.persistent !== true) {
    issues.push('persistent');
  }
  if (capabilities.productionReady !== false) {
    issues.push('productionReady');
  }
  if (issues.length > 0) {
    throw new PostgresAuditRepositoryError(
      'CAPABILITY_MISDECLARED',
      `PostgreSQL 审计仓储能力声明不符（backend 必须是 ${AUDIT_REPOSITORY_BACKEND_POSTGRES}、persistent=true、productionReady=false）：未完成驱动集成验证前不得声称生产可用`,
      issues,
    );
  }
}

/**
 * 公开视图裁剪的**泄漏检测**（纯函数，便于逐条用例固定）。
 *
 * 对每个「本 adapter 声明为不进入公开输出」的列，检查公开视图白名单里是否出现了该列名本身，
 * 或它映射到的领域字段名（例如 `actor_user_id → actorUserId`、`ip_hash → ipHash`）。返回空数组
 * 表示无泄漏。
 */
export function findAuditViewExclusionLeaks(viewFields: readonly string[]): readonly string[] {
  const declared = new Set(viewFields);
  const columnFields: Record<string, string | undefined> = POSTGRES_AUDIT_COLUMN_FIELDS;
  const leaks: string[] = [];
  for (const column of POSTGRES_AUDIT_VIEW_EXCLUDED_COLUMNS) {
    if (declared.has(column)) {
      leaks.push(column);
    }
    const field = columnFields[column];
    if (field !== undefined && declared.has(field)) {
      leaks.push(field);
    }
  }
  return [...new Set(leaks)];
}

/**
 * 模块加载期自检：**公开视图白名单不得包含归属、关联 ID、网络归属、可见性口径、资源标识或
 * 存储侧内部列**。
 *
 * 只要有一个泄漏项，本断言立即 fail-closed，避免「悄悄把归属 / 请求头 / IP / 路径 / URL /
 * payload / 内部审计字段投影出去」这类改动通过测试。
 */
export function assertAuditViewExclusion(viewFields: readonly string[]): void {
  const leaks = findAuditViewExclusionLeaks(viewFields);
  if (leaks.length > 0) {
    throw new PostgresAuditRepositoryError(
      'CAPABILITY_MISDECLARED',
      '公开视图白名单包含归属或存储侧内部列：不得把归属 / 关联 ID / 网络归属 / 可见性口径 / 资源标识 / 请求头 / IP / 路径 / URL / payload / 内部审计字段投影出去',
      leaks,
    );
  }
}

/** 模块加载即校验：视图白名单与实际裁剪清单必须一致（见 `assertAuditViewExclusion`） */
assertAuditViewExclusion(AUDIT_EVENT_VIEW_FIELDS);

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
    throw new PostgresAuditRepositoryError(
      'INVALID_CONFIGURATION',
      `SQL 标识符不合规（必须是裸小写标识符）：${label}`,
      [label],
    );
  }
  return value;
}

/** 模块加载即校验：表名与列名一旦被改成非标识符形状，直接 fail-closed（不静默拼进 SQL） */
const TABLE_IDENTIFIER = assertSqlIdentifier(POSTGRES_AUDIT_TABLE, 'table');
const COLUMN_LIST = POSTGRES_AUDIT_COLUMNS.map((column) =>
  assertSqlIdentifier(column, 'column'),
).join(', ');

/** 逐列的类型转换：只在「列 → 参数占位」这一步使用，值本身永远不进入 SQL 文本 */
const COLUMN_PARAMETER_CASTS: Partial<Record<(typeof POSTGRES_AUDIT_COLUMNS)[number], string>> = {
  id: '::uuid',
  actor_user_id: '::uuid',
  resource_id: '::uuid',
  request_id: '::uuid',
  occurred_at: '::timestamptz',
};

/** `VALUES ($1::uuid, $2::uuid, …)`：占位符与列一一对应，由列清单派生，不会出现数量漂移 */
const INSERT_VALUES = POSTGRES_AUDIT_COLUMNS.map(
  (column, index) => `$${index + 1}${COLUMN_PARAMETER_CASTS[column] ?? ''}`,
).join(', ');

/**
 * 追加语句：客户端可控值全部走 `$n`；`ON CONFLICT (id) DO NOTHING` 让**主键冲突显式暴露**
 * （与内存基线 `append` 抛「审计事件 ID 冲突」同语义：事件 ID 由服务端生成，冲突属于服务端缺陷，
 * 不得静默覆盖、也没有任何可覆盖的列）。
 * 刻意**没有**「冲突即改写」子句：本端口只提供追加，任何「写入即改写」都会绕过「审计不可变」这一底线。
 * `RETURNING` 让追加结果可被严格行契约复核（而不是「写完就当成功」）。
 */
const INSERT_SQL = `INSERT INTO ${TABLE_IDENTIFIER} (
  ${COLUMN_LIST}
) VALUES (${INSERT_VALUES})
ON CONFLICT (id) DO NOTHING
RETURNING ${COLUMN_LIST}`;

/**
 * 排序键：`occurred_at ASC, id ASC`——与内存基线的追加顺序一致（记录在 service 侧 append 时写入
 * `occurredAt = now`），并给出逐页稳定、可复现的**全序**（后续键集分页所需的稳定排序键）。
 * 本切片**不加** `LIMIT/OFFSET`：端口还没有分页窗口，adapter 自行截断会让结果与内存基线语义
 * 不一致（同名 spec 有边界断言）。
 */
const ORDER_BY = 'ORDER BY occurred_at ASC, id ASC';

/**
 * 按主体取数：主体走 `$1::uuid` 绑定，**归属与「本人可见」一起下推进 SQL**
 * （他人事件与仅管理端可见的事件既不出库也不回流）；显式列清单，不使用 `SELECT *`。
 */
const SELECT_VISIBLE_BY_ACTOR_SQL = `SELECT ${COLUMN_LIST}
  FROM ${TABLE_IDENTIFIER}
  WHERE actor_user_id = $1::uuid AND self_visible = TRUE
  ${ORDER_BY}`;

/**
 * 时间列契约：只接受驱动返回的 `Date` 或 **ISO 8601 datetime 字符串**。
 *
 * 刻意**不**用「任意字符串 + `new Date()` 归一」：那会把 `2026/01/05` 这类非法存储值静默修成
 * 合法 ISO，让「非法时间」变成「被悄悄修正」。非法形状一律 fail-closed（`INVALID_ROW`）。
 */
const postgresAuditTimestampSchema = z.union([z.date(), z.string().datetime()]);

/**
 * 数据库行契约（**严格**）。
 *
 * `.strict()` 是「字段污染」防线：数据库返回的未登记列（请求头、user-agent、明文 IP / 对端地址、
 * 路径、URL、方法、内部 payload、改前 / 改后快照、理由、完整性哈希、序列号、软删除时间、幂等键）
 * 会让解析失败，而不是被静默丢弃或带进领域对象。列缺失同样失败（PG 对 SELECT 列表中存在的列
 * 一定返回键，缺键说明驱动或 SQL 已被改动）。
 *
 * 存储标识列使用 `storageUuidSchema`（规范小写、非空）：它把「存储层不变量」写成行契约。
 * `action` 列（字典的受控操作字典）用事件类型**闭集**校验，因此未知事件类型在这里就被拦下
 * （非法 event / action 一律 fail-closed，不会当成合法值返回给上层）。
 *
 * 枚举闭集与列上的形状约束在这里先拦一道；`summary` 的**内容安全**（身份证号 / 长数字标识 /
 * 疑似密钥）由 `audit.contract.ts` 的读取契约兜底（映射后用 `parseStoredAuditEvent` 复核）。
 */
const postgresAuditRowSchema = z
  .object({
    id: storageUuidSchema,
    actor_user_id: storageUuidSchema,
    action: z.enum(AUDIT_EVENT_TYPE_VALUES),
    result: z.enum(AUDIT_RESULT_VALUES),
    resource_type: z.enum(AUDIT_RESOURCE_TYPE_VALUES),
    resource_id: storageUuidSchema.nullable(),
    summary: z.string().min(1).max(200),
    self_visible: z.boolean(),
    request_id: storageUuidSchema,
    ip_hash: ipHashSchema,
    occurred_at: postgresAuditTimestampSchema,
  })
  .strict();

/** 写入记录允许出现的字段名集合：由「领域字段 → 列」双射派生（单一事实来源，不会漂移） */
const WRITABLE_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.keys(POSTGRES_AUDIT_FIELD_COLUMNS),
);

/** 只保留字段路径与违规类型，绝不含字段取值（归属、摘要原文、网络归属哈希不进错误消息） */
function describeIssues(error: z.ZodError): readonly string[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      // 只列出**字段名**（不是字段取值）：让「契约漂移 / 字段污染」可定位，同时不泄露数据
      return issue.keys.map((key) => `${key}(unexpected)`);
    }
    return [`${issue.path.join('.') || '(root)'}(${issue.code})`];
  });
}

function invalidRow(error: z.ZodError, label = 'row'): PostgresAuditRepositoryError {
  return new PostgresAuditRepositoryError(
    'INVALID_ROW',
    `数据库行不符合 postgres 行契约（${label}）`,
    describeIssues(error),
  );
}

/** 时间列 → ISO 字符串；坏时间戳 fail-closed（不产生 `Invalid Date` 之类的半成品） */
function toIsoTimestamp(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PostgresAuditRepositoryError('INVALID_ROW', `时间列不是合法时间戳：${label}`, [
      label,
    ]);
  }
  return date.toISOString();
}

/**
 * 行 → 领域记录：**逐字段显式映射**（不使用展开），再整体过一次读取契约。
 *
 * 顺序刻意如此：先按严格行契约解析（拒绝未登记列 / 未知枚举 / 坏 UUID / 坏时间戳 / 非 sha256
 * 哈希 / 坏形状），再显式取字段构造新对象（即使行里有额外内容也不会被带出），最后用
 * `parseStoredAuditEvent` 复核共享读取契约（枚举闭集 + ISO 时间 + 免 PII 摘要 + 字段闭集），
 * 任一环节不合规都抛错。
 */
function mapRow(row: unknown): AuditEvent {
  const parsedRow = postgresAuditRowSchema.safeParse(row);
  if (!parsedRow.success) {
    throw invalidRow(parsedRow.error);
  }
  const dbRow = parsedRow.data;

  const record = {
    id: dbRow.id,
    // 归属：adapter 只承载，不生成、不覆盖；对外由 toAuditEventView 裁剪
    actorUserId: dbRow.actor_user_id,
    // 唯一一处非同名映射：字典的 `action` 列 ↔ 端口的 `type` 字段（受控操作字典）
    type: dbRow.action,
    result: dbRow.result,
    resourceType: dbRow.resource_type,
    ...(dbRow.resource_id === null ? {} : { resourceId: dbRow.resource_id }),
    summary: dbRow.summary,
    selfVisible: dbRow.self_visible,
    requestId: dbRow.request_id,
    ipHash: dbRow.ip_hash,
    occurredAt: toIsoTimestamp(dbRow.occurred_at, 'occurred_at'),
  };

  const parsedRecord = parseStoredAuditEvent(record);
  if (!parsedRecord.ok) {
    throw new PostgresAuditRepositoryError(
      'INVALID_ROW',
      '数据库行映射后不符合审计读取契约',
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
    throw new PostgresAuditRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      '未提供 SQL 执行器：PostgreSQL 审计仓储拒绝在半可用状态下构造或调用',
      ['executor'],
    );
  }
  const candidate = executor as { query?: unknown; capabilities?: unknown };
  if (typeof candidate.query !== 'function') {
    throw new PostgresAuditRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器缺少 query 方法：PostgreSQL 审计仓储拒绝在半可用状态下构造或调用',
      ['executor.query'],
    );
  }
  const capabilities = candidate.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new PostgresAuditRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器未声明能力（backend/persistent/productionReady）',
      ['executor.capabilities'],
    );
  }
  const { backend, persistent } = capabilities as { backend?: unknown; persistent?: unknown };
  if (typeof backend !== 'string' || backend.trim() === '') {
    throw new PostgresAuditRepositoryError(
      'EXECUTOR_UNAVAILABLE',
      'SQL 执行器的能力声明缺少 backend 标识',
      ['executor.capabilities.backend'],
    );
  }
  if (!/^postgres/iu.test(backend.trim())) {
    throw new PostgresAuditRepositoryError(
      'EXECUTOR_NOT_POSTGRES',
      'SQL 执行器声明的后端不是 PostgreSQL：拒绝把本 adapter 挂到其他存储上',
      ['executor.capabilities.backend'],
    );
  }
  if (persistent !== true) {
    throw new PostgresAuditRepositoryError(
      'EXECUTOR_NOT_PERSISTENT',
      'SQL 执行器声明为非持久后端（内存替身）：PostgreSQL 审计仓储拒绝在其上运行',
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
  code: PostgresAuditRepositoryErrorCode,
  message: string,
  label: string,
): string {
  if (!isStorageUuid(value)) {
    throw new PostgresAuditRepositoryError(code, message, [label]);
  }
  return value;
}

/** 服务端主体：会话解析值，非法即服务端缺陷（不得静默按「查不到」处理） */
function requireSubject(actorUserId: unknown): string {
  return requireStorageUuid(
    actorUserId,
    'INVALID_SUBJECT',
    '取数主体必须落在存储 ID 域内（合法且非空的规范小写 UUID）：非 UUID 的 actorUserId 属于服务端缺陷，不得进入 SQL',
    'actorUserId',
  );
}

/**
 * 写入记录校验：字段名闭集（未登记字段 → `(unexpected)`）+ 读取契约（含事件类型 / 结果 /
 * 资源类型三个枚举闭集、ISO 时间、`ipHash` 形态与免 PII 摘要）+ 存储 ID 域。
 *
 * 这里刻意**不**用 `storedAuditEventSchema.strict()`：该契约确实带 `strict()`，但本函数先把
 * 字段名闭集比对做在前面（拒绝而不是剥离，且能给出与读取契约可区分的错误码 `INVALID_RECORD`），
 * 再用契约复核形状与不变式。
 */
function assertWritableRecord(record: unknown): AuditEvent {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new PostgresAuditRepositoryError(
      'INVALID_RECORD',
      '待写入的审计事件不是对象：拒绝把非记录值交给写入路径',
      ['(root)'],
    );
  }
  const unexpected = Object.keys(record).filter((key) => !WRITABLE_FIELD_NAMES.has(key));
  if (unexpected.length > 0) {
    // 只列字段名，不回显取值；拒绝而不是静默剥离
    throw new PostgresAuditRepositoryError(
      'INVALID_RECORD',
      '待写入的审计事件含未登记字段（字段污染）：拒绝写入',
      unexpected.map((key) => `${key}(unexpected)`),
    );
  }

  const parsed = storedAuditEventSchema.safeParse(record);
  if (!parsed.success) {
    throw new PostgresAuditRepositoryError(
      'INVALID_RECORD',
      '待写入的审计事件不符合读取契约（含非法枚举取值、非法时间、非法形态或摘要含高敏内容）',
      describeIssues(parsed.error),
    );
  }
  const writable = parsed.data;
  const identifierColumns: readonly (readonly [string, string])[] = [
    ['id', writable.id],
    ['actor_user_id', writable.actorUserId],
    ['request_id', writable.requestId],
    ...(writable.resourceId === undefined ? [] : [['resource_id', writable.resourceId] as const]),
  ];
  for (const [label, value] of identifierColumns) {
    requireStorageUuid(
      value,
      'INVALID_RECORD',
      '待写入的审计事件含不在存储 ID 域内的标识（必须是合法且非空的规范小写 UUID）',
      label,
    );
  }
  return writable;
}

/**
 * 结果集形状 fail-closed：执行器必须返回对象且带 `rows` 数组。
 * 「少字段 / 类型不对」属于驱动或替身实现缺陷，不得被当成「空结果」静默放过
 * （否则会把基础设施故障伪装成「该主体尚无审计事件」）。
 */
function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new PostgresAuditRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果不是对象（驱动 / 替身实现缺陷）',
      ['result'],
    );
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new PostgresAuditRepositoryError(
      'INVALID_ROW',
      'SQL 执行结果缺少 rows 数组（驱动 / 替身实现缺陷）',
      ['rows'],
    );
  }
  return rows;
}

/**
 * 写入参数：**由列清单派生**（列 → 字段 → 值），因此参数顺序永远与 SQL 占位符一致；
 * `Record<keyof AuditEvent, unknown>` 让「新增领域字段但忘记补参数」成为编译错误。
 * 缺失的可选字段（`resourceId`）写 `NULL`（而不是 `undefined` 或省略列）。
 */
function writeParameters(record: AuditEvent): readonly unknown[] {
  const values: Record<keyof AuditEvent, unknown> = {
    id: record.id,
    actorUserId: record.actorUserId,
    type: record.type,
    result: record.result,
    resourceType: record.resourceType,
    resourceId: record.resourceId ?? null,
    summary: record.summary,
    selfVisible: record.selfVisible,
    requestId: record.requestId,
    ipHash: record.ipHash,
    occurredAt: record.occurredAt,
  };
  return POSTGRES_AUDIT_COLUMNS.map((column) => values[POSTGRES_AUDIT_COLUMN_FIELDS[column]]);
}

/**
 * 追加后的**逐列复核**（追加语句只插入新行，因此返回行必须与新记录逐字段一致）。
 *
 * 复核是为了拦住「存储层触发器 / SQL 被改写 / 驱动串行错位」这类纵深风险，并让「改写归属」
 * 有专属错误码：`id` → `IDENTITY_MISMATCH`、`actor_user_id` → `OWNER_VIOLATION`，
 * 其余列 → `IDENTITY_MISMATCH`。列清单与实现的对应关系由同名 spec 的**逐列行为断言**钉住
 * （翻转任一列都会失败）。
 */
function assertAppendRoundTrip(requested: AuditEvent, stored: AuditEvent): void {
  if (stored.id !== requested.id) {
    throw new PostgresAuditRepositoryError(
      'IDENTITY_MISMATCH',
      '返回记录的主键与请求写入的主键不一致（他人记录不得作为写入结果回流）',
      ['id'],
    );
  }
  if (stored.actorUserId !== requested.actorUserId) {
    throw new PostgresAuditRepositoryError(
      'OWNER_VIOLATION',
      '返回记录的归属与请求写入的归属不一致（他人归属不得回流）',
      ['actor_user_id'],
    );
  }
  for (const [column, requestedValue, storedValue] of [
    ['action', requested.type, stored.type],
    ['result', requested.result, stored.result],
    ['resource_type', requested.resourceType, stored.resourceType],
    ['resource_id', requested.resourceId, stored.resourceId],
    ['summary', requested.summary, stored.summary],
    ['self_visible', requested.selfVisible, stored.selfVisible],
    ['request_id', requested.requestId, stored.requestId],
    ['ip_hash', requested.ipHash, stored.ipHash],
    ['occurred_at', requested.occurredAt, stored.occurredAt],
  ] as const) {
    if (storedValue !== requestedValue) {
      throw new PostgresAuditRepositoryError(
        'IDENTITY_MISMATCH',
        `返回记录的 ${column} 与请求写入的值不一致（追加结果不得被改写）`,
        [column],
      );
    }
  }
}

/**
 * 基于 `SqlExecutor` 的 PostgreSQL 审计仓储（**仅追加**）。
 *
 * 构造与每次调用都会重新校验执行器（`assertUsableExecutor`）与自身能力声明，因此「执行器被换掉 /
 * 被降级」或「能力声明被改写」都会 fail-closed，而不是静默继续。
 * 本类**不是** Nest provider（不带任何 Nest 装饰器）：它只由 `AuditModule` 的工厂显式构造
 * （`createAuditRepository` → `createLazyPostgresAuditRepository`）。
 */
export class PostgresAuditRepository implements AsyncAuditRepository {
  readonly capabilities: AuditRepositoryCapabilities = POSTGRES_AUDIT_REPOSITORY_CAPABILITIES;

  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    assertPostgresAuditRepositoryCapabilities(this.capabilities);
    this.executor = assertUsableExecutor(executor);
  }

  /** 每次调用前的自检：能力声明与执行器都必须仍然可用 */
  private usableExecutor(): SqlExecutor {
    assertPostgresAuditRepositoryCapabilities(this.capabilities);
    return assertUsableExecutor(this.executor);
  }

  /**
   * 取数结果的行映射 + 归属与可见性复核（列表路径共用，避免语义漂移）。
   *
   * 三层 fail-closed：
   * - 每条行都必须通过严格行契约与读取契约（`mapRow`）；
   * - 同一记录不得在结果集里出现两次（`RESULT_SET_VIOLATION`，主键唯一性被破坏）；
   * - 归属必须等于请求主体（`OWNER_VIOLATION`）且必须标记本人可见（`VISIBILITY_VIOLATION`）：
   *   仓储的过滤行为**不作为安全边界**，返回了不该返回的记录即判服务端缺陷，整批 fail-closed，
   *   既不静默过滤也不外发。
   */
  private mapScopedRows(rows: readonly unknown[], ownerId: string): readonly AuditEvent[] {
    const records = rows.map((row) => mapRow(row));

    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id)) {
        throw new PostgresAuditRepositoryError(
          'RESULT_SET_VIOLATION',
          '返回结果包含重复的审计事件 ID：结果集违反取数契约',
          ['id'],
        );
      }
      seen.add(record.id);
      if (record.actorUserId !== ownerId) {
        throw new PostgresAuditRepositoryError(
          'OWNER_VIOLATION',
          '返回了请求主体之外的审计事件（他人记录不得回流）',
          ['actor_user_id'],
        );
      }
      if (record.selfVisible !== true) {
        throw new PostgresAuditRepositoryError(
          'VISIBILITY_VIOLATION',
          '返回了未标记为本人可见的审计事件（仅管理端可见的记录不得进入本人摘要）',
          ['self_visible'],
        );
      }
    }
    return records;
  }

  /**
   * 追加一条已由调用方校验并补齐主体 / 结果 / 时间戳的记录。
   *
   * - `actorUserId` 必须是服务端会话主体（非法 UUID / 空 UUID / 非规范小写 / 未登记字段一律拒绝）；
   * - 主键冲突（`ON CONFLICT DO NOTHING` 无返回行）显式抛 `CONFLICT`，与内存基线同语义，
   *   不静默覆盖；
   * - 返回行必须能通过严格行契约与读取契约，且**主键、归属与其余列**都必须等于请求写入的记录
   *   （数据库回流出「他人记录」或字段被改写时判服务端缺陷）；
   * - 本方法**只追加**：没有「冲突即改写」子句、没有第二次写语句，执行器收到的 SQL 只有一条 `INSERT`。
   */
  async append(event: AuditEvent): Promise<AuditEvent> {
    const executor = this.usableExecutor();
    const writable = assertWritableRecord(event);

    const result = await executor.query(INSERT_SQL, writeParameters(writable));

    const rows = rowsOf(result);
    if (rows.length === 0) {
      // 主键冲突（ON CONFLICT DO NOTHING）属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new PostgresAuditRepositoryError(
        'CONFLICT',
        '审计事件 ID 冲突：追加未返回任何行（主键已存在）',
        ['id'],
      );
    }
    if (rows.length > 1) {
      throw new PostgresAuditRepositoryError(
        'RESULT_SET_VIOLATION',
        '追加语句返回了多行：主键唯一性被破坏',
        ['id'],
      );
    }

    const appended = mapRow(rows[0]);
    assertAppendRoundTrip(writable, appended);
    return appended;
  }

  /**
   * 按服务端主体取数（本人审计摘要）。
   *
   * - 主体必须落在存储 ID 域内，否则 `INVALID_SUBJECT`，且不访问数据库；
   * - 归属与「本人可见」一起下推进 SQL（`WHERE actor_user_id = $1 AND self_visible = TRUE`），
   *   他人事件与仅管理端可见的事件不会出库；每条返回记录都会**逐条复核**归属与可见标记：
   *   返回了不该返回的记录即判服务端缺陷并 fail-closed（`OWNER_VIOLATION` /
   *   `VISIBILITY_VIOLATION`）；
   * - 重复主键同样判结果集违约（避免同一记录在列表里出现两次而放大影响）；
   * - 无记录返回空数组（`[]`），不是 `undefined`，且不抛错；
   * - 不做任何本地截断：结果集大小由 SQL 决定（本切片端口没有分页窗口，`ORDER_BY` 只固定全序）。
   */
  async listVisibleByActor(actorUserId: string): Promise<readonly AuditEvent[]> {
    const executor = this.usableExecutor();
    const ownerId = requireSubject(actorUserId);

    const result = await executor.query(SELECT_VISIBLE_BY_ACTOR_SQL, [ownerId]);
    return this.mapScopedRows(rowsOf(result), ownerId);
  }
}

/** DI 工厂：把驱动无关的 `SqlExecutor` 装成审计仓储端口实现（本切片的换绑点之一） */
export function createPostgresAuditRepository(executor: SqlExecutor): AuditRepository {
  return new PostgresAuditRepository(executor);
}

/**
 * 把「主体必须落在存储 ID 域内」变成可**先于建连**执行的断言（供分流点、service 与测试复用）。
 *
 * 为什么单独导出：延迟建连的实现必须在解析执行器**之前**判定主体，否则一个非 UUID 的会话主体
 * （例如会话基线的 `u-student-1`）会先触发一次数据库连接、再在 adapter 里被拒绝 ——
 * 那既浪费连接，也让「主体域判定发生在任何连接之前」这条性质无法被测试固定。
 * 错误信息不带主体取值（见 `requireStorageUuid`）。
 */
export function assertPostgresAuditSubject(actorUserId: unknown): string {
  return requireSubject(actorUserId);
}

/**
 * 延迟建连的审计仓储：**模块装配阶段不碰数据库**。
 *
 * 为什么必须延迟：`SQL_CONNECTION_FACTORY.connect()` 在数据库已配置但执行器未通过 attest 契约时
 * 会抛错。如果在这里急切建连，启动失败会表现为「模块工厂抛了数据库错」，而不是启动期持久化边界
 * 给出的**结构化违规**（`SQL_EXECUTOR_VERIFICATION_REQUIRED` / `DECLARATION_NOT_SEALED` 等）；
 * 依赖就绪门禁也必须能在**任何连接之前**给出 `AUDIT_REPOSITORY[DEPENDENCY_NOT_VERIFIED]`。
 * 延迟后，判定顺序保持为「配置 → 持久化边界 / 依赖就绪 → 首次真正读库」。
 *
 * 连接只在首次读写时建立并被复用；建立失败不缓存失败结果（下一次调用会重试）。
 * 主体域先判、再建连：非存储 ID 域（非 UUID）的主体不会触发任何数据库连接。
 */
export function createLazyPostgresAuditRepository(
  resolveExecutor: () => Promise<SqlExecutor>,
  capabilities: AuditRepositoryCapabilities = POSTGRES_AUDIT_REPOSITORY_CAPABILITIES,
): AuditRepository {
  assertPostgresAuditRepositoryCapabilities(capabilities);

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
    async append(event: AuditEvent): Promise<AuditEvent> {
      // 主体域先判、再建连：非存储 ID 域的写记录不应该触发任何数据库连接
      assertPostgresAuditSubject(event.actorUserId);
      const resolved = await executor();
      return new PostgresAuditRepository(resolved).append(event);
    },
    async listVisibleByActor(actorUserId: string): Promise<readonly AuditEvent[]> {
      const ownerId = assertPostgresAuditSubject(actorUserId);
      const resolved = await executor();
      return new PostgresAuditRepository(resolved).listVisibleByActor(ownerId);
    },
  };
}
