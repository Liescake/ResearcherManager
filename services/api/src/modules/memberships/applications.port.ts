import type { ApplicationKind, ApplicationStatus } from '@rm/shared';

/**
 * 入组申请持久化端口（**显式可替换 repository port**）。
 *
 * 为什么是端口：P4/P5 尚未引入数据库（迁移计划见 `db/migrations/`），但业务切片不能因此
 * 把「进程内 Map」当成生产存储。这里把持久化依赖显式化：
 * - 默认绑定内存基线 `InMemoryApplicationRepository`，它如实声明 `persistent = false`、
 *   `productionReady = false`，并在 `NODE_ENV=production` 下拒绝构造；
 * - 引入 PostgreSQL（或其他实现）时，只需把 DI 令牌 `APPLICATION_REPOSITORY` 换绑到同一接口的
 *   实现，service/controller 无需改动，因此这一迁移步可整步回退。
 *
 * 边界事实：
 * - 仓储只负责存储与按服务端解析的键取数，**不做授权判定、不做状态转移**；
 *   资源级判定属于 `AuthorizationGuard`，状态合法性属于 `packages/shared` 的申请状态机；
 * - 仓储不产生归属信息：`userId` 由 service 从服务端会话主体写入，永不来自请求体；
 * - `groupId` 是**申请目标小组**（业务字段，docs/P2-API契约基线.md「核心请求约束」要求
 *   `POST /join-applications` 请求包含 `groupId`），它**不是**授权范围：授权判定的 `scope`
 *   恒为服务端常量 `SELF`，客户端提交的 `scope`/`dataScope`/`groupIds` 由输入闭集直接拒绝
 *   （见 `applications.contract.ts` 与 `applications.service.ts`）；
 * - 仓储返回的每条记录都必须能被读取契约校验（`applications.contract.ts`），
 *   违反者由 service 判为服务端缺陷（500），不允许作为正常输出发给调用方。
 *
 * 本切片只承载**入组申请**（`kind = join`）的创建、本人列表与本人撤回；
 * 退组申请、审核、成员关系联动、幂等键与审计落库属于后续切片。
 */

/** 存储层的入组申请（对应 docs/P1-字段级数据字典.md 的 join_applications 字段） */
export interface Application {
  readonly id: string;
  /** 归属主体（申请人）：服务端会话解析值，非客户端输入 */
  readonly userId: string;
  /** 申请目标小组：业务字段，不作为授权范围 */
  readonly groupId: string;
  /** 申请类型：服务端常量（本切片恒为 join），客户端提交同名字段一律 400 */
  readonly kind: ApplicationKind;
  readonly note?: string;
  /** 申请状态：只由服务端状态机推进，客户端提交同名字段一律 400 */
  readonly status: ApplicationStatus;
  /** 审核人（内部身份字段，不进入对外视图） */
  readonly reviewedByUserId?: string;
  /** 审核意见（内部记录，不进入对外视图） */
  readonly reviewComment?: string;
  /** 审核时间（内部记录，不进入对外视图） */
  readonly reviewedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 存储后端能力声明：让上层与运维能机器判定当前后端是否持久化 */
export interface ApplicationRepositoryCapabilities {
  readonly backend: string;
  /** 是否跨进程/重启保留（内存基线必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

export interface ApplicationRepository {
  readonly capabilities: ApplicationRepositoryCapabilities;
  /** 写入一条已由 service 校验并补齐归属/类型/初始状态的记录 */
  create(application: Application): Application;
  findById(applicationId: string): Application | undefined;
  /**
   * 只按归属主体取数：调用方必须是已授权访问该主体资源的服务端代码。
   * 返回顺序为创建顺序（内存基线保留插入顺序，便于测试与逐页稳定的后续实现）。
   */
  listByUserId(userId: string): readonly Application[];
  /**
   * 按（归属主体, 目标小组）取数：供 service 判定数据约束
   * 「同一用户同一小组只能有一个未终态的入组申请」（docs/P2-权限目录与状态机.md §3）。
   * 仓储**不理解终态语义**（那是共享状态机的职责），只按字段过滤。
   */
  listByUserAndGroup(userId: string, groupId: string): readonly Application[];
  /**
   * 写回一条已由 service 校验、且已完成合法状态转移的完整记录。
   * 记录不存在时按服务端缺陷抛错（不得静默插入，避免绕过创建路径写数据）。
   */
  save(application: Application): Application;
}

/** DI 令牌：入组申请仓储 */
export const APPLICATION_REPOSITORY = Symbol('APPLICATION_REPOSITORY');
