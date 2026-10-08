import { z } from 'zod';
import {
  DEFAULT_ROLE_DATA_SCOPE,
  DataScope,
  GROUP_STATUS_VALUES,
  GroupStatus,
  PermissionPoint,
  isRole,
  researchGroupInputSchema,
  uuidSchema,
} from '@rm/shared';
import type { AuthorizationRequest, AuthorizationSubject } from '@rm/shared';
import type { ResearchGroup } from './groups.port';

/**
 * 小组切片的**输入闭集**、**读取契约**、**对外视图白名单**与**可见范围候选**。
 *
 * 输入闭集：创建接口只接受 `GROUP_CREATE_INPUT_FIELDS`（= 共享 `researchGroupInputSchema`
 * 去掉服务端独占字段后的键集，有回归断言）。出现闭集之外的字段（`leaderUserId`、`status`、
 * `groupId`、`userId`、`roles`、`scope`、`id`、时间戳…）一律 400，而不是「静默忽略」——
 * 客户端提交的负责人、状态、归属、权限与范围不是「被忽略的输入」，而是明确不被接受的输入，
 * 必须留下可观测的拒绝记录。
 *
 * 读取契约：存储记录在离开进程前必须满足本结构（含枚举闭集与 ISO 时间格式）。未知枚举
 * （例如数据库迁移先于代码上线、或数据被外部改写）属于服务端缺陷：由 service 判为 500，
 * 绝不允许把未知状态当作合法值返回给调用方。
 *
 * 对外视图白名单：`GroupView` 逐字段显式投影，**不含** `leaderUserId`（数据字典标注为
 * 「内部」的负责人标识），也不含任何审核/审计字段。负责人展示名需要画像切片提供脱敏展示名，
 * 属于后续版本项；本切片不把内部标识当作「负责人信息」输出。
 *
 * 可见范围候选：`buildGroupReadCandidates` 把「服务端主体」翻译成一组**授权候选**
 * （范围 + 该范围所需的服务端解析资源标识），由 service 逐个交给
 * `AuthorizationGuard`（其下是 `RUOYI_AUTHZ_ADAPTER` 端口）判定。
 * 这里不复制授权规则：候选范围取自共享的 `DEFAULT_ROLE_DATA_SCOPE`（与谓词同一张表），
 * 而能否通过完全由端口背后的 canonical 谓词决定。
 */

/**
 * 创建接口声明的请求字段闭集：必须与共享 `researchGroupInputSchema` 去掉
 * `leaderUserId` / `status` 后的键集一致（有回归断言）。
 */
export const GROUP_CREATE_INPUT_FIELDS = [
  'name',
  'description',
  'researchDirections',
  'recruitmentRequirements',
] as const;

/**
 * 服务端独占字段（**禁止客户端提交**）：即使它们不在创建 schema 内，也必须给出可区分的
 * 拒绝原因，避免「以为是业务字段但被静默剥离」。这些字段只能来自服务端会话、状态机或存储。
 */
export const FORBIDDEN_GROUP_FIELDS = [
  'id',
  'groupId',
  'groupIds',
  'leaderUserId',
  'leaderUserIds',
  'userId',
  'ownerUserId',
  'role',
  'roles',
  'scope',
  'dataScope',
  'status',
  'permissions',
  'permissionPoints',
  'assignedResourceIds',
  'members',
  'memberCount',
  'createdAt',
  'updatedAt',
] as const;

/**
 * 服务端写入的初始状态：新建小组一律开放（进入可被浏览/可被申请的集合）。
 * 停用/关闭只能经后续切片的 `PATCH /groups/{groupId}`（含状态机与 `group:manage` 判定）完成，
 * 因此入口状态只可能是 open。
 */
export const GROUP_INITIAL_STATUS = GroupStatus.Open;

/** 读取契约违规或仓储越界返回时的统一对外文案（多种情况共用，避免区分内部原因） */
export const GROUP_INTEGRITY_MESSAGE = '小组数据完整性校验失败';

/**
 * 创建接口的输入 schema：**直接复用共享 schema 的字段定义**，只去掉两个服务端独占字段。
 * - `leaderUserId`：负责人永远取会话主体，客户端提交该键会被输入闭集拒绝（400）；
 * - `status`：入口状态由 `GROUP_INITIAL_STATUS` 写入，客户端提交该键同样 400。
 *
 * 复用 `.omit()` 而不是另写一份，是为了让共享 schema 的约束（长度、标签数量、招募要求枚举、
 * 控制字符、高敏感内容）成为唯一事实来源：共享 schema 变更时本接口自动跟随。
 */
