import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataScope, PermissionPoint, StateTransitionError } from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import {
  EXPORT_DOWNLOAD_CONTENT_TYPE,
  EXPORT_DOWNLOAD_MAX_BYTES,
  EXPORT_DOWNLOAD_UNAVAILABLE_MESSAGE,
  EXPORT_REQUEST_INTEGRITY_MESSAGE,
  EXPORT_REVOCATION_UNAVAILABLE_MESSAGE,
  ExportRevocationVerdict,
  assertDeclaredExportListQueryFields,
  assertDeclaredExportQueryFields,
  assertDeclaredExportRequestFields,
  assertDeclaredExportRevocationRequestFields,
  assertSafeExportDownloadHeaderValue,
  buildExportDownloadDisposition,
  buildExportDownloadFilename,
  classifyExportRevocation,
  digestExportId,
  digestRequesterId,
  exportDownloadIdSchema,
  exportExpiresAtFrom,
  exportListQuerySchema,
  exportRequestInputSchema,
  exportRevokeIdSchema,
  isExportDownloadExpired,
  parseExportRequestView,
  parseStoredExportRequest,
  readArtifactId,
  readExportOwnerId,
  resolveExportFields,
  toExportPageMeta,
  toExportRequestView,
} from './exports.contract';
import type { ExportRequestPage, ExportRequestView } from './exports.contract';
import { EXPORT_CURSOR_CODEC } from './exports.cursor';
import type { ExportCursorCodec } from './exports.cursor';
import {
  EXPORT_ARTIFACT_STORE,
  EXPORT_DOWNLOAD_AUDIT,
  EXPORT_REPOSITORY,
  EXPORT_REVOCATION_AUDIT,
  ExportDownloadAuditResult,
  ExportResource,
  ExportRevocationAuditResult,
  ExportRevocationOutcome,
  ExportStatus,
  isExportTransitionRejection,
} from './exports.port';
import type {
  ExportArtifactContent,
  ExportArtifactStore,
  ExportDownloadAuditSink,
  ExportRepository,
  ExportRequest,
  ExportRevocationAuditSink,
  ExportRevocationResult,
} from './exports.port';
import { EXPORT_ENTRY_STATUS, assertExportTransition } from './exports.state-machine';

