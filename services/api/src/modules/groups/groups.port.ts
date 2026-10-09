import type { GroupStatus, RecruitmentRequirementsInput } from '@rm/shared';

/**
 * 小组持久化端口（**显式可替换 repository port**）。
 *
 * 为什么是端口：P4/P5 尚未引入数据库（迁移计划见 `db/migrations/`），但业务切片不能因此
 * 把「进程内 Map」当成生产存储。这里把持久化依赖显式化：
 * - 默认绑定内存基线 `InMemoryGroupRepository`，它如实声明 `persistent = false`、
 *   `productionReady = false`，并在 `NODE_ENV=production` 下拒绝构造；
 * - 引入 PostgreSQL（或其他实现）时，只需把 DI 令牌 `GROUP_REPOSITORY`
 *   换绑到同一接口的实现，service/controller 无需改动，因此这一迁移步可整步回退。
 *
 * 边界事实：
 * - 仓储只负责存储与「按服务端已解析的可见范围取数」，**不做授权判定**；
 *   资源级判定属于 `AuthorizationGuard`（其下是 `RUOYI_AUTHZ_ADAPTER` 端口）；
 * - 仓储不产生归属信息：`leaderUserId` 由 service 从服务端会话主体写入，永不来自请求体；
 * - 仓储返回的每条记录都必须能被读取契约校验（`groups.contract.ts`）；service 还会
 *   复核「返回的小组必须是开放状态且落在授权范围内」，违反者按服务端缺陷判为 500。
 *
 * 本切片只承载小组的最小垂直切片：**创建小组**与**分页浏览可见的开放小组**。
 * 小组详情（`GET /groups/{groupId}`）、修改/停用（`PATCH`，含状态机）、成员列表、
 * 招募要求的编辑、排序/过滤、幂等键与审计落库属于后续切片。
 */

