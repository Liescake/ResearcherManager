import type { AchievementType, ReviewStatus } from '@rm/shared';

/**
 * 成果持久化端口（**显式可替换 repository port**）。
 *
 * 为什么是端口：业务切片不能把「进程内 Map」当成生产存储。这里把持久化依赖显式化：
 * - 未配置数据库时绑定内存基线 `InMemoryAchievementRepository`，它如实声明 `persistent = false`、
 *   `productionReady = false`，并在 `NODE_ENV=production` 下拒绝构造；
 * - 已配置 `DATABASE_URL` 时把 DI 令牌 `ACHIEVEMENT_REPOSITORY` 换绑到 PostgreSQL 实现
 *   （见 `achievements.postgres-repository.ts`），service/controller 无需改动，
 *   因此这一迁移步可整步回退。
 *
 * 边界事实：
 * - 仓储只负责存储与按服务端主体取数，**不做授权判定**；资源级判定属于 `AuthorizationGuard`；
 * - 仓储不产生归属信息：`userId` 由 service 从服务端会话主体写入，永不来自请求体；
 * - 仓储返回的每条记录都必须能被读取契约校验（`achievements.contract.ts`），且
 *   `listByUserId` 必须**只返回该主体的记录**：service 会对返回记录的归属做一致性复核，
 *   违反者按服务端缺陷判为 500（不允许作为正常输出发给调用方）。
 *
 * ## 为什么端口整体是异步的（本切片完成的跨模块契约变更）
 * 会话主体解析、画像与本人统计三个切片都已收敛为「端口返回 Promise、内存基线与 PostgreSQL
 * 实现实现同一契约」的分流口径（见 `profiles.module.ts` / `statistics.module.ts` 的换绑点说明）。
 * 本切片把成果端口也收敛到同一口径后，`create` / `listByUserId` 的**唯一**调用方 service
 * 必须 `await`，因此「未认证就碰仓储」「先读后判」这类顺序错误不再可能被同步返回悄悄掩盖；
 * 同时「内存基线 ⇄ PostgreSQL」的替换只需要改一个 factory provider 的绑定。
 *
 * 本切片只承载成果的学生自服务部分：**创建本人成果**与**本人成果列表**。
 * 单条读取、更新（`achievement:self:update`）、审核（`achievement:review`）、
 * 附件实体校验、幂等键与审计落库属于后续切片。
 */

/** 存储层的成果（对应 docs/P1-字段级数据字典.md 的 achievements 字段） */
export interface Achievement {
  readonly id: string;
  /** 归属主体：服务端会话解析值，非客户端输入 */
  readonly userId: string;
  /** 成果类型：请求体字段，但取值必须在共享枚举闭集内（未知枚举 400） */
  readonly type: AchievementType;
  readonly title: string;
  readonly awardLevel?: string;
  readonly description?: string;
  /** 成果取得时间：服务端由请求值规范化为 ISO 8601 字符串 */
  readonly achievedAt?: string;
  /** 佐证材料文件 ID（本切片只校验 UUID 形状，不校验文件是否存在） */
  readonly evidenceFileId?: string;
  /** 审核态：只由服务端写入（本切片入口恒为 pending），客户端提交同名字段一律 400 */
  readonly reviewStatus: ReviewStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 存储后端能力声明：让上层与运维能机器判定当前后端是否持久化 */
export interface AchievementRepositoryCapabilities {
  readonly backend: string;
  /** 是否跨进程/重启保留（内存基线必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

/**
 * 成果仓储端口（**唯一**契约，内存基线与 PostgreSQL 实现都必须满足）。
 *
 * 两个实现必须满足**完全相同**的语义，包括「同 ID 重复写入视为服务端缺陷、不得静默覆盖」。
 * PostgreSQL 实现（`achievements.postgres-repository.ts`）额外守住四条边界：
 * 1. **归属只来自服务端**：`userId` 由 service 从服务端会话主体写入，adapter 不生成、不覆盖
 *    归属，并复核「返回记录的归属 === 请求取数 / 写入的归属」，不一致即判服务端缺陷；
 * 2. **存储 ID 域**：`userId` 必须落在 `ACHIEVEMENT_REPOSITORY_STORAGE_ID_DOMAIN`（UUID，
 *    规范小写形）内，否则 fail-closed（见下）；
 * 3. **按服务端主体隔离**（数据库形状上的**归属隔离强化**）：`listByUserId` 必须把归属下推进
 *    SQL（`WHERE user_id = $1`），让「他人记录」根本不出库，并在返回行上**逐条**复核归属
 *    （纵深防御）；本切片没有资源级取数方法，因此不存在「只按资源 ID 命中就返回」的路径；
 * 4. **每条返回记录都必须能被读取契约校验**：未知列、未知枚举、非法形状一律按服务端缺陷抛错，
 *    不得把未知状态或半成品记录交给上层；归属与个人级内容（标题/说明/佐证文件 ID）**绝不**
 *    进入错误消息与日志。
 *
 * 方法集刻意只有两个（`create` + `listByUserId`，没有单条读取、没有分页窗口）：
 * 单条读取（`achievement:self:read` 的资源级取数）与列表分页/排序都属于后续切片，一旦进入本
 * 契约，就必须与 service / controller / 两个实现一起改（例如单条读取必须**同时**接收服务端
 * 主体，才能把归属下推进 SQL），因此这里不预置「用不上的参数」。同名 spec 有边界断言，
 * 端口出现方法集漂移时会失败。
 */
export interface AchievementRepository {
  readonly capabilities: AchievementRepositoryCapabilities;
  /** 写入一条已由 service 校验并补齐归属/审核态的记录；同 ID 冲突必须显式抛错，不得静默覆盖 */
  create(achievement: Achievement): Promise<Achievement>;
  /**
   * 只按归属主体取数：调用方必须是已授权访问该主体资源的服务端代码。
   * 返回顺序为创建顺序（内存基线保留插入顺序；PostgreSQL 实现按 `created_at ASC, id ASC`
   * 给出同样的稳定全序），便于测试与逐页稳定的后续实现。
   */
  listByUserId(userId: string): Promise<readonly Achievement[]>;
}

/**
 * PostgreSQL 后端标识（能力声明 `backend` 的规范取值）。
 *
 * 数据库 adapter、边界守卫与运维摘要共用同一字面量，避免同一后端出现
 * `postgres` / `postgres-draft` / `postgresql` 多个拼写而无法机器比对。
 */
export const ACHIEVEMENT_REPOSITORY_BACKEND_POSTGRES = 'postgres';

/**
 * **存储 ID 域约束**：`achievements.user_id → users.id`，在存储侧是 `uuid`（字段类别见
 * docs/P1-字段级数据字典.md）。
 *
 * 会话主体当前的 `userId` 只保证是「安全 ID」（例如 `u-student-1`），**不是** UUID。
 * 因此绑定到数据库实现的那一片切片必须同时把会话主体标识收敛为 UUID（规范小写形，
 * 以便归属复核保持逐字节精确比较），否则数据库 adapter 会按本约束 **fail-closed 拒绝**，
 * 而不是退化成「放弃类型约束的字符串比较」。
 */
export const ACHIEVEMENT_REPOSITORY_STORAGE_ID_DOMAIN = 'uuid';

/** DI 令牌：成果仓储 */
export const ACHIEVEMENT_REPOSITORY = Symbol('ACHIEVEMENT_REPOSITORY');
