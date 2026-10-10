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
  NOTIFICATION_INTEGRITY_MESSAGE,
  NOTIFICATION_NOT_VISIBLE_MESSAGE,
  assertDeclaredNotificationQueryFields,
  assertNoNotificationPatchBodyFields,
  markNotificationRead,
  notificationIdParamsSchema,
  parseNotificationView,
  parseStoredNotification,
  readNotificationOwnerId,
  toNotificationView,
} from './notifications.contract';
import type { NotificationView, StoredNotification } from './notifications.contract';
import { NOTIFICATION_REPOSITORY } from './notifications.port';
import type { NotificationRepository } from './notifications.port';

const NOTIFICATION_TRANSITION_REJECTED = 'TRANSITION_REJECTED' as const;

function isNotificationTransitionRejection(
  error: unknown,
): error is { readonly code: typeof NOTIFICATION_TRANSITION_REJECTED } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === NOTIFICATION_TRANSITION_REJECTED
  );
}

/**
 * 站内通知切片（P7 最小垂直切片，本人通知箱）：
 * - `GET   /me/notifications`                         本人通知列表（`profile:self:read`）
 * - `PATCH /me/notifications/{notificationId}/read`   标记本人通知已读（`profile:self:update`）
 *
 * 与 docs/无人模式启动决策.md 的「通知采用订阅消息 + 站内状态」一致：本切片只落地**站内状态**的
 * 本人侧读写（订阅消息下发与失败重试属于后续切片），且不新增对外路由之外的行为。
 *
 * 六条硬约束：
 * 1. **主体只来自服务端会话**：`userId` 取 `AuthorizationSubject.userId`（由
 *    `SESSION_SUBJECT_RESOLVER` 从服务端会话存储解析）；查询串、请求体与自定义头里的
 *    `userId`/`roles`/`scope`/`groupId` 既不能进入判定，也不能改变取数主体或资源可见性。
 * 2. **授权先于一切**：两条路由都先经 `AuthorizationGuard`（其下是 `RUOYI_AUTHZ_ADAPTER`
 *    端口 → canonical 谓词），`scope` 恒为服务端常量 `SELF`，`resourceUserId` 恒为会话主体。
 *    拒绝即 403，且此时**仓储方法一次都不会被调用**——未授权主体拿不到任何关于「通知是否存在」
 *    或「字段是否合法」的信息。角色级无权（缺权限点或范围不是 SELF）与资源级不可见（见第 4 条）
 *    是两条不同的轴，各自对外只暴露一个稳定结果。
 * 3. **输入闭集**：列表与标记已读**都不声明任何查询参数**（`?userId=`/`?roles=`/`?scope=`/
 *    `?groupId=` 等一律 400）；标记已读**不接受任何请求体字段**（唯一输入是路径里的通知 ID），
 *    路径 ID 必须是 UUID（非法 ID 在取数之前 400）。客户端提交的归属/角色/范围/状态不是
 *    「被忽略的输入」，而是明确不被接受的输入，因此不存在「靠请求声明改口径」的路径。
 * 4. **越权与不存在统一安全边界**：单条标记已读时，`不存在`、`非本人所有`、`归属不可读`
 *    三种情况共用同一个 404 与同一文案（`NOTIFICATION_NOT_VISIBLE_MESSAGE`），且响应体逐字段
 *    相同，调用方无法据此构造存在性探测；进入该路径的记录**不会**再被解析或输出任何字段。
 * 5. **状态只能由服务端状态机推进**：唯一前向边是 `unread -> read`，且**幂等**——
 *    已是 `read` 时不再写库、不改写 `readAt`，重复请求不会产生第二次状态变化；
 *    入口不接受任何客户端状态声明（无请求体字段），因此也无法回退到未读。
 * 6. **出口再校验一次**：存储记录必须满足读取契约（枚举闭集、ISO 时间戳、`read` 必带 `readAt`、
 *    正文不含身份证号/密钥等高敏内容），违反者按服务端缺陷处理（列表 500 / 单条 500 或统一 404），
 *    且日志只写字段路径、不写取值；对外视图再过一遍 `.strict()` 白名单，多出字段即 500，绝不外发。
 *
 * 读取口径（已知偏差，与入组申请/统计切片的处理同构）：
 * 权限目录是**闭集**（docs/P2-权限目录与状态机.md §1「未列出即拒绝」），其中没有
 * `notification:self:read` / `notification:self:update` 这两个点。本切片在闭集目录内复用
 * **已有的 self 权限点**：`profile:self:read` 门控本人通知列表、`profile:self:update` 门控
 * 「标记本人通知已读」（对本人资源的自服务写操作）。这样学生角色默认即可用，缺该点的角色
 * 得到 403 而不是「认证即可读」，读取与写入路径同样经过端口判定、fail-closed。
 * 新增 `notification:self:*` 需要权限目录版本升级并同步公开契约夹具
 * `services/ruoyi-api/contracts`，属后续版本项；本切片**不新增权限点**。
 *
 * 尚不包含（明确留给后续切片）：通知的生产侧（审核结果/匹配结果/公告如何入库与去重）、
 * 未读数与批量已读、删除与归档、分页与排序、订阅消息下发与失败重试、导出、审计落库。
 *
 * 仓储端口是**异步**的（`Promise`）：未配置数据库时绑定内存基线、配置时绑定 PostgreSQL 实现
 * （见 `notifications.module.ts` 的 `createNotificationRepository`），service 因此不区分后端。
 * 已知约束：PostgreSQL 实现的归属主键是 `uuid`，因此绑定到数据库实现时**非 UUID 的会话主体**
 * 会被 adapter 在进入 SQL 之前 fail-closed 拒绝（`INVALID_SUBJECT`）；会话主体标识收敛为 UUID
 * 属于后续切片。
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(NOTIFICATION_REPOSITORY) private readonly repository: NotificationRepository,
  ) {}

  /**
   * 本人通知列表：授权 → 查询串闭集 → 按服务端主体取数 → 逐条复核归属与读取契约 → 出口白名单。
   *
   * `query` 只是「需要被 fail-closed 拒绝的不应存在之物」：本端点不声明任何查询参数，
   * 因此它作为显式参数传入（服务是单例，绝不保存任何请求级状态），且**在授权之后**才检查，
   * 避免未授权主体通过字段级反馈探测端点内部结构。
   */
  async listMyNotifications(
    subject: AuthorizationSubject,
    query: unknown,
  ): Promise<NotificationView[]> {
    // 1. 授权先于查询串校验、先于任何仓储访问
    this.authorizeSelf(subject, PermissionPoint.ProfileSelfRead);

    // 2. 查询串闭集：`?userId=`/`?roles=`/`?scope=`/`?groupId=` 等一律 400，不是静默忽略
    assertDeclaredNotificationQueryFields(query);

    // 3. 只按服务端主体取数；逐条复核：读取契约违规或归属不一致一律 500（绝不外发他人记录）
    const records = await this.repository.listByUserId(subject.userId);
    return records.map((record) => this.toOwnedView(record, subject.userId));
  }

  /**
   * 标记本人通知已读。
   *
   * 判定顺序（被测试固定）：无有效会话 → 401（认证边界，见 controller）；授权拒绝 → 403；
   * 请求体带字段 → 400；查询串带参数 → 400；路径 ID 非法 → 400；
   * 不可见（不存在 / 非本人所有 / 归属不可读）→ 统一 404；存储记录违反读取契约 → 500；
   * 已读 → 幂等 200（无第二次状态变化）。其中授权排在最前：无权主体拿不到任何关于
   * 「通知是否存在」或「字段是否合法」的信息。
   *
   * `body`/`query` 只是需要被 fail-closed 拒绝的「不应存在之物」：标记已读的唯一输入是路径中的
   * 通知 ID，因此它们作为显式参数传入，不参与任何业务判定。
   */
  async markMyNotificationRead(
    subject: AuthorizationSubject,
    notificationId: string,
    body: unknown,
    query: unknown,
  ): Promise<NotificationView> {
    // 1. 授权先于输入校验、先于任何仓储访问
    this.authorizeSelf(subject, PermissionPoint.ProfileSelfUpdate);

    // 2. 输入闭集：不接受任何请求体字段与查询参数，唯一输入是路径里的通知 ID（必须是 UUID）
    assertNoNotificationPatchBodyFields(body);
    assertDeclaredNotificationQueryFields(query);
    const { notificationId: id } = notificationIdParamsSchema.parse({ notificationId });

    // 3. 统一安全边界：不可见的三种成因合并为同一个 404 + 同一文案，且不输出记录的任何字段
    //    归属下推进仓储：非本人所有在数据库实现里根本不出库（此处仍复核，纵深防御）
    const record = await this.repository.findById(id, subject.userId);
    if (!record || readNotificationOwnerId(record) !== subject.userId) {
      if (record) {
        // 只记录「不一致」这一事实，不记录通知 ID、归属或任何内容
        this.logger.warn('[notifications] 通知归属与会话主体不一致，按不可见处理');
      }
      throw new NotFoundException(NOTIFICATION_NOT_VISIBLE_MESSAGE);
    }

    // 4. 读取契约（归属已确认属于本主体，此处只判字段/枚举/时间与 PII）
    const stored = this.assertStoredNotification(record);

    // 5. 状态机唯一前向边：read 是终态，已读记录原样返回（不写库、不漂移 readAt）
    const mark = markNotificationRead(stored, new Date().toISOString());
    let saved = mark.record;
    if (mark.changed) {
      try {
        saved = await this.repository.save(mark.record);
      } catch (error) {
        if (isNotificationTransitionRejection(error)) {
          throw new StateTransitionError('notification', stored.status, mark.record.status);
        }
        throw error;
      }
    }

    // 6. 写出后的记录同样要过读取契约与归属复核（异常仓储不得借写回把他人记录交出去）
    return this.toOwnedView(saved, subject.userId);
  }

  /**
   * 授权判定：权限点与范围恒为服务端常量 `SELF`，`resourceUserId` 恒为**会话主体**
   * （服务端解析值）；不接受任何客户端提交的角色/范围/归属。
   */
  private authorizeSelf(subject: AuthorizationSubject, permission: PermissionPoint): void {
    this.guard.assertAuthorized(subject, {
      permission,
      scope: DataScope.Self,
      resourceUserId: subject.userId,
    });
  }

  /**
   * 读取契约门禁：记录必须满足 `storedNotificationSchema`，否则按服务端缺陷 500，
   * 日志只写字段路径与违规类型（不含取值），因此即便仓储返回了 PII 或异常对象也不会外发。
   */
  private assertStoredNotification(record: unknown): StoredNotification {
    const parsed = parseStoredNotification(record);
    if (!parsed.ok) {
      this.logger.error(
        `[notifications] 存储记录违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(NOTIFICATION_INTEGRITY_MESSAGE);
    }
    return parsed.value;
  }

  /**
   * 输出边界：先过读取契约，再复核归属与调用方主体一致（纵深防御：仓储未按主体过滤、
   * 数据被外部改写、写回被替换）。归属不一致时同样 500 且使用同一文案，调用方无法据此区分
   * 「数据损坏」与「越权取数」，也不会看到他人记录的任何字段。
   */
  private toOwnedView(record: unknown, expectedOwnerId: string): NotificationView {
    const stored = this.assertStoredNotification(record);
    if (stored.userId !== expectedOwnerId) {
      this.logger.error('[notifications] 存储记录归属与会话主体不一致（仓储未按主体过滤）');
      throw new InternalServerErrorException(NOTIFICATION_INTEGRITY_MESSAGE);
    }
    return this.project(stored);
  }

  /** 出口白名单门禁：视图必须是恰好 `NOTIFICATION_VIEW_FIELDS` 的闭集（多出字段即服务端缺陷） */
  private project(stored: StoredNotification): NotificationView {
    const parsed = parseNotificationView(toNotificationView(stored));
    if (!parsed.ok) {
      this.logger.error(
        `[notifications] 对外视图违反输出白名单: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(NOTIFICATION_INTEGRITY_MESSAGE);
    }
    return parsed.value;
  }
}
