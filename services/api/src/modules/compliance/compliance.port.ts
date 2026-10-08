/**
 * 合规切片（compliance）的**显式端口**与存储侧词汇表
 * （docs/P2-架构与数据设计.md §2「compliance | 同意、留存、更正、删除与归档流程」）。
 *
 * 本切片只承载**本人合规状态的最小读侧垂直切片**：
 * `GET /me/compliance-status` 返回服务端会话主体本人的三个**状态枚举**
 * （隐私同意 / 数据保留 / 导出可用性），不返回任何原文、联系方式或内部审核与证据字段。
 *
 * 为什么必须是一个显式端口（而不是把「进程内 Map」当成生产存储）：
 * - `ComplianceRepository` —— 合规状态事实的持久化端口（对应后续 `user_compliance` 表或
 *   由画像/同意记录派生的读模型）。默认绑定内存基线 `InMemoryComplianceRepository`，
 *   它如实声明 `persistent = false`、`productionReady = false`，并在 `NODE_ENV=production`
 *   下**拒绝构造**，因此不存在「用进程内 Map 冒充生产合规存储」的可用路径。
 *
 * 边界事实（可机器判定，见 `compliance.controller.spec.ts`）：
 * - 端口**不做授权判定**：资源级判定属于 `AuthorizationGuard`，调用方必须先授权；
 * - 端口**没有写入口**（既没有 `create/save/upsert`，也没有 `delete/archive`）：
 *   「记录同意」「执行删除」属后续切片，本切片在类型层面就无法借读取路径改写合规事实；
 * - 端口**只按服务端主体取数**（`findByUserId`）：没有「按客户端提交的 owner 取数」这类方法，
 *   因此「拿他人的合规状态」在端口层面就没有可用的查询入口；
 * - 端口实体里**只有枚举与归属**：没有同意原文、政策正文、手机号、内部审核意见、
 *   证据文件指针的字段，因此这些内容在本切片的响应结构里没有可外发的来源。
 */

/** 隐私同意状态**闭集**：只表达「服务端是否记录了有效同意」，不携带任何原文或时间 */
export const PrivacyConsentStatus = {
  /** 已记录有效同意（服务端有该主体针对当前政策版本的同意记录） */
  Granted: 'granted',
  /** 已撤回同意（记录存在但状态为撤回） */
  Withdrawn: 'withdrawn',
  /** 尚未记录同意（新账号尚未提交告知同意） */
  NotRecorded: 'not-recorded',
} as const;
export type PrivacyConsentStatus = (typeof PrivacyConsentStatus)[keyof typeof PrivacyConsentStatus];
export const PRIVACY_CONSENT_STATUS_VALUES = [
  PrivacyConsentStatus.Granted,
  PrivacyConsentStatus.Withdrawn,
  PrivacyConsentStatus.NotRecorded,
] as const;

export function isPrivacyConsentStatus(value: unknown): value is PrivacyConsentStatus {
  return (
    typeof value === 'string' &&
    (PRIVACY_CONSENT_STATUS_VALUES as readonly string[]).includes(value)
  );
}

/**
 * 数据保留状态**闭集**（口径见 docs/P2-隐私留存矩阵.md：期限须由责任人批准后配置）。
 * 本切片只回答「是否仍在批准期限内」，**不**回答具体期限、到期时间或清理结论。
 */
export const DataRetentionStatus = {
  /** 仍在批准的保留期限内 */
  WithinRetention: 'within-retention',
  /** 已超出保留期限（应进入归档/清理流程） */
  Expired: 'expired',
} as const;
export type DataRetentionStatus = (typeof DataRetentionStatus)[keyof typeof DataRetentionStatus];
export const DATA_RETENTION_STATUS_VALUES = [
  DataRetentionStatus.WithinRetention,
  DataRetentionStatus.Expired,
] as const;

export function isDataRetentionStatus(value: unknown): value is DataRetentionStatus {
  return (
    typeof value === 'string' && (DATA_RETENTION_STATUS_VALUES as readonly string[]).includes(value)
  );
}

/**
 * 导出可用性**闭集**：本人导出通道当前是否对该主体开放。
 * `available` 是**需要举证**的强断言（服务端已核实同意与保留期都成立），
 * 因此存储层必须自洽：同意未生效或保留期已过时不得声明可用（见 `compliance.contract.ts`）。
 */
