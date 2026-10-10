/**
 * 导出切片（exports）的**显式端口**与存储侧词汇表
 * （docs/P2-架构与数据设计.md §2「exports | 异步导出、脱敏、有效期、下载审计」）。
 *
 * 本切片承载**本人导出请求的最小垂直切片**：
 * - `POST /me/exports` 创建本人的导出请求（服务端白名单资源 + 字段）；
 * - `GET  /me/exports` 本人导出请求列表与状态；
 * - `GET  /me/exports/:exportId/download` 下载本人**已完成**导出的产物内容；
 * - `POST /me/exports/:exportId/revoke` **本人撤销**自己的导出请求（写 `revoked_at`，
 *   与状态机正交的单调事实；撤销后下载立即统一 404 失效，但**不做**物理删除与产物清理）。
 *
 * **真实文件生成、字段级脱敏、管理端 `POST /admin/exports`**
 * （`export:{resource}:create`，见 docs/P2-API契约基线.md §「统计、导出、配置」）与
 * **异步产物清理**（过期回收 / 撤销后清理：本切片只登记能力边界
 * `EXPORT_REVOCATION_CLEANUP_BOUNDARY`）仍属于后续切片：
 * 下载切片只把「已完成导出的产物能不能被本人取走」这一段收敛到契约内
 * （含**服务端有效期**：创建时由服务端写入、下载时按绝对时刻判定，过期与不存在同形收敛到统一拒绝），
 * 撤销切片只把「本人能不能取回交付能力」这一段收敛到契约内（撤销即下载失效，
 * 记录与产物都保留），
 * 产物内容由 `ExportArtifactStore` 的显式端口给出（真实实现留给后续切片），
 * 本切片**不伪造生产文件下载**，也不声称任何实现可生产可用。
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
 * - 仓储**只按服务端主体取数**（`listByOwnerId` / `findByIdForOwner`）：没有「按客户端提交的
 *   owner 取数」这类方法，也没有**不带归属条件**的单条读取（不存在 `findById`），
 *   因此「拿他人的导出请求」在端口层面就没有可用的查询入口；
 * - 端口实体里**没有**文件名、文件路径、下载 URL、对象存储 key 这类字段：
 *   产物在存储侧的位置只存在于 `ExportArtifactStore` 内部，端口返回值只是一个不透明句柄；
 *   `ExportArtifactStore.read` 返回的也只有**内容字节**，不含 key / 路径 / 下载地址 / 签名地址。
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
 *
 * 刻意**没有** `revoked`：撤销（`revoked_at`）是一条与状态机**正交**的服务端事实，
 * 不是第四个状态 —— 撤销不改写 `status` / `artifact_id`（不物理删除、不同步清理产物），
 * 只把「这条导出已被本人取回交付能力」记在独立列上。公开视图把它呈现为 `revoked`
 * （见 `exports.contract.ts` 的 `EXPORT_VIEW_STATUS_VALUES`），但**存储侧状态闭集保持三态**，
 * 因此 0013 已应用的状态闭集 CHECK 与「产物短引用当且仅当 completed 存在」的跨字段 CHECK
 * 逐字不变（见 `db/migrations/0016_export_jobs_revocation.sql`）。
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
 * - `createdAt` / `updatedAt`：服务端时钟；
 * - `expiresAt`：**服务端创建**的产物有效期（绝对时刻，见下）；
 * - `revokedAt`：**服务端写入**的撤销时刻（绝对时刻，见下；与状态机正交的单调事实）。
 *
 * 记录里**没有**文件名、路径、下载地址与存储 key：产物位置只存在于
 * `ExportArtifactStore` 内部（内存基线里是内部 Map 的存储键），
 * 因此「输出泄露文件路径 / 内部存储」在数据结构层面就没有可泄露的字段来源。
 *
 * ## `expiresAt`：服务端创建、只读、fail-closed
 *
 * - **服务端创建**：值由 service 在创建入口用**服务端时钟**算出（`now + EXPORT_DOWNLOAD_TTL_MS`），
 *   与 `createdAt` 取自同一次时钟读取；客户端提交的 `expiresAt`（请求体或查询串）一律 400，
 *   该列在写回（`save`）路径上属于**不可变列**，谁都不能改写它；
 * - **绝对时刻语义**：值是 UTC 的 ISO 8601（`YYYY-MM-DDTHH:mm:ss.sssZ`），比较的是**瞬时点**，
 *   与本地时区 / 夏令时无关；存储侧对应 `timestamptz`（见 `db/migrations/0015_export_jobs_expiry.sql`）；
 * - **可选（fail-closed）**：存储里该列可缺省（数据库 `NULL` 的领域形）。缺省**不表示永不过期**，
 *   而是「没有可用的服务端有效期」：下载边界把「缺省 / 非法形态 / 早于当前时刻」一律判为不可下载，
 *   并与「不存在 / 跨主体 / 未完成 / 产物缺失」收敛到**同一个稳定拒绝**，因此既不会放行，
 *   也不会泄露「这条导出是否存在、处于什么状态」；
 * - **绝不进入公开视图**：到期时刻不外发（`EXPORT_REQUEST_VIEW_FIELDS` 里没有它），
 *   与 `ownerUserId` / `artifactId` 同属「只承载、不外发」的内部事实。
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
  /**
   * 服务端产物有效期（UTC ISO 8601 绝对时刻，服务端唯一写入方）：
   * 缺省 = 存储侧 `NULL` = 「没有可用的服务端有效期」⇒ 下载边界 fail-closed。
   */
  readonly expiresAt?: string;
  /**
   * 服务端**撤销**时刻（UTC ISO 8601 绝对时刻，服务端唯一写入方；缺省 = 未被撤销）。
   *
   * 三条硬性质（与本切片其余字段同构）：
   * - **服务端独占**：值只由 service 在撤销入口用服务端时钟写入，客户端提交的 `revokedAt` /
   *   `revoked_at` / `status`（请求体或查询串）一律 400，**不是静默剥离**；
   * - **单向单调**：`undefined → 时刻` 只能发生一次，之后任何写回路径都不得清空或改写它
   *   （状态机推进的 `save` 不写该列；数据库 adapter 的 `POSTGRES_EXPORT_REVOKE_COLUMNS`
   *   是唯一写入点，且带 `revoked_at IS NULL` 的条件谓词）；
   * - **与状态机正交**：撤销**不改写** `status` / `artifactId` —— 记录可以既是 `completed`
   *   又是已撤销。下载边界按「已撤销 ⇒ 统一拒绝」判定（`revoked_at` **优先**于 `status`），
   *   因此「并发撤销 / 完成」时撤销事实永远使下载失效，而不是被一次并发完成覆盖掉。
   *
   * 它同样**不进入公开视图**（撤销时刻不外发；列表只把 `status` 呈现为 `revoked`）。
   */
  readonly revokedAt?: string;
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
 * 分页窗口的**键集游标**（keyset）：排序键是**唯一全序** `(createdAt ASC, id ASC)` 的全前缀，
 * 两个分量都来自服务端记录（`createdAt` 由服务端时钟写入、`id` 由服务端生成），
 * 客户端无法声明或覆盖。
 *
 * 为什么不是 offset：`OFFSET n` 的语义是「跳过前 n 行」，在并发写入（本人新建导出请求）下会
 * 让同一行出现在两页或从两页之间漏掉；键集游标把「下一页从哪里继续」表达为**已返回的最后一行的
 * 键值边界**，因此分页结果与「上一页取走之后又插入了新行」无关，也不会重复或遗漏既有行。
 */
