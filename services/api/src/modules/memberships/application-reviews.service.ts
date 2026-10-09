import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DataScope,
  PermissionPoint,
  StateTransitionError,
  applicationReviewInputSchema,
  assertApplicationTransition,
} from '@rm/shared';
import type { AuthorizationSubject, ReviewDecision } from '@rm/shared';
import {
  AUTHORIZATION_FORBIDDEN_MESSAGE,
  AuthorizationGuard,
} from '../access-control/authorization-guard';
import {
  ApplicationReviewConflictError,
  APPLICATION_REVIEW_REPOSITORY,
} from './application-reviews.port';
import type {
  ApplicationReviewRepository,
  ApplicationReviewScope,
} from './application-reviews.port';
import {
  assertDeclaredReviewInputFields,
  assertDeclaredReviewQueryFields,
  parseReviewedApplication,
  readReviewListGroupId,
  reviewApplicationIdSchema,
  reviewDecisionToApplicationStatus,
  reviewListGroupIdSchema,
  toApplicationReviewView,
} from './application-reviews.contract';
import type { ApplicationReviewView } from './application-reviews.contract';
import type { Application } from './applications.port';
import type { StoredApplication } from './applications.contract';

/**
 * 入组申请**团队审核端**切片（独立授权切片，**不复用申请人 SELF 端口**）：
 * - `GET  /admin/applications`                       管理端申请列表（按服务端范围）
 * - `POST /admin/applications/{applicationId}/review` 审核（通过/驳回）
 *
 * ## 授权模型：范围只能来自服务端会话主体
 * 审核端有**两种**服务端范围，二者都由 `AuthorizationGuard`（下接 `RUOYI_AUTHZ_ADAPTER` 端口
 * → canonical 谓词）判定，判定输入只有**服务端解析的主体**：
 * - `membership:review:global` + `GLOBAL` ⇒ `{ kind: 'global' }`；
 * - `membership:review:group` + `GROUP` + `groupId` ⇒ 只对**服务端已验证的 `subject.groupIds`**
 *   逐个询问端口，命中的小组构成 `{ kind: 'groups', groupIds }`。
 *
 * 客户端提交的 `userId` / `roles` / `scope` / `groupId` / `status` / `reviewStatus`
 * **都不是判定输入**：
 * - `roles` / `scope` / `userId` / `status` / `reviewStatus` 只可能出现在请求体里，而请求体在
 *   审核动作上被闭集直接拒绝（400），列表上也只允许 `groupId` 一个查询参数；
 * - `groupId` 在列表上是**意图**而不是授权：它必须再经端口判定（`narrowReviewScope`），
 *   通过后 service 才构造一个**新的**服务端 scope（收窄，绝不扩张）；不通过即 403。
 *   审核**动作**不接受 `groupId`：审核记录的小组归属只能来自存储记录。
 *
 * ## 判定顺序（被测试固定）
 * 两个方法都遵守同一条顺序：**授权 → 输入闭集 → 字段级校验 → 仓储访问**。
 * 因此未授权主体既拿不到字段级校验反馈（不会有 400 告诉它哪个字段格式不对），
 * 也观察不到申请是否存在（不会有 404 告诉它某个 ID 存在）。
 *
 * 审核动作在仓储访问之后还有**第二次**（决定性的）授权：按**存储记录给出的小组归属**再问一次
 * 端口。这不是重复劳动，而是纵深防御 —— 范围谓词已经下推进 SQL（范围外记录根本不出库），
 * 这一次判定防的是「仓储实现异常 / 数据被外部改写 / 记录的 group_id 被换成范围外的小组」
 * 那一类情形。它与范围判定走**同一条端口路径、同一个文案**（403 无权执行该操作），
 * 调用方无法据此区分「无权」与「数据异常」。
 *
 * ## 状态机与并发
 * `assertApplicationTransition` 是唯一权威：`pending -> approved | rejected`；
 * 终态、`withdrawn`、以及「已是 approved 再批准」一律 409 `STATE_TRANSITION_INVALID`。
 * 写入是**范围内的条件写入**（端口契约）：并发两次审核只有第一个能命中，
 * 第二个命中 0 行 → 端口抛 `ApplicationReviewConflictError` → 本服务映射为同一种 409，
 * 而不是让它冒泡成 500（那是把客户端可见冲突说成服务端故障）。
 *
 * ## 明确不做（留给后续切片）
 * 成员关系联动（`approved -> completed` 需要 memberships 表）、小组存在性与招募状态复检
 * （需要 `research_groups` 表，当前只有 schema 草案）、结果通知、幂等键、审计事件落库与
 * 「资源版本」（存储层目前没有版本列，并发保护由条件写入状态谓词承担）、列表分页/排序/过滤。
 * 因此本切片**不返回**审计事件 ID 与成员关系变化摘要：契约基线要求的这两项没有可写入的目标，
 * 编造一个 ID 会比缺失更有害。
 */
