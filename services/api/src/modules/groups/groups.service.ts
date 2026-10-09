import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { DataScope, PermissionPoint, isGroupApplicable, paginationSchema } from '@rm/shared';
import type { AuthorizationSubject, Pagination } from '@rm/shared';
import {
  AUTHORIZATION_FORBIDDEN_MESSAGE,
  AuthorizationGuard,
} from '../access-control/authorization-guard';
import {
  GROUP_INITIAL_STATUS,
  GROUP_INTEGRITY_MESSAGE,
  assertDeclaredGroupInputFields,
  assertDeclaredGroupListQueryFields,
  assertNoGroupWriteQueryFields,
  buildGroupReadCandidates,
  groupCreateInputSchema,
  parseStoredGroup,
  readGroupLeaderId,
  toGroupView,
} from './groups.contract';
import type { GroupListPage, GroupView, StoredGroup } from './groups.contract';
import { GROUP_REPOSITORY } from './groups.port';
import type { GroupRepository, GroupVisibilityQuery, ResearchGroup } from './groups.port';

/**
 * 小组切片（P6 最小垂直切片）：
 * - `GET  /groups`  分页浏览**对服务端主体可见**的开放小组（`group:read:open`）
 * - `POST /groups`  创建小组（`group:manage`）
 *
 * 五条硬约束：
 * 1. **主体与归属都来自服务端**：负责人 `leaderUserId` 取自会话主体，初始状态由服务端常量
 *    写入（恒为 `open`）；客户端提交的 `leaderUserId`/`status`/`groupId`/`userId`/`roles`/`scope`
 *    既不能进入判定，也不能落库——它们由输入闭集直接拒绝（400），不是静默剥离。
 * 2. **授权先于任何仓储访问与字段校验**：两条路由都先经 `AuthorizationGuard`
 *    （其下是 `RUOYI_AUTHZ_ADAPTER` 端口 → canonical 谓词），拒绝即 403。
 *    未授权主体既观察不到小组是否存在，也拿不到字段级/查询串校验反馈。
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
 * 4. **分页只影响取数窗口，不影响可见性**：查询串闭集只接受共享 `paginationSchema` 的
 *    `page`/`pageSize`（其余键一律 400，含 `groupId`/`scope`/`userId`/`roles` 这类服务端声明）；
 *    `total` 由仓储按**同一套可见性语义**计数，因此分页元数据不会与实际数据不一致；
 *    窗口再大也只能返回已判定可见的小组（`offset` 超界即空页），不会扩大可见集合。
 * 5. **输出前再校验一次**：存储记录必须满足读取契约（枚举闭集 + ISO 时间格式），且
 *    （a）状态必须为开放（本端点只暴露开放小组）、（b）必须落在已判定的可见范围内；
 *    违反者按服务端缺陷 500 处理，不允许把未知枚举、非开放小组或范围外小组当作正常输出。
 *
 * 尚不包含（明确留给后续切片）：小组详情、修改/停用（`PATCH`，含状态机与
 * `group:manage` 的资源级判定）、成员与成员数、负责人由管理员指定的创建流程、
 * 排序/关键词过滤、幂等键与审计落库。
 *
 * ## 持久化绑定与本切片的关系
 * service 只认端口 `GROUP_REPOSITORY`，因此「内存基线」与「PostgreSQL」的切换**不在本层**
 * （见 `groups.module.ts` 的 `createGroupRepository`）。本层需要保证的是与换绑无关的性质：
 * 1. 归属只来自 `subject.userId`，可见范围只来自 `resolveVisibility(subject)` 的判定产物 ——
 *    两者都不经过请求体/查询串，因此**换绑到数据库不会改变授权口径**；
 * 2. 授权与输入闭集检查**先于**任何 `repository.*` 调用（`loadPage` 是本类唯一取数入口，
 *    只从 `listGroups` 的授权之后调用；`createGroup` 先授权、再校验、最后写入）；
 * 3. 仓储是否持久、是否生产可用由**能力声明**回答（`capabilities`），启动期持久化边界与
 *    依赖就绪门禁据此 fail-closed，而不是由本层猜测。
 */
@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(GROUP_REPOSITORY) private readonly repository: GroupRepository,
  ) {}

  /**
   * 分页浏览对服务端主体可见的开放小组。
   *
   * 顺序（被测试固定）：无有效会话 → 401（认证边界，见 controller）；授权拒绝 → 403；
   * 查询串出现未声明/服务端独占键 → 400；分页参数越界 → 400。
   * 授权排在最前，因此无权主体拿不到任何关于「有多少小组可见」或「查询串是否合法」的信息。
   *
   * `rawQuery` 只是原始查询串：它只被用来取分页窗口，**从不**参与授权判定，
   * 也从不被当作过滤器（本切片没有关键词/排序/过滤）。
   */
  listGroups(subject: AuthorizationSubject, rawQuery: unknown): Promise<GroupListPage> {
    const visibility = this.resolveVisibility(subject);

    // 查询串闭集（服务端独占键给出可区分的拒绝原因）→ 共享分页 schema 校验上下界
    assertDeclaredGroupListQueryFields(rawQuery);
    const pagination: Pagination = paginationSchema.parse(rawQuery ?? {});

    return this.loadPage(visibility, pagination);
  }

  /**
   * 取数 → 输出校验。**拆分出来是为了固定「授权先于仓储访问」的时序**：
   * `resolveVisibility` 与查询串闭集都在进入本方法之前完成，因此本方法内的任何
   * 仓储调用（以及它可能抛出的存储层错误）都只可能发生在授权通过之后。
   */
  private async loadPage(
    visibility: GroupVisibilityQuery,
    pagination: Pagination,
  ): Promise<GroupListPage> {
    const records = await this.repository.listVisibleGroups(visibility, {
      offset: (pagination.page - 1) * pagination.pageSize,
      limit: pagination.pageSize,
    });
    // total 与当前页来自同一套可见性语义（仓储的同一实现），不受窗口影响
    const total = await this.repository.countVisibleGroups(visibility);

    const items = records.map((record) => {
      const stored = this.assertStoredGroup(record);
      this.assertVisible(stored, visibility);
      return toGroupView(stored);
    });

    return { items, total, pagination };
  }

  /**
   * 创建小组：负责人与状态都由服务端决定，请求体只提供业务字段。
   *
   * 顺序（被测试固定）：无有效会话 → 401（认证边界，见 controller）；授权拒绝 → 403；
   * 查询串出现任何键 → 400（写接口不声明查询参数）；请求体字段闭集/字段级校验 → 400。
   * 授权仍排在最前：无权主体拿不到任何字段级或查询串反馈。
   */
  async createGroup(
    subject: AuthorizationSubject,
    body: unknown,
    rawQuery: unknown,
  ): Promise<GroupView> {
    this.authorizeGroupManage(subject);

    // 写接口不声明任何查询参数：`?userId=`/`?scope=`/`?groupId=` 这类声明必须显式拒绝，
    // 而不是「反正不会被读取」地静默忽略（否则该不变量无法被观测与回归）。
    assertNoGroupWriteQueryFields(rawQuery);

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
    const created = await this.repository.create(validated);

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