export const ExportAvailabilityStatus = {
  Available: 'available',
  Unavailable: 'unavailable',
} as const;
export type ExportAvailabilityStatus =
  (typeof ExportAvailabilityStatus)[keyof typeof ExportAvailabilityStatus];
export const EXPORT_AVAILABILITY_STATUS_VALUES = [
  ExportAvailabilityStatus.Available,
  ExportAvailabilityStatus.Unavailable,
] as const;

export function isExportAvailabilityStatus(value: unknown): value is ExportAvailabilityStatus {
  return (
    typeof value === 'string' &&
    (EXPORT_AVAILABILITY_STATUS_VALUES as readonly string[]).includes(value)
  );
}

/**
 * 存储层的一条本人合规状态（后续对应 `user_compliance` 表 / 由同意与留存记录派生的读模型）。
 *
 * **每一个字段都是服务端事实、都是闭集枚举**：
 * - `ownerUserId`：归属主体（服务端会话解析值），非客户端输入；
 * - `privacyConsent` / `dataRetention` / `exportAvailability`：三个状态闭集。
 *
 * 记录里**没有**：同意原文与政策正文、手机号/学号/姓名、内部审核意见与审核人、
 * 证据文件标识、到期时间与清理结论。因此「输出泄露隐私同意原文或内部证据字段」
 * 在数据结构层面就没有可泄露的字段来源；存储若被塞入这些字段，读取契约会将其判为非法（500）。
 */
export interface ComplianceRecord {
  /** 归属主体：服务端会话解析值，非客户端输入 */
  readonly ownerUserId: string;
  /** 隐私同意状态：必须在 `PRIVACY_CONSENT_STATUS_VALUES` 闭集内 */
  readonly privacyConsent: PrivacyConsentStatus;
  /** 数据保留状态：必须在 `DATA_RETENTION_STATUS_VALUES` 闭集内 */
  readonly dataRetention: DataRetentionStatus;
  /** 导出可用性：必须在 `EXPORT_AVAILABILITY_STATUS_VALUES` 闭集内，且与同意/留存自洽 */
  readonly exportAvailability: ExportAvailabilityStatus;
}