export interface ExportKeyset {
  /**
   * 排序键第一分量：服务端时钟写入的 UTC ISO 8601 绝对时刻。
   * 比较与边界判定都发生在**毫秒粒度**（见 `compareExportKeysets`）。
   */
  readonly createdAt: string;
  /** 排序键第二分量：服务端生成的记录主键（UUID），用于给同一时刻的多行定序 */
  readonly id: string;
}

/**
 * 分页窗口（**服务端**侧入参，不是客户端输入）：
 * - `limit`：本页最多返回的行数，由 API 层按服务端闭集校验（严格正整数且有有限上界）后传入；
 * - `after`：键集边界，缺省 = 从该主体名下的最早一行开始（首页）。
 */
export interface ExportPageWindow {
  readonly limit: number;
  readonly after?: ExportKeyset;
}

/**
 * 一页读取结果。
 *
 * `hasNext` **必须由存储实现**给出（而不是让上层「猜」）：判断依据是「按窗口多取一行」——
 * 取到 `limit + 1` 行即表示后面还有行，且多取的那一行**不得**出现在 `records` 里。
 * 因此 `records.length <= limit` 恒成立，且 `hasNext` 与 `records` 来自**同一次**取数快照，
 * 不存在「先数总数再取一页」两次读取之间的漂移。
 */
export interface ExportPage {
  readonly records: readonly ExportRequest[];
  readonly hasNext: boolean;
}

