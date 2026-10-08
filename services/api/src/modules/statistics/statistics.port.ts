/**
 * 统计切片（`GET /me/statistics`）的**四个显式计数读取端口**。
 *
 * 为什么是端口而不是直接注入其他模块的仓储：
 * 1. **模块边界**：`statistics` 是聚合读侧，education / memberships / achievements / matching
 *    各自的存储语义属于它们自己的模块。本切片只声明「需要某个来源按主体计数」这一能力，
 *    不 import 任何其他模块的 repository 类型，因此各领域模块的存储实现可以独立演进；
 * 2. **可替换**：P4—P8 尚未引入数据库（迁移计划见 `db/migrations/`），本切片默认绑定内存基线
 *    `InMemoryStatisticsCountRepository`（如实声明 `persistent = false`、`productionReady = false`，
 *    并在 `NODE_ENV=production` 下**拒绝构造**）。引入 PostgreSQL 后只需把四个 DI 令牌换绑到
 *    持久化实现（直接复用各领域仓储的 `listByUserId(...)` 计数，或下推为 `SELECT count(*)`），
 *    service / controller 无需改动，因而这一步可整步回退；
 * 3. **可测试的边界**：授权拒绝时断言「端口方法一次都没被调用」是本切片的硬要求
 *    （授权先于 repository），显式端口让这条断言可机器判定。
 *
 * 边界事实：
 * - 端口**不做授权判定**：资源级判定属于 `AuthorizationGuard`，调用方必须先授权；
 * - 端口**不接受任何客户端提交的 userId**：service 传入的永远是 `SESSION_SUBJECT_RESOLVER`
 *   解析出的服务端主体；查询串/请求体/自定义头里的 `userId`/`roles`/`scope`/`groupId`
 *   既不被读取也不被信任（出现即被输入闭集拒绝）；
 * - 端口**只返回计数**，不返回记录、不返回主键、不返回任何字段取值：因此聚合输出在结构上
 *   不可能携带记录内容、姓办学号手机号等 PII；计数本身的合法性由
 *   `statistics.contract.ts` 的读取契约校验，非法计数按服务端缺陷 500 处理。
 */

/** 统计来源标识：只用于能力声明、日志与错误文案，**不参与任何授权判定** */
export const StatisticsSource = {
  Education: 'education',
  Applications: 'applications',
  Achievements: 'achievements',
  Matching: 'matching',
} as const;
export type StatisticsSource = (typeof StatisticsSource)[keyof typeof StatisticsSource];
export const STATISTICS_SOURCE_VALUES = [
  StatisticsSource.Education,
  StatisticsSource.Applications,
  StatisticsSource.Achievements,
  StatisticsSource.Matching,
] as const;

/** 计数来源的能力声明：让上层与运维能机器判定当前来源是否可持久化 */
export interface StatisticsCountCapabilities {
  readonly backend: string;
  /** 该端口对应的来源（education / applications / achievements / matching） */
  readonly source: StatisticsSource;
  /** 是否跨进程/重启保留（内存基线必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

/**
 * 计数读取端口：唯一的查询入口是「某个服务端主体名下的记录条数」。
 * 返回 `number`（计数），不返回记录数组——这是本切片的输出白名单在存储侧的前置保证。
 */
export interface StatisticsCountRepository {
  readonly capabilities: StatisticsCountCapabilities;
  /** 只按服务端主体计数：调用方必须是已授权访问该主体统计数据的服务端代码 */
  countByUserId(userId: string): number;
}

/**
 * DI 令牌：升学记录计数来源（真实实现应委托 `EDUCATION_RECORD_REPOSITORY` /
 * `education_records` 表，本切片默认绑定内存基线）。
 */
export const EDUCATION_STATISTICS_REPOSITORY = Symbol('EDUCATION_STATISTICS_REPOSITORY');

/** DI 令牌：入组申请计数来源（真实实现应委托 `APPLICATION_REPOSITORY` / `join_applications` 表） */
export const APPLICATION_STATISTICS_REPOSITORY = Symbol('APPLICATION_STATISTICS_REPOSITORY');

/** DI 令牌：成果计数来源（真实实现应委托 `ACHIEVEMENT_REPOSITORY` / `achievements` 表） */
export const ACHIEVEMENT_STATISTICS_REPOSITORY = Symbol('ACHIEVEMENT_STATISTICS_REPOSITORY');

/** DI 令牌：匹配请求计数来源（真实实现应委托 `MATCHING_REPOSITORY` / `ai_match_records` 表） */
export const MATCHING_STATISTICS_REPOSITORY = Symbol('MATCHING_STATISTICS_REPOSITORY');

/** 令牌的运维可读名：只用于能力声明与「生产环境拒绝使用内存实现」的错误文案 */
export const STATISTICS_REPOSITORY_TOKEN_NAMES: Readonly<Record<StatisticsSource, string>> = {
  [StatisticsSource.Education]: 'EDUCATION_STATISTICS_REPOSITORY',
  [StatisticsSource.Applications]: 'APPLICATION_STATISTICS_REPOSITORY',
  [StatisticsSource.Achievements]: 'ACHIEVEMENT_STATISTICS_REPOSITORY',
  [StatisticsSource.Matching]: 'MATCHING_STATISTICS_REPOSITORY',
};
