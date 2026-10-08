import { createValueGuard } from './guard';

/** 角色（docs/P1-权限矩阵.md §1） */
export const Role = {
  Student: 'student',
  GroupLeader: 'group_leader',
  Admin: 'admin',
  SystemAdmin: 'system_admin',
  SuperAdmin: 'super_admin',
} as const;
export type Role = (typeof Role)[keyof typeof Role];
export const ROLE_VALUES = [
  Role.Student,
  Role.GroupLeader,
  Role.Admin,
  Role.SystemAdmin,
  Role.SuperAdmin,
] as const;
export const isRole = createValueGuard(ROLE_VALUES);

/** 数据范围（docs/P1-权限矩阵.md §3） */
export const DataScope = {
  Self: 'SELF',
  Group: 'GROUP',
  Assigned: 'ASSIGNED',
  Global: 'GLOBAL',
  System: 'SYSTEM',
} as const;
export type DataScope = (typeof DataScope)[keyof typeof DataScope];
export const DATA_SCOPE_VALUES = [
  DataScope.Self,
  DataScope.Group,
  DataScope.Assigned,
  DataScope.Global,
  DataScope.System,
] as const;
export const isDataScope = createValueGuard(DATA_SCOPE_VALUES);

/** P2 原子权限目录；未列出的值一律拒绝（docs/P2-权限目录与状态机.md §1）。 */
export const PermissionPoint = {
  ProfileSelfRead: 'profile:self:read',
  ProfileSelfUpdate: 'profile:self:update',
  ProfileAdminRead: 'profile:admin:read',
  ProfileAdminCorrect: 'profile:admin:correct',
  GroupReadOpen: 'group:read:open',
  GroupManage: 'group:manage',
  MembershipSelfCreate: 'membership:self:create',
  MembershipSelfWithdraw: 'membership:self:withdraw',
  MembershipReviewGroup: 'membership:review:group',
  MembershipReviewGlobal: 'membership:review:global',
  AchievementSelfCreate: 'achievement:self:create',
  AchievementSelfUpdate: 'achievement:self:update',
  AchievementSelfRead: 'achievement:self:read',
  AchievementReview: 'achievement:review',
  EducationSelfCreate: 'education:self:create',
  EducationSelfUpdate: 'education:self:update',
  EducationSelfRead: 'education:self:read',
  EducationReview: 'education:review',
  MatchingSelfRequest: 'matching:self:request',
  MatchingRecordsRead: 'matching:records:read',
  StatisticsFlowRead: 'statistics:flow:read',
  StatisticsAchievementRead: 'statistics:achievement:read',
  StatisticsEducationRead: 'statistics:education:read',
  ExportProfileCreate: 'export:profile:create',
  ExportProfileDownload: 'export:profile:download',
  ExportAchievementCreate: 'export:achievement:create',
  ExportAchievementDownload: 'export:achievement:download',
  ExportEducationCreate: 'export:education:create',
  ExportEducationDownload: 'export:education:download',
  ExportStatisticsCreate: 'export:statistics:create',
  ExportStatisticsDownload: 'export:statistics:download',
  AnnouncementManage: 'announcement:manage',
  UserManage: 'user:manage',
  RoleAssign: 'role:assign',
  PermissionConfigure: 'permission:configure',
  AuditRead: 'audit:read',
} as const;
export type PermissionPoint = (typeof PermissionPoint)[keyof typeof PermissionPoint];
export const PERMISSION_POINT_VALUES = Object.values(PermissionPoint) as [
  PermissionPoint,
  ...PermissionPoint[],
];
export const isPermissionPoint = createValueGuard(PERMISSION_POINT_VALUES);

/** role:assign remains restricted from ordinary administrator delegation. */
export const FORBIDDEN_PERMISSION_POINTS: readonly PermissionPoint[] = [
  PermissionPoint.RoleAssign,
  PermissionPoint.PermissionConfigure,
];

export const DEFAULT_ROLE_DATA_SCOPE: Record<Role, DataScope> = {
  [Role.Student]: DataScope.Self,
  [Role.GroupLeader]: DataScope.Group,
  [Role.Admin]: DataScope.Assigned,
  [Role.SystemAdmin]: DataScope.System,
  [Role.SuperAdmin]: DataScope.Global,
};

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, readonly PermissionPoint[]> = {
  [Role.Student]: [
    PermissionPoint.ProfileSelfRead,
    PermissionPoint.ProfileSelfUpdate,
    PermissionPoint.GroupReadOpen,
    PermissionPoint.MembershipSelfCreate,
    PermissionPoint.MembershipSelfWithdraw,
    PermissionPoint.AchievementSelfCreate,
    PermissionPoint.AchievementSelfUpdate,
    PermissionPoint.AchievementSelfRead,
    PermissionPoint.EducationSelfCreate,
    PermissionPoint.EducationSelfUpdate,
    PermissionPoint.EducationSelfRead,
    PermissionPoint.MatchingSelfRequest,
  ],
  [Role.GroupLeader]: [
    PermissionPoint.ProfileSelfRead,
    PermissionPoint.ProfileSelfUpdate,
    PermissionPoint.ProfileAdminRead,
    PermissionPoint.GroupReadOpen,
    PermissionPoint.MembershipReviewGroup,
    PermissionPoint.AchievementSelfRead,
    PermissionPoint.AchievementReview,
    PermissionPoint.EducationSelfRead,
    PermissionPoint.EducationReview,
    PermissionPoint.StatisticsFlowRead,
    PermissionPoint.StatisticsAchievementRead,
    PermissionPoint.StatisticsEducationRead,
    PermissionPoint.MatchingSelfRequest,
  ],
  [Role.Admin]: [
    PermissionPoint.ProfileSelfRead,
    PermissionPoint.ProfileSelfUpdate,
    PermissionPoint.ProfileAdminRead,
    PermissionPoint.GroupReadOpen,
    PermissionPoint.MatchingSelfRequest,
  ],
  [Role.SystemAdmin]: [
    PermissionPoint.ProfileSelfRead,
    PermissionPoint.ProfileSelfUpdate,
    PermissionPoint.GroupReadOpen,
    PermissionPoint.UserManage,
    PermissionPoint.PermissionConfigure,
    PermissionPoint.AuditRead,
  ],
  [Role.SuperAdmin]: PERMISSION_POINT_VALUES.filter(
    (permission) => permission !== PermissionPoint.RoleAssign,
  ),
};

export function canDelegatePermission(permission: PermissionPoint): boolean {
  return !FORBIDDEN_PERMISSION_POINTS.includes(permission);
}
