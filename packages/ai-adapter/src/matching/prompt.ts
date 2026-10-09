import { MATCHING_OUTPUT_SCHEMA_HINT } from './schema';
import type { MatchFeatureBundle } from './types';

/**
 * 提示词版本化：提示词变更必须提升版本号，并写入 ai_match_records.prompt_version。
 */
export const MATCHING_PROMPT_VERSION = 'matching-v1';

export const MATCHING_SYSTEM_PROMPT = [
  '你是科研小组匹配助手，只做结构化排序，不做录用决定。',
  '硬性约束：',
  '1) 只输出 JSON，不要输出解释、Markdown 代码块或多余文本。',
  '2) groupId 必须来自输入的候选列表，禁止编造或改写。',
  '3) score 为 0—100 的整数，reason 必须引用学生与小组的真实字段，不得编造经历。',
  '4) 推荐 1—3 个小组，按 score 从高到低排序。',
  '5) 不得推断或输出任何个人敏感信息（姓名、学号、联系方式、证件号）。',
  '6) 不确定时给出较低 score，而不是编造理由。',
].join('\n');

export interface MatchingPrompt {
  systemPrompt: string;
  userPrompt: string;
  schemaHint: string;
  promptVersion: string;
}

/**
 * 组装提示词：只序列化最小必要的脱敏特征。
 * 调用方必须先通过 assertNoPii，本函数不负责脱敏。
 */
export function buildMatchingPrompt(bundle: MatchFeatureBundle): MatchingPrompt {
  const payload = {
    student_features: {
      grade: bundle.student.grade,
      major: bundle.student.major,
      skills: bundle.student.skills,
      programming_level: bundle.student.programmingLevel,
      research_interests: bundle.student.researchInterests,
      intended_fields: bundle.student.intendedFields,
      weekly_hours: bundle.student.weeklyHours,
      available_periods: bundle.student.availablePeriods,
      experience_summary: bundle.student.experienceSummary ?? '',
      strengths_summary: bundle.student.strengthsSummary ?? '',
    },
    candidate_groups: bundle.candidates.map((candidate) => ({
      group_id: candidate.groupId,
      name: candidate.name,
      research_directions: candidate.researchDirections,
      required_skills: candidate.requiredSkills,
      grades: candidate.grades ?? [],
      min_weekly_hours: candidate.minWeeklyHours ?? null,
      headcount: candidate.headcount ?? null,
      member_count: candidate.memberCount ?? null,
    })),
  };

  return {
    systemPrompt: MATCHING_SYSTEM_PROMPT,
    userPrompt: `请根据学生特征与候选小组，输出结构化匹配结果：\n${JSON.stringify(payload)}`,
    schemaHint: MATCHING_OUTPUT_SCHEMA_HINT,
    promptVersion: MATCHING_PROMPT_VERSION,
  };
}
