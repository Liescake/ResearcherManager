import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { DataScope, PermissionPoint, isGroupApplicable } from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import {
  AUTHORIZATION_FORBIDDEN_MESSAGE,
  AuthorizationGuard,
} from '../access-control/authorization-guard';
import {
  GROUP_INITIAL_STATUS,
  GROUP_INTEGRITY_MESSAGE,
  assertDeclaredGroupInputFields,
  buildGroupReadCandidates,
  groupCreateInputSchema,
  parseStoredGroup,
  readGroupLeaderId,
  toGroupView,
} from './groups.contract';
import type { GroupView, StoredGroup } from './groups.contract';
import { GROUP_REPOSITORY } from './groups.port';
import type { GroupRepository, GroupVisibilityQuery, ResearchGroup } from './groups.port';

/**
 * 小组切片（P6 最小垂直切片）：
 * - `GET  /groups`  浏览**对服务端主体可见**的开放小组（`group:read:open`）
 * - `POST /groups`  创建小组（`group:manage`）
 *
 * 四条硬约束：
 * 1. **主体与归属都来自服务端**：负责人 `leaderUserId` 取自会话主体，初始状态由服务端常量
 *    写入（恒为 `open`）；客户端提交的 `leaderUserId`/`status`/`groupId`/`userId`/`roles`/`scope`
 *    既不能进入判定，也不能落库——它们由输入闭集直接拒绝（400），不是静默剥离。
 * 2. **授权先于任何仓储访问**：两条路由都先经 `AuthorizationGuard`
 *    （其下是 `RUOYI_AUTHZ_ADAPTER` 端口 → canonical 谓词），拒绝即 403。
 *    未授权主体既观察不到小组是否存在，也拿不到字段级校验反馈。
 * 3. **可见范围由服务端主体的多个候选范围判定得出，不接受客户端的范围声明**：
 *    `group:read:open` 在权限矩阵里对**所有角色**开放（R），但每个角色的默认数据范围不同
 *    （学生 SELF、负责人 GROUP、管理员 ASSIGNED、系统管理员 SYSTEM、超级管理员 GLOBAL），
 *    而谓词要求 `request.scope` 与角色默认范围**精确相等**。因此集合级列表不能用单一的
 *    服务端常量范围表达：本切片把主体翻译成一组候选（`buildGroupReadCandidates`，范围表复用
 *    共享 `DEFAULT_ROLE_DATA_SCOPE`），逐个交给端口判定，取**判定通过的并集**：
 *    - 集合级候选（SELF/SYSTEM/GLOBAL）通过 → 可见全部开放小组；
 *    - 资源级候选（GROUP/ASSIGNED）**逐条**通过 → 只可见那一个小组合计。
 *    一个候选都没通过（例如负责人没有任何 `groupIds`、管理员没有任何 `assignedResourceIds`）
 *    时返回 403，而不是空列表：本端点不回答「是否存在你看不见的小组」。
 * 4. **输出前再校验一次**：存储记录必须满足读取契约（枚举闭集 + ISO 时间格式），且
 *    （a）状态必须为开放（本端点只暴露开放小组）、（b）必须落在已判定的可见范围内；
 *    违反者按服务端缺陷 500 处理，不允许把未知枚举、非开放小组或范围外小组当作正常输出。
 *
 * 尚不包含（明确留给后续切片）：小组详情、修改/停用（`PATCH`，含状态机与
 * `group:manage` 的资源级判定）、成员与成员数、负责人由管理员指定的创建流程、
 * 分页/排序/过滤、幂等键与审计落库。
 */
