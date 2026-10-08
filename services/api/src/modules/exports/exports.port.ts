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
 * 1. `ExportRepository` —— 导出请求事实的持久化端口（对应后续 `export_requests` 表）。
 *    默认绑定内存基线 `InMemoryExportRepository`，它如实声明 `persistent = false`、
 *    `productionReady = false`，并在 `NODE_ENV=production` 下**拒绝构造**；
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
 */
export interface ExportRepository {
  readonly capabilities: ExportRepositoryCapabilities;
  create(request: ExportRequest): ExportRequest;
  save(request: ExportRequest): ExportRequest;
  listByOwnerId(ownerUserId: string): readonly ExportRequest[];
}

/** DI 令牌：导出请求仓储（真实实现应委托 `export_requests` 表） */
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
