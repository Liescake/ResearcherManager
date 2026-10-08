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
 *   属于后续切片，因此端口只提供 `findByUserId` / `save`，不提供跨主体枚举；
 * - 端口**不做对外投影**：高敏感字段（学号、联系方式）与隐私同意快照的对外裁剪属于
 *   `student-profile.contract.ts` 的 `toStudentProfileView`，仓储只按内部存储契约承载它们；
 * - 数据库实现按 `AsyncProfileRepository`（Promise 版，语义与内存基线一致）单独验证，
 *   **不与**当前同步绑定混用，也不得在同步端口绑定期间出现在任何模块的 provider 列表里。
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
 * **异步仓储契约**（数据库形状的 repository 端口，与 `ProfileRepository` 同语义）。
 *
 * 为什么与 `ProfileRepository` 并存、而不是把它直接改成异步：`ProfileRepository` 是当前
 * 运行时绑定（内存基线，同步返回）。把它改成 Promise 是**跨模块契约变更**
 * （service / controller 与既有 spec 必须一起改），只能与「引入经评估的数据库驱动 +
 * 集成验证」在同一片切片完成。在那之前，数据库 adapter 按本契约实现并单独验证，
 * 运行时绑定一动不动，因此「切换到数据库」与「回退到内存基线」都仍然是可以整步执行/
 * 整步回退的操作。
 *
 * 实现者（当前只有 `student-profile.postgres-repository.ts`）必须满足与内存基线
 * **完全相同**的语义，并额外守住四条边界：
 * 1. **归属只来自服务端**：`userId` 由 service 从服务端会话主体写入，adapter 不生成、
 *    不覆盖归属，并复核「返回记录的归属 === 请求取数/写入的归属」，不一致即判服务端缺陷；
 * 2. **存储 ID 域**：`userId` 必须落在 `PROFILE_REPOSITORY_STORAGE_ID_DOMAIN`（UUID）内，
 *    否则 fail-closed（见上）；
 * 3. **高敏感字段只按内部存储契约流转**：`studentNo` / `phone` 是写入型高敏感字段，
 *    实现必须在存储记录上原样承载它们（不得静默丢弃），但**绝不把它们写进错误消息、日志
 *    或任何对外视图**（对外投影由 `toStudentProfileView` 负责，本端口不承担投影）；
 * 4. **每条返回记录都必须能被读取契约校验**：未知列、未知枚举、非法形状一律按服务端缺陷抛错，
 *    不得把未知状态或半成品记录交给上层。
 *
 * 迁移到数据库实现的同一切片还必须处理「存储 ID 域」（见上）与学号/手机号的落地形态
 * （字段字典要求学号加密存储 + 摘要唯一索引、手机号默认掩码展示）。
 */
export interface AsyncProfileRepository {
  readonly capabilities: ProfileRepositoryCapabilities;
  /** 未命中返回 `undefined`（不抛错）：该主体尚无画像 */
  findByUserId(userId: string): Promise<StudentProfile | undefined>;
  /** 覆盖写入（upsert）一条已由 service 校验、补齐归属与时间戳的画像，返回写入后的副本 */
  save(profile: StudentProfile): Promise<StudentProfile>;
}

/** DI 令牌：学生画像仓储 */
export const PROFILE_REPOSITORY = Symbol('PROFILE_REPOSITORY');
