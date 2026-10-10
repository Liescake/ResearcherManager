/**
 * 导出切片（exports）的**显式端口**与存储侧词汇表
 * （docs/P2-架构与数据设计.md §2「exports | 异步导出、脱敏、有效期、下载审计」）。
 *
 * 本切片只承载**本人导出请求的最小垂直切片**：
 * - `POST /me/exports` 创建本人的导出请求（服务端白名单资源 + 字段）；
 * - `GET  /me/exports` 本人导出请求列表与状态。
 *
 * 真实文件下载、有效期与清理、脱敏规则明细、下载审计、管理端 `POST /admin/exports`
 * （`export:{resource}:create`，见 docs/P2-API契约基线.md §「统计、导出、配置」）属于后续切片。
 *
 * 为什么必须有两个显式端口（而不是把「进程内 Map」当成生产存储）：
 * 1. `ExportRepository` —— 导出请求事实的持久化端口。**按是否解析出 `DATABASE_URL` 分流**：
 *    未配置数据库时绑定内存基线 `InMemoryExportRepository`（如实声明 `persistent = false`、
 *    `productionReady = false`，并在 `NODE_ENV=production` 下**拒绝构造**）；已配置数据库且
 *    拿到 `SQL_CONNECTION_FACTORY` 时换绑 PostgreSQL adapter（延迟建连，表 `export_jobs`
 *    由迁移 `0013` 建立）；已配置数据库却拿不到执行器工厂时**抛错**（fail-closed，
 *    绝不悄悄退回内存）。分流口径与 auth / compliance / notifications 等切片完全一致；
 * 2. `ExportArtifactStore` —— **导出产物**的服务端存储端口（脱敏文件的生成本身属后续切片）。
 *    它是「导出有没有做出来」这一事实的唯一来源，因此它的失败必须能与「任务落库失败」区分：
 *    产物生成/写入失败 ⇒ 任务收敛为 `failed` 终态；请求事实无法落库 ⇒ 500 fail-closed。
 *
 * 边界事实（可机器判定，见 `exports.controller.spec.ts`）：
 * - 两个端口都**不做授权判定**：资源级判定属于 `AuthorizationGuard`，调用方必须先授权；
 * - 两个端口都**不生成归属与状态**：`ownerUserId` 只由 service 从服务端会话主体写入，
 *   `status` 只由 service 的状态机写入，`createdAt` / `updatedAt` 取服务端时钟；
 * - 仓储**只按服务端主体取数**（`listByOwnerId`）：没有「按客户端提交的 owner 取数」这类方法，
 *   因此「拿他人的导出请求」在端口层面就没有可用的查询入口；
 * - 端口实体里**没有**文件名、文件路径、下载 URL、对象存储 key 这类字段：
 *   产物在存储侧的位置只存在于 `ExportArtifactStore` 内部，端口返回值只是一个不透明句柄。
 */

/** 导出资源**闭集**：与 docs/P2-API契约基线.md 的 `export:{resource}:*` 资源名一一对应 */
export const ExportResource = {
  Profile: 'profile',
  Achievement: 'achievement',
  Education: 'education',
  Statistics: 'statistics',
} as const;
export type ExportResource = (typeof ExportResource)[keyof typeof ExportResource];
export const EXPORT_RESOURCE_VALUES = [
  ExportResource.Profile,
  ExportResource.Achievement,
  ExportResource.Education,
  ExportResource.Statistics,
] as const;

export function isExportResource(value: unknown): value is ExportResource {
  return typeof value === 'string' && (EXPORT_RESOURCE_VALUES as readonly string[]).includes(value);
}

/**
 * 导出任务状态**闭集**：入口恒为 `pending`，只允许推进到一个终态
 * （`completed` = 产物已在服务端生成；`failed` = 未生成出产物）。
 * 未登记取值一律视为存储损坏（500），绝不当作合法值外发。
 */
export const ExportStatus = {
  Pending: 'pending',
  Completed: 'completed',
  Failed: 'failed',
} as const;
export type ExportStatus = (typeof ExportStatus)[keyof typeof ExportStatus];
export const EXPORT_STATUS_VALUES = [
  ExportStatus.Pending,
  ExportStatus.Completed,
  ExportStatus.Failed,
] as const;