@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(GROUP_REPOSITORY) private readonly repository: GroupRepository,
  ) {}

  /** 浏览对服务端主体可见的开放小组：先做（多候选）集合级判定，再按授权产物取数 */
  listGroups(subject: AuthorizationSubject): GroupView[] {
    const visibility = this.resolveVisibility(subject);
    return this.repository.listVisibleGroups(visibility).map((record) => {
      const stored = this.assertStoredGroup(record);
      this.assertVisible(stored, visibility);
      return toGroupView(stored);
    });
  }

  /** 创建小组：负责人与状态都由服务端决定，请求体只提供业务字段 */
  createGroup(subject: AuthorizationSubject, body: unknown): GroupView {
    this.authorizeGroupManage(subject);

    // 输入闭集 → 字段级校验（共享 schema）：未知枚举、越界长度、控制字符、
    // 招募要求字段非法、小组名缺省等一律抛 ZodError，由统一异常过滤器映射为 400。
    assertDeclaredGroupInputFields(body);
    const input = groupCreateInputSchema.parse(body);

    const now = new Date().toISOString();
    const record: ResearchGroup = {
      id: randomUUID(),
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      researchDirections: [...input.researchDirections],
      recruitmentRequirements: input.recruitmentRequirements,
      // 负责人 = 服务端会话主体（不是请求体字段）；本切片不提供「替他人创建」的能力
      leaderUserId: subject.userId,
      // 新建小组一律开放：暂停/关闭只能经后续切片的 PATCH 状态机
      status: GROUP_INITIAL_STATUS,
      createdAt: now,
      updatedAt: now,
    };

    // 写入前先过读取契约：负责人必须是合法 UUID 等约束不满足时**不得落库**，
    // 避免把「进程内/数据库中违反共享契约的记录」当作正常结果。
    const validated = this.assertStoredGroup(record);
    const created = this.repository.create(validated);

    const stored = this.assertStoredGroup(created);
    if (readGroupLeaderId(stored) !== subject.userId) {
      // 纵深防御：仓储改写负责人（或返回他人记录）属于服务端缺陷，不得作为本人创建结果返回
      this.logger.error('[groups] 仓储返回的小组负责人与会话主体不一致');
      throw new InternalServerErrorException(GROUP_INTEGRITY_MESSAGE);
    }
    return toGroupView(stored);
  }

  /**
   * 创建小组的判定：权限点恒为 `group:manage`，范围恒为服务端常量 `GLOBAL`
   * （权限矩阵中 `group:manage` 只授予默认范围为 GLOBAL 的角色）。
   * 请求体与查询串里的 `leaderUserId`/`status`/`scope` 不参与判定。
   */
  private authorizeGroupManage(subject: AuthorizationSubject): void {
    this.guard.assertAuthorized(subject, {
      permission: PermissionPoint.GroupManage,
      scope: DataScope.Global,
    });
  }

  /**
   * 可见范围判定：候选来自服务端主体（角色来自会话存储，资源标识来自会话中的
   * `groupIds` / `assignedResourceIds`），逐个询问 `RUOYI_AUTHZ_ADAPTER` 端口，取并集。
   * 全部候选都被拒绝时抛 403，与资源级拒绝共用同一文案，
   * 调用方无法据此区分「没有该权限点」「范围内的资源不存在」。
   */
  private resolveVisibility(subject: AuthorizationSubject): GroupVisibilityQuery {
    const allowed = buildGroupReadCandidates(subject).filter((candidate) =>
      this.guard.canAuthorize(subject, candidate.request),
    );
    if (allowed.length === 0) {
      throw new ForbiddenException(AUTHORIZATION_FORBIDDEN_MESSAGE);
    }

    const visibleGroupIds = [
      ...new Set(
        allowed.flatMap((candidate) =>
          candidate.kind === 'resource' && candidate.resourceId ? [candidate.resourceId] : [],
        ),
      ),
    ];
    return {
      includeAllOpenGroups: allowed.some((candidate) => candidate.kind === 'collection'),
      visibleGroupIds,
    };
  }

  /** 存储记录必须满足读取契约，否则按服务端缺陷 500（日志不含字段取值） */
  private assertStoredGroup(record: unknown): StoredGroup {
    const parsed = parseStoredGroup(record);
    if (!parsed.ok) {
      this.logger.error(
        `[groups] 存储记录违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(GROUP_INTEGRITY_MESSAGE);
    }
    return parsed.value;
  }

  /**
   * 可见性复核（纵深防御，两个条件都属服务端不变量）：
   * 1. 本端点只输出**开放**小组，仓储若返回暂停/关闭小组即违反契约；
   * 2. 只输出已判定可见的小组：非集合级可见时，返回的小组必须落在 `visibleGroupIds` 内。
   * 违反者一律 500 且使用同一文案，调用方无法据此区分「数据损坏」与「越权取数」。
   */
  private assertVisible(record: StoredGroup, visibility: GroupVisibilityQuery): void {
    if (!isGroupApplicable(record.status)) {
      this.logger.error('[groups] 仓储返回了非开放状态的小组（可见性契约被违反）');
      throw new InternalServerErrorException(GROUP_INTEGRITY_MESSAGE);
    }
    if (!visibility.includeAllOpenGroups && !visibility.visibleGroupIds.includes(record.id)) {
      this.logger.error('[groups] 仓储返回了授权集合之外的小组（可见性契约被违反）');
      throw new InternalServerErrorException(GROUP_INTEGRITY_MESSAGE);
    }
  }
}
