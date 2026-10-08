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
 *   违反者按服务端缺陷判为 500（不允许作为正常输出发给调用方）。
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

/** DI 令牌：成果仓储 */
export const ACHIEVEMENT_REPOSITORY = Symbol('ACHIEVEMENT_REPOSITORY');
