import type { AiErrorCode, MatchFeatureBundle } from '@rm/ai-adapter';
import type { MatchingRecommendationItem, MatchingRequestStatus } from '@rm/shared';

/**
 * 匹配（matching）切片的两个**显式可替换端口**与存储实体。
 *
 * 为什么是端口：业务切片不能把「进程内 Map」当成生产存储。这里把两类依赖显式化：
 *
 * 1. `MatchingRepository`（匹配请求持久化，对应 `ai_match_records`）：
 *    **异步 + 授权边界**契约（`MatchingAccessScope` 随每次访问传入）。未配置数据库时绑定内存基线
 *    `InMemoryMatchingRepository`（如实声明 `persistent = false`、`productionReady = false`，
 *    并在 `NODE_ENV=production` 下拒绝构造）；已配置数据库时由模块换绑工厂绑定
 *    `createLazyPostgresMatchingRepository`（延迟建连，生产准入由启动期依赖就绪门禁判定）。
 *    两种后端同语义，因此「切换到数据库」与「回退到内存基线」都不改动 service / controller；
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

/**
 * 匹配请求仓储端口（**运行时唯一取用点**，`MATCHING_REPOSITORY`）。
 *
 * 形状是「异步 + 授权边界」：四个方法都要求 `MatchingAccessScope`，因此不存在
 * 「只传 `userId` 就绕过小组边界」的调用形态；两个后端（内存基线 / PostgreSQL adapter）
 * 必须语义一致。把它设计成 Promise 之后，绑定哪个后端不再影响 service / controller 的形状。
 */
export interface MatchingRepository {
  readonly capabilities: MatchingRepositoryCapabilities;
  /** 写入一条已由 service 补齐归属、状态、摘要与时间戳的记录（入口恒为 `pending`） */
  create(request: MatchingRequest, scope: MatchingAccessScope): Promise<MatchingRequest>;
  /** 按 id 覆盖写入（状态机推进用）；id 不存在属服务端缺陷，必须报错而不是静默插入 */
  save(request: MatchingRequest, scope: MatchingAccessScope): Promise<MatchingRequest>;
  findById(requestId: string, scope: MatchingAccessScope): Promise<MatchingRequest | undefined>;
  /** 只按归属主体取数：调用方必须是已授权访问该主体资源的服务端代码 */
  listByUserId(scope: MatchingAccessScope): Promise<readonly MatchingRequest[]>;
}

/**
 * PostgreSQL 后端标识（能力声明 `backend` 的规范取值）。
 *
 * 数据库 adapter、边界守卫与运维摘要共用同一字面量，避免同一后端出现
 * `postgres` / `postgres-draft` / `postgresql` 多个拼写而无法机器比对。
 */
export const MATCHING_REPOSITORY_BACKEND_POSTGRES = 'postgres';

/**
 * **存储 ID 域约束**：`ai_match_records.id` / `user_id` 与推荐结果里的 `groupId`
 * 在存储侧都是 `uuid`（`ai_match_records` 引用 `users`，`recommendations[].groupId` 引用
 * `research_groups`，见 docs/P1-字段级数据字典.md 与 docs/P2-ER图.md）。
 *
 * 会话主体当前的 `userId` 只保证是「安全 ID」（例如 `u-student-1`），**不是** UUID；
 * 推荐来源 `MatchingFeatureSource` 返回的候选小组 ID 同样只保证是安全 ID。
 * 因此绑定到数据库实现的那一片切片必须把这两类标识一起收敛为 UUID（规范小写形，
 * 以便归属复核保持逐字节精确比较），否则数据库 adapter 会按本约束 **fail-closed 拒绝**，
 * 而不是退化成「放弃类型约束的字符串比较」。
 */
export const MATCHING_REPOSITORY_STORAGE_ID_DOMAIN = 'uuid';

