import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ApplicationStatus,
  DataScope,
  PermissionPoint,
  assertApplicationTransition,
  isApplicationTerminal,
  joinApplicationInputSchema,
  withdrawApplicationInputSchema,
} from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import {
  APPLICATION_INITIAL_STATUS,
  APPLICATION_SLICE_KIND,
  assertDeclaredApplicationInputFields,
  assertNoWithdrawBodyFields,
  parseStoredApplication,
  readApplicationOwnerId,
  toApplicationView,
} from './applications.contract';
import type { ApplicationView, StoredApplication } from './applications.contract';
import { APPLICATION_REPOSITORY } from './applications.port';
import type { Application, ApplicationRepository } from './applications.port';

/**
 * 入组申请切片（P6 最小垂直切片，学生自服务部分）：
 * - `POST /me/applications`                        创建本人入组申请（`membership:self:create`）
 * - `GET  /me/applications`                        本人申请列表（`membership:self:create`，见下方口径说明）
 * - `POST /me/applications/{applicationId}/withdraw` 撤回本人待审核申请（`membership:self:withdraw`）
 *
 * 五条硬约束：
 * 1. **主体与资源归属都来自服务端**：`userId` 取自会话主体，`status` 由共享状态机写入，
 *    `kind` 是服务端常量；客户端提交的 `status`/`reviewStatus`/`userId`/`roles`/`scope`/`groupIds`
 *    既不能进入判定，也不能落库——它们由输入闭集直接拒绝（400），不是静默剥离。
 * 2. **授权先于任何存储访问**：三条路由都先经 `AuthorizationGuard`（其下是
 *    `RUOYI_AUTHZ_ADAPTER` 端口 → canonical 谓词），拒绝即 403；`scope` 恒为服务端常量 `SELF`，
 *    `resourceUserId` 取会话主体。未授权主体既观察不到申请是否存在，也拿不到字段级校验反馈。
 * 3. **请求字段闭集**：创建只接受共享 `joinApplicationInputSchema` 的字段（`groupId`/`note`），
 *    撤回不接受任何请求体字段，唯一输入是路径里的申请 ID。
 * 4. **状态只能由服务端状态机推进**：创建固定落在 `pending`；撤回必须满足
 *    `pending -> withdrawn`，否则抛 `StateTransitionError`（由统一异常过滤器映射为
 *    409 `STATE_TRANSITION_INVALID`），重复撤回不会产生第二次状态变化。
 * 5. **输出前再校验一次**：存储记录必须满足读取契约（枚举闭集 + ISO 时间戳），违反者按
 *    服务端缺陷 500 处理；对外视图不含 `userId` 与审核人/审核意见/审核时间。
 *
 * 读取口径（`GET /me/applications` 的权限点）：
 * 权限目录是**闭集**（docs/P2-权限目录与状态机.md §1「未列出即拒绝」），其中 membership 自有侧
 * 只有 `create`/`withdraw` 两点，没有 self-read 点。本切片在闭集目录内选取 `membership:self:create`
 * 作为「本人申请自服务」能力的读取侧门控点：
 * - 它对学生角色默认授予（`DEFAULT_ROLE_PERMISSIONS`），因此本人列表对申请人是可用的；
 * - 缺该点的角色（如普通管理员/小组负责人）得到 403，而不是「认证即可读」，
 *   保证读取路径同样经过端口判定、fail-closed；
 * - 由于闭集目录不允许臆造权限点（新增 `membership:self:read` 需要权限目录版本升级并同步
 *   公开契约夹具 `services/ruoyi-api/contracts`），本切片**不新增权限点**，并把该口径写入报告
 *   与 README 作为后续版本项。
 *
 * 本切片不做（明确留给后续切片）：小组存在性与招募状态校验（需要 `groups` 仓储端口）、
 * 审核（`membership:review:group` / `membership:review:global`）、退组申请、成员关系联动、
 * 结果通知、幂等键与审计落库、列表分页/排序/过滤。
 */