/** 存储后端能力声明：让上层与运维能机器判定当前后端是否可持久化 */
export interface ComplianceRepositoryCapabilities {
  /** 后端标识，例如 `in-memory-baseline` */
  readonly backend: string;
  /** 是否跨进程/重启保留（内存基线必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

/**
 * 合规状态仓储端口（**只读**）。
 *
 * - `findByUserId`：只返回该服务端主体名下的记录，没有则返回 `undefined`
 *   （由 service 按 fail-closed 处理：拿不到服务端事实时不得给出「看起来正常」的状态）；
 * - service 仍会逐条复核归属与读取契约（纵深防御：仓储的过滤行为不作为安全边界）；
 * - 端口**没有**写方法：本切片不提供「记录同意」「撤回同意」「执行删除」的能力。
 */
export interface ComplianceRepository {
  readonly capabilities: ComplianceRepositoryCapabilities;
  findByUserId(ownerUserId: string): ComplianceRecord | undefined;
}

/**
 * PostgreSQL 后端标识（能力声明 `backend` 的规范取值）。
 *
 * 数据库 adapter、持久化边界守卫与运维摘要共用同一字面量，避免同一后端出现
 * `postgres` / `postgres-draft` / `postgresql` 多个拼写而无法机器比对。
 */
export const COMPLIANCE_REPOSITORY_BACKEND_POSTGRES = 'postgres';

/**
 * **存储 ID 域约束**：`user_compliance.user_id` 在存储侧是 `uuid`
 * （docs/P2-架构与数据模型 §4「主键 UUID」：业务表主键与归属统一 UUID；docs/P1-字段级数据字典.md §4
 * 把 `privacy_consents.user_id` 标注为 uuid）。
 *
 * 读取契约把 `ownerUserId` 写成 `complianceSubjectIdSchema`（非空、无空白与控制字符、长度 1–64），
 * 会话基线的主体形如 `u-student-1` 也落在该形态内；而存储域**更严**：必须是
 * 「合法、非空、规范小写形」的 UUID。两者不矛盾（UUID 形必然落在 1–64 长度内），
 * 但把 `COMPLIANCE_REPOSITORY` 换绑到数据库实现的那一片切片必须把会话主体收敛为 UUID，
 * 否则 adapter 按本约束 **fail-closed 拒绝**，而不是退化成「放弃类型约束的字符串比较」。
 */
export const COMPLIANCE_REPOSITORY_STORAGE_ID_DOMAIN = 'uuid';

/**
 * **异步仓储契约**（数据库形状的合规状态仓储端口，与 `ComplianceRepository` 同语义）。
 *
 * 为什么与同步端口并存、而不是把它直接改成异步：同步端口是当前运行时绑定（内存基线，同步返回）。
 * 把它改成 Promise 是**跨模块契约变更**（service / controller 与既有 spec 必须一起改），
 * 只能与「引入经评估的驱动 + 对真实 PostgreSQL 的集成验证」在同一片切片完成。在那之前，
 * 数据库 adapter 按本契约实现并单独验证，运行时绑定一动不动，因此「切换到数据库」与
 * 「回退到内存基线」都仍是可整步执行 / 整步回退的操作。
 *
 * 方法集与同步端口**逐字对应**，且**只有一个方法**：`findByUserId`。这里刻意没有
 * `findById` / `listByOwnerId` 那种「单条读取」与「列表读取」入口——本切片只交付「本人一条状态」，
 * 入口越少，越不存在「按客户端提交的主体取数」或「未过滤的批量导出」这类越权面。
 *
 * 实现者（当前只有 `compliance.postgres-repository.ts`）必须满足与内存基线**完全相同**的语义
 * （按主体取数、无记录返回 `undefined`、返回副本而不是内部可变引用），并额外守住六条边界：
 * 1. **只读**：端口没有写入口，实现同样不得新增 `create` / `save` / `insert` / `update` /
 *    `delete` / `archive` / `purge` / `truncate` / `upsert` 任何一个方法；
 * 2. **归属只来自服务端**：`ownerUserId` 由 service 从服务端会话主体传入，adapter 不生成、
 *    不覆盖归属，并复核「返回记录归属 === 请求主体」，不一致即判服务端缺陷；
 * 3. **存储 ID 域**：主体与存储行归属必须落在 `COMPLIANCE_REPOSITORY_STORAGE_ID_DOMAIN`
 *    （规范小写形 UUID）内，否则 fail-closed；
 * 4. **按服务端主体隔离**：归属下推进 SQL（`WHERE user_id = $1`），让「他人合规状态」根本不出库，
 *    并在返回行上复核归属（纵深防御：仓储的过滤行为不作为安全边界）；
 * 5. **每条返回记录都必须能被读取契约校验**：未知列、未知状态枚举、非法归属形态、状态不自洽
 *    （未生效的同意 / 已过的保留期却声明导出可用）一律按服务端缺陷抛错；结果集出现多行同样
 *    fail-closed（本读模型按主体唯一）；
 * 6. **归属、内部时间戳、同意原文、联系方式、审核与证据字段、路径 / URL / 存储 key 与 PII 绝不
 *    进入错误消息、日志与公开视图**：公开视图由 `compliance.contract.ts` 的
 *    `toComplianceStatusView` 逐字段裁剪（恰好 `COMPLIANCE_STATUS_VIEW_FIELDS` 三个状态枚举）。
 */
export interface AsyncComplianceRepository {
  readonly capabilities: ComplianceRepositoryCapabilities;
  /**
   * 只返回该服务端主体名下的合规状态记录，没有则 `undefined`（由 service 按 fail-closed 处理）。
   * 调用方必须是已授权访问该主体资源的服务端代码；归属必须下推进 SQL（他人记录不出库）。
   */
  findByUserId(ownerUserId: string): Promise<ComplianceRecord | undefined>;
}

/**
 * DI 令牌：合规状态仓储（真实实现委托 `user_compliance` 表 / 派生读模型）。
 *
 * 命名边界（当前已知偏差，登记在数据库 adapter 的验证清单里）：`db/migrations/0001_bootstrap.sql`
 * 的业务表占位清单里是**原始同意表** `privacy_consents`（另见 docs/P2-ER图.md
 * `privacy_consents(user_id, policy_id, consented_at, withdrawn_at)`），而本端口承载的是
 * 「同意 + 留存 + 导出可用性」聚合出的**读模型**，端口注释把它命名为 `user_compliance`。
 * 启用数据库前必须二选一并对齐：把 `user_compliance` 补入占位清单与字段字典并落 schema 草案，
 * 或把 adapter 改为从同意 / 留存 / 配置派生的查询——不得让同一概念在存储侧出现两份真相。
 */
export const COMPLIANCE_REPOSITORY = Symbol('COMPLIANCE_REPOSITORY');
