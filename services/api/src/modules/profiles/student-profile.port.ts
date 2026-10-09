import type { AvailablePeriod, Grade, ProgrammingLevel } from '@rm/shared';

/**
 * 学生画像持久化端口（**显式可替换 repository port**）。
 *
 * 为什么是端口：业务切片不能把「进程内 Map」当成生产存储。这里把持久化依赖显式化：
 * - 未配置数据库时绑定内存基线 `InMemoryProfileRepository`，它如实声明 `persistent = false`、
 *   `productionReady = false`，并在 `NODE_ENV=production` 下拒绝构造；
 * - 配置了 `DATABASE_URL` 时把 DI 令牌 `PROFILE_REPOSITORY` 换绑到 PostgreSQL 实现
 *   （`student-profile.postgres-repository.ts` 的 `createLazyPostgresStudentProfileRepository`），
 *   由 `profiles.module.ts` 的 `createProfileRepository` 按配置分流；service/controller 只依赖本
 *   接口，因此这一迁移步可整步回退。
 *
 * 边界事实：
 * - 仓储只负责存储与按 `userId` 取数，**不做授权判定**；资源级判定属于 `AuthorizationGuard`；
 * - 仓储不产生归属信息：`userId` 由 service 从服务端主体写入，永不来自请求体；
 * - 仓储返回的每条记录都必须能被读取契约校验（`student-profile.contract.ts`），
 *   违反者由 service 判为服务端缺陷（500），不允许作为正常输出发给调用方；
 * - 本切片只覆盖「读取本人画像」与「更新本人画像」；画像**创建**（首次提交）与更正申请
 *   属于后续切片，因此端口只提供 `findByUserId` / `save`，不提供跨主体枚举；
 * - 端口**不做对外投影**：高敏感字段（学号、联系方式）与隐私同意快照的对外裁剪属于
 *   `student-profile.contract.ts` 的 `toStudentProfileView`，仓储只按内部存储契约承载它们；
 * - **异步契约**：读写都返回 Promise。内存基线与 PostgreSQL adapter 同语义，因此两者可以
 *   互为替换；同步端口与本 adapter 混用会掩盖「数据库调用被当成即时返回」的错误，故不保留。
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
  findByUserId(userId: string): Promise<StudentProfile | undefined>;
  /** 覆盖写入一条已由 service 校验、补齐归属与时间戳的画像，返回写入后的副本 */
  save(profile: StudentProfile): Promise<StudentProfile>;
}

/**
 * PostgreSQL 后端标识（能力声明 `backend` 的规范取值）。
 *
 * 数据库 adapter、边界守卫与运维摘要共用同一字面量，避免同一后端出现
 * `postgres` / `postgres-draft` / `postgresql` 多个拼写而无法机器比对。
 */
export const PROFILE_REPOSITORY_BACKEND_POSTGRES = 'postgres';

/**
 * **存储 ID 域约束**：画像按归属主体取数，而存储侧的归属主键是 `uuid`
 * （`student_profiles.user_id → users.id`，字段类别见 docs/P1-字段级数据字典.md）。
 *
 * 会话主体当前的 `userId` 只保证是「安全 ID」（例如 `u-student-1`），**不是** UUID。
 * 因此绑定到数据库实现的那一片切片必须同时把会话主体标识收敛为 UUID（规范小写形，
 * 以便归属复核保持逐字节精确比较），否则数据库 adapter 会按本约束 **fail-closed 拒绝**，
 * 而不是退化成「放弃类型约束的字符串比较」。
 */
export const PROFILE_REPOSITORY_STORAGE_ID_DOMAIN = 'uuid';

/**
 * **异步仓储契约的历史名称（等价别名）**。
 *
 * 引入 PostgreSQL adapter 时（驱动已评估并引入、迁移与集成验证就绪）需要 Promise 语义，于是
 * `ProfileRepository` 本身改成了异步契约。此别名保留给既有引用（adapter 与离线 spec 用它标注
 * 「我实现的是异步端口」），语义与 `ProfileRepository` **完全一致**：它不再是「另一份契约」，
 * 因此不存在「同步绑定 + 异步实现混用」这种状态。
 */
export type AsyncProfileRepository = ProfileRepository;

/** DI 令牌：学生画像仓储 */
export const PROFILE_REPOSITORY = Symbol('PROFILE_REPOSITORY');