@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(APPLICATION_REPOSITORY) private readonly repository: ApplicationRepository,
  ) {}

  /** 本人申请列表：先做集合级 SELF 判定，再按服务端主体取数 */
  listMyApplications(subject: AuthorizationSubject): ApplicationView[] {
    this.authorizeSelf(subject, PermissionPoint.MembershipSelfCreate);
    return this.repository.listByUserId(subject.userId).map((record) => this.toView(record));
  }

  /** 创建本人入组申请：归属、类型、审核状态全部由服务端决定 */
  createMyApplication(subject: AuthorizationSubject, body: unknown): ApplicationView {
    this.authorizeSelf(subject, PermissionPoint.MembershipSelfCreate);

    // 输入闭集 → 字段级校验（共享 zod schema）：未知枚举、缺 groupId、非 UUID 小组、
    // 备注含控制字符或敏感内容等一律抛 ZodError，由统一异常过滤器映射为 400。
    assertDeclaredApplicationInputFields(body);
    const input = joinApplicationInputSchema.parse(body);

    // 数据约束：同一用户同一小组只能有一个未终态的入组申请（docs/P2-权限目录与状态机.md §3）。
    // 终态判定复用共享状态机的终态集合，仓储只按字段过滤、不理解业务语义。
    const pending = this.repository
      .listByUserAndGroup(subject.userId, input.groupId)
      .filter((record) => !isApplicationTerminal(record.status));
    if (pending.length > 0) {
      // 不返回既有申请的 ID/内容：重复提交者不需要通过错误响应获得他人可见的申请标识
      throw new ConflictException('该小组已有未完成的入组申请，请勿重复提交');
    }

    const now = new Date().toISOString();
    const created = this.repository.create({
      id: randomUUID(),
      userId: subject.userId,
      groupId: input.groupId,
      kind: APPLICATION_SLICE_KIND,
      ...(input.note ? { note: input.note } : {}),
      // 审核态只能由服务端写入：学生自建申请一律待审核
      status: APPLICATION_INITIAL_STATUS,
      createdAt: now,
      updatedAt: now,
    });

    return this.toView(created);
  }

  /**
   * 撤回本人待审核申请。
   *
   * 判定顺序（被测试固定）：无有效会话 → 401（认证边界，见 controller）；授权拒绝 → 403；
   * 路径 ID 非法 → 400；申请不存在 → 404；存储归属与主体不一致 → 403（同一文案）；
   * 存储记录违反读取契约 → 500；状态机不允许该转移 → 409；请求体带字段 → 400。
   * 其中授权排在最前：无权主体拿不到任何关于「申请是否存在」或「字段是否合法」的信息。
   *
   * `body` 只是需要被 fail-closed 拒绝的「不应存在之物」：撤回的唯一输入是路径中的申请 ID，
   * 因此它作为显式参数传入（服务是单例，绝不保存任何请求级状态），不参与任何业务判定。
   */
  withdrawMyApplication(
    subject: AuthorizationSubject,
    applicationId: string,
    body: unknown,
  ): ApplicationView {
    this.authorizeSelf(subject, PermissionPoint.MembershipSelfWithdraw);

    // 撤回不接受请求体：唯一输入是路径参数
    assertNoWithdrawBodyFields(body);
    // 路径参数用共享 schema 校验（applicationId 必须是 UUID），非法即 400
    const { applicationId: id } = withdrawApplicationInputSchema.parse({ applicationId });

    const record = this.repository.findById(id);
    if (!record) {
      throw new NotFoundException('目标申请不存在或不可见');
    }

    // 纵深防御：取数后**再按存储给出的归属**做一次同样的 SELF 判定（异常仓储 / 横向越权 /
    // 数据被外部改写）。归属不可读时按空串处理，SELF 谓词必然拒绝 → 403；
    // 该 403 与授权拒绝走同一条端口路径、同一个文案，调用方无法据此区分原因。
    this.authorizeSelf(
      subject,
      PermissionPoint.MembershipSelfWithdraw,
      readApplicationOwnerId(record),
    );

    const stored = this.assertStoredApplication(record);
    // 状态机是唯一权威：只有 pending 可以撤回，终态（approved/rejected/withdrawn/completed）
    // 一律 409 STATE_TRANSITION_INVALID，客户端无法通过重复请求改写结果。
    assertApplicationTransition(stored.status, ApplicationStatus.Withdrawn);

    const withdrawn = this.repository.save(
      toWithdrawnApplication(stored, new Date().toISOString()),
    );
    return this.toView(withdrawn);
  }

  /**
   * 授权判定：权限点与范围恒为服务端常量 `SELF`。
   * `resourceUserId` 默认取**会话主体**（服务端解析值），只有撤回的第二次判定会显式传入
   * **存储给出的归属**；两处都不接受任何客户端提交的字段。
   */
  private authorizeSelf(
    subject: AuthorizationSubject,
    permission: PermissionPoint,
    resourceUserId: string = subject.userId,
  ): void {
    this.guard.assertAuthorized(subject, {
      permission,
      scope: DataScope.Self,
      resourceUserId,
    });
  }

  /** 存储记录必须满足读取契约，否则按服务端缺陷 500（日志不含字段取值） */
  private assertStoredApplication(record: unknown): StoredApplication {
    const parsed = parseStoredApplication(record);
    if (!parsed.ok) {
      this.logger.error(
        `[applications] 存储记录违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException('入组申请数据完整性校验失败');
    }
    return parsed.value;
  }

  /** 输出边界：即便是仓储返回的对象也要先过读取契约，再投影为不含归属/审核字段的视图 */
  private toView(record: Application): ApplicationView {
    return toApplicationView(this.assertStoredApplication(record));
  }
}

/**
 * 撤回写入：只改 `status` 与 `updatedAt`，归属、目标小组、类型、备注与审核字段逐字段沿用
 * 存储值（显式赋值，不用对象展开，避免把未知字段带进存储）。
 */
function toWithdrawnApplication(record: StoredApplication, now: string): Application {
  return {
    id: record.id,
    userId: record.userId,
    groupId: record.groupId,
    kind: record.kind,
    ...(record.note ? { note: record.note } : {}),
    status: ApplicationStatus.Withdrawn,
    ...(record.reviewedByUserId ? { reviewedByUserId: record.reviewedByUserId } : {}),
    ...(record.reviewComment ? { reviewComment: record.reviewComment } : {}),
    ...(record.reviewedAt ? { reviewedAt: record.reviewedAt } : {}),
    createdAt: record.createdAt,
    updatedAt: now,
  };
}
