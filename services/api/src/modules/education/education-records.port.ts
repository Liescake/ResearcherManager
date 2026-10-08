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
 *   违反者由 service 判为服务端缺陷（500），不允许作为正常输出发给调用方。
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

/** DI 令牌：升学记录仓储 */
export const EDUCATION_RECORD_REPOSITORY = Symbol('EDUCATION_RECORD_REPOSITORY');
