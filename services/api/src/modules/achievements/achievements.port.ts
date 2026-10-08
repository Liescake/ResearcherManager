import type { AchievementType, ReviewStatus } from '@rm/shared';

/**
 * 成果持久化端口（**显式可替换 repository port**）。
 *
 * 为什么是端口：P4/P5 尚未引入数据库（迁移计划见 `db/migrations/`），但业务切片不能因此
 * 把「进程内 Map」当成生产存储。这里把持久化依赖显式化：
 * - 默认绑定内存基线 `InMemoryAchievementRepository`，它如实声明 `persistent = false`、
 *   `productionReady = false`，并在 `NODE_ENV=production` 下拒绝构造；
 * - 引入 PostgreSQL（或其他实现）时，只需把 DI 令牌 `ACHIEVEMENT_REPOSITORY`
 *   换绑到同一接口的实现，service/controller 无需改动，因此这一迁移步可整步回退。
 *
 * 边界事实：
 * - 仓储只负责存储与按服务端主体取数，**不做授权判定**；资源级判定属于 `AuthorizationGuard`；
 * - 仓储不产生归属信息：`userId` 由 service 从服务端会话主体写入，永不来自请求体；
 * - 仓储返回的每条记录都必须能被读取契约校验（`achievements.contract.ts`），且
 *   `listByUserId` 必须**只返回该主体的记录**：service 会对返回记录的归属做一致性复核，
 *   违反者按服务端缺陷判为 500（不允许作为正常输出发给调用方）；
 * - 数据库实现按 `AsyncAchievementRepository`（Promise 版，语义与内存基线一致）单独验证，
 *   **不与**当前同步绑定混用，也不得在同步端口绑定期间出现在任何模块的 provider 列表里。
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

export interface AchievementRepository {
  readonly capabilities: AchievementRepositoryCapabilities;
  /** 写入一条已由 service 校验并补齐归属/审核态的记录 */
  create(achievement: Achievement): Achievement;
  /**
   * 只按归属主体取数：调用方必须是已授权访问该主体资源的服务端代码。
   * 返回顺序为创建顺序（内存基线保留插入顺序，便于测试与逐页稳定的后续实现）。
   */
  listByUserId(userId: string): readonly Achievement[];
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

/**
 * **异步仓储契约**（数据库形状的 repository 端口，与 `AchievementRepository` 同语义）。
 *
 * 为什么与 `AchievementRepository` 并存、而不是把它直接改成异步：后者是当前运行时绑定
 * （内存基线，同步返回）。把它改成 Promise 是**跨模块契约变更**（service / controller 与既有
 * spec 必须一起改），只能与「引入经评估的数据库驱动 + 集成验证」在同一片切片完成。在那之前，
 * 数据库 adapter 按本契约实现并单独验证，运行时绑定一动不动，因此「切换到数据库」与
 * 「回退到内存基线」都仍然是可以整步执行 / 整步回退的操作。
 *
 * 方法集**刻意与同步端口逐字对应**（`create` + `listByUserId`，没有单条读取、没有分页窗口）：
 * 单条读取（`achievement:self:read` 的资源级取数）与列表分页/排序都属于后续切片，一旦进入本
 * 契约，就必须与 service / controller / 内存基线一起改（例如单条读取必须**同时**接收服务端
 * 主体，才能把归属下推进 SQL），因此这里不预置「用不上的参数」。同名 spec 有边界断言，
 * 端口出现方法集漂移时会失败。
 *
 * 实现者（当前只有 `achievements.postgres-repository.ts`）必须满足与内存基线**完全相同**的
 * 语义（含「同 ID 重复写入视为服务端缺陷、不得静默覆盖」），并额外守住四条边界：
 * 1. **归属只来自服务端**：`userId` 由 service 从服务端会话主体写入，adapter 不生成、不覆盖
 *    归属，并复核「返回记录的归属 === 请求取数 / 写入的归属」，不一致即判服务端缺陷；
 * 2. **存储 ID 域**：`userId` 必须落在 `ACHIEVEMENT_REPOSITORY_STORAGE_ID_DOMAIN`（UUID，
 *    规范小写形）内，否则 fail-closed（见上）；
 * 3. **按服务端主体隔离**（数据库形状上的**归属隔离强化**）：`listByUserId` 必须把归属下推进
 *    SQL（`WHERE user_id = $1`），让「他人记录」根本不出库，并在返回行上**逐条**复核归属
 *    （纵深防御）；本切片没有资源级取数方法，因此不存在「只按资源 ID 命中就返回」的路径；
 * 4. **每条返回记录都必须能被读取契约校验**：未知列、未知枚举、非法形状一律按服务端缺陷抛错，
 *    不得把未知状态或半成品记录交给上层；归属与个人级内容（标题/说明/佐证文件 ID）**绝不**
 *    进入错误消息与日志。
 *
 * 迁移到数据库实现的同一切片还必须处理「存储 ID 域」（见上）并把 service 的取数调用改为异步。
 */
export interface AsyncAchievementRepository {
  readonly capabilities: AchievementRepositoryCapabilities;
  /** 写入一条已由 service 校验并补齐归属/审核态的记录；同 ID 冲突必须显式抛错，不得静默覆盖 */
  create(achievement: Achievement): Promise<Achievement>;
  /** 只按归属主体取数：调用方必须是已授权访问该主体资源的服务端代码 */
  listByUserId(userId: string): Promise<readonly Achievement[]>;
}

/** DI 令牌：成果仓储 */
export const ACHIEVEMENT_REPOSITORY = Symbol('ACHIEVEMENT_REPOSITORY');
