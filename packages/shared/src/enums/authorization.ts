import {
  DataScope,
  DEFAULT_ROLE_DATA_SCOPE,
  DEFAULT_ROLE_PERMISSIONS,
  PermissionPoint,
  Role,
  isDataScope,
  isPermissionPoint,
  isRole,
} from './permission';

/** 最小授权主体；groupIds 是服务端已验证的组关系，不能来自请求体。 */
export interface AuthorizationSubject {
  userId: string;
  roles: readonly Role[];
  groupIds?: readonly string[];
  assignedResourceIds?: readonly string[];
}

export interface AuthorizationRequest {
  permission: PermissionPoint;
  scope: DataScope;
  groupId?: string;
  /** 服务端解析的资源用户；客户端提交的同名字段不得直接作为主体。 */
  resourceUserId?: string;
  /** ASSIGNED 范围内由服务端解析并绑定的资源集合。 */
  assignedResourceIds?: readonly string[];
}

export interface PermissionGrant extends AuthorizationRequest {
  targetUserId: string;
}

const EXPORT_PERMISSIONS = new Set<PermissionPoint>([
  PermissionPoint.ExportProfileCreate,
  PermissionPoint.ExportProfileDownload,
  PermissionPoint.ExportAchievementCreate,
  PermissionPoint.ExportAchievementDownload,
  PermissionPoint.ExportEducationCreate,
  PermissionPoint.ExportEducationDownload,
  PermissionPoint.ExportStatisticsCreate,
  PermissionPoint.ExportStatisticsDownload,
]);

/** 默认拒绝：检查角色原子权限、角色范围及 GROUP 绑定。 */
export function isAuthorized(
  subject: AuthorizationSubject,
  request: AuthorizationRequest,
): boolean {
  if (!subject.userId || !isPermissionPoint(request.permission) || !isDataScope(request.scope))
    return false;
  if (!subject.roles.every((role) => isRole(role))) return false;
  return subject.roles.some((role) => {
    if (!DEFAULT_ROLE_PERMISSIONS[role]?.includes(request.permission)) return false;
    const roleScope = DEFAULT_ROLE_DATA_SCOPE[role];
    if (request.scope !== roleScope) return false;
    if (request.scope === DataScope.Self && request.resourceUserId !== subject.userId) {
      return false;
    }
    if (
      request.scope === DataScope.Assigned &&
      (!request.resourceUserId || !subject.assignedResourceIds?.includes(request.resourceUserId))
    ) {
      return false;
    }
    if (role === Role.GroupLeader) {
      return (
        request.scope === DataScope.Group &&
        !!request.groupId &&
        subject.groupIds?.includes(request.groupId) === true
      );
    }
    return true;
  });
}

/** 服务端权限配置边界：不能自授予敏感配置或 GLOBAL；组负责人只能配置本组 GROUP。 */
export function canGrantPermissions(
  actor: AuthorizationSubject,
  grants: readonly PermissionGrant[],
): boolean {
  if (!actor.userId || !actor.roles.every((role) => isRole(role))) return false;
  const isSuperAdmin = actor.roles.includes(Role.SuperAdmin);
  const isSystemAdmin = actor.roles.includes(Role.SystemAdmin);
  // Only system/super admins may configure, and ordinary admins can never self-elevate.
  if (!isSuperAdmin && !isSystemAdmin) return false;
  return grants.every((grant) => {
    if (!grant.targetUserId || !isPermissionPoint(grant.permission) || !isDataScope(grant.scope))
      return false;
    if (
      grant.permission === PermissionPoint.RoleAssign ||
      grant.permission === PermissionPoint.PermissionConfigure
    )
      return false;
    if (grant.scope === DataScope.Global && !isSuperAdmin) return false;
    if (grant.scope === DataScope.System && !isSuperAdmin) return false;
    if (actor.roles.includes(Role.GroupLeader)) {
      if (
        grant.scope !== DataScope.Group ||
        !grant.groupId ||
        !actor.groupIds?.includes(grant.groupId)
      )
        return false;
    }
    if (grant.scope === DataScope.Global && !actor.roles.includes(Role.SuperAdmin)) return false;
    if (
      grant.scope === DataScope.System &&
      !actor.roles.includes(Role.SystemAdmin) &&
      !actor.roles.includes(Role.SuperAdmin)
    )
      return false;
    return true;
  });
}

/** 导出与审计均按原子权限判断，拒绝 wildcard/未登记权限。 */
export function isAtomicPermission(permission: unknown): permission is PermissionPoint {
  return (
    typeof permission === 'string' &&
    (Object.values(PermissionPoint) as string[]).includes(permission) &&
    (EXPORT_PERMISSIONS.has(permission as PermissionPoint) ||
      permission === PermissionPoint.AuditRead ||
      !permission.includes('*'))
  );
}
