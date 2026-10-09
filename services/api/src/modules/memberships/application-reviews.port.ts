import { APPLICATION_STATUS_TRANSITIONS, type ApplicationStatus } from '@rm/shared';
import type { Application, ApplicationRepositoryCapabilities } from './applications.port';

/**
 * 入组申请**团队审核端**的持久化端口（**独立于申请人自服务端口**）。
 *
 * ## 为什么必须是另一个端口，而不是给 `ApplicationRepository` 加方法
 * `ApplicationRepository`（`applications.port.ts`）的每一条取数谓词都是**申请人归属**：
 * `findById(id, ownerUserId)` 把归属下推进 `WHERE user_id = $2`，`listByUserId(userId)` 只按主体取数。
 * 它的安全性质是「他人的记录根本不出库」。团队审核者的需求在方向上是**相反**的：它就是要读
 * **他人**提交的申请。把这两种需求塞进同一个端口，只有两种结局：
 * 1. 给 `findById` 加一个「不校验归属」的旁路参数 —— 申请人路径上那条「他人记录不出库」的
 *    保证立刻变成「调用方记得传对参数」，纵深防御降级为调用方自律；
 * 2. 让审核端复用 `listByUserId` 再在上层过滤 —— 它只能按**申请人**取数，而审核者手上没有申请人
 *    标识，于是上层不得不先全量取数再筛，范围谓词被移出 SQL，`scope` 隔离退化成内存过滤。
 * 两条路都会让「审核端读了什么」不再由一条可下推的 SQL 谓词决定。因此审核端有**自己的端口**：
 * 范围谓词（`scope`）是端口签名的一部分，实现必须把它下推进 SQL，而不是留给上层复核。
 *
 * ## 范围（scope）是服务端解析结果，且是本端口的**唯一**隔离依据
 * `ApplicationReviewScope` 只有两种形状，都由 service 从服务端会话主体 + 授权端口推导
 * （见 `application-reviews.service.ts`）：
 * - `{ kind: 'global' }` —— 全局审核（`membership:review:global` + `GLOBAL`）；
 * - `{ kind: 'groups', groupIds }` —— 小组审核（`membership:review:group` + `GROUP`），
 *   其中 `groupIds` **只允许**来自服务端已验证的 `subject.groupIds`。
 *
 * 端口**不接受**任何客户端字段：`userId` / `roles` / `scope` / `groupId` / `status` / `reviewStatus`
 * 都不在本端口的签名里。客户端提交的 `groupId` 最多作为「缩小范围」的意图，先经授权端口判定，
 * 再由 service 换成一个**新的**服务端 scope 传进来（见 service 的 `narrowReviewScope`）。
 *
 * ## 空范围必须等价于「什么都看不到」（fail-closed）
 * `{ kind: 'groups', groupIds: [] }` 在语义上**必须**返回空结果，绝不允许被实现读成
 * 「没有限制 ⇒ 返回全部」。这是本端口最容易出现的一类静默越权：SQL 里 `= ANY(ARRAY[]::uuid[])`
 * 天然返回空集，但若实现为了「优化」在空数组时省掉 `WHERE` 子句，就会把「无权」变成「全量」。
 * 实现必须显式守住这一点（`assertNonEmptyReviewScope` 供实现复用；内存基线与 PostgreSQL 实现
 * 都必须满足，且两侧各有边界断言）。
 *
 * ## 写入是「范围内的条件写入」
 * `saveReviewed` 同时钉住三件事：资源 ID、**范围**、以及「当前状态必须是目标状态的合法前驱」。
 * 因此：
 * - 拿范围外的记录 ID 也写不中数据（范围谓词在 `WHERE` 里，不在调用方记忆里）；
 * - 并发重复审核只有第一个请求能命中（第二个 0 行 → `TRANSITION_REJECTED`），
 *   已被终态化的申请不会被第二次审核覆盖。
 *
 * ## 实现必须满足的边界
 * 1. **范围只来自参数**：实现不读取任何环境/请求状态，也不从记录反推范围；
 * 2. **范围下推进 SQL**：`listForReview` / `findForReview` / `saveReviewed` 三者都必须把范围
 *    变成 `WHERE` 谓词，因此范围外的记录既不出库也不可写；
 * 3. **每条返回记录都必须能被读取契约校验**（`applications.contract.ts`），违规按服务端缺陷抛错；
 * 4. **错误与日志不含字段取值**：申请人归属、备注原文与审核意见绝不出现在错误消息里，
 *    只允许出现字段路径与违规类型；
 * 5. **存储 ID 域**：与申请人端口一致，标识必须落在规范小写形非空 UUID 内，否则 fail-closed。
 */

/**
 * 审核端可见范围。
 *
 * 刻意只允许这两种形状：任何「按资源 ID 集合」「按状态集合」之类的扩展都会让范围从
 * 「服务端可判定的组织边界」退化成「调用方给的过滤器」，因此不在这里提供。
 */
export type ApplicationReviewScope =
  { readonly kind: 'global' } | { readonly kind: 'groups'; readonly groupIds: readonly string[] };

/** 审核端仓储能力声明：语义与申请人端口一致（内存基线必须 `persistent=false`） */
export type ApplicationReviewRepositoryCapabilities = ApplicationRepositoryCapabilities;

/**
 * 审核端仓储端口。
 *
 * 三个方法的范围参数都是 `ApplicationReviewScope`（服务端解析值），且**都必须**被下推进存储谓词。
 */
export interface ApplicationReviewRepository {
  readonly capabilities: ApplicationReviewRepositoryCapabilities;

