import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { DataScope, PermissionPoint } from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import {
  STATISTICS_INTEGRITY_MESSAGE,
  assertDeclaredStatisticsQueryFields,
  parseSelfStatisticsView,
} from './statistics.contract';
import type { SelfStatisticsView } from './statistics.contract';
import { SELF_STATISTICS_REPOSITORY } from './statistics.port';
import type { SelfStatisticsRepository } from './statistics.port';

/**
 * 统计切片（P8 最小垂直切片，本人侧）：
 * `GET /me/statistics` —— 返回**服务端会话主体本人**的教育记录/申请/成果/匹配请求条数。
 *
 * 输出契约（白名单，`statistics.contract.ts`）：
 * `data` 恰好是四个整数 `educationRecords` / `applications` / `achievements` /
 * `matchingRequests`。不含归属 `userId`、不含任何记录标识或字段取值、不含记录内容与 PII；
 * 计数**不做状态过滤**（只回答「有几条」），升学率、按状态/类型的分布等口径需要明细，
 * 属于后续切片，不在本切片的白名单内。
 *
 * 六条硬约束：
 * 1. **主体只来自服务端会话**：`userId` 取 `AuthorizationSubject.userId`（由
 *    `SESSION_SUBJECT_RESOLVER` 从服务端会话存储解析），查询串与请求体、自定义头里的
 *    `userId`/`roles`/`scope`/`groupId` 既不能进入判定也不能改变取数主体。
 * 2. **授权先于一切**：四个来源各自的读取门控点先全部判定（见下表），任何一项不通过即整体
 *    403，此时**仓储一次都不会被调用**，未授权主体也拿不到查询串级别的字段反馈
 *    （查询串闭集在授权之后才检查，与其它切片「授权先于字段校验」的顺序一致）。
 * 3. **不允许部分放行**：不按「可见类别」拼装响应，因为那会让响应形状随授权结果变化；
 *    本端点要么给出完整且稳定的四个计数，要么 403。这样调用方永远无法从响应形状推断
 *    「自己看不见哪一类」。
 * 4. **读数经唯一聚合端口**：服务只依赖 `SELF_STATISTICS_REPOSITORY`（`statistics.port.ts`），
 *    该端口只被要求「按服务端主体一次读出四类计数」，不返回记录。内存实现由四个来源端口组合，
 *    持久化实现是一条参数化聚合 `SELECT`；两条路径的计数口径一致。
 * 5. **计数必须合法**：仓储返回非整数/负数/NaN/超上限/非数字一律 500，且日志只写字段路径，
 *    不写返回值；「空数据」是合法的 0，稳定返回四个 0，不是 404/500。
 * 6. **出口再校验一次**：聚合视图在返回前过一遍 `.strict()` 白名单，
 *    出现白名单之外的字段即 500，绝不外发。
 *
 * 读取门控点（权限点 + 数据范围恒为服务端常量 `SELF`）：
 * | 输出字段 | 权限点 | 口径说明 |
 * | --- | --- | --- |
 * | `educationRecords` | `education:self:read` | 与升学记录切片本人列表同一点 |
 * | `applications` | `membership:self:create` | 见下方「已知偏差」 |
 * | `achievements` | `achievement:self:read` | 与成果切片本人列表同一点 |
 * | `matchingRequests` | `matching:self:request` | 与匹配切片本人列表同一点 |
 *
 * 已知偏差（与入组申请切片的处理同构，列入后续版本项）：权限目录是**闭集**且没有
 * `statistics:self:read` 点；目录里已有的 `statistics:flow:read` / `statistics:achievement:read` /
 * `statistics:education:read` 的门控对象是小组/全局统计（默认范围为 `GROUP`/`GLOBAL`），
 * 用于本人端点会让学生（`SELF`）拿不到人统计，因此本切片选取上述四个**已有的 self 权限点**
 * 分别门控四类计数，不新增权限点。新增 `statistics:self:read` 需要权限目录版本升级并同步
 * 公开契约夹具 `services/ruoyi-api/contracts`，属后续版本项。
 *
 * 尚不包含（明确留给后续切片）：小组/全局统计（`statistics:flow:read` 等）、按状态/类型/时间
 * 的分布、明细下钻、导出、缓存与预聚合、审计落库。
 */
