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
 *   违反者由 service 判为服务端缺陷（500），不允许作为正常输出发给调用方；
 * - 数据库实现按 `AsyncApplicationRepository`（Promise 版，语义与内存基线一致）单独验证，
 *   **不与**当前同步绑定混用，也不得在同步端口绑定期间出现在任何模块的 provider 列表里。
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

/**
 * PostgreSQL 后端标识（能力声明 `backend` 的规范取值）。
 *
 * 数据库 adapter、边界守卫与运维摘要共用同一字面量，避免同一后端出现
 * `postgres` / `postgres-draft` / `postgresql` 多个拼写而无法机器比对。
 */
export const APPLICATION_REPOSITORY_BACKEND_POSTGRES = 'postgres';

/**
 * **存储 ID 域约束**：`join_applications.id / user_id / group_id → users.id / research_groups.id`，
 * 在存储侧是 `uuid`（字段类别见 docs/P1-字段级数据字典.md）。
 *
 * 会话主体当前的 `userId` 只保证是「安全 ID」（例如 `u-student-1`），**不是** UUID；
 * `groupId` 虽经请求体 `uuidSchema` 校验，但不要求规范小写形。因此绑定到数据库实现的那一片
 * 切片必须把这些标识收敛为「规范小写形 UUID」（归属/范围复核是**逐字节精确比较**，而 UUID 文本
 * 在数据库侧大小写不敏感：静默小写化会把「归属被改写」与「大小写差异」混成同一种静默修正）。
 * 在收敛完成之前，数据库 adapter 会按本约束 **fail-closed 拒绝**，而不是退化成「放弃类型约束的
 * 字符串比较」。
 */
export const APPLICATION_REPOSITORY_STORAGE_ID_DOMAIN = 'uuid';

/**
 * **异步仓储契约**（数据库形状的 repository 端口，与 `ApplicationRepository` 同语义）。
 *
 * 为什么与 `ApplicationRepository` 并存、而不是把它直接改成异步：后者是当前运行时绑定
 * （内存基线，同步返回）。把它改成 Promise 是**跨模块契约变更**（service / controller 与既有
 * spec 必须一起改），只能与「引入经评估的数据库驱动 + 集成验证」在同一片切片完成。在那之前，
 * 数据库 adapter 按本契约实现并单独验证，运行时绑定一动不动，因此「切换到数据库」与
 * 「回退到内存基线」都仍然是可以整步执行 / 整步回退的操作。
 *
 * 方法集与同步端口逐字对应（`create` / `findById` / `listByUserId` / `listByUserAndGroup` /
 * `save`，没有分页窗口），但有两处**刻意的签名差异**——两处都是**归属隔离强化**，
 * 不是语义漂移：
 * 1. `findById` 增加服务端主体参数 `ownerUserId`：数据库实现里不存在「只按资源 ID 命中就返回」
 *    的合法路径，归属必须**下推进 SQL**（`WHERE id = $1 AND user_id = $2`）。若保持 `findById(id)`
 *    的签名，他人的申请会先出库、再指望上层复核——那是把归属隔离降级为「上层记得复核」；
 * 2. `save` 不额外接收主体：待写记录由 service 从**存储记录**构造（归属已在记录里），adapter 把
 *    `id + user_id` 一起下推进 `WHERE`，因此「拿他人记录的 ID 改写他人数据」在存储层被关闭。
 *
 * 实现者（当前只有 `applications.postgres-repository.ts`）必须满足与内存基线**完全相同**的语义
 * （含「同 ID 重复写入视为服务端缺陷、不得静默覆盖」与「记录不存在时拒绝写入」），并额外守住五条
 * 边界：
 * 1. **归属只来自服务端**：`userId` 由 service 从服务端会话主体写入，adapter 不生成、不覆盖归属，
 *    并逐条复核「返回记录的归属 === 请求主体 / 请求记录的归属」，不一致即判服务端缺陷；
 * 2. **存储 ID 域**：主体、记录内的 `userId` / `groupId` / `reviewedByUserId` 与资源标识必须落在
 *    `APPLICATION_REPOSITORY_STORAGE_ID_DOMAIN`（规范小写形 UUID）内，否则 fail-closed（见上）；
 * 3. **按服务端主体隔离**：`listByUserId` / `listByUserAndGroup` / `findById` 都必须把归属下推进
 *    SQL，让「他人记录」根本不出库，并在返回行上**逐条**复核归属（纵深防御）；
 * 4. **状态闭集与状态转移 fail-closed**：`status` 只接受共享状态机的闭集取值；写回（`save`）
 *    必须把「本次转移是否合法」下推进为**条件写入**（谓词由 `APPLICATION_STATUS_TRANSITIONS`
 *    的逆映射派生），非法转移**不产生任何写入**并显式抛错；未知状态值一律按服务端缺陷拒绝，
 *    不得当作合法值返回；
 * 5. **每条返回记录都必须能被读取契约校验**：未知列、未知枚举、非法形状一律按服务端缺陷抛错；
 *    归属、个人级内容（备注）与审核意见**绝不**进入错误消息与日志。
 *
 * 迁移到数据库实现的同一切片还必须：把 service 的取数/写回改为异步、把会话主体与请求体中的 UUID
 * 字段收敛为规范小写形，并把 `save` 的非法转移拒绝映射为 409 `STATE_TRANSITION_INVALID`
 * （并发重复撤回是客户端可见冲突，不是服务端缺陷）——三件事都已登记在该 adapter 的验证清单里。
 */
export interface AsyncApplicationRepository {
  readonly capabilities: ApplicationRepositoryCapabilities;
  /** 写入一条已由 service 校验并补齐归属/类型/初始状态的记录；同 ID 冲突必须显式抛错，不得静默覆盖 */
  create(application: Application): Promise<Application>;
  /**
   * 单条读取：**必须**同时给出服务端主体，归属下推进 SQL（他人申请不出库）。
   * 返回 `undefined` 表示「该主体名下不存在此申请」。
   */
  findById(applicationId: string, ownerUserId: string): Promise<Application | undefined>;
  /** 只按归属主体取数：调用方必须是已授权访问该主体资源的服务端代码 */
  listByUserId(userId: string): Promise<readonly Application[]>;
  /**
   * 按（归属主体, 目标小组）取数：供 service 判定「同一用户同一小组只能有一个未终态的入组申请」。
   * 仓储**不理解终态语义**（那是共享状态机的职责），只按字段过滤、不做唯一性判定。
   */
  listByUserAndGroup(userId: string, groupId: string): Promise<readonly Application[]>;
  /**
   * 写回一条已由 service 校验、且已完成**合法状态转移**的完整记录。
   * 记录不存在（或归属不符）时按服务端缺陷抛错，不得静默插入；非法状态转移必须 fail-closed
   * 且不产生任何写入。
   */
  save(application: Application): Promise<Application>;
}

/** DI 令牌：入组申请仓储 */
export const APPLICATION_REPOSITORY = Symbol('APPLICATION_REPOSITORY');
