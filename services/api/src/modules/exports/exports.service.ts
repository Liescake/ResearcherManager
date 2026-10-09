import { randomUUID } from 'node:crypto';
import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { DataScope, PermissionPoint } from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import {
  EXPORT_REQUEST_INTEGRITY_MESSAGE,
  assertDeclaredExportQueryFields,
  assertDeclaredExportRequestFields,
  exportRequestInputSchema,
  parseExportRequestView,
  parseStoredExportRequest,
  readArtifactId,
  readExportOwnerId,
  resolveExportFields,
  toExportRequestView,
} from './exports.contract';
import type { ExportRequestView } from './exports.contract';
import {
  EXPORT_ARTIFACT_STORE,
  EXPORT_REPOSITORY,
  ExportResource,
  ExportStatus,
} from './exports.port';
import type { ExportArtifactStore, ExportRepository, ExportRequest } from './exports.port';
import { EXPORT_ENTRY_STATUS, assertExportTransition } from './exports.state-machine';

/**
 * 导出切片（P8 最小垂直切片，本人侧）：
 * - `POST /me/exports` 创建**本人**的导出请求（服务端白名单资源 + 字段）；
 * - `GET  /me/exports` 本人导出请求列表与状态。
 *
 * 六条硬约束：
 * 1. **主体与结论都来自服务端**：`ownerUserId` 取 `AuthorizationSubject.userId`（由
 *    `SESSION_SUBJECT_RESOLVER` 从服务端会话存储解析），`id` / `artifactId` 是服务端 UUID，
 *    `status` 只由状态机写入（入口恒为 `pending`），`createdAt` / `updatedAt` 取服务端时钟；
 *    客户端提交的 `userId`/`roles`/`scope`/`groupId`/`status`/`fileUrl`/`path`/`artifactId`
 *    一律 400（输入闭集），不是静默剥离。自定义头（`x-user-id`/`x-roles`/`x-scope`/
 *    `x-group-id`）同样不参与任何判定。
 * 2. **授权先于一切**：先做**入口授权**（权限点与范围是服务端常量），再做请求体/查询串闭集与
 *    字段级校验，然后按 `resource` 做**资源级授权**，最后才可能触达仓储与产物存储。
 *    拒绝即 403，且此时两个端口的方法**一次都不会被调用**：未授权主体既拿不到任何字段级反馈，
 *    也不会在存储里留下写入副作用。
 * 3. **资源与字段都是服务端白名单**：`resource` 必须在闭集内；`fields` 必须落在该资源的
 *    服务端字段白名单内（缺省即白名单全集），白名单之外的取值一律 400 且**不回显取值**。
 *    「导出哪些列」由服务端契约决定，客户端只能在白名单内做选择。
 * 4. **状态机收敛且不可回退**：入口 `pending` → `completed` / `failed`；
 *    产物生成失败或产物存储返回非法句柄都收敛为 `failed` 终态（这是「导出没做出来」的业务事实，
 *    不把用户卡在 500 上）；仓储返回非 `pending` 记录（重复处理/数据被改写）由状态机拦截为
 *    409 `STATE_TRANSITION_INVALID`，绝不覆盖既有结论。
 * 5. **落库失败 fail-closed**：请求事实无法落库（`create` / `save` 抛异常）或写回记录未如实
 *    持久化本次结论时，返回 500 且不泄露内部细节——绝不返回「看起来成功但没有记录」的响应，
 *    也不把仓储的内部错误信息外发。
 * 6. **出口再校验一次**：存储记录必须满足读取契约（枚举闭集、字段白名单子集与去重、
 *    状态与产物句柄自洽、ISO 时间、字段闭集），违规或归属与会话主体不一致一律 500，
 *    且日志只写字段路径、不写取值；对外视图再过一遍 `.strict()` 白名单，多出字段即 500。
 *    视图**不含**归属、产物句柄、文件名、路径、下载地址与存储 key（那些字段在记录里就不存在）。
 *
 * 授权口径（已知偏差，与审计/通知/统计切片的处理同构，属后续版本项）：权限目录是**闭集**
 * （docs/P2-权限目录与状态机.md §1「未列出即拒绝」），其中 `export:{resource}:create` 的默认范围
 * 是 `GROUP`/`ASSIGNED` 等管理侧范围（矩阵里学生为「-」），用于 `/me/*` 端点会让所有本人请求 403；
 * 目录里也没有 `export:self:create`。因此本切片在闭集目录内复用**已有的 self 权限点**：
 * - 入口门控点 `profile:self:read`（与审计摘要、通知箱的处理一致——导出是「把本人可读数据
 *   交付给本人」的读侧动作）；
 * - 资源门控点按服务端白名单把 `resource` 映射到该资源的本人读取权限点
 *   （`profile:self:read` / `achievement:self:read` / `education:self:read`；
 *   `statistics` 与统计切片同口径，要求四类本人读取点全部通过）。
 * 新增 `export:self:create` 需要权限目录版本升级并同步公开契约夹具 `services/ruoyi-api/contracts`，
 * 属后续版本项；本切片**不新增权限点**。`resource=profile` 时入口与资源两段门控点相同：
 * 两段语义独立（入口 = 本人导出入口；资源 = 该资源的本人读取），重复判定不改变结果。
 *
 * 尚不包含（明确留给后续切片）：真实文件生成与字段级脱敏、文件有效期与清理、下载路由与
 * 下载审计、管理端 `POST /admin/exports` 与按资源/范围的导出、列表分页与筛选、
 * 幂等键与元数据落库（`export_requests` 表）、以及把本切片的产物句柄接入下载通道。
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(EXPORT_REPOSITORY) private readonly repository: ExportRepository,
    @Inject(EXPORT_ARTIFACT_STORE) private readonly artifacts: ExportArtifactStore,
  ) {}

  /**
   * 本人导出请求列表与状态：先入口授权，再查询串闭集，最后只按服务端主体取数。
   *
   * 契约改为异步后的**顺序约束没有变化**：入口授权与查询串闭集都在**任何 `await` 之前**完成，
   * 因此「未授权主体一次都不会触达仓储」在异步契约下同样成立 —— 拒绝路径上一个 Promise
   * 都不会被创建，更不会建立任何数据库连接。
   */
  async listMyExportRequests(
    subject: AuthorizationSubject,
    query: unknown,
  ): Promise<ExportRequestView[]> {
    // 1. 入口授权先于查询串校验与任何仓储访问（未授权主体拿不到任何字段级反馈）
    this.authorizeEntry(subject);

    // 2. 查询串闭集：`?status=`/`?userId=`/`?fileUrl=` 等一律 400，不是静默忽略
    assertDeclaredExportQueryFields(query);

    // 3. 只按服务端主体取数；逐条复核读取契约与归属（绝不外发他人记录）
    const records = await this.repository.listByOwnerId(subject.userId);
    return records.map((record) => this.toOwnedView(record, subject.userId));
  }

  /**
   * 创建本人导出请求。
   *
   * 判定顺序（被测试固定）：无有效会话 → 401（认证边界，见 controller）；入口授权拒绝 → 403；
   * 查询串带参数 / 请求体带服务端字段或未声明字段 → 400；资源不在白名单 → 400；
   * 资源级授权拒绝 → 403；字段不在该资源白名单内 → 400；入口写回被替换 → 500；仓储失败 → 500；
   * 产物生成失败 → 201 + `failed` 终态；仓储返回非 `pending` → 409。
   * 未授权请求在两个端口上都没有调用记录。
   */
  async createMyExportRequest(
    subject: AuthorizationSubject,
    query: unknown,
    body: unknown,
  ): Promise<ExportRequestView> {
    // 1. 入口授权（服务端常量）先于任何输入校验与任何端口调用
    this.authorizeEntry(subject);

    // 2. 查询串闭集：POST 同样不接受 `?userId=`/`?status=`/`?fileUrl=` 之类
    assertDeclaredExportQueryFields(query);

    // 3. 请求体闭集：服务端字段（归属/授权/状态/产物位置）与未声明字段可区分
    assertDeclaredExportRequestFields(body);

    // 4. 字段级 schema：缺 `resource`、非法类型、超长/超量字段名
    const input = exportRequestInputSchema.parse(body === undefined ? {} : body);

    // 5. 资源级授权：由**服务端白名单**把 resource 映射到原子权限点，仍先于字段白名单与端口调用
    this.authorizeResource(subject, input.resource);

    // 6. 字段白名单归一化（白名单之外的取值一律 400，且不回显取值）
    const fields = resolveExportFields(input.resource, input.fields);

    const now = new Date().toISOString();

    // 7. 入口记录：状态恒为 pending、无产物句柄；此时不得声称导出已生成
    const exportRequestId = randomUUID();
    const created = await this.repository.create({
      id: exportRequestId,
      ownerUserId: subject.userId,
      resource: input.resource,
      fields,
      status: EXPORT_ENTRY_STATUS,
      createdAt: now,
      updatedAt: now,
    });

    // 8. 入口写回复核（**先于任何产物副作用**）：仓储返回的记录必须与本次写入同一身份与范围。
    //    被替换的记录（他人归属/别的资源/别的字段）说明存储或调用链已损坏：立即 500，
    //    绝不为他人或别的导出范围产出服务端产物。
    this.assertRecordedEntry(created, {
      id: exportRequestId,
      ownerUserId: subject.userId,
      resource: input.resource,
      fields,
    });

    // 9. 状态机门禁：本切片在同一个请求内把 `pending` 推进到终态，因此「推进目标」是服务端常量
    //    `completed`；仓储若返回非 `pending` 记录（重复处理 / 数据被改写）→ 409
    //    `STATE_TRANSITION_INVALID`。产物生成失败时结论改判 `failed`
    //    （`pending -> failed` 同样由状态机表允许）。
    assertExportTransition(created.status, ExportStatus.Completed);

    const outcome = this.materialize(created);

    const saved = await this.repository.save({
      ...created,
      status: outcome.status,
      ...(outcome.artifactId !== undefined ? { artifactId: outcome.artifactId } : {}),
      updatedAt: new Date().toISOString(),
    });

    // 10. 写回复核：仓储必须如实持久化本次结论（状态与产物句柄）
    this.assertRecordedOutcome(saved, outcome);

    return this.toOwnedView(saved, subject.userId);
  }

  /**
   * 入口门控点：权限点与范围都是**服务端常量**，`resourceUserId` 取会话主体；
   * 不接受任何客户端提交的角色、范围或归属，因此伪造的 claims 无法让入口通过。
   */
  private authorizeEntry(subject: AuthorizationSubject): void {
    this.authorizeSelf(subject, EXPORT_ENTRY_PERMISSION);
  }

  /**
   * 资源级门控点：把**已通过白名单校验**的 `resource` 映射到该资源的本人读取权限点，
   * 缺一即 403。映射表是服务端常量，客户端无法用 `resource` 之外的任何输入影响它。
   */
  private authorizeResource(subject: AuthorizationSubject, resource: ExportResource): void {
    for (const permission of EXPORT_RESOURCE_READ_PERMISSIONS[resource]) {
      this.authorizeSelf(subject, permission);
    }
  }

  /** 单次判定：权限点为服务端常量，范围恒为 `SELF`，资源归属恒为会话主体 */
  private authorizeSelf(subject: AuthorizationSubject, permission: PermissionPoint): void {
    this.guard.assertAuthorized(subject, {
      permission,
      scope: DataScope.Self,
      resourceUserId: subject.userId,
    });
  }

  /**
   * 产物物化：把记录（归属、资源、字段全部来自服务端）交给产物存储。
   *
   * 失败语义被刻意分开：
   * - 产物存储抛异常或返回形态非法的句柄 ⇒ `failed` 终态（「导出没做出来」是业务事实，
   *   用户应当能看到状态，而不是被 500 卡住）；
   * - 仓储（`EXPORT_REPOSITORY`）抛异常 ⇒ 由调用链抛到统一错误出口，映射为 500
   *   （请求事实无法落库，fail-closed）。
   * 两条路径都**不把内部错误原文、错误名以外的细节或非法返回值外发**。
   */
  private materialize(created: ExportRequest): ExportMaterializationOutcome {
    try {
      const ref = this.artifacts.store({
        exportRequestId: created.id,
        ownerUserId: created.ownerUserId,
        resource: created.resource,
        fields: [...created.fields],
      });

      const artifactId = readArtifactId(ref);
      if (artifactId === undefined) {
        this.logger.error('[exports] 产物存储返回了非法句柄，导出按失败收敛');
        return { status: ExportStatus.Failed };
      }

      return { status: ExportStatus.Completed, artifactId };
    } catch (error) {
      // 只记录错误名，不记录消息（可能含内部路径/连接串）与任何 spec 取值
      this.logger.error(
        `[exports] 产物生成失败: ${error instanceof Error ? error.name : typeof error}`,
      );
      return { status: ExportStatus.Failed };
    }
  }

  /**
   * 入口写回复核：仓储返回的入口记录必须与本次写入**同一身份、同一导出范围**
   * （主键、归属、资源与字段都不得被替换）。
   *
   * 不一致说明仓储或调用链已损坏：立即 500（共用完整性文案，不记录取值），
   * 且此时**不会生成任何产物**——否则可能为他人或别的导出范围产出服务端产物。
   * 状态**不在**这里判定：`pending -> 终态` 的推进由状态机负责（非 `pending` 记录 → 409）。
   */
  private assertRecordedEntry(created: ExportRequest, expected: ExportEntryExpectation): void {
    const sameFields =
      created.fields.length === expected.fields.length &&
      created.fields.every((field, index) => field === expected.fields[index]);

    if (
      created.id !== expected.id ||
      created.ownerUserId !== expected.ownerUserId ||
      created.resource !== expected.resource ||
      !sameFields
    ) {
      this.logger.error('[exports] 仓储返回的入口记录与写入不一致（主键/归属/资源/字段被替换）');
      throw new InternalServerErrorException(EXPORT_REQUEST_INTEGRITY_MESSAGE);
    }
  }

  /**
   * 写回复核：仓储返回的记录必须与本次结论一致。
   * 状态未推进或产物句柄未被持久化都属服务端缺陷（500，共用同一文案），
   * 调用方因此无法据此区分「仓储坏了」与「数据被改写」。
   */
  private assertRecordedOutcome(saved: ExportRequest, outcome: ExportMaterializationOutcome): void {
    if (saved.status !== outcome.status) {
      this.logger.error('[exports] 仓储未持久化状态推进（写回状态与结论不一致）');
      throw new InternalServerErrorException(EXPORT_REQUEST_INTEGRITY_MESSAGE);
    }
    if (outcome.artifactId !== undefined && saved.artifactId !== outcome.artifactId) {
      this.logger.error('[exports] 仓储未持久化服务端产物句柄（写回句柄与结论不一致）');
      throw new InternalServerErrorException(EXPORT_REQUEST_INTEGRITY_MESSAGE);
    }
  }

  /**
   * 输出边界：先过读取契约（枚举/字段白名单/状态自洽/字段闭集），再复核归属
   * （纵深防御：仓储未按主体过滤、数据被外部改写），最后过一遍出口白名单。
   * 违反者 500 且使用同一文案，日志只写字段路径与违规类型，不写取值、不外发任何记录内容。
   */
  private toOwnedView(record: unknown, expectedOwnerId: string): ExportRequestView {
    const parsed = parseStoredExportRequest(record);
    if (!parsed.ok) {
      this.logger.error(
        `[exports] 存储记录违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(EXPORT_REQUEST_INTEGRITY_MESSAGE);
    }

    if (readExportOwnerId(parsed.value) !== expectedOwnerId) {
      this.logger.error('[exports] 存储记录归属与会话主体不一致（仓储未按主体过滤）');
      throw new InternalServerErrorException(EXPORT_REQUEST_INTEGRITY_MESSAGE);
    }

    const view = parseExportRequestView(toExportRequestView(parsed.value));
    if (!view.ok) {
      this.logger.error(
        `[exports] 对外视图违反输出白名单: ${view.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(EXPORT_REQUEST_INTEGRITY_MESSAGE);
    }

    return view.value;
  }
}

/** 物化结论：终态与（仅在 `completed` 时存在的）服务端产物句柄 */
interface ExportMaterializationOutcome {
  readonly status: ExportStatus;
  readonly artifactId?: string;
}

/** 入口写入的服务端期望值：用于复核仓储是否如实保存了本次入口记录 */
interface ExportEntryExpectation {
  readonly id: string;
  readonly ownerUserId: string;
  readonly resource: ExportResource;
  readonly fields: readonly string[];
}

/**
 * 导出入口门控点（服务端常量）：`profile:self:read` + `SELF`。
 * 复用已有的 self 权限点（不新增权限点），理由见类注释的「授权口径（已知偏差）」。
 */
export const EXPORT_ENTRY_PERMISSION: PermissionPoint = PermissionPoint.ProfileSelfRead;

/**
 * 资源 → 本人读取门控点的**服务端白名单映射**：客户端只能用 `resource` 在闭集内选择，
 * 无法用它把判定降级到别的资源或别的范围。
 * `statistics` 与统计切片同口径：本人统计需要四类本人读取点全部通过。
 */
export const EXPORT_RESOURCE_READ_PERMISSIONS: Readonly<
  Record<ExportResource, readonly PermissionPoint[]>
> = {
  [ExportResource.Profile]: [PermissionPoint.ProfileSelfRead],
  [ExportResource.Achievement]: [PermissionPoint.AchievementSelfRead],
  [ExportResource.Education]: [PermissionPoint.EducationSelfRead],
  [ExportResource.Statistics]: [
    PermissionPoint.EducationSelfRead,
    PermissionPoint.MembershipSelfCreate,
    PermissionPoint.AchievementSelfRead,
    PermissionPoint.MatchingSelfRequest,
  ],
};
