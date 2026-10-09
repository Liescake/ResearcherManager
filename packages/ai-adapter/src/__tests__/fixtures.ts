import { AvailablePeriod, Grade, GroupStatus, ProgrammingLevel } from '@rm/shared';
import type { GroupCandidate, MatchFeatureBundle, StudentFeatureSnapshot } from '../matching/types';

/** 测试夹具：已脱敏的学生特征与候选小组，不包含任何敏感字段 */
export const studentSnapshot: StudentFeatureSnapshot = {
  grade: Grade.Junior,
  major: '软件工程',
  skills: ['TypeScript', 'PostgreSQL', '数据分析'],
  programmingLevel: ProgrammingLevel.Intermediate,
  researchInterests: ['机器学习', '数据可视化'],
  intendedFields: ['人工智能'],
  weeklyHours: 12,
  availablePeriods: [AvailablePeriod.Weekend],
  experienceSummary: '参与校级创新项目，负责数据处理',
  strengthsSummary: '文档与协作能力',
};

export const groupCandidates: GroupCandidate[] = [
  {
    groupId: '11111111-1111-4111-8111-111111111111',
    name: '机器学习小组',
    researchDirections: ['机器学习', '计算机视觉'],
    requiredSkills: ['TypeScript', 'PyTorch'],
    grades: [Grade.Junior, Grade.Senior],
    minWeeklyHours: 8,
    headcount: 6,
    memberCount: 3,
    status: GroupStatus.Open,
  },
  {
    groupId: '22222222-2222-4222-8222-222222222222',
    name: '数据可视化小组',
    researchDirections: ['数据可视化', '人机交互'],
    requiredSkills: ['TypeScript'],
    minWeeklyHours: 6,
    headcount: 4,
    memberCount: 4,
    status: GroupStatus.Open,
  },
  {
    groupId: '33333333-3333-4333-8333-333333333333',
    name: '生物信息小组',
    researchDirections: ['生物信息'],
    requiredSkills: ['R'],
    grades: [Grade.Graduate],
    minWeeklyHours: 20,
    headcount: 5,
    memberCount: 1,
    status: GroupStatus.Open,
  },
  {
    groupId: '44444444-4444-4444-8444-444444444444',
    name: '已关闭小组',
    researchDirections: ['机器学习'],
    requiredSkills: ['TypeScript'],
    status: GroupStatus.Closed,
  },
];

export const ML_GROUP_ID = '11111111-1111-4111-8111-111111111111';

export function validBundle(): MatchFeatureBundle {
  return { student: studentSnapshot, candidates: groupCandidates };
}

export function groundedRecommendation(
  groupId: string,
  reason = '你的机器学习兴趣与该组方向一致',
  score = 82,
) {
  return { groupId, score, reason, advice: '建议补充相关技能并联系小组负责人' };
}
