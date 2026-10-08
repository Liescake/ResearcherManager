import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { DataScope, PermissionPoint } from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import {
  COMPLIANCE_INTEGRITY_MESSAGE,
  assertDeclaredComplianceBodyFields,
  assertDeclaredComplianceQueryFields,
  parseComplianceStatusView,
  parseStoredComplianceRecord,
  readComplianceOwnerId,
  toComplianceStatusView,
} from './compliance.contract';
import type { ComplianceStatusView } from './compliance.contract';
import { COMPLIANCE_REPOSITORY } from './compliance.port';
import type { ComplianceRepository } from './compliance.port';

/**
 * 合规切片（P9 最小垂直切片，本人侧）：
 * `GET /me/compliance-status` —— 返回**服务端会话主体本人**的最小合规状态。
 *
 * 输出契约（白名单，`compliance.contract.ts`）：`data` 恰好是三个状态枚举
 * `privacyConsent` / `dataRetention` / `exportAvailability`。**不含**归属 `userId`、
 * 不含隐私同意原文与政策正文、不含手机号/学号/姓名、不含内部审核意见与审核人、
 * 不含证据文件标识，也不含任何时间戳与期限取值。
 *
 * 六条硬约束：
 * 1. **主体只来自服务端会话**：`userId` 取 `AuthorizationSubject.userId`（由
 *    `SESSION_SUBJECT_RESOLVER` 从服务端会话存储解析）；查询串、请求体与自定义头里的
 *    `userId`/`roles`/`scope`/`groupId`/`consentText`/`phone` 之类既不能进入判定，
 *    也不能改变取数主体。
 * 2. **授权先于一切**：判定入参的权限点与数据范围都是**服务端常量**，`resourceUserId`
 *    取会话主体；拒绝即 403，且此时端口方法**一次都不会被调用**——未授权主体既拿不到
 *    任何字段级或状态级反馈，也不会在存储里留下任何读取痕迹。
 * 3. **输入闭集而不是静默忽略**：本端点不声明任何查询参数与请求体字段，因此
 *    `?userId=`/`?roles=`/`?phone=`/`?consentText=` 与请求体 `{userId, roles, status, …}`
 *    一律 400 `VALIDATION_FAILED`，且拒绝原因只给字段名、**不回显取值**。
 *    查询串闭集在授权之后检查（与其它切片「授权先于字段校验」的顺序一致），
 *    避免未授权主体通过字段级反馈探测端点内部结构。
 * 4. **只按服务端主体取数**：端口只有 `findByUserId`，没有「按客户端提交的主体取数」的入口；
 *    service 仍会复核记录归属（纵深防御：仓储的过滤行为不作为安全边界）。
 * 5. **拿不到事实就 fail-closed**：主体没有合规记录（`undefined`）时返回 500，
 *    绝不凭空给出「看起来正常」的合规状态；未知状态枚举、非法存储形态、
 *    状态不自洽（未生效的同意/已过的保留期却声明导出可用）同样是 500，
 *    并共用同一文案，使调用方无法据此区分内部原因。
 * 6. **出口再校验一次**：存储记录必须满足读取契约（字段闭集、枚举闭集、主体形态、状态自洽），
 *    违规即 500，且日志只写字段路径与违规类型、**不写取值**；对外视图再过一遍 `.strict()`
 *    白名单，多出字段即 500。因此即使存储被塞进同意原文或审核意见，也绝不会外发。
 *
 * 授权口径（已知偏差，与审计/通知/统计/导出切片的处理同构，属后续版本项）：权限目录是
 * **闭集**（docs/P2-权限目录与状态机.md §1「未列出即拒绝」），其中没有 `compliance:self:read`。
 * 本切片因此复用目录内已有的 self 权限点 `profile:self:read`（合规状态是「把本人可读事实
 * 交付给本人」的读侧动作）；新增 `compliance:self:read` 需要权限目录版本升级并同步公开契约
 * 夹具 `services/ruoyi-api/contracts`，属后续版本项；本切片**不新增权限点**。
 *
 * 尚不包含（明确留给后续切片）：记录/撤回同意、政策版本升级与重新告知、数据保留期限配置与
 * 到期清理、更正与删除请求（`requested -> approved|rejected|cancelled -> executed`）、
 * 归档与调查冻结、通知投递、审计落库、管理端合规视图与导出。
 */
@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(COMPLIANCE_REPOSITORY) private readonly repository: ComplianceRepository,
  ) {}

  /**
   * 本人最小合规状态：授权 → 查询串闭集 → 请求体闭集 → 按主体取数 → 出口白名单。
   *
   * `query` / `body` 只是「需要被 fail-closed 拒绝的不应存在之物」：本端点不声明任何输入，
   * 因此它们作为显式参数传入（服务是单例，绝不保存任何请求级状态），且**在授权之后**才检查。
   */
  getMyComplianceStatus(
    subject: AuthorizationSubject,
    query: unknown,
    body: unknown,
  ): ComplianceStatusView {
    // 1. 授权先于输入校验、先于任何端口读取（权限点/范围是服务端常量，归属取会话主体）
    this.authorizeSelf(subject, COMPLIANCE_STATUS_PERMISSION);

    // 2. 查询串闭集：`?userId=`/`?roles=`/`?phone=` 等一律 400，不是静默忽略
    assertDeclaredComplianceQueryFields(query);

    // 3. 请求体闭集：GET 读取接口不接受任何请求体字段
    assertDeclaredComplianceBodyFields(body);

    // 4. 只按服务端主体取数；随后复核读取契约、归属与出口白名单（fail-closed）
    return this.toOwnedView(this.repository.findByUserId(subject.userId), subject.userId);
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
   * 输出边界：先判「有没有事实」（没有即 500，不得凭空给出状态），再过读取契约
   * （字段闭集/枚举闭集/主体形态/状态自洽），再复核归属（纵深防御：仓储未按主体过滤、
   * 数据被外部改写），最后过一遍出口白名单。
   * 违反者 500 且使用同一文案，日志只写字段路径与违规类型，不写取值、不外发任何记录内容。
   */
  private toOwnedView(record: unknown, expectedOwnerId: string): ComplianceStatusView {
    if (record === undefined) {
      this.logger.error('[compliance] 未找到该主体的合规状态记录（缺失即 fail-closed）');
      throw new InternalServerErrorException(COMPLIANCE_INTEGRITY_MESSAGE);
    }

    const parsed = parseStoredComplianceRecord(record);
    if (!parsed.ok) {
      this.logger.error(
        `[compliance] 存储记录违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(COMPLIANCE_INTEGRITY_MESSAGE);
    }

    if (readComplianceOwnerId(parsed.value) !== expectedOwnerId) {
      this.logger.error('[compliance] 存储记录归属与会话主体不一致（仓储未按主体过滤）');
      throw new InternalServerErrorException(COMPLIANCE_INTEGRITY_MESSAGE);
    }

    const view = parseComplianceStatusView(toComplianceStatusView(parsed.value));
    if (!view.ok) {
      this.logger.error(
        `[compliance] 对外视图违反输出白名单: ${view.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(COMPLIANCE_INTEGRITY_MESSAGE);
    }

    return view.value;
  }
}

/**
 * 本人合规状态的门控点（服务端常量）：`profile:self:read` + `SELF`。
 * 复用已有的 self 权限点（不新增权限点），理由见类注释的「授权口径（已知偏差）」。
 */
export const COMPLIANCE_STATUS_PERMISSION: PermissionPoint = PermissionPoint.ProfileSelfRead;