export function isExportStatus(value: unknown): value is ExportStatus {
  return typeof value === 'string' && (EXPORT_STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * 存储层的一条导出请求（后续对应 `export_requests` 表）。
 *
 * 除 `resource` / `fields`（客户端可声明，但必须是服务端白名单内的取值）外，
 * **每一个字段都是服务端独占字段**：
 * - `id` / `artifactId`：服务端生成的主键与产物句柄（UUID），非客户端输入；
 * - `ownerUserId`：会话主体（`SESSION_SUBJECT_RESOLVER` 解析值），非客户端输入；
 * - `status`：由状态机写入（入口恒为 `pending`），客户端提交同名字段一律 400；
 * - `createdAt` / `updatedAt`：服务端时钟。
 *
 * 记录里**没有**文件名、路径、下载地址与存储 key：产物位置只存在于
 * `ExportArtifactStore` 内部（内存基线里是内部 Map 的存储键），
 * 因此「输出泄露文件路径 / 内部存储」在数据结构层面就没有可泄露的字段来源。
 */
export interface ExportRequest {
  readonly id: string;
  /** 归属主体：服务端会话解析值，非客户端输入 */
  readonly ownerUserId: string;
  /** 导出资源：必须在 `EXPORT_RESOURCE_VALUES` 闭集内 */
  readonly resource: ExportResource;
  /** 导出字段：必须是该资源服务端白名单的子集（由 service 归一化后写入） */
  readonly fields: readonly string[];
  /** 状态：只由服务端状态机写入（入口恒为 `pending`） */
  readonly status: ExportStatus;
  /** 服务端产物句柄（仅 `completed` 存在）：**不透明标识**，绝不进入任何 API 输出 */
  readonly artifactId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 存储后端能力声明：让上层与运维能机器判定当前后端是否持久化 */
export interface ExportRepositoryCapabilities {
  readonly backend: string;
  /** 是否跨进程/重启保留（内存基线必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

/**
 * 导出请求仓储端口（**任务事实的唯一落库入口**）。
 *
 * - `create`：写入一条已由 service 补齐归属、状态、字段与时间戳的记录（入口恒为 `pending`）；
 *   主键冲突属于服务端缺陷（ID 由服务端生成），拒绝静默覆盖；
 * - `save`：按 id 覆盖写入（状态机推进用）；id 不存在、或归属被改写属服务端缺陷，
 *   必须报错而不是静默插入/静默换主；
 * - `listByOwnerId`：只返回该服务端主体名下的记录，按创建顺序。
 *   service 仍会逐条复核归属（纵深防御：仓储的过滤行为不作为安全边界）；
 * - 端口**没有**删除/归档方法：本切片不提供「删除导出记录」的能力。
 *
 * ## 契约形态：**唯一一份异步契约**（本切片完成收敛）
 * 端口此前是**同步**契约（内存基线同步返回），数据库实现只能并存一份 `AsyncExportRepository`。
 * 那是一次刻意延后的跨模块契约变更：把它提前改成 Promise，会迫使 service / controller 与既有
 * spec 在没有真实 PostgreSQL 集成验证的情况下一起改。本切片满足了这个前提（迁移 `0013` 建出
 * `export_jobs`、adapter 换成运行时可换绑的延迟建连工厂、真库集成验证闭环），
 * 因此**同步与异步两份契约已收敛为下面这一份**：
 * - `create` / `save` / `listByOwnerId` 一律返回 `Promise`；
 * - 内存基线（`InMemoryExportRepository`）与数据库 adapter（`PostgresExportRepository`）
 *   实现**同一份**契约，因此「未配置数据库走内存、配置了走 PostgreSQL」是整步换绑，
 *   两条路径的语义由同一个 spec 口径约束，不再存在「同步一份、异步一份」的漂移面。
 *
 * 历史名 `AsyncExportRepository` 保留为**同一份契约的类型别名**（见下），
 * 使既有引用不必改名；它不是第二份契约，也不允许再出现第二份。
 */
export interface ExportRepository {
  readonly capabilities: ExportRepositoryCapabilities;
  /**
   * 写入一条已由调用方补齐归属、入口状态、字段与时间戳的记录（入口恒为 `pending`）。
   * 同 ID 冲突必须显式抛错，不得静默覆盖。
   */
  create(request: ExportRequest): Promise<ExportRequest>;
  /**
   * 按 id 覆盖写入（状态机推进用），`WHERE` 同时钉住 `id` 与归属。
   * id 不存在、归属不符或非法状态转移都必须报错且**不产生任何写入**；
   * 不得退化成插入，也不得静默换主。
   *
   * 非法状态转移（并发推进 / 记录已到终态）必须抛出带有**端口级并发冲突标记**
   * `EXPORT_TRANSITION_REJECTED` 的错误（`isExportTransitionRejection` 可判定），
   * 由 service 映射为 409 `STATE_TRANSITION_INVALID`；其余失败码
   * （`NOT_FOUND` / `OWNER_VIOLATION` / 行契约与执行器故障）仍是服务端缺陷，必须维持 fail-closed。
   */
  save(request: ExportRequest): Promise<ExportRequest>;
  /**
   * 只返回该服务端主体名下的记录，按创建顺序。
   * 调用方必须是已授权访问该主体资源的服务端代码；归属必须下推进 SQL（他人记录不出库）。
   */
  listByOwnerId(ownerUserId: string): Promise<readonly ExportRequest[]>;
}

/**
 * PostgreSQL 后端标识（能力声明 `backend` 的规范取值）。
 *
 * 数据库 adapter、持久化边界守卫与运维摘要共用同一字面量，避免同一后端出现
 * `postgres` / `postgres-draft` / `postgresql` 多个拼写而无法机器比对。
 */
export const EXPORT_REPOSITORY_BACKEND_POSTGRES = 'postgres';

/**
 * **存储 ID 域约束**：`export_jobs.id / requester_id / artifact_id` 在存储侧是 `uuid`
 * （docs/P2-架构与数据设计.md §4「主键 UUID」、docs/P1-字段级数据字典.md §4）。
 *
 * 读取契约把 `ownerUserId` 写成 `requesterIdSchema`（非空、无空白与控制字符、长度 1–64），
 * 会话基线的主体形如 `u-student-1` 也落在该形态内；而存储域**更严**：必须是
 * 「合法、非空、规范小写形」的 UUID。两者不矛盾（UUID 形必然落在 1–64 长度内）。
 * `EXPORT_REPOSITORY` 已在本切片换绑到数据库实现，因此**会话主体收敛为 UUID 仍是未完成前置**：
 * 数据库路径对非 UUID 主体在**进入 SQL 之前**就按本约束 fail-closed，
 * 而不是退化成「放弃类型约束的字符串比较」。
 */
export const EXPORT_REPOSITORY_STORAGE_ID_DOMAIN = 'uuid';

/**
 * **异步端口契约的边界规则**（`AsyncExportRepository` 只是 `ExportRepository` 的类型别名；
 * 下面六条是两种实现 —— 内存基线与 PostgreSQL adapter —— 共同必须守住的口径）。
 *
 * 本契约就是上面那份 `ExportRepository`：**同一条异步契约的唯一事实来源**。
 * 它曾以「与同步端口并存的异步契约」形式存在 —— 同步端口是当时的运行时绑定，把它改成 Promise
 * 属跨模块契约变更，只能与「引入经评估的驱动 + 对真实 PostgreSQL 的集成验证」同一片切片完成。
 * 该前提已由本切片满足（迁移 `0013` 建出 `export_jobs`、adapter 换成延迟建连的可换绑工厂、
 * 真库集成验证闭环），因此两份契约已收敛：运行时绑定（内存基线）与数据库 adapter 现在实现
 * **同一份**签名，「切换到数据库」与「回退到内存基线」仍是可整步执行 / 整步回退的操作。
 *
 * 方法集**只有三个**（`create` / `save` / `listByOwnerId`）——这里没有 `findById` 那种
 * 「单条读取」，因此不存在需要额外补主体参数的入口；三者都从入参取**服务端**主体，
 * 数据库实现把归属**下推进 SQL**（`WHERE requester_id = $1`）。
 *
 * 实现者（`exports.in-memory-repository.ts` 与 `exports.postgres-repository.ts`）必须满足
 * **完全相同**的语义
 * （含「同 ID 重复创建视为服务端缺陷、不得静默覆盖」与「写回未知 id / 改写归属必须报错」），
 * 并额外守住六条边界：
 * 1. **状态机唯一入口与唯一出口**：`create` 只接受入口状态 `pending`（服务端常量
 *    `EXPORT_ENTRY_STATUS`）；`save` 只接受 `pending -> completed | failed` 的合法转移，
 *    非法转移**不产生任何写入**，并由 service 的状态机门禁映射为 409
 *    `STATE_TRANSITION_INVALID`（`assertExportTransition` → `StateTransitionError`；
 *    adapter 侧的条件写入是同一条规则的**存储层镜像**，未命中时抛出的错误带端口级标记
 *    `EXPORT_TRANSITION_REJECTED`，由 service 映射为**同一个** 409 出口）。
 *    终态不可再转移，重复处理同一请求绝不静默改写历史结论；
 * 2. **归属只来自服务端**：`ownerUserId` 由 service 从服务端会话主体写入，adapter 不生成、
 *    不覆盖归属，并逐条复核「返回记录的归属 === 请求主体 / 请求记录的归属」，不一致即判服务端缺陷；
 * 3. **存储 ID 域**：主体与记录内的 `id` / `artifactId` 必须落在
 *    `EXPORT_REPOSITORY_STORAGE_ID_DOMAIN`（规范小写形 UUID）内，否则 fail-closed；
 * 4. **按服务端主体隔离**：`listByOwnerId` 必须把归属下推进 SQL，让「他人导出请求」根本不出库，
 *    并在返回行上**逐条**复核归属（纵深防御：仓储的过滤行为不作为安全边界）；
 *    写回路径同样以 `id + 归属` 双重限定，拿他人的作业 ID 也写不中他人数据；
 * 5. **每条返回记录都必须能被读取契约校验**：未知列、未知资源 / 状态枚举、非法时间戳、
 *    非 UUID 标识、字段白名单之外的字段一律按服务端缺陷抛错；结果集出现多行 / 重复主键同样
 *    fail-closed；
 * 6. **归属、产物句柄、文件位置与存储侧内部列绝不进入错误消息、日志与公开视图**：
 *    `ownerUserId`、`artifactId` 以及文件名 / 路径 / 下载地址 / 存储 key / 内部资源内容 /
 *    原始错误文本既不出现在 adapter 的公开投影里，也不进入错误信息；公开视图由
 *    `exports.contract.ts` 的 `toExportRequestView` 逐字段裁剪（恰好 `EXPORT_REQUEST_VIEW_FIELDS`）。
 */
export type AsyncExportRepository = ExportRepository;

/**
 * **端口级的并发 / 非法状态写回拒绝标记**（`save` 的条件写入未命中）。
 *
 * 触发条件：目标状态有合法前驱，但存储里的当前状态不在该前驱集合内 —— 典型场景是并发重复推进
 * （第一个请求已把记录推进到终态，第二个请求的状态谓词不再命中），或历史结论被外部改写。
 * 这是**客户端可见冲突**（应映射为 409 `STATE_TRANSITION_INVALID`），不是服务端缺陷。
 *
 * 为什么必须由端口规定这个标记：内存基线不做条件写入，只有数据库 adapter 会在存储层真的遇到竞态；
 * 若两个实现各自抛普通 `Error`，service 就只能靠错误消息猜类型，409 映射会随实现漂移。
 * 本标记是**结构化**的（唯一事实来源是这里的字面量，`isExportTransitionRejection` 只读 `code`，
 * 不解析消息、不匹配错误名），因此 PostgreSQL adapter 的
 * `PostgresExportRepositoryError('TRANSITION_REJECTED', …)` 天然满足它；而
 * `NOT_FOUND` / `OWNER_VIOLATION` / `IDENTITY_MISMATCH` / `INVALID_RECORD` / `INVALID_ROW` /
 * `EXECUTOR_FAILURE` 这些**服务端缺陷或基础设施故障**不满足它，仍按 500 fail-closed，
 * 不会被这张映射吞成 409。
 */
export const EXPORT_TRANSITION_REJECTED = 'TRANSITION_REJECTED' as const;

/** 端口级并发冲突标记的载体形态：`code` 精确等于 `EXPORT_TRANSITION_REJECTED` */
export interface ExportTransitionRejection {
  readonly code: typeof EXPORT_TRANSITION_REJECTED;
}

/**
 * 判定端口抛出的错误是否代表「并发 / 非法状态导致的写回拒绝」。
 *
 * 只检查结构化的 `code` 字段：不匹配错误名、不解析消息（消息可能被实现替换为本地化文案，
 * 且可能被注入载荷污染），因此实现细节、SQL 文本、归属与文件路径都不可能影响判定结果。
 */
export function isExportTransitionRejection(
  error: unknown,
): error is Error & ExportTransitionRejection {
  return (
    error instanceof Error &&
    (error as { readonly code?: unknown }).code === EXPORT_TRANSITION_REJECTED
  );
}

/**
 * DI 令牌：导出请求仓储（真实实现应委托 `export_jobs` 表）。
 *
 * 表名以 docs/P2-ER图.md §「关系与最小字段」（`export_jobs(id, requester_id, resource,
 * filters, fields, status, expires_at, downloaded_at)`）、docs/P1-字段级数据字典.md §4 与
 * `db/migrations/0001_bootstrap.sql` 的业务表占位清单为准；本文件早先注释里的
 * `export_requests` 属未定稿的旧名，命名对齐已登记在数据库 adapter 的验证清单里。
 */
export const EXPORT_REPOSITORY = Symbol('EXPORT_REPOSITORY');

/**
 * 产物生成规格：**全部字段都由服务端推导**（归属取会话主体，资源与字段取已验证的服务端白名单取值）。
 * 端口不接受任何客户端提交的路径、文件名或目标位置：产物落在哪里是服务端实现细节。
 */
export interface ExportArtifactSpec {
  /** 关联的导出请求 ID（服务端生成），用于存储侧追溯 */
  readonly exportRequestId: string;
  readonly ownerUserId: string;
  readonly resource: ExportResource;
  readonly fields: readonly string[];
}

/**
 * 产物句柄：只有一个**不透明** `artifactId`（UUID）。
 * 它不携带路径、URL、存储 key 或任何可反推服务端存储位置的信息。
 */
export interface ExportArtifactRef {
  readonly artifactId: string;
}

/** 产物存储后端的能力声明 */
export interface ExportArtifactStoreCapabilities {
  readonly backend: string;
  /** 产物是否跨进程/重启保留（内存基线必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

/**
 * 导出产物存储端口：把「服务端白名单内的资源 + 字段」物化为服务端侧产物。
 *
 * - **没有读/下载方法**：本切片不提供下载能力，因此端口在类型层面就无法把产物内容或位置交给调用方；
 * - 返回的句柄只用于写入记录的 `artifactId`（供后续下载切片关联），**绝不外发**；
 * - 失败（生成或写入抛异常、返回形态非法）由 service 收敛为任务的 `failed` 终态：
 *   这是「导出没做出来」的业务事实，不是 500；
 * - 实现**不做授权判定**，也不决定归属：spec 由 service 从服务端主体与已验证输入推导。
 */
export interface ExportArtifactStore {
  readonly capabilities: ExportArtifactStoreCapabilities;
  store(spec: ExportArtifactSpec): ExportArtifactRef;
}

/** DI 令牌：导出产物存储（真实实现应写入对象存储/临时文件区并保留有效期与清理策略） */
export const EXPORT_ARTIFACT_STORE = Symbol('EXPORT_ARTIFACT_STORE');