/** 存储层的小组（对应 docs/P1-字段级数据字典.md 的 research_groups 字段） */
export interface ResearchGroup {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly researchDirections: readonly string[];
  readonly recruitmentRequirements: RecruitmentRequirementsInput;
  /**
   * 负责人：服务端会话主体写入，非客户端输入。
   * 该字段在数据字典中标注为「内部」敏感级别，因此**不进入对外视图**（见 groups.contract.ts）。
   */
  readonly leaderUserId: string;
  /** 小组状态：创建时由服务端写入 `open`，客户端提交同名字段一律 400 */
  readonly status: GroupStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 存储后端能力声明：让上层与运维能机器判定当前后端是否持久化 */
export interface GroupRepositoryCapabilities {
  readonly backend: string;
  /** 是否跨进程/重启保留（内存基线必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

/**
 * PostgreSQL 后端标识（能力声明 `backend` 的规范取值）。
 *
 * 数据库 adapter、边界守卫与运维摘要共用同一字面量，避免同一后端出现
 * `postgres` / `postgres-draft` / `postgresql` 多个拼写而无法机器比对。
 */
export const GROUP_REPOSITORY_BACKEND_POSTGRES = 'postgres';

/**
 * 可见性查询：**由 service 在授权判定之后构造**，只承载服务端已经解析/判定过的范围。
 *
 * 它刻意不是「客户端过滤器」：`includeAllOpenGroups` 来自集合级判定
 * （SELF / SYSTEM / GLOBAL 之一通过），`visibleGroupIds` 来自对服务端会话里
 * `groupIds` / `assignedResourceIds` 的**逐条**资源级判定（GROUP / ASSIGNED）。
 * 请求体、查询串与自定义头里的 `groupId` / `scope` / `roles` 永不进入本结构。
 *
 * **存储 ID 域约束**（数据库实现的前提）：`research_groups.id` 是 `uuid`，因此绑定到数据库实现
 * 时，进入本结构的资源标识必须落在存储 ID 域内（UUID）。会话解析器当前只保证
 * `groupIds` / `assignedResourceIds` 是「安全 ID」而非 UUID，所以迁移到数据库实现的那一片切片
 * 必须同时把会话主体的资源标识收敛为 UUID（否则 adapter 会 fail-closed 而不是退化成
 * 放弃类型约束的 `uuid[]` 比较）。
 */
export interface GroupVisibilityQuery {
  /** 集合级可见：能看到全部**开放**小组 */
  readonly includeAllOpenGroups: boolean;
  /** 资源级可见：逐条判定通过的小组 ID（服务端解析值） */
  readonly visibleGroupIds: readonly string[];
}

/**
 * 取数窗口：由 service 用共享 `paginationSchema` 规范化后换算成 `offset`/`limit` 传入。
 *
 * 端口只做**窗口下推**（数据库实现可直接 `LIMIT/OFFSET`），不理解分页语义、
 * 不校验上下界、也不做授权判定。窗口是对「已经判定可见的集合」的切片，因此**永远不会**
 * 扩大可见范围：`offset` 再大也只可能返回空数组。
 */
export interface GroupListWindow {
  /** 从 0 开始；`(page - 1) * pageSize` */
  readonly offset: number;
  /** 单页最大条数；共享 `paginationSchema` 已限制上限（`MAX_PAGE_SIZE`） */
  readonly limit: number;
}

/**
 * ## 为什么是 Promise
 * PostgreSQL 实现必须等待数据库往返。内存基线按同一异步契约返回 Promise，因此
 * 「无数据库」与「已配置数据库且执行器就绪」两条运行路径共用同一个端口与同一份 service，
 * 换绑/回退只是把 `GROUP_REPOSITORY` 指向不同实现（见 `groups.module.ts` 的
 * `createGroupRepository`），service 与 controller 不需要再改一次。
 *
 * 本切片之前该端口是同步的（`列表/计数` 同步返回），与之并存的是一份独立的
 * `AsyncGroupRepository` 契约，用来在「不引入驱动、不接数据库」的前提下离线验证 SQL 与映射。
 * 现在数据库 adapter 要接入运行时，两条契约合并为一条：异步端口就是唯一端口，
 * `AsyncGroupRepository` 保留为别名以免破坏既有引用。
 *
 * 实现者（`groups.in-memory-repository.ts` 与 `groups.postgres-repository.ts`）必须满足
 * **完全相同**的语义：
 * 1. 只存取未软删除且开放（`isGroupApplicable`）的小组，再按 `GroupVisibilityQuery` 过滤，
 *    最后按 `GroupListWindow` 切片；列表与计数必须共用同一套可见性语义；
 * 2. 不做授权判定：`visibleGroupIds` 只来自服务端已判定的产物，绝不来自请求体/查询串；
 * 3. 不生成归属信息：`leaderUserId` / `status` 由 service 从服务端会话主体与常量写入；
 * 4. 每条返回记录都必须能被 `groups.contract.ts` 的读取契约校验（违者按服务端缺陷抛错，
 *    不得把未知枚举、越界字段或范围外记录交给上层）；
 * 5. 存储 ID 域：数据库实现的 `visibleGroupIds` 会与 `uuid` 主键比较，因此非 UUID 的资源标识
 *    在进入 SQL 之前 fail-closed（见 `GroupVisibilityQuery` 的说明与
 *    `assertPostgresGroupVisibilityQuery`）。会话主体的 `groupIds` / `assignedResourceIds`
 *    收敛为 UUID 属于后续切片；在那之前，数据库绑定对「资源级可见」的主体是 fail-closed 的，
 *    这也是 PostgreSQL 实现的能力声明里 `productionReady` 恒为 false 的原因之一。
 */
export interface GroupRepository {
  readonly capabilities: GroupRepositoryCapabilities;
  /** 写入一条已由 service 校验并补齐负责人/状态的记录 */
  create(group: ResearchGroup): Promise<ResearchGroup>;
  /**
   * 返回对调用方可见的小组（**分页窗口内**）：
   * 1. 只返回**开放状态**的小组（复用共享 `isGroupApplicable`：暂停/关闭的小组不在此端点展示）；
   * 2. 再按 `includeAllOpenGroups` / `visibleGroupIds` 过滤；
   * 3. 最后按 `window` 切片。
   * 返回顺序为创建顺序（内存基线保留插入顺序，便于测试与逐页稳定的后续实现）。
   *
   * 仓储不做授权判定：调用方必须先经 `AuthorizationGuard` 授权，并把判定产物传进来。
   */
  listVisibleGroups(
    query: GroupVisibilityQuery,
    window: GroupListWindow,
  ): Promise<readonly ResearchGroup[]>;
  /**
   * 返回可见小组总数（不受窗口影响），供 service 计算 `meta.total` / `meta.totalPages`。
   * 与 `listVisibleGroups` 必须使用**同一套**可见性语义，否则分页元数据会与实际数据不一致。
   */
  countVisibleGroups(query: GroupVisibilityQuery): Promise<number>;
}

/** 兼容别名：合并为异步端口后，数据库 adapter 的既有引用保持不变 */
export type AsyncGroupRepository = GroupRepository;

/** DI 令牌：小组仓储 */
export const GROUP_REPOSITORY = Symbol('GROUP_REPOSITORY');
