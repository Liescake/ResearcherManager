/**
 * 展示层中文标签：集中维护，避免前端各处硬编码字符串。
 * 未知值由 createLabelLookup 返回占位符。
 */
import { createLabelLookup } from './guard';
import {
  AccountStatus,
  ApplicationStatus,
  GroupStatus,
  MembershipStatus,
  ReviewStatus,
} from './status';
import {
  AchievementType,
  AvailablePeriod,
  EducationStatus,
  EducationType,
  Grade,
  ProgrammingLevel,
} from './taxonomy';
import { DataScope, Role } from './permission';

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  [AccountStatus.Active]: '正常',
  [AccountStatus.Locked]: '已锁定',
  [AccountStatus.Deleted]: '已注销',
};

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  [ApplicationStatus.Pending]: '待审核',
  [ApplicationStatus.Approved]: '审核通过',
  [ApplicationStatus.Rejected]: '审核驳回',
  [ApplicationStatus.Withdrawn]: '已撤回',
  [ApplicationStatus.Completed]: '已完成',
};

export const MEMBERSHIP_STATUS_LABELS: Record<MembershipStatus, string> = {
  [MembershipStatus.Active]: '在组',
  [MembershipStatus.Ended]: '已退组',
};

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  [ReviewStatus.Pending]: '待审核',
  [ReviewStatus.Approved]: '已通过',
  [ReviewStatus.Rejected]: '已驳回',
};

export const GROUP_STATUS_LABELS: Record<GroupStatus, string> = {
  [GroupStatus.Open]: '开放招募',
  [GroupStatus.Paused]: '暂停招募',
  [GroupStatus.Closed]: '已关闭',
};

export const GRADE_LABELS: Record<Grade, string> = {
  [Grade.Freshman]: '大一',
  [Grade.Sophomore]: '大二',
  [Grade.Junior]: '大三',
  [Grade.Senior]: '大四',
  [Grade.Graduate]: '研究生',
  [Grade.Other]: '其他',
};

export const PROGRAMMING_LEVEL_LABELS: Record<ProgrammingLevel, string> = {
  [ProgrammingLevel.None]: '无基础',
  [ProgrammingLevel.Basic]: '入门',
  [ProgrammingLevel.Intermediate]: '熟练',
  [ProgrammingLevel.Advanced]: '精通',
};

export const ACHIEVEMENT_TYPE_LABELS: Record<AchievementType, string> = {
  [AchievementType.Paper]: '论文',
  [AchievementType.Patent]: '专利',
  [AchievementType.Software]: '软件著作权',
  [AchievementType.Competition]: '竞赛',
  [AchievementType.Project]: '大创/项目',
  [AchievementType.Experience]: '科研经历',
};

export const EDUCATION_TYPE_LABELS: Record<EducationType, string> = {
  [EducationType.Recommendation]: '保研',
  [EducationType.Postgraduate]: '考研',
  [EducationType.Doctoral]: '考博',
  [EducationType.DirectDoctorate]: '直博',
};

export const EDUCATION_STATUS_LABELS: Record<EducationStatus, string> = {
  [EducationStatus.Preparing]: '备考中',
  [EducationStatus.Admitted]: '已录取',
  [EducationStatus.NotAdmitted]: '未上岸',
};

export const AVAILABLE_PERIOD_LABELS: Record<AvailablePeriod, string> = {
  [AvailablePeriod.WeekdayDay]: '工作日白天',
  [AvailablePeriod.WeekdayNight]: '工作日晚上',
  [AvailablePeriod.Weekend]: '周末',
};

export const ROLE_LABELS: Record<Role, string> = {
  [Role.Student]: '学生',
  [Role.GroupLeader]: '小组负责人',
  [Role.Admin]: '普通管理员',
  [Role.SystemAdmin]: '系统管理员',
  [Role.SuperAdmin]: '超级管理员/会长',
};

export const DATA_SCOPE_LABELS: Record<DataScope, string> = {
  [DataScope.Self]: '仅本人',
  [DataScope.Group]: '负责小组',
  [DataScope.Assigned]: '授权范围',
  [DataScope.Global]: '全局业务数据',
  [DataScope.System]: '系统配置与安全',
};

export const accountStatusLabel = createLabelLookup(ACCOUNT_STATUS_LABELS);
export const applicationStatusLabel = createLabelLookup(APPLICATION_STATUS_LABELS);
export const membershipStatusLabel = createLabelLookup(MEMBERSHIP_STATUS_LABELS);
export const reviewStatusLabel = createLabelLookup(REVIEW_STATUS_LABELS);
export const groupStatusLabel = createLabelLookup(GROUP_STATUS_LABELS);
export const gradeLabel = createLabelLookup(GRADE_LABELS);
export const programmingLevelLabel = createLabelLookup(PROGRAMMING_LEVEL_LABELS);
export const achievementTypeLabel = createLabelLookup(ACHIEVEMENT_TYPE_LABELS);
export const educationTypeLabel = createLabelLookup(EDUCATION_TYPE_LABELS);
export const educationStatusLabel = createLabelLookup(EDUCATION_STATUS_LABELS);
export const availablePeriodLabel = createLabelLookup(AVAILABLE_PERIOD_LABELS);
export const roleLabel = createLabelLookup(ROLE_LABELS);
export const dataScopeLabel = createLabelLookup(DATA_SCOPE_LABELS);
