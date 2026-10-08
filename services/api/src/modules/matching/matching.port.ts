import type { AiErrorCode, MatchFeatureBundle } from '@rm/ai-adapter';
import type { MatchingRecommendationItem, MatchingRequestStatus } from '@rm/shared';

/**
 * 匹配（matching）切片的两个**显式可替换端口**与存储实体。
 *
 * 为什么是端口：P4/P5 尚未引入数据库（迁移计划见 `db/migrations/`），但业务切片不能因此
 * 把「进程内 Map」当成生产存储。这里把两类依赖显式化：
 *
 * 1. `MatchingRepository`（匹配请求持久化，对应 `ai_match_records`）：
 *    默认绑定内存基线 `InMemoryMatchingRepository`，它如实声明 `persistent = false`、
 *    `productionReady = false`，并在 `NODE_ENV=production` 下拒绝构造；引入 PostgreSQL 时
 *    只需换绑 DI 令牌 `MATCHING_REPOSITORY`，service/controller 不改动；
 * 2. `MatchingFeatureSource`（**特征最小化与召回**边界）：
 *    只返回「已脱敏的最小特征 + 候选小组」。本切片默认绑定内存基线
 *    `InMemoryMatchingFeatureSource`（同样 `productionReady = false` 且生产拒绝构造），
 *    它要求写入的快照先通过 PII 门禁（姓名/学号/手机号/微信标识一律无法入库）。
 *    接入 profiles / groups 的仓储端口时只替换这一个绑定。
 *
 * 边界事实：
 * - 两个端口都**不做授权判定**：资源级判定属于 `AuthorizationGuard`，调用方必须先授权；
 * - 两个端口都不产生归属信息：`userId` 由 service 从服务端会话主体写入，永不来自请求体；
 * - 仓储返回的每条记录都必须能被读取契约校验（`matching.contract.ts`）；成果、画像等切片的
 *   实测证明「损坏记录当作正常输出」是必须 fail-closed 的，这里规则相同。
 *
 * 本切片只承载匹配请求的**发起**与**本人列表/状态**：
 * 管理端 `/admin/matching-records`、推荐结果的历史回溯与导出、幂等键与审计落库、
 * 画像版本核对（需要 profiles 仓储端口）以及异步化处理属于后续切片。
 */

/** 存储层的一条匹配请求（对应 docs/P1-字段级数据字典.md 的 ai_match_records 字段） */
export interface MatchingRequest {
  readonly id: string;
  /** 归属主体：服务端会话解析值，非客户端输入 */
  readonly userId: string;
  /** 状态：只由服务端状态机写入（入口恒为 `pending`），客户端提交同名字段一律 400 */
  readonly status: MatchingRequestStatus;
  /** 客户端声明的画像版本：仅用于追溯，不参与授权与结果计算（是否核对属后续切片） */
  readonly profileVersion?: number;
  /** 已脱敏输入快照的 sha256 摘要：**不存特征原文**，也不进入对外视图 */
  readonly inputSnapshotHash: string;
  /** 推荐结果：0—3 条，`completed` 至少有 1 条（由读取契约校验） */
  readonly recommendations: readonly MatchingRecommendationItem[];
  /** 模型/供应商标识：不可为空（数值字典要求），未调用模型时为 provider 标识 */
  readonly modelVersion: string;
  /** 提示词版本：不可为空 */
  readonly promptVersion: string;
  /** true = 结果来自规则降级（未采用模型输出） */
  readonly fallbackUsed: boolean;
  /** 降级原因码（AI 适配层的安全错误码）；成功调用模型时为 undefined */
  readonly degradationCode?: AiErrorCode;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 存储后端能力声明：让上层与运维能机器判定当前后端是否持久化 */
export interface MatchingRepositoryCapabilities {
  readonly backend: string;
  /** 是否跨进程/重启保留（内存基线必须为 false） */
  readonly persistent: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

export interface MatchingRepository {
  readonly capabilities: MatchingRepositoryCapabilities;
  /** 写入一条已由 service 补齐归属、状态、摘要与时间戳的记录（入口恒为 `pending`） */
  create(request: MatchingRequest): MatchingRequest;
  /** 按 id 覆盖写入（状态机推进用）；id 不存在属服务端缺陷，必须报错而不是静默插入 */
  save(request: MatchingRequest): MatchingRequest;
  findById(requestId: string): MatchingRequest | undefined;
  /** 只按归属主体取数：调用方必须是已授权访问该主体资源的服务端代码 */
  listByUserId(userId: string): readonly MatchingRequest[];
}

/** 召回与特征最小化后端的能力声明 */
export interface MatchingSourceCapabilities {
  readonly backend: string;
  /** 是否与真实 profiles / groups 数据源联动（内存基线必须为 false） */
  readonly connectedToDomainData: boolean;
  /** 是否可用于生产（内存基线必须为 false） */
  readonly productionReady: boolean;
}

/**
 * 特征最小化与召回端口。
 *
 * 只返回 `@rm/ai-adapter` 的 `MatchFeatureBundle`：学生侧是**已脱敏**的最小特征
 * （年级/专业/技能/编程等级/兴趣方向/意向领域/周投入时间/时段/脱敏摘要），
 * 候选侧是逐条小组的匹配所需字段；**不包含**姓名、学号、手机号、微信标识、原始经历文本，
 * 也不返回全部小组（候选集合由召回决定）。
 */
export interface MatchingFeatureSource {
  readonly capabilities: MatchingSourceCapabilities;
  /**
   * 按服务端主体加载快照：调用方必须先完成授权。
   * 返回 `undefined` 表示该主体暂无可用画像/召回结果（由 service 转成 `no_candidate`）。
   */
  loadBundle(userId: string): MatchFeatureBundle | undefined;
}

/** DI 令牌：匹配请求仓储 */
export const MATCHING_REPOSITORY = Symbol('MATCHING_REPOSITORY');

/** DI 令牌：特征最小化与召回来源 */
export const MATCHING_FEATURE_SOURCE = Symbol('MATCHING_FEATURE_SOURCE');

/** DI 令牌：AI 模型 provider（仅经 `@rm/ai-adapter` 的 `AiProvider` 端口被调用） */
export const MATCHING_AI_PROVIDER = Symbol('MATCHING_AI_PROVIDER');
