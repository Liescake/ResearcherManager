import { randomUUID } from 'node:crypto';
import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { DataScope, PermissionPoint } from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import {
  AUDIT_INTEGRITY_MESSAGE,
  SELF_AUDIT_READ_SUMMARY,
  assertDeclaredAuditQueryFields,
  assertNoAuditReadBodyFields,
  hashPeerAddress,
  parseAuditEventView,
  parseStoredAuditEvent,
  toAuditEventView,
} from './audit.contract';
import type { AuditEventView, AuditRequestContext, StoredAuditEvent } from './audit.contract';
import { AUDIT_REPOSITORY, AuditEventType, AuditResourceType, AuditResult } from './audit.port';
import type { AuditEvent, AuditRepository } from './audit.port';

/**
 * 审计切片（P8 最小垂直切片，本人审计摘要）：
 * - `GET /me/audit-events` —— 返回**服务端会话主体本人**且标记为本人可见的审计事件**脱敏摘要**；
 * - 该请求自身也会追加一条服务端审计事件（`audit_self_events_read`，见下「先读后记」）。
 *
 * 与 docs/P2-架构与数据设计.md §2「audit | 不可变业务审计记录」、数据字典 §4 `audit_logs`
 * 以及 docs/P1-核心验收基线.md AC-ADM-08（审计查询、敏感值掩码、业务 API 不可删除）一致：
 * 本切片只落地**追加写 + 本人摘要读**这两条最小能力，不新增对外路由之外的行为。
 *
 * 六条硬约束：
 * 1. **主体只来自服务端会话**：`actorUserId` 取 `AuthorizationSubject.userId`（由
 *    `SESSION_SUBJECT_RESOLVER` 从服务端会话存储解析）；查询串、请求体与自定义头里的
 *    `actorUserId`/`userId`/`roles`/`scope`/`ip`/`requestId`/`result` 既不能进入判定，
 *    也不能改变取数主体、写入主体或写入结果。
 * 2. **授权先于一切**：先经 `AuthorizationGuard`（其下是 `RUOYI_AUTHZ_ADAPTER` 端口 →
 *    canonical 谓词），`scope` 恒为服务端常量 `SELF`、`resourceUserId` 恒为会话主体。
 *    拒绝即 403，且此时**仓储方法一次都不会被调用**——既没有取数，也没有审计写入：
 *    未授权主体拿不到任何关于「自己有多少审计事件」「字段是否合法」的信息，
 *    也不会因为一次未授权请求而在存储里留下写入副作用。
 * 3. **输入闭集**：端点**不声明任何查询参数**也不**接受任何请求体字段**，
 *    两者都在授权之后 fail-closed 拒绝（400 `VALIDATION_FAILED`，并区分「服务端字段」与
 *    「未声明字段」）。客户端提交的归属/权限/网络/结果声明不是「被忽略的输入」，
 *    而是明确不被接受的输入，因此不存在「靠请求声明改口径」的路径。
 * 4. **写入字段全部由服务端生成**：`id` / `requestId` 是服务端 UUID，`occurredAt` 取服务端时钟，
 *    `result` 是服务端常量 `success`，`ipHash` 是**传输层对端地址**的 sha256（不读任何客户端头，
 *    明文 IP 不入库），`summary` 是服务端常量文案。**审计里没有一处来自客户端输入**。
 * 5. **可见性只由服务端口径决定**：只有既有「本人主体一致」**又**标记 `selfVisible` 的记录才会
 *    进入摘要；「他人记录」「仅管理端可见的记录」「归属不可读的记录」一律按服务端缺陷 500，
 *    既不放行也不静默丢弃——仓储的过滤行为不作为安全边界（纵深防御）。
 * 6. **出口再校验一次**：存储记录必须满足读取契约（三个枚举闭集、ISO 时间戳、UUID、
 *    `ipHash` 必须是 sha256、摘要免 PII、字段集合闭合），违反者按服务端缺陷 500，
 *    且日志只写字段路径、不写取值；对外摘要再过一遍 `.strict()` 白名单，多出字段即 500，绝不外发。
 *
 * 「先读后记」的顺序（被测试固定）：本端点先组装响应、**再**追加自身事件。原因是：
 * - 响应只反映「请求到达前已存在的事件」，不会因为本次写入而在同一次响应里漂移，
 *   因此同一请求内的 `data` 是稳定快照；
 * - 「读一次审计 = 存储里多一条审计」这一性质可被测试端到端固定（第一次响应的内容在**下一次**
 *   读取中可见），无需为写入另开路由；
 * - 读取失败（读取契约违规）时不会写入事件，避免把损坏数据反复放大成写入。
 *
 * 读取口径（已知偏差，与入组申请/统计/通知切片的处理同构）：权限目录是**闭集**
 * （docs/P2-权限目录与状态机.md §1「未列出即拒绝」），其中 `audit:read` 的门控对象是
 * **管理端审计查询**（系统管理员/超级管理员，默认范围 `SYSTEM`/`GLOBAL`），用于本人端点会让学生
 * 拿到 403；目录里也没有 `audit:self:read`。本切片因此在闭集目录内复用**已有的 self 权限点**
 * `profile:self:read` 门控「读取本人审计摘要」（与通知切片「本人通知箱」的处理完全一致）。
 * 新增 `audit:self:read` 需要权限目录版本升级并同步公开契约夹具 `services/ruoyi-api/contracts`，
 * 属后续版本项；本切片**不新增权限点**。
 *
 * 尚不包含（明确留给后续切片）：管理端审计查询（`GET /admin/audit-logs`，`audit:read`）、
 * 按主体/资源/时间/结果检索与分页、**拒绝与失败结果的留痕**（需要限流与专用写入通道，避免
 * 未授权请求被放大成写入）、改前/改后快照与理由字段、链式完整性校验与归档留存、
 * 以及其它业务切片向本端口写入各自事件（本切片只写入自身的读取事件）。
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepository,
  ) {}

  /**
   * 本人审计摘要。
   *
   * 判定顺序（被测试固定）：无有效会话 → 401（认证边界，见 controller）；授权拒绝 → 403；
   * 请求体带字段 → 400；查询串带参数 → 400；存储记录违反读取契约 / 归属不一致 /
   * 未标记本人可见 → 500。其中授权排在最前，且 403 时仓储一次都不会被调用
   * （既不取数也不写入）。
   *
   * `query` / `body` 只是需要被 fail-closed 拒绝的「不应存在之物」：本端点不从它们读取任何输入，
   * 因此它们作为显式参数传入（服务是单例，绝不保存任何请求级状态）。
   */
  listMyAuditEvents(
    subject: AuthorizationSubject,
    context: AuditRequestContext,
    query: unknown,
    body: unknown,
  ): AuditEventView[] {
    // 事件时间取请求到达时的服务端时钟：客户端没有任何提交时间的入口
    const occurredAt = new Date().toISOString();

    // 1. 授权先于输入校验、先于任何仓储访问（403 时无取数、无写入）
    this.authorizeSelf(subject);

    // 2. 输入闭集：任何请求体字段与查询参数一律 400，不是静默忽略
    assertNoAuditReadBodyFields(body);
    assertDeclaredAuditQueryFields(query);

    // 3. 只按服务端主体取数；逐条复核读取契约、归属与本人可见标记（绝不外发他人/管理端记录）
    const views = this.repository
      .listVisibleByActor(subject.userId)
      .map((record) => this.toOwnedView(record, subject.userId));

    // 4. 先读后记：本次请求自身的事件在响应组装之后追加（见类注释的「先读后记」）
    this.recordSelfAuditRead(subject, context, occurredAt);

    return views;
  }

  /**
   * 授权判定：权限点与范围恒为服务端常量 `SELF`，`resourceUserId` 恒为**会话主体**
   * （服务端解析值）；不接受任何客户端提交的角色、范围或归属。
   */
  private authorizeSelf(subject: AuthorizationSubject): void {
    this.guard.assertAuthorized(subject, {
      permission: PermissionPoint.ProfileSelfRead,
      scope: DataScope.Self,
      resourceUserId: subject.userId,
    });
  }

  /**
   * 服务端审计写入：追加「本人读取审计摘要」事件。
   *
   * 事件里**每一个字段都由服务端生成**：主体来自会话，结果为常量，时间来自服务端时钟，
   * 关联 ID / 事件 ID 为服务端 UUID，网络归属是对端地址的哈希（不读客户端头，明文不入库），
   * 摘要为服务端常量文案。因此不存在「客户端提交 actor/result/ip/requestId」的输入路径。
   *
   * 写入失败（仓储抛异常或写回记录不合法）→ 500：审计不可用时**不**返回「看起来成功但没有审计」
   * 的响应（fail-closed），也绝不把仓储的内部错误信息外发。
   */
  private recordSelfAuditRead(
    subject: AuthorizationSubject,
    context: AuditRequestContext,
    occurredAt: string,
  ): void {
    const event: AuditEvent = {
      id: randomUUID(),
      actorUserId: subject.userId,
      type: AuditEventType.SelfAuditEventsRead,
      result: AuditResult.Success,
      resourceType: AuditResourceType.AuditEvent,
      summary: SELF_AUDIT_READ_SUMMARY,
      selfVisible: true,
      // 服务端生成的关联 ID：**不使用**客户端可提交的 x-request-id（见 audit.contract.ts 的说明）
      requestId: randomUUID(),
      ipHash: hashPeerAddress(context.peerAddress),
      occurredAt,
    };

    const appended = this.assertStoredAuditEvent(this.repository.append(event));
    // 写回记录同样要复核归属与可见标记：异常仓储不得借写回把他人/管理端记录写进存储
    this.assertOwnedSelfVisible(appended, subject.userId, '写回');
  }

  /**
   * 读取契约门禁：记录必须满足 `storedAuditEventSchema`，否则按服务端缺陷 500，
   * 日志只写字段路径与违规类型（不含取值），因此即便仓储返回了 PII、明文 IP 或异常对象也不会外发。
   */
  private assertStoredAuditEvent(record: unknown): StoredAuditEvent {
    const parsed = parseStoredAuditEvent(record);
    if (!parsed.ok) {
      this.logger.error(
        `[audit] 存储记录违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(AUDIT_INTEGRITY_MESSAGE);
    }
    return parsed.value;
  }

  /** 归属与可见标记复核：两者都不满足时按服务端缺陷 500，文案与「数据损坏」不可区分 */
  private assertOwnedSelfVisible(
    stored: StoredAuditEvent,
    expectedActorId: string,
    source: '取数' | '写回',
  ): StoredAuditEvent {
    if (stored.actorUserId !== expectedActorId) {
      // 只记录「不一致」这一事实，不记录事件 ID、归属或任何内容
      this.logger.error(`[audit] 存储记录归属与会话主体不一致（${source}）`);
      throw new InternalServerErrorException(AUDIT_INTEGRITY_MESSAGE);
    }
    if (!stored.selfVisible) {
      this.logger.error(`[audit] 存储记录未标记为本人可见（${source}）`);
      throw new InternalServerErrorException(AUDIT_INTEGRITY_MESSAGE);
    }
    return stored;
  }

  /**
   * 输出边界：先过读取契约，再复核归属与本人可见标记（纵深防御：仓储未按主体/可见性过滤、
   * 数据被外部改写）。违反者 500 且使用同一文案，调用方无法据此区分「数据损坏」与「越权取数」，
   * 也不会看到他人或管理端记录的任何字段。
   */
  private toOwnedView(record: unknown, expectedActorId: string): AuditEventView {
    const stored = this.assertOwnedSelfVisible(
      this.assertStoredAuditEvent(record),
      expectedActorId,
      '取数',
    );
    return this.project(stored);
  }

  /** 出口白名单门禁：摘要必须是恰好 `AUDIT_EVENT_VIEW_FIELDS` 的闭集（多出字段即服务端缺陷） */
  private project(stored: StoredAuditEvent): AuditEventView {
    const parsed = parseAuditEventView(toAuditEventView(stored));
    if (!parsed.ok) {
      this.logger.error(
        `[audit] 对外摘要违反输出白名单: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(AUDIT_INTEGRITY_MESSAGE);
    }
    return parsed.value;
  }
}