export const groupCreateInputSchema = researchGroupInputSchema.omit({
  leaderUserId: true,
  status: true,
});

/** 共享 `researchGroupInputSchema` 中可直接复用的字段定义（避免复制约束） */
const sharedGroupShape = researchGroupInputSchema.shape;

/**
 * 存储记录读取契约：字段 + 枚举闭集 + ISO 时间戳。
 *
 * 与共享输入 schema 的差异只有两处，且都是刻意的：
 * - `status` 用不带默认值的 `z.enum(GROUP_STATUS_VALUES)`：共享输入 schema 的 `status`
 *   带 `default('open')`，若直接复用，存储记录**缺失状态**会被静默补成 open；
 *   读取契约必须「缺失即违规」；
 * - 增加 `id` / `createdAt` / `updatedAt`（服务端生成）。
 * 其余字段全部复用共享 schema 的字段定义，因此约束不会与输入侧漂移。
 */
export const storedGroupSchema = z.object({
  id: uuidSchema,
  name: sharedGroupShape.name,
  description: sharedGroupShape.description,
  researchDirections: sharedGroupShape.researchDirections,
  recruitmentRequirements: sharedGroupShape.recruitmentRequirements,
  leaderUserId: sharedGroupShape.leaderUserId,
  status: z.enum(GROUP_STATUS_VALUES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type StoredGroup = z.infer<typeof storedGroupSchema>;

/**
 * 对外视图白名单：逐字段显式投影。
 * **不含** `leaderUserId`（内部标识），也不含审核/审计字段与任何原始请求体回显。
 */
export interface GroupView {
  id: string;
  name: string;
  description?: string;
  researchDirections: string[];
  recruitmentRequirements: StoredGroup['recruitmentRequirements'];
  status: StoredGroup['status'];
  createdAt: string;
  updatedAt: string;
}

export interface GroupContractIssue {
  readonly kind: 'invalid' | 'unexpected';
  readonly path: string;
}

export type StoredGroupParse =
  | { readonly ok: true; readonly value: StoredGroup }
  | { readonly ok: false; readonly issues: readonly GroupContractIssue[] };

/**
 * 校验并规范化一条存储记录（一次解析，避免「先断言后使用」的重复解析）。
 * 失败时只返回字段路径与违规类型，**不返回字段取值**。
 */
export function parseStoredGroup(record: unknown): StoredGroupParse {
  const parsed = storedGroupSchema.safeParse(record);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      kind: issue.code === 'unrecognized_keys' ? ('unexpected' as const) : ('invalid' as const),
      path: issue.path.join('.') || '(root)',
    })),
  };
}