@Injectable()
export class ApplicationReviewsService {
  private readonly logger = new Logger(ApplicationReviewsService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(APPLICATION_REVIEW_REPOSITORY)
    private readonly repository: ApplicationReviewRepository,
  ) {}

  /**
   * 管理端列表：范围由服务端解析，客户端 `groupId` 最多把范围**收窄**。
   *
   * 顺序：授权（纯主体）→ 查询闭集 → 形状校验 + 收窄授权 → 仓储取数（范围下推 SQL）。
   */
  async listApplications(
    subject: AuthorizationSubject,
    query: unknown,
  ): Promise<ApplicationReviewView[]> {
    // 1. 授权：只用服务端主体，先于任何校验与仓储访问
    const scope = this.resolveReviewScope(subject);

    // 2. 查询参数闭集：未列出的参数一律 400（而不是被静默忽略）
    assertDeclaredReviewQueryFields(query);

    // 3+4. 收窄：客户端 groupId 先过形状（400），再过授权端口（403）
    const effective = this.narrowReviewScope(subject, scope, readReviewListGroupId(query));

    // 5. 仓储：范围作为参数下推，范围外记录根本不出库
    const records = await this.repository.listForReview(effective);
    return records.map((record) => this.toView(record));
  }

  /**
   * 审核（通过/驳回）。
   *
   * 顺序：授权 → 请求体闭集 → 字段级校验 → 路径参数 → **范围内**单条读取 →
   * 决定性授权（按存储归属）→ 读取契约 → 状态机 → 范围内条件写入。
   */
  async reviewApplication(
    subject: AuthorizationSubject,
    applicationId: string,
    body: unknown,
  ): Promise<ApplicationReviewView> {
    // 1. 授权：只用服务端主体
    const scope = this.resolveReviewScope(subject);

    // 2. 请求体闭集：客户端提交 status/reviewStatus/groupId/userId/roles/scope… 一律 400
    assertDeclaredReviewInputFields(body);

    // 3. 字段级校验：复用共享 schema（decision=approve|reject；驳回必须填写意见）
    const input = applicationReviewInputSchema.parse(body);

    // 4. 路径参数：申请 ID 必须是 UUID
    const { applicationId: id } = reviewApplicationIdSchema.parse({ applicationId });

    // 5. 范围内单条读取：范围外的申请与「不存在」在存储层就是同一种结果
    const record = await this.repository.findForReview(id, scope);
    if (!record) {
      // 与申请人端同口径：不区分「不存在」与「不在你的范围内」
      throw new NotFoundException('目标申请不存在或不可见');
    }

    // 6. 决定性授权：按**存储给出的**小组归属再判一次（范围谓词下推之外的纵深防御）
    this.authorizeStoredGroup(subject, readApplicationGroupId(record));

    // 7. 读取契约：存储记录必须完整合法，否则按服务端缺陷 500
    const stored = this.assertStoredApplication(record);

    // 8. 状态机是唯一权威：只有 pending 可以进入审核
    const target = reviewDecisionToApplicationStatus(input.decision);
    assertApplicationTransition(stored.status, target);

    // 9. 范围内的条件写入（记录不可变字段逐字段沿用存储值）
    const reviewed = toReviewedApplication(
      stored,
      target,
      subject.userId,
      input.comment,
      new Date().toISOString(),
    );

    let saved: Application;
    try {
      saved = await this.repository.saveReviewed(reviewed, scope);
    } catch (error) {
      if (error instanceof ApplicationReviewConflictError) {
        // 并发重复审核：客户端可见冲突，映射为与状态机拒绝一致的 409
        throw new StateTransitionError('application', stored.status, target);
      }
      throw error;
    }

    return this.toView(saved);
  }

  /**
   * 服务端范围解析（**纯主体**判定，不读请求任何字段）。
   *
   * 先用只读判定（`canAuthorize`）而不是「试着调用再捕获 403」：本方法需要**枚举候选范围**，
   * 把拒绝当控制流会让「无权」与「端口故障」混在一起。全局优先于小组：
   * 拥有全局审核能力的角色不需要再逐个小组判定。
   */
  private resolveReviewScope(subject: AuthorizationSubject): ApplicationReviewScope {
    if (this.canReviewGlobally(subject)) {
      return { kind: 'global' };
    }

    const groupIds = this.authorizedReviewGroupIds(subject);
    if (groupIds.length > 0) {
      return { kind: 'groups', groupIds };
    }

    throw new ForbiddenException(AUTHORIZATION_FORBIDDEN_MESSAGE);
  }

