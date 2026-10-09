import type { EducationStatus, EducationType, ReviewStatus } from '@rm/shared';

/**
 * 升学记录持久化端口（**显式可替换 repository port**）。
 *
 * 为什么是端口：业务切片不能把「进程内 Map」当成生产存储。这里把持久化依赖显式化：
 * - 未配置 `DATABASE_URL` 时绑定内存基线 `InMemoryEducationRecordRepository`，它如实声明
 *   `persistent = false`、`productionReady = false`，并在 `NODE_ENV=production` 下拒绝构造；
 * - 已配置 `DATABASE_URL` 时把 DI 令牌 `EDUCATION_RECORD_REPOSITORY` 换绑到 PostgreSQL 实现
 *   （见 `education-records.postgres-repository.ts`），service/controller 无需改动，
 *   因此这一迁移步可整步回退（见 `education.module.ts` 的唯一换绑点）。
 *
 * 边界事实：
 * - 仓储只负责存储与按 `userId` 取数，**不做授权判定**；资源级判定属于 `AuthorizationGuard`；
 * - 仓储不产生归属信息：`userId` 由 service 从服务端主体写入，永不来自请求体；
 * - 仓储返回的每条记录都必须能被读取契约校验（`education-records.contract.ts`），
 *   违反者由 service 判为服务端缺陷（500），不允许作为正常输出发给调用方；
 * - 端口是**异步**的：内存基线与 PostgreSQL 实现实现**同一份**契约，`create` / `findById` /
 *   `listByUserId` 都返回 Promise。service 必须 `await`，因此「未授权就碰仓储」
 *   「先读后判」这类顺序错误不再可能被同步返回悄悄掩盖。
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

/**
 * 升学记录仓储端口（**唯一**契约，内存基线与 PostgreSQL 实现都必须满足）。
 *
 * 两个实现必须满足**完全相同**的语义，包括「同 ID 重复写入视为服务端缺陷、不得静默覆盖」。
 * PostgreSQL 实现（`education-records.postgres-repository.ts`）额外守住四条边界：
 * 1. **归属只来自服务端**：`userId` 由 service 从服务端会话主体写入，adapter 不生成、不覆盖
 *    归属，并复核「返回记录的归属 === 请求取数 / 写入的归属」，不一致即判服务端缺陷；
 * 2. **存储 ID 域**：`userId` 与资源 `id` 都必须落在
 *    `EDUCATION_RECORD_REPOSITORY_STORAGE_ID_DOMAIN`（UUID，规范小写形）内，否则 fail-closed
 *    （见下）；
 * 3. **按服务端主体隔离**（数据库形状上的**归属隔离强化**）：`findById` **同时**接收服务端
 *    主体，只返回「资源 ID 与归属同时命中」的记录——归属被**下推进 SQL**（`WHERE id = $1
 *    AND user_id = $2::uuid`），让「他人记录」根本不出库，并在返回行上再复核一次归属
 *    （纵深防御）。`listByUserId` 同样只按服务端主体取数；
 * 4. **每条返回记录都必须能被读取契约校验**：未知列、未知枚举、非法形状一律按服务端缺陷抛错，
 *    不得把未知状态或半成品记录交给上层；高敏感内容（归属、院校或去向）**绝不**进入错误消息与日志。
 *
 * 为什么端口整体是异步的（本切片完成的跨模块契约变更）：会话存储、画像、本人统计与成果四个切片
 * 都已收敛为「端口返回 Promise、内存基线与 PostgreSQL 实现实现同一契约」的口径。本切片把升学记录
 * 端口也收敛到同一口径后，「内存基线 ⇄ PostgreSQL」的替换只需要改一个 factory provider 的绑定，
 * 而**单条读取**因为必须把归属下推进 SQL，签名变成 `findById(recordId, ownerUserId)`：
 * 「不存在」与「存在但不属于该主体」在 adapter 层不可区分并统一返回 `undefined`，
 * 调用方据此判 404 —— 他人资源的存在性因此**不可探测**（此前同步端口需要先取数、再判归属，
 * 只能用 403 与 404 的差别泄露存在性）。
 */
export interface EducationRecordRepository {
  readonly capabilities: EducationRecordRepositoryCapabilities;
  /** 写入一条已由 service 校验并补齐归属/审核态的记录；同 ID 冲突必须显式抛错，不得静默覆盖 */
  create(record: EducationRecord): Promise<EducationRecord>;
  /**
   * 未命中返回 `undefined`（不抛错）：只返回**同时**命中资源 ID 与**服务端主体归属**的记录。
   * 「记录不存在」与「记录存在但不属于该主体」在此**不可区分**，调用方统一判 404，
   * 避免用存在性探测他人资源。
   */
  findById(recordId: string, ownerUserId: string): Promise<EducationRecord | undefined>;
  /** 只按归属主体取数：调用方必须是已授权访问该主体资源的服务端代码 */
  listByUserId(userId: string): Promise<readonly EducationRecord[]>;
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

/** DI 令牌：升学记录仓储 */
export const EDUCATION_RECORD_REPOSITORY = Symbol('EDUCATION_RECORD_REPOSITORY');