/**
 * 分页窗口的**服务端闭集**：默认页大小与硬上界都是服务端常量。
 *
 * 为什么上界必须有限且写在契约层：`limit` 若可以被客户端放大到任意值，一次请求就能把本人全部
 * 导出请求（以及它们的字段列表）拉出来，分页本身就不再是资源边界，而只是一个可选的提示。
 * 上界放在这里（而不是 API 层独有）还有第二个原因：数据库 adapter 需要先判定「窗口合法」
 * 才允许把 `limit + 1` 绑定进 SQL 的 `LIMIT`，否则「按客户端提交的行数取数」这条路径在
 * 存储层就是敞开的。
 */
export const EXPORT_PAGE_DEFAULT_LIMIT = 20;
export const EXPORT_PAGE_MAX_LIMIT = 100;

/** 页大小是否是服务端闭集内的严格正整数（唯一的判定位点，内存基线与数据库 adapter 共用） */
export function isExportPageLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= EXPORT_PAGE_MAX_LIMIT
  );
}

/**
 * 窗口自检（**服务端缺陷**出口）：非法页大小或形态非法的键集边界都说明调用链已损坏，
 * 必须抛错而不是「夹到一个合法值继续」——静默修正会让「上层漏了校验」永远不可见。
 */
export function assertExportPageWindow(window: unknown): ExportPageWindow {
  if (typeof window !== 'object' || window === null || Array.isArray(window)) {
    throw new Error('导出分页窗口必须是对象（服务端缺陷）');
  }
  const candidate = window as { readonly limit?: unknown; readonly after?: unknown };
  if (!isExportPageLimit(candidate.limit)) {
    throw new Error(`导出分页窗口的 limit 必须是 1–${EXPORT_PAGE_MAX_LIMIT} 的整数（服务端缺陷）`);
  }
  if (candidate.after !== undefined) {
    assertExportKeyset(candidate.after);
  }
  return window as ExportPageWindow;
}

/** 键集边界的形态自检：两个分量都必须是非空字符串（取值域由上层读取契约保证） */
export function assertExportKeyset(keyset: unknown): ExportKeyset {
  if (typeof keyset !== 'object' || keyset === null || Array.isArray(keyset)) {
    throw new Error('导出分页键集边界必须是对象（服务端缺陷）');
  }
  const candidate = keyset as { readonly createdAt?: unknown; readonly id?: unknown };
  if (
    typeof candidate.createdAt !== 'string' ||
    candidate.createdAt === '' ||
    typeof candidate.id !== 'string' ||
    candidate.id === ''
  ) {
    throw new Error('导出分页键集边界必须是 (createdAt, id) 两个非空字符串（服务端缺陷）');
  }
  return candidate as ExportKeyset;
}

/**
 * 键集全序比较（**内存基线与数据库 adapter 必须一致的那一份序**）。
 *
 * - 第一分量按**毫秒粒度**的绝对时刻比较（`Date.parse` 的取值就是毫秒整数），
 *   而不是按 ISO 字符串字面量：同一瞬时点的合法 ISO 形态不止一种（带 / 不带小数秒、
 *   微秒位不同），逐字节比较会排出与时间先后不同的顺序；毫秒粒度同时与数据库侧
 *   `date_trunc('milliseconds', created_at)` 的排序表达式、以及领域记录能表达的
 *   ISO 毫秒精度一致（`ORDER BY date_trunc('milliseconds', created_at) ASC, id ASC`）；
 * - 第二分量按**规范小写 UUID 文本**比较：数据库对 `uuid` 的比较是 16 字节值序，而规范小写形
 *   （定长十六进制 + 固定位置连字符）的文本序与该值序一致，因此两侧序相同；
 * - 排序键合起来是唯一全序（主键唯一），因此「严格大于边界」与「等于边界之后」等价，
 *   分页既不会重复也不会遗漏。
 *
 * 为什么毫秒粒度是**必须**的：`timestamptz` 允许微秒精度，而领域记录的 `createdAt` 是
 * ISO 毫秒形态（驱动读回的 `Date` 也只有毫秒）。若排序用原始列、边界用毫秒截断值，
 * 边界行自己的真实值严格大于截断值，于是它会在下一页**被再次取出** —— 相邻两页重复同一行。
 */
