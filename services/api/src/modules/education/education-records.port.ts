import type { EducationStatus, EducationType, ReviewStatus } from '@rm/shared';

/**
 * 升学记录持久化端口（**显式可替换 repository port**）。
 *
 * 为什么是端口：P3/P4 尚未引入数据库（迁移计划见 `db/migrations/`），
 * 但业务切片不能因此把「进程内 Map」当成生产存储。这里把持久化依赖显式化：
 * - 默认绑定内存基线 `InMemoryEducationRecordRepository`，它如实声明
 *   `persistent = false`、`productionReady = false`，并在 `NODE_ENV=production` 下拒绝构造；
 * - 引入 PostgreSQL（或其他实现）时，只需把 DI 令牌 `EDUCATION_RECORD_REPOSITORY`
 *   换绑到同一接口的实现，service/controller 无需改动，因此这一迁移步可整步回退。
 *
 * 边界事实：
 * - 仓储只负责存储与按 `userId` 取数，**不做授权判定**；资源级判定属于 `AuthorizationGuard`；
 * - 仓储不产生归属信息：`userId` 由 service 从服务端主体写入，永不来自请求体；
 * - 仓储返回的每条记录都必须能被读取契约校验（`education-records.contract.ts`），
 *   违反者由 service 判为服务端缺陷（500），不允许作为正常输出发给调用方；
 * - 数据库实现按 `AsyncEducationRecordRepository`（Promise 版，语义与内存基线一致）单独验证，
 *   **不与**当前同步绑定混用，也不得在同步端口绑定期间出现在任何模块的 provider 列表里。
 */

/** 存储层的升学记录（对应 docs/P1-字段级数据字典.md 的 education_records 字段） */
export interface EducationRecord {
  readonly id: string;
  /** 归属主体：服务端解析，非客户端输入 */
  readonly userId: string;
  readonly year: number;
  readonly type: EducationType;
  readonly status: EducationStatus;
  readonly institutionOrDestination?: string;
  readonly reviewStatus: ReviewStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 存储后端能力声明：让上层与运维能机器判定当前后端是否持久化 */
export interface EducationRecordRepositoryCapabilities {
  readonly backend: string;
  /** 是否跨进程/重启保留（内存基线必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

export interface EducationRecordRepository {
  readonly capabilities: EducationRecordRepositoryCapabilities;
  /** 写入一条已由 service 校验并补齐归属/审核态的记录 */
  create(record: EducationRecord): EducationRecord;
  findById(recordId: string): EducationRecord | undefined;
  /** 只按归属主体取数：调用方必须是已授权访问该主体资源的服务端代码 */
  listByUserId(userId: string): readonly EducationRecord[];
}

/**
 * PostgreSQL 后端标识（能力声明 `backend` 的规范取值）。
 *
 * 数据库 adapter、边界守卫与运维摘要共用同一字面量，避免同一后端出现
 * `postgres` / `postgres-draft` / `postgresql` 多个拼写而无法机器比对。
 */
export const EDUCATION_RECORD_REPOSITORY_BACKEND_POSTGRES = 'postgres';

/**
 * **存储 ID 域约束**：`education_records.user_id → users.id`，在存储侧是 `uuid`
 * （字段类别见 docs/P1-字段级数据字典.md）。
 *
 * 会话主体当前的 `userId` 只保证是「安全 ID」（例如 `u-student-1`），**不是** UUID。
 * 因此绑定到数据库实现的那一片切片必须同时把会话主体标识收敛为 UUID（规范小写形，
 * 以便归属复核保持逐字节精确比较），否则数据库 adapter 会按本约束 **fail-closed 拒绝**，
 * 而不是退化成「放弃类型约束的字符串比较」。
 */
export const EDUCATION_RECORD_REPOSITORY_STORAGE_ID_DOMAIN = 'uuid';

/**
 * **异步仓储契约**（数据库形状的 repository 端口，与 `EducationRecordRepository` 同语义）。
 *
 * 为什么与 `EducationRecordRepository` 并存、而不是把它直接改成异步：后者是当前运行时绑定
 * （内存基线，同步返回）。把它改成 Promise 是**跨模块契约变更**（service / controller 与既有
 * spec 必须一起改），只能与「引入经评估的数据库驱动 + 集成验证」在同一片切片完成。在那之前，
 * 数据库 adapter 按本契约实现并单独验证，运行时绑定一动不动，因此「切换到数据库」与
 * 「回退到内存基线」都仍然是可以整步执行 / 整步回退的操作。
 *
 * 实现者（当前只有 `education-records.postgres-repository.ts`）必须满足与内存基线
 * **完全相同**的语义（含「同 ID 重复写入视为服务端缺陷、不得静默覆盖」），并额外守住
 * 四条边界：
 * 1. **归属只来自服务端**：`userId` 由 service 从服务端会话主体写入，adapter 不生成、不覆盖
 *    归属，并复核「返回记录的归属 === 请求取数 / 写入的归属」，不一致即判服务端缺陷；
 * 2. **存储 ID 域**：`userId` 必须落在 `EDUCATION_RECORD_REPOSITORY_STORAGE_ID_DOMAIN`（UUID，
 *    规范小写形）内，否则 fail-closed（见上）；
 * 3. **按服务端主体隔离**（数据库形状上的**归属隔离强化**）：`findById` 必须**同时**接收服务端
 *    主体，只返回「资源 ID 与归属同时命中」的记录。同步端口 `findById(recordId)` 之后的归属
 *    判定发生在取数**之后**（`AuthorizationGuard` 仍会拒绝他人资源），但数据库形状可以也应该
 *    把归属下推进 SQL，让「他人记录」根本不出库——因此本契约要求 `findById(recordId, ownerUserId)`，
 *    并且 adapter 在返回行上再复核一次归属（纵深防御）；
 * 4. **每条返回记录都必须能被读取契约校验**：未知列、未知枚举、非法形状一律按服务端缺陷抛错，
 *    不得把未知状态或半成品记录交给上层；高敏感内容（归属、院校或去向）**绝不**进入错误消息与日志。
 *
 * 迁移到数据库实现的同一切片还必须处理「存储 ID 域」（见上）并把 service 的取数调用改为异步
 * （单条读取时要传服务端解析出的归属，而不是只传资源 ID）。
 */
export interface AsyncEducationRecordRepository {
  readonly capabilities: EducationRecordRepositoryCapabilities;
  /** 写入一条已由 service 校验并补齐归属/审核态的记录；同 ID 冲突必须显式抛错，不得静默覆盖 */
  create(record: EducationRecord): Promise<EducationRecord>;
  /** 未命中返回 `undefined`（不抛错）：只返回同时命中资源 ID 与**服务端主体归属**的记录 */
  findById(recordId: string, ownerUserId: string): Promise<EducationRecord | undefined>;
  /** 只按归属主体取数：调用方必须是已授权访问该主体资源的服务端代码 */
  listByUserId(userId: string): Promise<readonly EducationRecord[]>;
}

/** DI 令牌：升学记录仓储 */
export const EDUCATION_RECORD_REPOSITORY = Symbol('EDUCATION_RECORD_REPOSITORY');
