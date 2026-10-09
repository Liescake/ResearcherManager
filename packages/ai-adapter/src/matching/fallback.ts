import { GroupStatus } from '@rm/shared';
import type {
  GroupCandidate,
  MatchFeatureBundle,
  MatchingRecommendation,
  StudentFeatureSnapshot,
} from './types';

/**
 * 规则降级：模型不可用、超时或输出非法时使用。
 * 要求：纯函数、确定性（同输入同输出）、理由必须由真实字段拼出（可解释）。
 */

export interface FallbackOptions {
  maxRecommendations?: number;
  /** 是否允许把非开放小组纳入推荐，默认 false */
  includeNonOpenGroups?: boolean;
  /** 低于该分数不推荐，默认 1 */
  minScore?: number;
}

export interface CandidateScoreBreakdown {
  score: number;
  matchedDirections: string[];
  matchedSkills: string[];
  missingSkills: string[];
  hoursShortfall: number;
  gradeMatched: boolean;
  capacityOk: boolean | undefined;
}

export const FALLBACK_WEIGHTS = {
  direction: 45,
  skill: 25,
  grade: 10,
  time: 10,
  capacity: 10,
} as const;

const DEFAULT_MAX_RECOMMENDATIONS = 3;
const REASON_MAX_LENGTH = 500;
const SUGGESTION_MAX_LENGTH = 500;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function intersect(studentValues: readonly string[], candidateValues: readonly string[]): string[] {
  const candidateByKey = new Map(candidateValues.map((value) => [normalize(value), value]));
  const result: string[] = [];
  for (const value of studentValues) {
    const hit = candidateByKey.get(normalize(value));
    if (hit !== undefined && !result.includes(hit)) {
      result.push(hit);
    }
  }
  return result;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 方向命中比例：命中 3 个方向即视为充分匹配 */
function directionRatio(matched: number, directions: number): number {
  if (directions === 0) {
    return 0.4;
  }
  return Math.min(1, matched / Math.min(3, directions));
}

export function scoreCandidate(
  student: StudentFeatureSnapshot,
  candidate: GroupCandidate,
): CandidateScoreBreakdown {
  const matchedDirections = intersect(
    [...student.researchInterests, ...student.intendedFields],
    candidate.researchDirections,
  );
  const matchedSkills = intersect(student.skills, candidate.requiredSkills);
  const missingSkills = candidate.requiredSkills.filter(
    (skill) => !matchedSkills.some((matched) => normalize(matched) === normalize(skill)),
  );

  const gradeMatched =
    candidate.grades === undefined ||
    candidate.grades.length === 0 ||
    candidate.grades.includes(student.grade);

  const requiredHours = candidate.minWeeklyHours ?? 0;
  const hoursShortfall = Math.max(0, requiredHours - student.weeklyHours);
  const timeRatio = requiredHours === 0 ? 1 : Math.min(1, student.weeklyHours / requiredHours);

  const capacityOk =
    candidate.headcount === undefined
      ? undefined
      : candidate.memberCount === undefined
        ? undefined
        : candidate.memberCount < candidate.headcount;

  const directionScore =
    FALLBACK_WEIGHTS.direction *
    directionRatio(matchedDirections.length, candidate.researchDirections.length);
  const skillScore =
    candidate.requiredSkills.length === 0
      ? FALLBACK_WEIGHTS.skill * 0.6
      : FALLBACK_WEIGHTS.skill * (matchedSkills.length / candidate.requiredSkills.length);
  const gradeScore = gradeMatched ? FALLBACK_WEIGHTS.grade : 0;
  const timeScore = FALLBACK_WEIGHTS.time * timeRatio;
  const capacityScore =
    capacityOk === undefined
      ? FALLBACK_WEIGHTS.capacity * 0.5
      : capacityOk
        ? FALLBACK_WEIGHTS.capacity
        : 0;

  const total = directionScore + skillScore + gradeScore + timeScore + capacityScore;

  return {
    score: Math.max(0, Math.min(100, Math.round(total))),
    matchedDirections,
    matchedSkills,
    missingSkills,
    hoursShortfall,
    gradeMatched,
    capacityOk,
  };
}

function buildReason(
  student: StudentFeatureSnapshot,
  candidate: GroupCandidate,
  breakdown: CandidateScoreBreakdown,
): string {
  // 理由必须同时引用学生侧字段与小组侧字段，才能通过可解释性校验
  const studentAnchor = student.intendedFields[0] ?? student.researchInterests[0] ?? student.major;
  const parts: string[] = [`规则推荐「${candidate.name}」`, `对应你的意向方向${studentAnchor}`];

  if (breakdown.matchedDirections.length > 0) {
    parts.push(`与该组方向${breakdown.matchedDirections.join('、')}一致`);
  }
  if (breakdown.matchedSkills.length > 0) {
    parts.push(`已具备要求技能${breakdown.matchedSkills.join('、')}`);
  }
  if (breakdown.matchedDirections.length === 0 && breakdown.matchedSkills.length === 0) {
    parts.push(
      candidate.researchDirections.length > 0
        ? `方向标签重合有限，该组方向为${candidate.researchDirections.join('、')}`
        : '方向标签重合有限，建议先与负责人沟通',
    );
  }
  if (!breakdown.gradeMatched) {
    parts.push('年级要求需要进一步确认');
  }

  return truncate(parts.join('；'), REASON_MAX_LENGTH);
}

function buildSuggestion(breakdown: CandidateScoreBreakdown): string {
  const parts: string[] = [];
  if (breakdown.missingSkills.length > 0) {
    parts.push(`建议补充${breakdown.missingSkills.join('、')}`);
  }
  if (breakdown.hoursShortfall > 0) {
    parts.push(`每周可投入时间比要求少 ${breakdown.hoursShortfall} 小时`);
  }
  if (breakdown.capacityOk === false) {
    parts.push('该组当前名额可能已满');
  }
  if (!breakdown.gradeMatched) {
    parts.push('该组对年级有要求，建议先与负责人确认');
  }
  return parts.length === 0
    ? '建议结合自身兴趣与时间安排，进一步联系小组负责人了解详情'
    : truncate(parts.join('；'), SUGGESTION_MAX_LENGTH);
}

interface ScoredCandidate {
  candidate: GroupCandidate;
  breakdown: CandidateScoreBreakdown;
}

/**
 * 生成规则推荐：只返回开放小组，按分数降序、groupId 升序稳定排序。
 * 结果可能为空数组，调用方据此返回 AI_NO_CANDIDATE。
 */
export function buildFallbackRecommendations(
  bundle: MatchFeatureBundle,
  options: FallbackOptions = {},
): MatchingRecommendation[] {
  const {
    maxRecommendations = DEFAULT_MAX_RECOMMENDATIONS,
    includeNonOpenGroups = false,
    minScore = 1,
  } = options;

  const scored: ScoredCandidate[] = [];
  for (const candidate of bundle.candidates) {
    if (!includeNonOpenGroups && candidate.status !== GroupStatus.Open) {
      continue;
    }
    const breakdown = scoreCandidate(bundle.student, candidate);
    if (breakdown.score < minScore) {
      continue;
    }
    scored.push({ candidate, breakdown });
  }

  scored.sort((left, right) => {
    if (right.breakdown.score !== left.breakdown.score) {
      return right.breakdown.score - left.breakdown.score;
    }
    return left.candidate.groupId < right.candidate.groupId
      ? -1
      : left.candidate.groupId > right.candidate.groupId
        ? 1
        : 0;
  });

  return scored.slice(0, Math.max(1, maxRecommendations)).map(({ candidate, breakdown }) => {
    const advice = buildSuggestion(breakdown);
    return {
      groupId: candidate.groupId,
      score: breakdown.score,
      reason: buildReason(bundle.student, candidate, breakdown),
      advice,
    };
  });
}