/**
 * 导出切片（本人侧）：
 * - `POST /me/exports` 创建**本人**的导出请求（服务端白名单资源 + 字段）；
 * - `GET  /me/exports` 本人导出请求列表与状态；
 * - `GET  /me/exports/:exportId/download` 下载本人**已完成**导出的产物内容；
 * - `POST /me/exports/:exportId/revoke` **本人撤销**自己的导出请求（写 `revoked_at`）。
 *
 * 硬约束（前六条对四条路由都成立；第七条只对下载成立；第八条只对撤销成立）：
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
 *    409 `STATE_TRANSITION_INVALID`，绝不覆盖既有结论。数据库 adapter 的条件写入是这条规则的
 *    **存储层镜像**：并发下未命中时抛出的错误带端口标记 `EXPORT_TRANSITION_REJECTED`，
 *    由本服务的写回边界映射为**同一个** 409（`StateTransitionError`），并发重复推进同样是 409。
 * 5. **落库失败 fail-closed**：请求事实无法落库（`create` / `save` 抛异常）或写回记录未如实
 *    持久化本次结论时，返回 500 且不泄露内部细节——绝不返回「看起来成功但没有记录」的响应，
 *    也不把仓储的内部错误信息外发。**唯一的例外**是上面那条客户端可见冲突（端口标记
 *    `EXPORT_TRANSITION_REJECTED` → 409）：它按结构化 `code` 判定，错误消息里的 SQL、归属、
 *    文件路径与 PII 既不参与判定也不进入响应。
 * 6. **出口再校验一次**：存储记录必须满足读取契约（枚举闭集、字段白名单子集与去重、
 *    状态与产物句柄自洽、ISO 时间、字段闭集），违规或归属与会话主体不一致一律 500，
 *    且日志只写字段路径、不写取值；对外视图再过一遍 `.strict()` 白名单，多出字段即 500。
 *    视图**不含**归属、产物句柄、文件名、路径、下载地址与存储 key（那些字段在记录里就不存在）。
 * 7. **下载只交付内容，不交付位置**（`GET /me/exports/:exportId/download`）：
 *    - 归属同时来自**会话主体**与**服务端记录**（取数语句把归属下推进存储：`findByIdForOwner`），
 *      客户端提交的 `userId` / `ownerUserId` / `artifactId` / `fileUrl` / `expiresAt` / 自定义路径与
 *      自定义头一律不参与判定（查询串闭集直接 400，控制器也不读任何自定义头）；
 *    - 「不存在 / 跨主体 / 未完成 / 产物缺失 / 空产物 / **已过期** / **无服务端有效期**」收敛到
 *      **同一个稳定拒绝**（404 + 同一条文案 + 同一个审计结果码），因此拒绝本身不泄露存在性、
 *      状态或「是否已过期」；仓储故障、产物读取故障、内容超限、存储记录违约则是 fail-closed 500
 *      （不把基础设施故障伪装成业务结论）；
 *    - **有效期是服务端独占事实**：`expiresAt` 由 service 在创建入口用服务端时钟算出
 *      （`createdAt + EXPORT_DOWNLOAD_TTL_MS`，UTC 绝对时刻），客户端提交的同名字段一律 400，
 *      写回路径不改写它；下载时只读一次服务端时钟做**绝对时刻**比较，边界时刻判为过期，
 *      缺省 / 非法形态按 fail-closed 拒绝（绝不解释成「永不过期」）；
 *    - 产物内容由 `ExportArtifactStore.read` 给出：**只有字节**，没有 storage key / 路径 /
 *      下载地址 / 签名地址；响应头取值（Content-Type / Content-Disposition 文件名）由服务端
 *      常量派生并再过一次「控制字符 / 路径 / 引号」门禁，命中即 500 且一个字节都不写出；
 *    - 内容有**硬上限**（`EXPORT_DOWNLOAD_MAX_BYTES`），超限不截断、不分片、不流式降级；
 *    - 下载留痕只写**脱敏三元组**（服务端生成的 requestId、导出 ID 的单向摘要、结果码），
 *      不写内容、产物位置、有效期、归属、请求侧输入或 PII；留痕失败即 500
 *      （不做「没有留痕的成功下载」）。
 * 8. **撤销只取回交付能力，不删除任何东西**（`POST /me/exports/:exportId/revoke`）：
 *    - 归属只来自**会话主体**并下推进存储（`findByIdForOwner`）；客户端提交的
 *      `userId` / `ownerId` / `artifactId` / `path` / `status` / `revokedAt` 一律 400
 *      （查询串闭集与请求体空闭集），自定义头从不进入判定；
 *    - 可撤销判定是**纯函数**且只用**单次**服务端时钟读数：已撤销 ⇒ 幂等成功；
 *      `failed` 结论 / 已过期 ⇒ 与「不存在 / 跨主体」收敛到**同一个** 404 出口；
 *    - 写库是**条件更新**：`WHERE id + 归属 + 可撤销前驱集合 + revoked_at IS NULL`，
 *      `SET` **只**写 `revoked_at` / `updated_at` —— 不覆盖 `created_at` / `expires_at` /
 *      `artifact_id` / `status`（`failed` 终态写不中），也不删行、不清理产物；
 *    - **撤销优先于完成**：`save`（状态机推进）的 `SET` 列表里没有 `revoked_at`，
 *      因此并发完成既不会清空撤销事实、也不会被撤销的条件谓词挡住；下载边界按
 *      「已撤销 ⇒ 统一拒绝」判定，撤销事实**胜出**，一次并发完成不能把已取回的交付能力放开；
 *    - 撤销留痕只写**脱敏四元组**（服务端 requestId、导出 ID 单向摘要、**请求主体单向摘要**、
 *      结果码 `success` / `duplicate` / `unavailable`），**不写 body**、不写 PII / 路径 /
 *      storage key / 产物句柄 / secret；留痕失败即 500（但已落库的撤销时刻不回滚 ——
 *      单调事实 + 幂等入口使客户端重试自然收敛到 `duplicate`）。
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
 * 尚不包含（明确留给后续切片）：真实文件生成与字段级脱敏、**过期产物的清理 / 回收**
 * （本切片只判定「过期即拒绝下载」，并允许「未过期且未撤销」的导出被本人撤销；
 * 撤销**不做**物理删除与产物清理 —— 异步清理属后续切片，能力边界登记在
 * `EXPORT_REVOCATION_CLEANUP_BOUNDARY`）、有效期续期入口、
 * 管理端 `POST /admin/exports` 与按资源/范围的导出、**列表的筛选**（分页已在本切片落地：
 * 键集分页 + 不透明签名游标）、幂等键与元数据落库、下载限流与审计的持久化查询面。
 * 下载切片已落地的是**交付边界**本身（归属、状态、授权、硬上限、响应头、留痕脱敏），
 * 撤销切片已落地的是**取回边界**本身（归属、可撤销判定、条件更新、幂等、留痕脱敏），
 * 它们复用内存基线产物存储的**最小读能力**，不伪造生产文件下载。
 *
 * ## 列表分页的安全边界（本切片新增）
 * - **游标是不透明签名串**：载荷只有版本号与两个排序键分量（该主体在公开视图里已经收到的
 *   `createdAt` / `id`），**没有**归属、产物句柄、路径、存储 key 或任何 PII；签名密钥由
 *   服务端主体派生，因此**跨主体重放**与**篡改**在同一条判定上失败（同一个 400）；
 * - **归属只来自服务端会话**：`?userId=` / `?ownerUserId=` / `?groupId=` / `?status=` /
 *   `?fileUrl=` / `?path=` / `?artifactId=` 一律 400（可区分原因），既不读取也不信任；
 * - **页大小有界**：`limit` 缺省取服务端默认值，上界是服务端常量，仓储侧再判一次
 *   （绝不「夹到上界继续」）；
 * - **排序与边界都由服务端固定**：`(createdAt ASC, id ASC)`，边界是严格大于，
 *   客户端无法提交排序字段或边界键值。
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(EXPORT_REPOSITORY) private readonly repository: ExportRepository,
    @Inject(EXPORT_ARTIFACT_STORE) private readonly artifacts: ExportArtifactStore,
    @Inject(EXPORT_DOWNLOAD_AUDIT) private readonly downloadAudit: ExportDownloadAuditSink,
    @Inject(EXPORT_REVOCATION_AUDIT) private readonly revocationAudit: ExportRevocationAuditSink,
    @Inject(EXPORT_CURSOR_CODEC) private readonly cursors: ExportCursorCodec,
  ) {}

  /**
   * 本人导出请求列表与状态（**键集分页**）：先入口授权，再查询串闭集与分页参数校验，
   * 最后只按服务端主体、按服务端给定的窗口取数。
   *
   * 判定顺序（被测试固定，且契约改为异步后顺序约束不变）：
   * 1. 入口授权（服务端常量）先于一切输入校验与任何取数：未授权主体**一次都不会触达仓储**，
   *    拒绝路径上一个 Promise 都不会被创建，更不会建立任何数据库连接；
   * 2. 查询串闭集：`cursor` / `limit` 之外的任何查询参数一律 400，其中归属 / 授权 / 状态 /
   *    产物位置类参数**可区分地**拒绝（`禁止使用查询参数 userId`），而不是静默忽略；
   * 3. 分页参数 schema：`limit` 必须是服务端闭集内的严格正整数（缺省 = 服务端默认值），
   *    `cursor` 必须是形态合规的短串；超长 / 非 base64url / 段数不对在**解码之前**就 400；
   * 4. **游标校验绑定服务端主体**：`decode(cursor, subject.userId)` —— 篡改与**跨主体重放**
   *    在这里收敛为同一个 400（同一个错误码、同一条文案，不区分原因、不回显取值）；
   *    游标里没有归属明文：绑定靠的是「签名密钥由服务端主体派生」；
   * 5. 取数：`listByOwnerIdPage(subject.userId, {limit, after})` —— 主体只来自服务端会话，
   *    窗口只来自服务端校验结果；仓储把归属下推进存储，并按键集全序取**一页**；
   * 6. 逐条复核读取契约、归属与出口白名单（`toOwnedView`），任何一条不合规即 500
   *    （绝不「跳过坏行继续返回」）；
   * 7. 下一页游标由**本页最后一行**签发（`hasNext` 为 false 时不签发），
   *    因此 `hasNext === true` 与 `nextCursor !== null` 互为充要条件。
   */
  async listMyExportRequests(
    subject: AuthorizationSubject,
    query: unknown,
  ): Promise<ExportRequestPage> {
    // 1. 入口授权先于查询串校验与任何仓储访问（未授权主体拿不到任何字段级反馈）
    this.authorizeEntry(subject);

    // 2. 列表端点的查询串闭集：`cursor` / `limit` 之外一律 400，不是静默忽略
    assertDeclaredExportListQueryFields(query);

    // 3. 分页参数 schema（limit 默认值与上界都是服务端常量；cursor 先过形态与长度门禁）
    const input = exportListQuerySchema.parse(query === undefined || query === null ? {} : query);

    // 4. 游标解码：签名校验 + 主体绑定。篡改 / 跨主体重放 / 版本不符都收敛为同一个 400，
    //    且**先于任何取数**：存储层不会因为一个伪造游标被访问
    const after =
      input.cursor === undefined ? undefined : this.cursors.decode(input.cursor, subject.userId);

    // 5. 只按服务端主体取一页；归属下推进仓储，排序与边界由仓储的键集实现保证
    const page = await this.repository.listByOwnerIdPage(subject.userId, {
      limit: input.limit,
      ...(after === undefined ? {} : { after }),
    });

    // 5b. **窗口契约复核**（纵深防御）：`hasNext = true` 只可能来自「取到 limit + 1 行」的探针，
    //     因此此时 `records` 必须恰好是 `limit` 行；任何「多返行 / 少返行 / hasNext 与行数不自洽」
    //     都是仓储缺陷 ⇒ 500。若放过它，就会出现「`hasNext: true` 却没有可签发游标的边界行」
    //     这种自相矛盾的分页元数据，客户端会卡在死循环里。
    if (
      page.records.length > input.limit ||
      (page.hasNext && page.records.length !== input.limit)
    ) {
      this.logger.error(
        '[exports] 仓储返回的分页窗口与端口契约不符（行数超出窗口，或 hasNext 与行数不自洽）',
      );
      throw new InternalServerErrorException(EXPORT_REQUEST_INTEGRITY_MESSAGE);
    }

    // 6. 逐条复核读取契约与归属（绝不外发他人记录）
    const items = page.records.map((record) => this.toOwnedView(record, subject.userId));

    // 7. 下一页游标由**本页最后一行**签发：`hasNext` 为真时必然存在一行（limit ≥ 1），
    //    `hasNext` 为假时不签发（`nextCursor` 恒为 null，客户端不需要二次探测）
    const boundary = page.hasNext ? items[items.length - 1] : undefined;
    const nextCursor =
      boundary === undefined
        ? undefined
        : this.cursors.encode({ createdAt: boundary.createdAt, id: boundary.id }, subject.userId);

    return { items, page: toExportPageMeta(input.limit, page.hasNext, nextCursor) };
  }

  /**
   * 创建本人导出请求。
   *
   * 判定顺序（被测试固定）：无有效会话 → 401（认证边界，见 controller）；入口授权拒绝 → 403；
   * 查询串带参数 / 请求体带服务端字段或未声明字段 → 400；资源不在白名单 → 400；
   * 资源级授权拒绝 → 403；字段不在该资源白名单内 → 400；入口写回被替换 → 500；仓储失败 → 500；
   * 产物生成失败 → 201 + `failed` 终态；仓储返回非 `pending` 或写回被存储层条件谓词拒绝
   * （并发重复推进）→ 409 `STATE_TRANSITION_INVALID`。
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

    // 7. **服务端时钟只读一次**：`createdAt` 与 `expiresAt` 必须来自同一次读取，
    //    否则「有效期在创建时间之后」这条存储层不变式会因为两次时钟读取的漂移而出现边界噪音。
    //    `expiresAt` 由服务端 TTL 派生（UTC 绝对时刻），**绝不取自请求体**：
    //    客户端的同名字段在闭集门禁处就已经 400（见 exports.contract.ts 的禁止字段清单）。
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const expiresAt = exportExpiresAtFrom(nowMs);

    // 8. 入口记录：状态恒为 pending、无产物句柄；此时不得声称导出已生成
    const exportRequestId = randomUUID();
    const created = await this.repository.create({
      id: exportRequestId,
      ownerUserId: subject.userId,
      resource: input.resource,
      fields,
      status: EXPORT_ENTRY_STATUS,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    // 9. 入口写回复核（**先于任何产物副作用**）：仓储返回的记录必须与本次写入同一身份与范围。
    //    被替换的记录（他人归属/别的资源/别的字段/别的有效期）说明存储或调用链已损坏：立即 500，
    //    绝不为他人或别的导出范围产出服务端产物。
    this.assertRecordedEntry(created, {
      id: exportRequestId,
      ownerUserId: subject.userId,
      resource: input.resource,
      fields,
      expiresAt,
    });

    // 10. 状态机门禁：本切片在同一个请求内把 `pending` 推进到终态，因此「推进目标」是服务端常量
    //    `completed`；仓储若返回非 `pending` 记录（重复处理 / 数据被改写）→ 409
    //    `STATE_TRANSITION_INVALID`。产物生成失败时结论改判 `failed`
    //    （`pending -> failed` 同样由状态机表允许）。
    assertExportTransition(created.status, ExportStatus.Completed);

    const outcome = this.materialize(created);

    // 11. 写回结论。**唯一的错误边界**：端口在条件写入未命中（并发重复推进 / 记录已到终态）时
    //     按端口标记 `EXPORT_TRANSITION_REJECTED` 抛错，这是客户端可见冲突，必须映射为与状态机
    //     门禁**同一个** 409 `STATE_TRANSITION_INVALID`，而不是冒泡成 500。判定只读结构化 `code`，
    //     不解析消息、不匹配错误名：错误消息里的 SQL / 归属 / 路径 / PII 既不参与判定也不外发。
    //     其余失败（未知 id / 归属不符 / 行契约损坏 / 执行器故障）仍是服务端缺陷，原样向上抛，
    //     由统一出口 fail-closed 为 500。
    //     注意 `expiresAt` 随 `...created` 一起回写：有效期是**不可变**的服务端事实，
    //     写回路径不得改写它（数据库 adapter 的 `POSTGRES_EXPORT_IMMUTABLE_COLUMNS` 是同一规则的
    //     存储层镜像：写回后逐列复核，被改写即 fail-closed）。
    let saved: ExportRequest;
    try {
      saved = await this.repository.save({
        ...created,
        status: outcome.status,
        ...(outcome.artifactId !== undefined ? { artifactId: outcome.artifactId } : {}),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (isExportTransitionRejection(error)) {
        throw new StateTransitionError('export request', created.status, outcome.status);
      }
      throw error;
    }

    // 12. 写回复核：仓储必须如实持久化本次结论（状态与产物句柄）
    this.assertRecordedOutcome(saved, outcome);

    return this.toOwnedView(saved, subject.userId);
  }

  /**
   * 下载本人已完成导出的产物内容（`GET /me/exports/:exportId/download`）。
   *
   * 判定顺序（被测试固定）：
   * 1. 入口授权（服务端常量，`profile:self:read` + `SELF`）→ 拒绝即 403，此时**仓储、产物存储、
   *    审计出口一次都不会被调用**；
   * 2. 查询串闭集：任何查询参数（`?userId=`/`?ownerUserId=`/`?artifactId=`/`?fileUrl=`/`?path=`/
   *    `?expiresAt=`…）一律 400，且**不回显取值**；自定义头从不进入判定（控制器只读 `authorization`）；
   * 3. 路径参数形态：非 UUID 与「不存在」走**同一个拒绝出口**（不进任何存储）；
   * 4. 取数：`findByIdForOwner(exportId, subject.userId)` —— 归属来自**会话主体**并下推进存储，
   *    因此「他人的导出」与「不存在的导出」不可区分（都是 `undefined`）；
   * 5. 读取契约 + 归属复核（纵深防御）→ 违规即 fail-closed 500；
   * 6. 状态必须为 `completed` 且有服务端产物句柄，否则收敛到统一拒绝；
   * 7. **服务端有效期**必须存在且严格晚于服务端当前时刻，否则收敛到**同一个**统一拒绝
   *    （`expiresAt` 缺失 = 存储 `NULL` ⇒ fail-closed；边界时刻判为过期）；
   * 8. 资源级授权（权限点由**记录里的服务端资源**映射）；
   * 9. 产物读取：故障 fail-closed，缺失（或空内容）收敛到统一拒绝，超过硬上限 fail-closed；
   * 10. 响应头取值由服务端常量派生并通过「控制字符 / 路径 / 引号」门禁；
   * 11. 留痕（脱敏三元组）成功后返回内容 —— **留痕失败即 500**。
   *
   * 返回的载荷只含**内容字节**与两个服务端常量派生值（文件名、内容类型），不含存储位置，
   * 也不含有效期：到期时刻是服务端判定用的事实，不进响应体也不进响应头。
   */
  async downloadMyExport(
    subject: AuthorizationSubject,
    exportId: unknown,
    query: unknown,
  ): Promise<ExportDownloadPayload> {
    // 1. 入口授权先于查询串校验与任何取数/留痕
    this.authorizeEntry(subject);

    // 2. 查询串闭集：下载端点同样不接受任何查询参数
    assertDeclaredExportQueryFields(query);

    // 3. 留痕用关联 ID 由**服务端**生成：客户端可提交的 `x-request-id` 不进入审计
    const requestId = randomUUID();
    // 4. 审计只落导出 ID 的**单向摘要**：非法形态同样只摘要，绝不落原值
    const exportIdDigest = digestExportId(typeof exportId === 'string' ? exportId : '');

    // 5. 路径参数形态：非 UUID 与「不存在」共用同一拒绝出口（不泄露存在性）
    const parsedId = exportDownloadIdSchema.safeParse(exportId);
    if (!parsedId.success) {
      return this.rejectDownload(requestId, exportIdDigest);
    }

    // 6. 取数：归属下推进仓储；他人记录与不存在返回同一个 undefined
    let record: ExportRequest | undefined;
    try {
      record = await this.repository.findByIdForOwner(parsedId.data, subject.userId);
    } catch (error) {
      // 仓储故障 ⇒ fail-closed：绝不把基础设施故障伪装成「导出不存在」
      return this.failDownload(requestId, exportIdDigest, `取数故障(${errorName(error)})`);
    }
    if (record === undefined) {
      return this.rejectDownload(requestId, exportIdDigest);
    }

    // 7. 读取契约与归属复核（纵深防御：仓储未按主体过滤 / 数据被外部改写 → 500，不返回任何内容）
    const parsed = parseStoredExportRequest(record);
    if (!parsed.ok) {
      return this.failDownload(requestId, exportIdDigest, '存储记录违反读取契约');
    }
    if (readExportOwnerId(parsed.value) !== subject.userId) {
      return this.failDownload(requestId, exportIdDigest, '存储记录归属与会话主体不一致');
    }

    // 8. **已撤销优先**（本切片新增）：只要记录带服务端撤销时刻，就一律不可下载 —— 收敛到
    //    **同一个**统一安全拒绝。它刻意排在状态判定**之前**，因为撤销与状态机正交：
    //    「并发撤销 / 完成」可以让记录同时是 `completed` 且已撤销，此时撤销事实必须**胜出**
    //    （否则一次并发完成就能把刚被取回的交付能力重新放开）。判定只读服务端存储里的
    //    `revokedAt`，客户端提交的任何取值都不参与（`?revoked=…` 在查询串闭集处就已经 400）。
    if (parsed.value.revokedAt !== undefined) {
      return this.rejectDownload(requestId, exportIdDigest);
    }

    // 9. 只有 `completed` 且带服务端产物句柄才可下载；pending / failed 收敛到同一拒绝
    if (parsed.value.status !== ExportStatus.Completed) {
      return this.rejectDownload(requestId, exportIdDigest);
    }
    const artifactId = parsed.value.artifactId;
    if (artifactId === undefined) {
      return this.rejectDownload(requestId, exportIdDigest);
    }

    // 10. **服务端有效期门禁**（唯一判定点，纯函数，见 `isExportDownloadExpired`）：
    //    - 时钟：只读一次服务端时钟（`Date.now()`，UTC 瞬时点），客户端提交的任何时间类取值
    //      都不参与判定（`?expiresAt=` 在查询串闭集处就已经 400）；
    //    - 比较：绝对时刻比较（存储值由 `exportExpiresAtFrom` 产出为 UTC ISO `Z` 形态），
    //      因此与本地时区 / 夏令时无关；边界时刻**判为过期**（没有「到期后还能取走一次」的窗口）；
    //    - **fail-closed**：`expiresAt` 缺失（数据库 `NULL` 的领域形）或形态非法都判为不可下载，
    //      绝不解释成「永不过期」；
    //    - **不泄露存在性**：过期与「不存在 / 跨主体 / 未完成 / 产物缺失」收敛到**同一个**稳定拒绝
    //      （同一状态码、同一错误码、同一文案、同一审计结果码），因此调用方无法据此区分
    //      「这条导出不存在」与「它已过期」；过期判定刻意排在**资源级授权之前**，
    //      使「已过期」在任何权限状态下都是同一个 404，不会因权限差异变成 403 而暴露状态。
    const nowMs = Date.now();
    if (isExportDownloadExpired(parsed.value.expiresAt, nowMs)) {
      return this.rejectDownload(requestId, exportIdDigest);
    }

    // 11. 资源级授权：权限点由记录里的服务端资源映射，客户端无法影响
    this.authorizeResource(subject, parsed.value.resource);

    // 12. 产物读取：故障 fail-closed；缺失收敛到统一拒绝
    let content: ExportArtifactContent | undefined;
    try {
      content = await this.artifacts.read(artifactId);
    } catch (error) {
      return this.failDownload(requestId, exportIdDigest, `产物读取故障(${errorName(error)})`);
    }
    if (content === undefined) {
      return this.rejectDownload(requestId, exportIdDigest);
    }
    const bytes = content.bytes;
    if (!(bytes instanceof Uint8Array)) {
      // 产物存储返回形态非法：这是实现缺陷，不是「没有内容」
      return this.failDownload(requestId, exportIdDigest, '产物内容形态非法');
    }
    // 空产物视为「没有可交付内容」：与缺失同一出口，绝不发出 0 字节下载
    if (bytes.byteLength === 0) {
      return this.rejectDownload(requestId, exportIdDigest);
    }
    // 硬上限：在写出任何字节之前判定；超限不截断、不分片、不降级
    if (bytes.byteLength > EXPORT_DOWNLOAD_MAX_BYTES) {
      return this.failDownload(requestId, exportIdDigest, '产物超过下载硬上限');
    }

    // 13. 响应头取值由服务端常量派生，再过一次头注入门禁（CRLF / 路径 / 引号 ⇒ fail-closed）
    let fileName: string;
    try {
      fileName = buildExportDownloadFilename(parsedId.data);
      assertSafeExportDownloadHeaderValue('content-type', EXPORT_DOWNLOAD_CONTENT_TYPE);
      buildExportDownloadDisposition(fileName);
    } catch (error) {
      return this.failDownload(requestId, exportIdDigest, `响应头不合法(${errorName(error)})`);
    }

    // 14. 留痕成功后才交付内容：审计不可用时绝不返回「看起来成功但没有留痕」的下载
    await this.recordDownloadAudit(requestId, exportIdDigest, ExportDownloadAuditResult.Success);

    return { bytes, fileName, contentType: EXPORT_DOWNLOAD_CONTENT_TYPE };
  }

  /**
   * **本人撤销自己的导出请求**（`POST /me/exports/:exportId/revoke`）。
   *
   * 判定顺序（被测试固定）：
   * 1. 入口授权（服务端常量，`profile:self:read` + `SELF`）→ 拒绝即 403，此时**仓储、产物存储与
   *    两条审计出口一次都不会被调用**（未授权主体既不落库、也不留痕）；
   * 2. 查询串闭集：任何查询参数一律 400（`?userId=`/`?ownerUserId=`/`?artifactId=`/`?path=`/
   *    `?status=`/`?revokedAt=`…），且**不回显取值**；自定义头从不进入判定（控制器只读
   *    `authorization`）；
   * 3. 请求体闭集：**空集** —— 任何字段都 400（服务端独占字段与未声明字段可区分），
   *    因此归属、结论、撤销时刻、产物句柄与路径都不可能由客户端声明；
   * 4. 路径参数形态：非 UUID 与「不存在」走**同一个拒绝出口**（不进任何存储）；
   * 5. 取数：`findByIdForOwner(exportId, subject.userId)` —— 归属来自**会话主体**并下推进存储，
   *    因此「他人的导出」与「不存在的导出」不可区分（都是 `undefined` → 同一个 404）；
   * 6. 读取契约 + 归属复核（纵深防御）→ 违规即 fail-closed 500；
   * 7. 可撤销判定（纯函数 `classifyExportRevocation`，**单次服务端时钟读数**）：
   *    - 已撤销 ⇒ **幂等成功**（`duplicate` 留痕，返回当前视图，**不**再写库）；
   *    - `failed` 结论 / 已过期 ⇒ **统一安全拒绝**（`unavailable` 留痕，404 同一条文案）；
   * 8. 条件写入：`revokeForOwner(exportId, subject.userId, revokedAt)` —— `WHERE` 钉住
   *    归属、可撤销前驱集合与 `revoked_at IS NULL`，`SET` **只**写 `revoked_at` / `updated_at`；
   *    0 行时由仓储自己的归属范围内诊断给出 `already-revoked` / `not-revocable` / `undefined`
   *    （并发撤销与并发完成都在这里收敛成**同一组**结论，绝不覆盖既有事实）；
   * 9. 三种结论分别留痕（`success` / `duplicate` / `unavailable`）后返回或拒绝；
   *    **留痕失败即 500**，但撤销时刻已经落库（单调事实不回滚）—— 客户端重试会因幂等
   *    落到 `duplicate` 分支，这正是「单调事实 + 幂等入口」要的行为。
   *
   * **不做的事**（本切片的能力边界）：不物理删除记录（端口上没有删除方法）、不同步清理产物
   * （撤销路径对 `ExportArtifactStore` 的调用次数恒为 0，见
   * `EXPORT_REVOCATION_CLEANUP_BOUNDARY`）、不改写 `status` / `artifactId` / `expiresAt` /
   * `createdAt`、不新增权限点（复用 `profile:self:read` 的自我读取门控）。
   *
   * 返回的载荷是既有 `ExportRequestView` 闭集（**没有新增字段**）：已撤销时其 `status` 呈现为
   * `revoked`（由 `revokedAt` 派生），撤销时刻、产物句柄与归属都不外发。
   */
  async revokeMyExportRequest(
    subject: AuthorizationSubject,
    exportId: unknown,
    query: unknown,
    body: unknown,
  ): Promise<ExportRequestView> {
    // 1. 入口授权先于任何输入校验与任何端口调用
    this.authorizeEntry(subject);

    // 2. 查询串闭集：撤销端点同样不接受任何查询参数
    assertDeclaredExportQueryFields(query);

    // 3. 请求体闭集：空集（归属 / 结论 / 撤销时刻 / 产物位置都不是「被忽略的输入」）
    assertDeclaredExportRevocationRequestFields(body);

    // 4. 留痕用关联 ID 与两个摘要都由**服务端**生成：客户端可提交的 `x-request-id` 不进入审计，
    //    主体也**不落原值**（只落单向摘要）
    const requestId = randomUUID();
    const exportIdDigest = digestExportId(typeof exportId === 'string' ? exportId : '');
    const requesterDigest = digestRequesterId(subject.userId);

    // 5. 路径参数形态：非 UUID 与「不存在」共用同一拒绝出口（不泄露存在性）
    const parsedId = exportRevokeIdSchema.safeParse(exportId);
    if (!parsedId.success) {
      return this.rejectRevocation(requestId, exportIdDigest, requesterDigest);
    }

    // 6. 取数：归属下推进仓储；他人记录与不存在返回同一个 undefined
    let record: ExportRequest | undefined;
    try {
      record = await this.repository.findByIdForOwner(parsedId.data, subject.userId);
    } catch (error) {
      return this.failRevocation(
        requestId,
        exportIdDigest,
        requesterDigest,
        `取数故障(${errorName(error)})`,
      );
    }
    if (record === undefined) {
      return this.rejectRevocation(requestId, exportIdDigest, requesterDigest);
    }

    // 7. 读取契约与归属复核（纵深防御：仓储未按主体过滤 / 数据被外部改写 → 500）
    const parsed = parseStoredExportRequest(record);
    if (!parsed.ok) {
      return this.failRevocation(
        requestId,
        exportIdDigest,
        requesterDigest,
        '存储记录违反读取契约',
      );
    }
    if (readExportOwnerId(parsed.value) !== subject.userId) {
      return this.failRevocation(
        requestId,
        exportIdDigest,
        requesterDigest,
        '存储记录归属与会话主体不一致',
      );
    }

    // 8. 服务端时钟只读**一次**：判定用的「当前时刻」与写入用的撤销时刻取自同一次读取，
    //    因此「已过期不可撤销」的边界不会因为两次时钟读取的漂移产生噪音。
    const nowMs = Date.now();
    const verdict = classifyExportRevocation(parsed.value, nowMs);

    if (verdict === ExportRevocationVerdict.AlreadyRevoked) {
      // 幂等成功：不写库、不改写既有撤销时刻，只如实留痕 `duplicate` 并返回当前视图
      await this.recordRevocationAudit(
        requestId,
        exportIdDigest,
        requesterDigest,
        ExportRevocationAuditResult.Duplicate,
      );
      return this.toOwnedView(parsed.value, subject.userId);
    }
    if (verdict === ExportRevocationVerdict.Unavailable) {
      // 不可撤销（failed 结论 / 已过期）：与「不存在 / 跨主体」收敛到同一个 404 出口
      return this.rejectRevocation(requestId, exportIdDigest, requesterDigest);
    }

    // 9. 条件写入。仓储故障（执行器异常 / 行契约损坏）是基础设施故障 ⇒ fail-closed 500，
    //    绝不被伪装成「不可撤销」的统一 404。
    const revokedAt = new Date(nowMs).toISOString();
    let outcome: ExportRevocationResult | undefined;
    try {
      outcome = await this.repository.revokeForOwner(parsedId.data, subject.userId, revokedAt);
    } catch (error) {
      return this.failRevocation(
        requestId,
        exportIdDigest,
        requesterDigest,
        `撤销写入故障(${errorName(error)})`,
      );
    }
    if (outcome === undefined) {
      // 记录在「预读」与「条件写入」之间不可见：只有「不存在 / 属于他人」会给出 undefined，
      // 两种情形都与统一拒绝同形（不泄露存在性）。
      return this.rejectRevocation(requestId, exportIdDigest, requesterDigest);
    }

    // 10. 条件写入的**结论**决定留痕结果码与对外出口：并发撤销 ⇒ duplicate（幂等成功），
    //     结论不可撤销 ⇒ unavailable（统一拒绝）。两者都不改写既有事实。
    const result =
      outcome.outcome === ExportRevocationOutcome.Revoked
        ? ExportRevocationAuditResult.Success
        : outcome.outcome === ExportRevocationOutcome.AlreadyRevoked
          ? ExportRevocationAuditResult.Duplicate
          : ExportRevocationAuditResult.Unavailable;

    if (result === ExportRevocationAuditResult.Unavailable) {
      return this.rejectRevocation(requestId, exportIdDigest, requesterDigest);
    }

    await this.recordRevocationAudit(requestId, exportIdDigest, requesterDigest, result);
    return this.toOwnedView(outcome.record, subject.userId);
  }

  /**
   * **统一安全拒绝**出口：不存在 / 跨主体 / 未完成 / 产物缺失 / **已过期** / **无服务端有效期**
   * 全部收敛到这里，状态码、错误码与文案完全一致，因此调用方无法据此区分
   * 「有没有这条导出、它是什么状态、它是否已经过期」。
   */
  private async rejectDownload(requestId: string, exportIdDigest: string): Promise<never> {
    await this.recordDownloadAudit(
      requestId,
      exportIdDigest,
      ExportDownloadAuditResult.Unavailable,
    );
    throw new NotFoundException(EXPORT_DOWNLOAD_UNAVAILABLE_MESSAGE);
  }

  /**
   * fail-closed 出口：基础设施故障（取数 / 产物读取）、内容超过硬上限、存储记录违约、
   * 响应头取值不合法。对外只给统一内部错误（不泄露原因），日志只写**原因标签与错误名**，
   * 绝不写取值（产物位置、内容、归属、原始错误文本都可能出现在取值里）。
   */
  private async failDownload(
    requestId: string,
    exportIdDigest: string,
    reason: string,
  ): Promise<never> {
    this.logger.error(`[exports] 下载 fail-closed：${reason}`);
    await this.recordDownloadAudit(requestId, exportIdDigest, ExportDownloadAuditResult.Failed);
    throw new InternalServerErrorException(EXPORT_REQUEST_INTEGRITY_MESSAGE);
  }

  /**
   * 下载留痕：只写**脱敏三元组**（服务端 requestId、导出 ID 单向摘要、结果码）。
   *
   * 审计失败（存储故障或条目违约）一律 fail-closed 为 500：审计不可用时不得让下载「静默成功」。
   * 日志只写错误名，不写审计错误原文（原文可能含内部路径与连接信息）。
   */
  private async recordDownloadAudit(
    requestId: string,
    exportIdDigest: string,
    result: ExportDownloadAuditResult,
  ): Promise<void> {
    try {
      await this.downloadAudit.record({ requestId, exportIdDigest, result });
    } catch (error) {
      this.logger.error(`[exports] 下载审计写入失败: ${errorName(error)}`);
      throw new InternalServerErrorException(EXPORT_REQUEST_INTEGRITY_MESSAGE);
    }
  }

  /**
   * **撤销的统一安全拒绝**出口：不存在 / 跨主体 / `failed` 结论 / 已过期 / 非法路径参数
   * 全部收敛到这里，状态码、错误码与文案完全一致，因此调用方无法据此区分
   * 「有没有这条导出、它是什么结论、它是否已经过期」。
   *
   * 留痕结果码固定为 `unavailable`（撤销**没有**发生）：它同样不区分原因，因此审计本身
   * 也不变成存在性预言机。
   */
  private async rejectRevocation(
    requestId: string,
    exportIdDigest: string,
    requesterDigest: string,
  ): Promise<never> {
    await this.recordRevocationAudit(
      requestId,
      exportIdDigest,
      requesterDigest,
      ExportRevocationAuditResult.Unavailable,
    );
    throw new NotFoundException(EXPORT_REVOCATION_UNAVAILABLE_MESSAGE);
  }

  /**
   * 撤销的 fail-closed 出口：取数故障、存储记录违约、归属不一致、撤销写入故障。
   * 对外只给统一内部错误（不泄露原因），日志只写**原因标签与错误名**，
   * 绝不写取值（归属标识、记录 ID、撤销时刻、原始错误文本都可能出现在取值里）。
   *
   * 留痕同样记 `unavailable`：撤销没有发生这一事实是真的，而结果码闭集刻意只有三个
   * （成功 / 重复 / 不可用），因此基础设施故障与业务拒绝**共享**同一个「未生效」结果码 ——
   * 与下载切片的 `failed` 不同，这里的闭集是用户明确要求的三个取值。
   */
  private async failRevocation(
    requestId: string,
    exportIdDigest: string,
    requesterDigest: string,
    reason: string,
  ): Promise<never> {
    this.logger.error(`[exports] 撤销 fail-closed：${reason}`);
    await this.recordRevocationAudit(
      requestId,
      exportIdDigest,
      requesterDigest,
      ExportRevocationAuditResult.Unavailable,
    );
    throw new InternalServerErrorException(EXPORT_REQUEST_INTEGRITY_MESSAGE);
  }

  /**
   * 撤销留痕：只写**脱敏四元组**（服务端 requestId、导出 ID 单向摘要、请求主体单向摘要、
   * 结果码）。**不写** request body、PII、路径、storage key、产物句柄与任何 secret ——
   * 端口类型与严格契约（`exportRevocationAuditEntrySchema`）在结构上就装不下它们。
   *
   * 审计失败（存储故障或条目违约）一律 fail-closed 为 500：审计不可用时不得让撤销「静默成功」。
   * 日志只写错误名，不写审计错误原文（原文可能含内部路径与连接信息）。
   */
  private async recordRevocationAudit(
    requestId: string,
    exportIdDigest: string,
    requesterDigest: string,
    result: ExportRevocationAuditResult,
  ): Promise<void> {
    try {
      await this.revocationAudit.record({ requestId, exportIdDigest, requesterDigest, result });
    } catch (error) {
      this.logger.error(`[exports] 撤销审计写入失败: ${errorName(error)}`);
      throw new InternalServerErrorException(EXPORT_REQUEST_INTEGRITY_MESSAGE);
    }
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
      created.expiresAt !== expected.expiresAt ||
      !sameFields
    ) {
      this.logger.error(
        '[exports] 仓储返回的入口记录与写入不一致（主键/归属/资源/字段/有效期被替换）',
      );
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

/**
 * 下载载荷：只有**内容字节**与两个由服务端常量派生的响应头取值（文件名、内容类型）。
 * 刻意没有 storage key / 路径 / 下载地址 / 签名地址 / 产物句柄：调用方拿不到可反推存储位置的信息。
 */
export interface ExportDownloadPayload {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly contentType: string;
}

/** 只取错误名：错误消息可能含内部路径 / 连接串 / 字段取值，绝不进入日志或响应 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** 物化结论：终态与（仅在 `completed` 时存在的）服务端产物句柄 */
interface ExportMaterializationOutcome {
  readonly status: ExportStatus;
  readonly artifactId?: string;
}

/**
 * 入口写入的服务端期望值：用于复核仓储是否如实保存了本次入口记录。
 * `expiresAt` 也在这里：有效期是服务端独占事实（客户端不可提交、写回不可改写），
 * 仓储若把它丢掉或换成别的值，属于服务端缺陷而不是「可以继续」的小差异。
 */
interface ExportEntryExpectation {
  readonly id: string;
  readonly ownerUserId: string;
  readonly resource: ExportResource;
  readonly fields: readonly string[];
  readonly expiresAt: string;
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
