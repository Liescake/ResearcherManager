import type { AvailablePeriod, Grade, ProgrammingLevel } from '@rm/shared';

/**
 * 学生画像持久化端口（**显式可替换 repository port**）。
 *
 * 为什么是端口：P3/P4 尚未引入数据库（迁移计划见 `db/migrations/`），但业务切片不能因此
 * 把「进程内 Map」当成生产存储。这里把持久化依赖显式化：
 * - 默认绑定内存基线 `InMemoryProfileRepository`，它如实声明 `persistent = false`、
 *   `productionReady = false`，并在 `NODE_ENV=production` 下拒绝构造；
 * - 引入 PostgreSQL（或其他实现）时，只需把 DI 令牌 `PROFILE_REPOSITORY` 换绑到同一接口的
 *   实现，service/controller 无需改动，因此这一迁移步可整步回退。
 *
 * 边界事实：
 * - 仓储只负责存储与按 `userId` 取数，**不做授权判定**；资源级判定属于 `AuthorizationGuard`；
 * - 仓储不产生归属信息：`userId` 由 service 从服务端主体写入，永不来自请求体；
 * - 仓储返回的每条记录都必须能被读取契约校验（`student-profile.contract.ts`），
 *   违反者由 service 判为服务端缺陷（500），不允许作为正常输出发给调用方；
 * - 本切片只覆盖「读取本人画像」与「更新本人画像」；画像**创建**（首次提交）与更正申请
 *   属于后续切片，因此端口只提供 `findByUserId` / `save`，不提供跨主体枚举。
 */

/** 空余时间（`availableTime`）：与共享 `availableTimeSchema` 的输出结构一致 */
export interface StoredAvailableTime {
  readonly weeklyHours: number;
  readonly periods: readonly AvailablePeriod[];
  readonly note?: string;
}

/**
 * 隐私同意快照。
 * `agreed` 是提交时的门禁条件（`z.literal(true)`），不作为状态存储；
 * `consentedAt` 由**服务端**写入（ISO 8601），不接受客户端时间。
 */
export interface StoredPrivacyConsent {
  readonly policyVersion: string;
  readonly consentedAt: string;
}

/**
 * 存储层的学生画像（对应 docs/P1-字段级数据字典.md 的 student_profiles 字段）。
 * `studentNo` 与 `phone` 是**高敏感**字段：只写入、不进入对外视图（`StudentProfileView`）。
 */
export interface StudentProfile {
  readonly userId: string;
  readonly name: string;
  /** 高敏感：不进入对外视图 */
  readonly studentNo: string;
  readonly college: string;
  readonly major: string;
  readonly grade: Grade;
  /** 高敏感：不进入对外视图 */
  readonly phone: string;
  readonly skills: readonly string[];
  readonly programmingLevel: ProgrammingLevel;
  readonly researchExperience?: string;
  readonly competitionExperience?: string;
  readonly availableTime: StoredAvailableTime;
  readonly researchInterests: readonly string[];
  readonly strengths?: string;
  readonly intendedFields: readonly string[];
  readonly privacyConsent: StoredPrivacyConsent;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 存储后端能力声明：让上层与运维能机器判定当前后端是否持久化 */
export interface ProfileRepositoryCapabilities {
  readonly backend: string;
  /** 是否跨进程/重启保留（内存基线必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

export interface ProfileRepository {
  readonly capabilities: ProfileRepositoryCapabilities;
  /**
   * 按归属主体取数：调用方必须是已授权访问该主体资源的服务端代码。
   * 返回 `undefined` 表示该主体尚无画像（本切片下由 service 转 404）。
   */
  findByUserId(userId: string): StudentProfile | undefined;
  /** 覆盖写入一条已由 service 校验、补齐归属与时间戳的画像，返回写入后的副本 */
  save(profile: StudentProfile): StudentProfile;
}

/** DI 令牌：学生画像仓储 */
export const PROFILE_REPOSITORY = Symbol('PROFILE_REPOSITORY');