/**
 * 匹配记录的**服务端授权边界**（读 / 写都必须携带）。
 *
 * 它刻意不是「客户端过滤器」：两个字段都只能由 service 在 `AuthorizationGuard`
 * 判定之后、从**服务端会话主体**与**服务端资源级判定产物**构造，请求体、查询串与自定义头
 * （`x-user-id` / `x-roles` / `x-scope` / `x-group-id`）永不进入本结构。
 *
 * - `ownerUserId`：会话主体。仓储把它**下推进 SQL**（`WHERE user_id = $n`），
 *   他人匹配记录根本不出库；返回行上再逐条复核归属（纵深防御）。
 * - `authorizedGroupIds`：服务端已判定「该主体可见」的小组集合（推荐召回与资源级判定的产物）。
 *   存储记录里的推荐结果一旦出现集合之外的小组，说明记录被外部改写或召回越权：
 *   仓储**fail-closed 抛错**（`GROUP_SCOPE_VIOLATION`），绝不像过滤器那样静默剔除后照常返回
 *   ——静默剔除会把「存储层被污染」伪装成「这条记录只是少几条推荐」。
 */
export interface MatchingAccessScope {
  /** 服务端会话主体（归属）：非客户端输入，必须是存储 ID 域内的 UUID */
  readonly ownerUserId: string;
  /** 服务端已授权可见的小组 ID 集合（资源级判定产物）；空集合表示一条推荐都不允许出现 */
  readonly authorizedGroupIds: readonly string[];
}

/**
 * **异步仓储契约的历史名**（`AsyncMatchingRepository`）：现在它是 `MatchingRepository` 的别名。
 *
 * 历史事实：本端口原先按「同步端口（内存基线）+ 异步契约（数据库形状，尚未接入）」并存设计，
 * 「同步 → 异步」的迁移与「接入经评估的数据库驱动 + 集成验证」被刻意绑定在同一片切片。
 * 本切片完成的正是那次迁移：**运行时端口 `MatchingRepository` 自身已经是异步 + 授权边界的形状**，
 * 因此「绑定 PostgreSQL 实现」与「回退到内存基线」都可以在不改动 service / controller 的前提下
 * 整步执行、整步回退。保留本名字是为了让既有 adapter 与其离线 spec 使用的契约名继续有效。
 *
 * 实现者（当前只有 `matching.postgres-repository.ts`）必须满足与内存基线**完全相同**的语义
 * （含「同 ID 重复写入视为服务端缺陷、不得静默覆盖」与「覆盖写入未知 ID 必须显式抛错」），
 * 并额外守住五条边界：
 * 1. **授权边界随每次访问传入**：四个方法都要求 `MatchingAccessScope`（服务端 subject + 已授权小组
 *    集合），因此不存在「只传 `userId` 就绕过小组边界」的调用形态。仓储**不做授权判定**，
 *    只校验传入的边界是否被满足；边界本身由 `AuthorizationGuard` 与召回来源负责。
 *    `listByUserId` 的方法名沿用历史命名，取数主体由 `scope.ownerUserId` 承载。
 * 2. **归属只来自服务端**：`userId` 既是写入记录的归属，也是取数主体；仓储不生成、不覆盖归属，
 *    并复核「返回记录的归属 === 本次访问的归属」，不一致即判服务端缺陷（`OWNER_VIOLATION`）。
 * 3. **存储 ID 域**：`userId`、记录 `id` 与推荐结果里的 `groupId` 都必须落在
 *    `MATCHING_REPOSITORY_STORAGE_ID_DOMAIN`（UUID，规范小写形）内，否则 fail-closed
 *    （`INVALID_SUBJECT` / `INVALID_RECORD_ID` / `INVALID_RECORD` / `INVALID_SCOPE`）。
 * 4. **推荐结果闭集**：状态、降级码只接受闭集取值；推荐条目只接受
 *    `groupId` / `score` / `reason` / `advice` 四条白名单字段（原始模型 payload、内部评分明细与
 *    审核字段既不入库也不出库）；`completed` 必须有推荐、其余状态必须为空（读取契约的自洽校验）。
 * 5. **每条返回记录都必须能被读取契约校验**：未知列、未知枚举、坏形状、状态与条数矛盾、
 *    推荐理由里出现个人标识，一律按服务端缺陷抛错；高敏感内容与归属**绝不**进入错误消息与日志。
 */
export type AsyncMatchingRepository = MatchingRepository;

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