  /**
   * 把范围**收窄**到客户端指定的单个小组。
   *
   * 这是客户端 `groupId` 唯一被允许发挥作用的地方，且它只能让范围变小：
   * - 未提供 `groupId` → 原样返回服务端范围；
   * - 形状非法 → 400（形状错误，与授权无关）；
   * - 全局审核者且形状合法 → 收窄为单个小组（已有 GLOBAL 能力，不是扩张）；
   * - 小组审核者 → 必须**重新经端口判定**该小组是否在服务端 `subject.groupIds` 内，否则 403。
   */
  private narrowReviewScope(
    subject: AuthorizationSubject,
    scope: ApplicationReviewScope,
    groupId: string | undefined,
  ): ApplicationReviewScope {
    if (groupId === undefined) {
      return scope;
    }

    const { groupId: requested } = reviewListGroupIdSchema.parse({ groupId });

    if (
      this.guard.canAuthorize(subject, {
        permission: PermissionPoint.MembershipReviewGroup,
        scope: DataScope.Group,
        groupId: requested,
      })
    ) {
      return { kind: 'groups', groupIds: [requested] };
    }

    if (scope.kind === 'global') {
      return { kind: 'groups', groupIds: [requested] };
    }

    // 范围外的 groupId：与「不属于你」的其他拒绝同一文案
    throw new ForbiddenException(AUTHORIZATION_FORBIDDEN_MESSAGE);
  }

  private canReviewGlobally(subject: AuthorizationSubject): boolean {
    return this.guard.canAuthorize(subject, {
      permission: PermissionPoint.MembershipReviewGlobal,
      scope: DataScope.Global,
    });
  }

  /**
   * 服务端已验证的小组集合中，**逐个**询问端口哪些落在审核能力内。
   *
   * 候选来源是 `subject.groupIds`（会话存储解析值），去重后保持稳定顺序，
   * 因此范围内容可复现、可断言。空结果表示「一个小组都审不了」，由调用方转 403。
   */
  private authorizedReviewGroupIds(subject: AuthorizationSubject): readonly string[] {
    const candidates = Array.isArray(subject.groupIds) ? subject.groupIds : [];
    const seen = new Set<string>();
    const authorized: string[] = [];

    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate.length === 0 || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      if (
        this.guard.canAuthorize(subject, {
          permission: PermissionPoint.MembershipReviewGroup,
          scope: DataScope.Group,
          groupId: candidate,
        })
      ) {
        authorized.push(candidate);
      }
    }

    return authorized;
  }

  /**
   * 决定性授权：全局能力直接放行；否则必须对本条记录的**存储小组归属**通过 GROUP 判定。
   * 拒绝走 `assertAuthorized`，因此文案与范围拒绝完全一致（403「无权执行该操作」）。
   */
  private authorizeStoredGroup(subject: AuthorizationSubject, groupId: string): void {
    if (this.canReviewGlobally(subject)) {
      return;
    }
    this.guard.assertAuthorized(subject, {
      permission: PermissionPoint.MembershipReviewGroup,
      scope: DataScope.Group,
      groupId,
    });
  }

  /** 存储记录必须满足读取契约，否则按服务端缺陷 500（日志只含字段路径与违规类型） */
  private assertStoredApplication(record: unknown): StoredApplication {
    const parsed = parseReviewedApplication(record);
    if (!parsed.ok) {
      this.logger.error(
        `[application-reviews] 存储记录违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException('入组申请数据完整性校验失败');
    }
    return parsed.value;
  }

  /** 输出边界：存储记录先过读取契约，再投影为审核端视图 */
  private toView(record: Application): ApplicationReviewView {
    return toApplicationReviewView(this.assertStoredApplication(record));
  }
}

/** 记录的小组归属（不可读时返回空串，交由授权判定默认拒绝） */
function readApplicationGroupId(record: Application): string {
  return typeof record.groupId === 'string' ? record.groupId : '';
}

/**
 * 审核写入：只改审核相关字段与 `updatedAt`；归属、目标小组、类型、备注与创建时间
 * 逐字段沿用**存储值**（显式赋值，不用对象展开，避免把未知字段带进存储）。
 *
 * `reviewedByUserId` 取服务端会话主体（绝不来自身请求体），
 * `reviewComment` 来自经共享 schema 校验的 `comment`。
 */
function toReviewedApplication(
  record: StoredApplication,
  status: StoredApplication['status'],
  reviewerUserId: string,
  comment: string | undefined,
  now: string,
): Application {
  return {
    id: record.id,
    userId: record.userId,
    groupId: record.groupId,
    kind: record.kind,
    ...(record.note ? { note: record.note } : {}),
    status,
    reviewedByUserId: reviewerUserId,
    ...(comment ? { reviewComment: comment } : {}),
    reviewedAt: now,
    createdAt: record.createdAt,
    updatedAt: now,
  };
}

/** 供测试与调用方复用的类型出口（避免测试从实现文件深处导入） */
export type { ReviewDecision };