  /**
   * 按范围列出待审/已审申请（**不按申请人聚合**：审核者看的是一个小组/全局的申请流）。
   * 返回顺序为创建顺序（内存基线保留插入顺序，数据库实现按 `created_at, id` 全序）。
   */
  listForReview(scope: ApplicationReviewScope): Promise<readonly Application[]>;

  /**
   * 按资源 ID 在**范围之内**取单条。
   *
   * 返回 `undefined` 表示「该范围内不存在此申请」——范围外的记录与「不存在」在存储层就是
   * 同一种结果，因此调用方无法据此探测范围外资源是否存在（对客户端表现为 404，与申请人端
   * 的「他人的申请不可区分」同口径）。
   */
  findForReview(
    applicationId: string,
    scope: ApplicationReviewScope,
  ): Promise<Application | undefined>;

  /**
   * 写回一条已完成合法审核转移的完整记录（**范围内的条件写入**）。
   *
   * 记录不存在、不在范围内、或当前状态不是目标状态的合法前驱时，实现必须 fail-closed 且
   * **不产生任何写入**：前两种按服务端缺陷/范围外拒绝（错误码由实现给出），
   * 第三人称并发冲突映射为 `TRANSITION_REJECTED`（客户端可见冲突，service 侧映射为 409）。
   */
  saveReviewed(application: Application, scope: ApplicationReviewScope): Promise<Application>;
}

/**
 * 范围 → 小组 ID 列表（`global` 返回空数组表示「不加小组谓词」，**不等于**「无可见小组」）。
 *
 * 这个函数是给实现用的：它让「global 不加谓词」与「groups 加谓词」的差别显式化，
 * 避免实现自己判断 `scope.kind` 时把空数组写成「省略 WHERE」。
 */
export function reviewScopeGroupIds(scope: ApplicationReviewScope): readonly string[] {
  return scope.kind === 'global' ? [] : scope.groupIds;
}

/**
 * 空小组范围断言（**fail-closed**）：`{ kind: 'groups', groupIds: [] }` 是**无权**的表示，
 * 不是「不限制」。实现必须在构造任何查询之前调用本函数，让这一条不可被静默绕过。
 */
export function assertNonEmptyReviewScope(scope: ApplicationReviewScope): void {
  if (scope.kind === 'groups' && scope.groupIds.length === 0) {
    throw new Error(
      '审核范围为空（groups 且 groupIds 为空）：空范围表示无权可见任何申请，绝不可解释为「不限制」',
    );
  }
}

/**
 * 目标审核状态的**合法前驱集合**（从共享状态机的逆映射派生，单一事实来源）。
 *
 * 两个实现都必须用它构造条件写入谓词，因此「哪些状态可以进入本次审核」在内存基线与
 * PostgreSQL 实现里是**同一份**定义：`pending → approved | rejected`；
 * 已被终态化的申请（`approved`/`rejected`/`withdrawn`）不在任何前驱集合里，
 * 因此重复审核不会产生第二次状态变化，也不可能覆盖既有终态。
 */
export function reviewStatusPredecessors(target: ApplicationStatus): readonly ApplicationStatus[] {
  return (Object.keys(APPLICATION_STATUS_TRANSITIONS) as ApplicationStatus[]).filter((from) =>
    APPLICATION_STATUS_TRANSITIONS[from].includes(target),
  );
}

/** 范围内判定：把范围谓词写成纯函数，两个实现共用，避免「内存能看、数据库不能看」的语义漂移 */
export function isWithinReviewScope(record: Application, scope: ApplicationReviewScope): boolean {
  return scope.kind === 'global' || scope.groupIds.includes(record.groupId);
}

/**
 * 并发审核冲突（**客户端可见冲突**，不是服务端缺陷）。
 *
 * 触发条件是「条件写入 0 行，且原因是当前状态不再是目标状态的合法前驱」——典型场景是
 * 两个审核请求几乎同时到达，第一个把申请推进到终态，第二个的状态谓词不再命中。
 * 两个实现都必须抛这一个类型（而不是各自抛普通 `Error`），否则 service 只能靠错误消息
 * 猜类型，`409 STATE_TRANSITION_INVALID` 的映射就会随实现漂移。
 */
export class ApplicationReviewConflictError extends Error {
  readonly code = 'TRANSITION_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'ApplicationReviewConflictError';
  }
}

/** 审核写入的**范围外/不存在**拒绝：属于服务端缺陷或越权写入，不与并发冲突混同 */
export class ApplicationReviewRejectedError extends Error {
  readonly code: 'NOT_FOUND' | 'OUT_OF_SCOPE' | 'IDENTITY_MISMATCH';

  constructor(code: 'NOT_FOUND' | 'OUT_OF_SCOPE' | 'IDENTITY_MISMATCH', message: string) {
    super(message);
    this.name = 'ApplicationReviewRejectedError';
    this.code = code;
  }
}

/**
 * DI 令牌：入组申请**审核端**仓储。
 *
 * 与申请人端的 `APPLICATION_REPOSITORY` 是**两个独立的令牌**，这是本切片的核心边界：
 * 两个令牌各自在 `db/persistence-bindings.ts` 登记，因此生产门禁会分别判定两者的持久性，
 * 不会因为「申请人端已经换绑到数据库」就默认审核端也换绑了 —— 那种默认正是
 * 「审核端悄悄跑在内存替身上」这一类静默失效的温床。
 */
export const APPLICATION_REVIEW_REPOSITORY = Symbol('APPLICATION_REVIEW_REPOSITORY');