export function compareExportKeysets(left: ExportKeyset, right: ExportKeyset): number {
  const leftMs = Date.parse(left.createdAt);
  const rightMs = Date.parse(right.createdAt);
  const bothFinite = Number.isFinite(leftMs) && Number.isFinite(rightMs);
  if (bothFinite && leftMs !== rightMs) {
    return leftMs < rightMs ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
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
 * - `findByIdForOwner`：按「记录 ID + 服务端主体归属」取**单条**记录（下载切片唯一的取数入口）。
 *   归属**同时**出现在方法签名与 SQL 谓词里（`WHERE id = $1::uuid AND requester_id = $2::uuid`），
 *   因此他人记录既不出库，也无法通过「拿他人的作业 ID」取到；查不到与不属于本人**不可区分**
 *   （都返回 `undefined`），所以端口层面就不可能泄露「该 ID 是否存在」；
 * - 端口**没有**删除/归档方法，也**没有**不带归属条件的单条读取（`findById` / `findByOwner` /
 *   `query` 一类入口一律不存在）：本切片不提供「删除导出记录」与「跨主体取数」的能力。
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
   *
   * **无窗口的完整读取**：HTTP 路由不再使用它（`GET /me/exports` 走下面的窗口入口），
   * 它保留为端口上的既有取数能力与回归夹具的读取入口；两条入口共用同一份行映射与归属复核，
   * 因此语义不会漂移。
   */
  listByOwnerId(ownerUserId: string): Promise<readonly ExportRequest[]>;
  /**
   * 按服务端主体取**一页**记录（键集分页的唯一取数入口）。
   *
   * - 排序固定为键集全序 `(createdAt ASC, id ASC)`；`window.after` 缺省表示首页；
   * - 边界语义是**严格大于**：`after` 行本身不会再出现在下一页（否则相邻两页会重复该行）；
   * - 实现**必须多取一行**（`limit + 1`）来判定 `hasNext`，且多取的那一行不得进入 `records`；
   * - **不得使用 `OFFSET`**：位移分页在并发写入下会重复或遗漏行，键集边界必须由
   *   `(created_at, id)` 的下推谓词表达；
   * - 归属必须下推进存储（`WHERE requester_id = …`），并逐条复核返回行的归属；
   * - `window.limit` 必须落在 `EXPORT_PAGE_MAX_LIMIT` 内，非法窗口在**取数之前** fail-closed
   *   （绝不「夹到上界继续」）。
   */
  listByOwnerIdPage(ownerUserId: string, window: ExportPageWindow): Promise<ExportPage>;
  /**
   * 按「记录 ID + 服务端主体归属」取单条记录（下载切片的唯一取数入口）。
   *
   * - `id` 来自服务端已通过形态校验的路由参数，`ownerUserId` 只来自服务端会话主体；
   * - **归属必须下推进存储**（SQL：`WHERE id = $1 AND requester_id = $2`）；
   * - 记录不存在**或不属于该主体**都返回 `undefined`（两者不可区分，因此不会泄露存在性）；
   * - 返回的记录不经过任何公开视图裁剪，调用方必须自行复核读取契约与归属，
   *   并**自行判定服务端有效期**（`expiresAt` 由本端口原样承载，可以是缺省 = 存储 `NULL`）；
   *   本端口**不做**过期过滤：过期与否是下载边界的判定，不是取数语义（把过期做成
   *   「取不到」会让「不存在」与「已过期」在端口层就不可区分，也让内存基线与数据库实现的
   *   语义凭空多出一处需要同步的实现细节）；
   * - 存储故障（执行器异常、行契约损坏、ID 不在存储域）必须**抛错**（fail-closed），
   *   绝不能被伪装成「不存在」。
   */
  findByIdForOwner(id: string, ownerUserId: string): Promise<ExportRequest | undefined>;
  /**
   * **本人撤销**（`POST /me/exports/:exportId/revoke` 的唯一写入入口）：把「这条导出已被本人
   * 取回交付能力」这一**单调**事实写进 `revoked_at`，并**条件更新**：
   *
   * ```
   * WHERE id = $1 AND requester_id = $2 AND status = ANY(可撤销前驱集合) AND revoked_at IS NULL
   * SET   revoked_at = $3, updated_at = $4
   * ```
   *
   * - `ownerUserId` 只来自服务端会话主体，`revokedAt` 只来自服务端时钟；调用方（service）
   *   必须先完成入口授权与读取契约复核；
   * - **不改写** `status` / `artifact_id` / `created_at` / `expires_at` / `resource` / `fields`：
   *   撤销不是状态机转移，也不删除产物（无物理删除、无同步清理 —— 清理属异步后续切片）；
   * - **条件谓词**同时钉住归属、可撤销前驱集合与 `revoked_at IS NULL`：
   *   拿他人的记录 ID 写不中他人数据（`undefined`，与「不存在」不可区分）；
   *   `failed` 结论写不中（`not-revocable`）；已撤销的记录写不中（`already-revoked`，幂等）；
   * - **并发**：撤销与状态机推进（`save`）互不覆盖 —— `save` 的 `SET` 列表里没有 `revoked_at`，
   *   而本方法接受「`pending` 或 `completed`」两种前驱，因此并发完成之后撤销仍然生效，
   *   撤销事实**优先**（下载边界按已撤销统一拒绝）；
   * - 返回 `undefined` 表示「记录不存在或不属于该主体」（与「不是可撤销结论」**不可区分**地
   *   收敛在调用方的统一拒绝出口 —— 但本方法仍然如实区分这两种内部结论，因为调用方需要
   *   幂等响应与 404 的差别：`already-revoked` 必须幂等成功，`not-revocable` 必须拒绝）。
   */
  revokeForOwner(
    id: string,
    ownerUserId: string,
    revokedAt: string,
  ): Promise<ExportRevocationResult | undefined>;
}

/**
 * 撤销写入的**结论闭集**（内存基线与数据库 adapter 必须给出同一组取值）：
 * - `revoked`：本次调用**真的**把一条未撤销且可撤销的记录置为已撤销（条件更新命中 1 行）；
 * - `already-revoked`：记录**已经**被撤销（重复请求 ⇒ 幂等成功，**不是**错误，也不改写时刻）；
 * - `not-revocable`：记录存在且属于请求主体，但当前结论**不可撤销**（`failed` ——
 *   与存储层 CHECK `export_jobs_revoked_at_matches_status` 同一条规则）。
 *
 * 「不存在 / 不属于请求主体」**不是**这里的一个取值，而是方法返回的 `undefined`：
 * 两者在端口层不可区分，因此不会泄露「该记录是否存在」。三种结论都**必然**携带记录本身
 * （服务端已授权主体自己的记录），调用方据此构造幂等响应或拒绝判定。
 */
export const ExportRevocationOutcome = {
  Revoked: 'revoked',
  AlreadyRevoked: 'already-revoked',
  NotRevocable: 'not-revocable',
} as const;
export type ExportRevocationOutcome =
  (typeof ExportRevocationOutcome)[keyof typeof ExportRevocationOutcome];
export const EXPORT_REVOCATION_OUTCOME_VALUES = [
  ExportRevocationOutcome.Revoked,
  ExportRevocationOutcome.AlreadyRevoked,
  ExportRevocationOutcome.NotRevocable,
] as const;

export function isExportRevocationOutcome(value: unknown): value is ExportRevocationOutcome {
  return (
    typeof value === 'string' &&
    (EXPORT_REVOCATION_OUTCOME_VALUES as readonly string[]).includes(value)
  );
}

/** 撤销写入的结果：结论 + 该主体自己的记录（记录已由仓储按归属取回并逐列复核） */
export interface ExportRevocationResult {
  readonly outcome: ExportRevocationOutcome;
  readonly record: ExportRequest;
}

/**
 * **撤销不清产物**的能力边界（可机器判定的声明，见本切片 spec）。
 *
 * 撤销只落一个时刻列：它**不**调用产物存储，产物存储端口上也**没有**删除 / 清理方法
 * （`EXPORT_ARTIFACT_STORE_FORBIDDEN_METHODS`）。产物的过期回收 / 撤销后清理属于
 * **异步清理切片**，必须先有独立的有效期扫描与回收入口，不能在撤销请求里同步做
 * （同步清理会让「撤销」变成一次可能失败的多阶段副作用，并把产物存储故障升级成 5xx）。
 */
export const EXPORT_REVOCATION_CLEANUP_BOUNDARY = {
  /** 撤销路径对产物存储的调用次数：恒为 0 */
  artifactStoreCalls: 0,
  /** 撤销是否删除记录：否（端口上没有删除 / 归档方法） */
  deletesRecord: false,
  /** 撤销是否清理产物：否（清理属异步后续切片） */
  cleansArtifact: false,
  /** 承接清理的切片标识（登记，不实现） */
  deferredTo: 'async-artifact-cleanup',
} as const;

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
 * 方法集**只有六个**（`create` / `save` / `listByOwnerId` / `listByOwnerIdPage` /
 * `findByIdForOwner` / `revokeForOwner`）：唯一的单条读取入口也把主体写进签名
 * （`findByIdForOwner`），不存在需要额外补主体参数的「裸 findById」；无窗口与有窗口两个列表入口
 * 都从入参取**服务端**主体，数据库实现把归属**下推进 SQL**（`WHERE requester_id = $1`）。
 * 唯一的写入型单条入口是 `revokeForOwner`，它同样把归属写进签名与 SQL 谓词，
 * 且**只**写 `revoked_at` / `updated_at` 两列（条件更新，不删记录、不清理产物）。
 *
 * 实现者（`exports.in-memory-repository.ts` 与 `exports.postgres-repository.ts`）必须满足
 * **完全相同**的语义
 * （含「同 ID 重复创建视为服务端缺陷、不得静默覆盖」与「写回未知 id / 改写归属必须报错」），
 * 并额外守住七条边界：
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
 * 4. **按服务端主体隔离**：`listByOwnerId` 与 `findByIdForOwner` 都必须把归属下推进 SQL，
 *    让「他人导出请求」根本不出库，并在返回行上**逐条**复核归属（纵深防御：仓储的过滤行为
 *    不作为安全边界）；`findByIdForOwner` 对「不存在」与「属于他人」返回同一个 `undefined`，
 *    不得用不同返回值 / 不同错误区分两者；写回路径同样以 `id + 归属` 双重限定，
 *    拿他人的作业 ID 也写不中他人数据；
 * 5. **每条返回记录都必须能被读取契约校验**：未知列、未知资源 / 状态枚举、非法时间戳、
 *    非 UUID 标识、字段白名单之外的字段一律按服务端缺陷抛错；结果集出现多行 / 重复主键同样
 *    fail-closed；
 * 6. **归属、产物句柄、文件位置与存储侧内部列绝不进入错误消息、日志与公开视图**：
 *    `ownerUserId`、`artifactId` 以及文件名 / 路径 / 下载地址 / 存储 key / 内部资源内容 /
 *    原始错误文本既不出现在 adapter 的公开投影里，也不进入错误信息；公开视图由
 *    `exports.contract.ts` 的 `toExportRequestView` 逐字段裁剪（恰好 `EXPORT_REQUEST_VIEW_FIELDS`）。
 * 7. **撤销是「只写一个时刻」的单调操作，绝不是状态机转移，也不做任何清理**：
 *    `revokeForOwner` 的 `SET` 只有 `revoked_at` / `updated_at`（不写 `status` / `artifact_id` /
 *    `created_at` / `expires_at` / `resource` / `fields`），`WHERE` 同时钉住 `id`、归属、
 *    `EXPORT_REVOCABLE_STATUSES`（`pending` / `completed`）与 `revoked_at IS NULL`。
 *    因此：重复撤销幂等（`already-revoked`，时刻不被改写）、`failed` 不可撤销（`not-revocable`）、
 *    他人记录不可见也不可写（`undefined`）、状态机写回（`save`）永不覆盖或清空撤销事实。
 *    撤销**不删除记录**（端口上没有删除 / 归档方法）、**不同步清理产物**
 *    （`EXPORT_REVOCATION_CLEANUP_BOUNDARY` 声明撤销路径对产物存储的调用次数恒为 0，
 *    清理属异步后续切片），因此撤销请求不会因为产物存储故障而失败。
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

/**
 * 产物内容：**只有内容本身**。
 *
 * 刻意不携带 storage key、文件路径、下载地址、签名地址、文件名、桶名、有效期或 MIME ——
 * 「位置即能力」：任何可反推存储位置或自带取件能力的字段都不得离开存储实现。
 * 内容类型与文件名由 API 层用**服务端常量**固定（见 `exports.contract.ts`），
 * 不由存储实现决定，因此存储侧无法用「返回一个 header」的方式注入响应头。
 */
export interface ExportArtifactContent {
  readonly bytes: Uint8Array;
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
 * 导出产物存储端口：把「服务端白名单内的资源 + 字段」物化为服务端侧产物，并按不透明句柄读回内容。
 *
 * - **`store` 没有位置语义**：返回的句柄只有一个 UUID（供记录关联），**绝不外发**；
 * - **`read` 只返回内容字节**：没有 storage key / 路径 / 下载地址 / 签名地址 / 文件名
 *   （见 `ExportArtifactContent`），因此「把内部存储位置或一次性签名地址交给调用方」在类型层面
 *   就不可表达；
 * - `read` 命中返回内容；句柄不存在（含「该句柄不属于请求中的记录」）返回 `undefined`；
 *   读取故障必须**抛异常**（不能返回 `undefined`），由 service 按 fail-closed 处理；
 * - `read` **一次返回全部内容**（不做流式读出）：调用方因此能在写出任何字节之前完成硬上限判定，
 *   不存在「流到一半才发现超大」的窗口；
 * - 失败（生成或写入抛异常、返回形态非法）由 service 收敛为任务的 `failed` 终态：
 *   这是「导出没做出来」的业务事实，不是 500；
 * - 实现**不做授权判定**，也不决定归属：spec 由 service 从服务端主体与已验证输入推导，
 *   读取前必须先由 service 完成归属与资源级判定。
 */
export interface ExportArtifactStore {
  readonly capabilities: ExportArtifactStoreCapabilities;
  store(spec: ExportArtifactSpec): ExportArtifactRef;
  read(artifactId: string): Promise<ExportArtifactContent | undefined>;
}

/**
 * **产物存储端口上刻意不存在的清理能力**（可机器判定的能力边界）。
 *
 * 撤销（`revokeForOwner`）**不同步清理产物**：它只落一个时刻列，产物存储端口既不提供
 * 删除 / 清理入口，也没有任何「按句柄失效」的方法。这样声明有两个作用：
 * 1. 撤销请求的成功与失败**不依赖**产物存储：产物存储故障不会把撤销升级成 5xx，
 *    也不会出现「记录已撤销、产物却没清掉 / 清了但记录没落」这种半成品状态；
 * 2. 产物的过期回收 / 撤销后清理必须先有**独立的异步清理切片**（有效期扫描 + 回收入口 +
 *    幂等重试），本切片只把这条边界登记下来，不实现它。
 *
 * spec 会逐名断言产物存储实例（含内存基线）上没有这些方法。
 */
export const EXPORT_ARTIFACT_STORE_FORBIDDEN_METHODS: readonly string[] = Object.freeze([
  'delete',
  'remove',
  'purge',
  'revoke',
  'invalidate',
  'cleanup',
  'truncate',
  'archive',
]);

/** DI 令牌：导出产物存储（真实实现应写入对象存储/临时文件区并保留有效期与清理策略） */
export const EXPORT_ARTIFACT_STORE = Symbol('EXPORT_ARTIFACT_STORE');

/**
 * 下载审计结果**闭集**：只记「这次下载尝试的结果码」，不记原因、不记任何业务取值。
 *
 * - `success`：内容已交付；
 * - `unavailable`：**统一安全拒绝**（不存在 / 跨主体 / 未完成 / 产物缺失 / 已过期 / 无服务端有效期
 *   收敛到同一结果），因此审计本身也不泄露「该导出是否存在、处于什么状态、是否已过期」；
 * - `failed`：fail-closed（产物读取故障、内容超过硬上限、存储记录违反读取契约）；
 * - 未登记取值一律视为存储损坏，绝不作为合法结果外发。
 */
export const ExportDownloadAuditResult = {
  Success: 'success',
  Unavailable: 'unavailable',
  Failed: 'failed',
} as const;
export type ExportDownloadAuditResult =
  (typeof ExportDownloadAuditResult)[keyof typeof ExportDownloadAuditResult];
export const EXPORT_DOWNLOAD_AUDIT_RESULT_VALUES = [
  ExportDownloadAuditResult.Success,
  ExportDownloadAuditResult.Unavailable,
  ExportDownloadAuditResult.Failed,
] as const;

/**
 * 下载审计条目：**恰好三个字段**，每一个都是服务端生成的脱敏值。
 *
 * - `requestId`：服务端生成的请求关联 ID（**不使用**客户端可提交的 `x-request-id`：
 *   客户端可控值不得进入审计，否则审计可被伪造成指向任意请求）；
 * - `exportIdDigest`：导出 ID 的**单向摘要**（`sha256:<32 位十六进制>`）。记摘要而不是原值，
 *   使审计在可用于关联的同时不落任何原始标识；摘要不可逆，因此审计泄露不等于 ID 泄露；
 * - `result`：结果码闭集（见上）。
 *
 * **刻意没有**的字段：产物内容 / 字节 / 响应体、`artifactId` 或任何产物句柄、storage key /
 * 路径 / 下载地址 / 签名地址 / 文件名、归属主体、角色 / 权限、查询串、请求头、IP、UA、
 * 错误原文。审计端口在类型层面就装不下这些取值（严格契约见 `exports.contract.ts` 的
 * `exportDownloadAuditEntrySchema`），因此「审计顺手把产物位置或 PII 写进去」不可能悄悄发生。
 */
export interface ExportDownloadAuditEntry {
  readonly requestId: string;
  readonly exportIdDigest: string;
  readonly result: ExportDownloadAuditResult;
}

/**
 * 下载审计端口（**只追加单条脱敏记录**）。
 *
 * 为什么独立于 `audit` 模块：本切片只要求「下载尝试留痕」这一件事，而 `AuditRepository`
 * 的读取契约（actor / ipHash / 事件类型 / 资源类型闭集）面向业务审计事件，扩它需要改动
 * 公开权限与事件目录（属后续版本项）。本端口因此只承载下载留痕的最小事实集，
 * **不落任何业务取值**，也不提供读取面（读取属于后续的审计查询切片）。
 *
 * 失败语义：`record` 抛异常即表示「留痕失败」，由 service fail-closed 为 500 ——
 * 审计不可用时绝不返回「看起来成功但没有留痕」的下载响应。
 */
export interface ExportDownloadAuditSink {
  record(entry: ExportDownloadAuditEntry): Promise<void>;
}

/** DI 令牌：下载审计出口 */
export const EXPORT_DOWNLOAD_AUDIT = Symbol('EXPORT_DOWNLOAD_AUDIT');

/**
 * **撤销审计结果**闭集：只记「这次撤销尝试的结果码」，不记原因、不记任何业务取值。
 *
 * - `success`：本次调用真的把一条未撤销且可撤销的记录置为已撤销；
 * - `duplicate`：重复撤销（记录**已经**被撤销）—— 这是**幂等成功**，不是失败，
 *   因此必须与 `success` 区分：审计要能回答「这条记录被撤销了几次」，
 *   而不是把幂等重放混成一次新的撤销；
 * - `unavailable`：撤销**没有**发生。统一安全拒绝（记录不存在 / 跨主体 / `failed` 结论 /
 *   已过期 / 非法路径参数）与 fail-closed 500（存储记录违约、执行器故障、审计前取数故障）
 *   **共享**这个结果码：它与调用方的对外出口一样**不区分原因**，因此审计本身也不泄露
 *   「该记录是否存在、处于什么结论、是否已过期」；
 * - 未登记取值一律视为存储损坏，绝不作为合法结果外发。
 */
export const ExportRevocationAuditResult = {
  Success: 'success',
  Duplicate: 'duplicate',
  Unavailable: 'unavailable',
} as const;
export type ExportRevocationAuditResult =
  (typeof ExportRevocationAuditResult)[keyof typeof ExportRevocationAuditResult];
export const EXPORT_REVOCATION_AUDIT_RESULT_VALUES = [
  ExportRevocationAuditResult.Success,
  ExportRevocationAuditResult.Duplicate,
  ExportRevocationAuditResult.Unavailable,
] as const;

/**
 * 撤销审计条目：**恰好四个字段**，每一个都是服务端生成的脱敏值。
 *
 * - `requestId`：服务端生成的请求关联 ID（**不使用**客户端可提交的 `x-request-id`：
 *   客户端可控值不得进入审计，否则审计可被伪造成指向任意请求）；
 * - `exportIdDigest`：导出 ID 的**单向摘要**（`sha256:<32 位十六进制>`）；记摘要而不是原值，
 *   使审计可用于关联而不落任何原始标识；
 * - `requesterDigest`：**请求主体**（服务端会话主体）的单向摘要。撤销是一条「谁取回了自己的
 *   交付能力」的事实，因此审计需要能按主体聚合 —— 但主体标识本身同样**不落原值**：
 *   记的是同一个 `sha256:<32 位十六进制>` 单向摘要（与导出 ID 同一套摘要口径），
 *   因此审计泄露不等于主体标识泄露；
 * - `result`：结果码闭集（见上）。
 *
 * **刻意没有**的字段：请求体 / 字节 / 响应体（**绝不记 body**）、产物内容与任何产物句柄、
 * storage key / 路径 / 下载地址 / 签名地址 / 文件名、归属主体的**原值**、角色 / 权限、
 * 查询串、请求头 / 凭据 / secret、IP、UA、原始错误文本。
 * 审计端口在类型层面就装不下这些取值（严格契约见 `exports.contract.ts` 的
 * `exportRevocationAuditEntrySchema`），因此「撤销审计顺手把 body 或 PII 写进去」不可能悄悄发生。
 */
export interface ExportRevocationAuditEntry {
  readonly requestId: string;
  readonly exportIdDigest: string;
  readonly requesterDigest: string;
  readonly result: ExportRevocationAuditResult;
}

/**
 * 撤销审计端口（**只追加单条脱敏记录**）。
 *
 * 与 `ExportDownloadAuditSink` 一样刻意独立于 `audit` 模块（理由同下载审计），
 * 但它是**另一条**最小事实集：撤销多一个 `requesterDigest`、结果闭集多一个 `duplicate`。
 * 两者共用同一份摘要口径（`exports.contract.ts` 的 `digestExportId` / `digestRequesterId`），
 * 因此「同一主体 / 同一条导出」在两条留痕里可被关联，而两处都不落原始标识。
 *
 * 失败语义：`record` 抛异常即表示「留痕失败」，由 service fail-closed 为 500 ——
 * 审计不可用时绝不返回「看起来撤销成功但没有留痕」的响应；反过来，`success` 留痕失败
 * **不**回滚已落库的撤销时刻（撤销是单调事实），响应是 500，客户端重试会因为幂等
 * 落到 `duplicate` 分支 —— 这正是「单调事实 + 幂等入口」要的行为。
 */
export interface ExportRevocationAuditSink {
  record(entry: ExportRevocationAuditEntry): Promise<void>;
}

/** DI 令牌：撤销审计出口 */
export const EXPORT_REVOCATION_AUDIT = Symbol('EXPORT_REVOCATION_AUDIT');