@Injectable()
export class StatisticsService {
  private readonly logger = new Logger(StatisticsService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(SELF_STATISTICS_REPOSITORY)
    private readonly selfStatistics: SelfStatisticsRepository,
  ) {}

  /**
   * 本人统计：授权 → 查询串闭集 → 聚合端口一次读数 → 出口白名单。
   *
   * `query` 只是「需要被 fail-closed 拒绝的不应存在之物」：本端点不声明任何查询参数，
   * 因此它作为显式参数传入（服务是单例，绝不保存任何请求级状态），且**在授权之后**才检查，
   * 避免未授权主体通过字段级反馈探测端点内部结构。
   */
  async getMyStatistics(
    subject: AuthorizationSubject,
    query: unknown,
  ): Promise<SelfStatisticsView> {
    // 1. 授权先于查询串校验、先于任何仓储读取
    this.assertAllSectionsAuthorized(subject);

    // 2. 查询串闭集：`?userId=`/`?roles=`/`?scope=`/`?groupId=` 等一律 400，不是静默忽略
    assertDeclaredStatisticsQueryFields(query);

    // 3. 聚合端口一次读数：主体只来自服务端会话
    const counts = await this.readCounts(subject.userId);

    // 4. 出口白名单门禁
    return this.assertView(counts);
  }

  /**
   * 四类计数的读取门控点全部判定（缺一即 403）。
   * 权限点与数据范围都是服务端常量，`resourceUserId` 取服务端会话主体；
   * 不接受任何客户端提交的角色/范围/归属，因此伪造的 claims 无法让任何一项通过。
   */
  private assertAllSectionsAuthorized(subject: AuthorizationSubject): void {
    this.authorizeSelf(subject, PermissionPoint.EducationSelfRead);
    this.authorizeSelf(subject, PermissionPoint.MembershipSelfCreate);
    this.authorizeSelf(subject, PermissionPoint.AchievementSelfRead);
    this.authorizeSelf(subject, PermissionPoint.MatchingSelfRequest);
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
   * 聚合端口取数 + 读取契约校验。
   * 违规（含持久化实现抛出的任何异常）一律 500；日志只写字段路径，**不写读取结果与异常原文**，
   * 因此即便仓储返回了记录/对象/PII，或驱动异常里带着连接信息，也不会经由日志或响应外发。
   */
  private async readCounts(ownerUserId: string): Promise<SelfStatisticsView> {
    let counts: unknown;
    try {
      counts = await this.selfStatistics.readCountsByUserId(ownerUserId);
    } catch {
      // 原始异常文本可能含连接串、SQL 与字段取值，一律不外发（也不写日志）
      this.logger.error('[statistics] 聚合读数失败：原始异常不外发（见持久化层脱敏口径）');
      throw new InternalServerErrorException(STATISTICS_INTEGRITY_MESSAGE);
    }

    const parsed = parseSelfStatisticsView(counts);
    if (!parsed.ok) {
      this.logger.error(
        `[statistics] 聚合读数违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(STATISTICS_INTEGRITY_MESSAGE);
    }
    return parsed.value;
  }

  /** 出口边界：聚合视图必须是恰好四个合法计数的闭集（多出字段即服务端缺陷） */
  private assertView(view: SelfStatisticsView): SelfStatisticsView {
    const parsed = parseSelfStatisticsView(view);
    if (!parsed.ok) {
      this.logger.error(
        `[statistics] 聚合视图违反输出白名单: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(STATISTICS_INTEGRITY_MESSAGE);
    }
    return parsed.value;
  }
}
