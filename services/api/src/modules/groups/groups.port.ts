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
 * 本切片只承载小组的最小垂直切片：**创建小组**与**浏览可见的开放小组**。
 * 小组详情（`GET /groups/{groupId}`）、修改/停用（`PATCH`，含状态机）、成员列表、
 * 招募要求的编辑、分页/排序/过滤、幂等键与审计落库属于后续切片。
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
 * 可见性查询：**由 service 在授权判定之后构造**，只承载服务端已经解析/判定过的范围。
 *
 * 它刻意不是「客户端过滤器」：`includeAllOpenGroups` 来自集合级判定
 * （SELF / SYSTEM / GLOBAL 之一通过），`visibleGroupIds` 来自对服务端会话里
 * `groupIds` / `assignedResourceIds` 的**逐条**资源级判定（GROUP / ASSIGNED）。
 * 请求体、查询串与自定义头里的 `groupId` / `scope` / `roles` 永不进入本结构。
 */
export interface GroupVisibilityQuery {
  /** 集合级可见：能看到全部**开放**小组 */
  readonly includeAllOpenGroups: boolean;
  /** 资源级可见：逐条判定通过的小组 ID（服务端解析值） */
  readonly visibleGroupIds: readonly string[];
}

export interface GroupRepository {
  readonly capabilities: GroupRepositoryCapabilities;
  /** 写入一条已由 service 校验并补齐负责人/状态的记录 */
  create(group: ResearchGroup): ResearchGroup;
  /**
   * 返回对调用方可见的小组：
   * 1. 只返回**开放状态**的小组（复用共享 `isGroupApplicable`：暂停/关闭的小组不在此端点展示）；
   * 2. 再按 `includeAllOpenGroups` / `visibleGroupIds` 过滤。
   * 返回顺序为创建顺序（内存基线保留插入顺序，便于测试与逐页稳定的后续实现）。
   *
   * 仓储不做授权判定：调用方必须先经 `AuthorizationGuard` 授权，并把判定产物传进来。
   */
  listVisibleGroups(query: GroupVisibilityQuery): readonly ResearchGroup[];
}

/** DI 令牌：小组仓储 */
export const GROUP_REPOSITORY = Symbol('GROUP_REPOSITORY');
