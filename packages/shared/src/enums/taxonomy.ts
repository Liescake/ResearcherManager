import { createValueGuard } from './guard';

/** 年级（student_profiles.grade），口径需与字典一致 */
export const Grade = {
  Freshman: 'freshman',
  Sophomore: 'sophomore',
  Junior: 'junior',
  Senior: 'senior',
  Graduate: 'graduate',
  Other: 'other',
} as const;
export type Grade = (typeof Grade)[keyof typeof Grade];
export const GRADE_VALUES = [
  Grade.Freshman,
  Grade.Sophomore,
  Grade.Junior,
  Grade.Senior,
  Grade.Graduate,
  Grade.Other,
] as const;
export const isGrade = createValueGuard(GRADE_VALUES);

/** 编程能力等级，不允许自由文本等级 */
export const ProgrammingLevel = {
  None: 'none',
  Basic: 'basic',
  Intermediate: 'intermediate',
  Advanced: 'advanced',
} as const;
export type ProgrammingLevel = (typeof ProgrammingLevel)[keyof typeof ProgrammingLevel];
export const PROGRAMMING_LEVEL_VALUES = [
  ProgrammingLevel.None,
  ProgrammingLevel.Basic,
  ProgrammingLevel.Intermediate,
  ProgrammingLevel.Advanced,
] as const;
export const isProgrammingLevel = createValueGuard(PROGRAMMING_LEVEL_VALUES);

/** 成果类型（achievements.type） */
export const AchievementType = {
  Paper: 'paper',
  Patent: 'patent',
  Software: 'software',
  Competition: 'competition',
  Project: 'project',
  Experience: 'experience',
} as const;
export type AchievementType = (typeof AchievementType)[keyof typeof AchievementType];
export const ACHIEVEMENT_TYPE_VALUES = [
  AchievementType.Paper,
  AchievementType.Patent,
  AchievementType.Software,
  AchievementType.Competition,
  AchievementType.Project,
  AchievementType.Experience,
] as const;
export const isAchievementType = createValueGuard(ACHIEVEMENT_TYPE_VALUES);

/** 升学类型（education_records.type） */
export const EducationType = {
  Recommendation: 'recommendation',
  Postgraduate: 'postgraduate',
  Doctoral: 'doctoral',
  DirectDoctorate: 'direct_doctorate',
} as const;
export type EducationType = (typeof EducationType)[keyof typeof EducationType];
export const EDUCATION_TYPE_VALUES = [
  EducationType.Recommendation,
  EducationType.Postgraduate,
  EducationType.Doctoral,
  EducationType.DirectDoctorate,
] as const;
export const isEducationType = createValueGuard(EDUCATION_TYPE_VALUES);

/** 升学状态（education_records.status）：必须区分备考中/已录取/未上岸 */
export const EducationStatus = {
  Preparing: 'preparing',
  Admitted: 'admitted',
  NotAdmitted: 'not_admitted',
} as const;
export type EducationStatus = (typeof EducationStatus)[keyof typeof EducationStatus];
export const EDUCATION_STATUS_VALUES = [
  EducationStatus.Preparing,
  EducationStatus.Admitted,
  EducationStatus.NotAdmitted,
] as const;
export const isEducationStatus = createValueGuard(EDUCATION_STATUS_VALUES);

/** 空余时间段（student_profiles.available_time.periods） */
export const AvailablePeriod = {
  WeekdayDay: 'weekday_day',
  WeekdayNight: 'weekday_night',
  Weekend: 'weekend',
} as const;
export type AvailablePeriod = (typeof AvailablePeriod)[keyof typeof AvailablePeriod];
export const AVAILABLE_PERIOD_VALUES = [
  AvailablePeriod.WeekdayDay,
  AvailablePeriod.WeekdayNight,
  AvailablePeriod.Weekend,
] as const;
export const isAvailablePeriod = createValueGuard(AVAILABLE_PERIOD_VALUES);