/** 校验后的存储记录 → 对外视图（逐字段显式赋值，不使用对象展开传内部字段） */
export function toGroupView(record: StoredGroup): GroupView {
  const requirements = record.recruitmentRequirements;
  return {
    id: record.id,
    name: record.name,
    ...(record.description ? { description: record.description } : {}),
    // 数组与嵌套对象逐层复制：不把仓储的内部引用交给响应序列化
    researchDirections: [...record.researchDirections],
    recruitmentRequirements: {
      ...(requirements.skills ? { skills: [...requirements.skills] } : {}),
      ...(requirements.grades ? { grades: [...requirements.grades] } : {}),
      ...(requirements.minWeeklyHours !== undefined
        ? { minWeeklyHours: requirements.minWeeklyHours }
        : {}),
      ...(requirements.headcount !== undefined ? { headcount: requirements.headcount } : {}),
      ...(requirements.note ? { note: requirements.note } : {}),
    },
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * 字段闭集门禁：请求体出现未声明字段时抛 `ZodError`，由 `ApiExceptionFilter` 统一映射为
 * 400 `VALIDATION_FAILED` + `details.issues`。
 *
 * `path` 指向违规字段本身，`message` 区分「服务端独占字段」与「未声明字段」：
 * 前者是必须显式拒绝的越权尝试（负责人/状态/归属/角色/范围），后者是契约漂移，两者都要能被观测到。
 * 非对象请求体（缺体、`null`、数组、标量）不在这里拒绝，交给字段级 schema 判非法。
 */
export function assertDeclaredGroupInputFields(body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;

  const declared: readonly string[] = GROUP_CREATE_INPUT_FIELDS;
  const forbidden: readonly string[] = FORBIDDEN_GROUP_FIELDS;
  const unexpected = Object.keys(body).filter((key) => !declared.includes(key));
  if (unexpected.length === 0) return;

  throw new z.ZodError(
    unexpected.map((key) => ({
      code: 'unrecognized_keys' as const,
      keys: [key],
      path: [key] as (string | number)[],
      message: forbidden.includes(key)
        ? `禁止设置服务端字段 ${key}`
        : `请求体包含未声明字段 ${key}`,
    })),
  );
}

/** 授权候选的判定来源；只用于日志/测试与报告口径，不返回客户端 */
export type GroupReadOrigin = 'SELF' | 'GROUP' | 'ASSIGNED' | 'SYSTEM' | 'GLOBAL';

/**
 * 一条授权候选：
 * - `collection`：集合级判定通过即可见**全部开放小组**；
 * - `resource`：只对 `resourceId` 这一个小组合法（GROUP 范围必须逐条带 `groupId` 判定，
 *   不能用一个集合级判定越过「groupId 必须属于服务端解析的 groupIds」这条检查）。
 */
export interface GroupReadCandidate {
  readonly kind: 'collection' | 'resource';
  readonly origin: GroupReadOrigin;
  readonly request: AuthorizationRequest;
  readonly resourceId?: string;
}

/**
 * 把服务端主体翻译成授权候选列表（纯函数，便于单测与回归）：
 *
 * - 范围来自共享 `DEFAULT_ROLE_DATA_SCOPE`（与谓词同一张表），角色来自**服务端会话**；
 *   未登记角色不产生候选（fail-closed，绝不退化成「按已知角色继续」）；
 * - `SELF`：`resourceUserId` 取会话主体；`SYSTEM` / `GLOBAL` 不需要资源标识；
 * - `GROUP`：**逐个** `groupIds` 生成候选（每条都要过「groupId 属于服务端解析集合」的检查）；
 * - `ASSIGNED`：**逐个** `assignedResourceIds` 生成候选（服务端分配的可见资源）；
 * - 结果去重且顺序确定，保证判定次数与判定入参可被测试固定。
 *
 * 候选只是「可以问端口的问题」，不是授权结论：能否通过完全由端口背后的谓词决定。
 * 客户端提交的 `roles`/`scope`/`groupId` 永远不会进入本函数。
 */
export function buildGroupReadCandidates(
  subject: AuthorizationSubject,
): readonly GroupReadCandidate[] {
  const candidates: GroupReadCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: GroupReadCandidate): void => {
    const { scope, groupId, resourceUserId } = candidate.request;
    const key = `${scope}|${groupId ?? ''}|${resourceUserId ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };
  const permission = PermissionPoint.GroupReadOpen;

  for (const role of subject.roles) {
    if (!isRole(role)) continue;
    switch (DEFAULT_ROLE_DATA_SCOPE[role]) {
      case DataScope.Self:
        add({
          kind: 'collection',
          origin: 'SELF',
          request: { permission, scope: DataScope.Self, resourceUserId: subject.userId },
        });
        break;
      case DataScope.Group:
        for (const groupId of subject.groupIds ?? []) {
          add({
            kind: 'resource',
            origin: 'GROUP',
            resourceId: groupId,
            request: { permission, scope: DataScope.Group, groupId },
          });
        }
        break;
      case DataScope.Assigned:
        for (const resourceId of subject.assignedResourceIds ?? []) {
          add({
            kind: 'resource',
            origin: 'ASSIGNED',
            resourceId,
            request: { permission, scope: DataScope.Assigned, resourceUserId: resourceId },
          });
        }
        break;
      case DataScope.System:
        add({
          kind: 'collection',
          origin: 'SYSTEM',
          request: { permission, scope: DataScope.System },
        });
        break;
      case DataScope.Global:
        add({
          kind: 'collection',
          origin: 'GLOBAL',
          request: { permission, scope: DataScope.Global },
        });
        break;
      default:
        break;
    }
  }

  return candidates;
}

/** 供测试与调用方复用：读取记录负责人（不可读时返回空串，交由调用方按服务端缺陷处理） */
export function readGroupLeaderId(record: ResearchGroup): string {
  return typeof record.leaderUserId === 'string' ? record.leaderUserId : '';
}
