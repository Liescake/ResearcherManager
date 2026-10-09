import type { AvailablePeriod, Grade, GroupStatus, ProgrammingLevel } from '@rm/shared';

/**
 * AI 输入/输出契约。
 * 输入只允许「最小必要 + 已脱敏」的结构化特征：不得包含姓名、学号、手机号、微信标识。
 */

export interface StudentFeatureSnapshot {
  grade: Grade;
  major: string;
  skills: string[];
  programmingLevel: ProgrammingLevel;
  researchInterests: string[];
  intendedFields: string[];
  weeklyHours: number;
  availablePeriods: AvailablePeriod[];
  /** 已脱敏、长度受限的经历摘要 */
  experienceSummary?: string;
  /** 已脱敏、长度受限的优势摘要 */
  strengthsSummary?: string;
}

export interface GroupCandidate {
  groupId: string;
  name: string;
  researchDirections: string[];
  requiredSkills: string[];
  grades?: Grade[];
  minWeeklyHours?: number;
  headcount?: number;
  memberCount?: number;
  status: GroupStatus;
}

export interface MatchFeatureBundle {
  student: StudentFeatureSnapshot;
  /** 候选集合：由规则/标签召回产生，严禁把全部数据送进模型 */
  candidates: GroupCandidate[];
}

export interface MatchingRecommendation {
  groupId: string;
  /** 0—100，越界即为非法输出 */
  score: number;
  /** 必须能对应学生与小组的真实字段 */
  reason: string;
  /** 面向用户的可执行建议，必须非空 */
  advice: string;
}

/** 模型输出的结构化结果（1—3 条，由 schema 强制） */
export interface MatchingModelOutput {
  recommendations: MatchingRecommendation[];
}

/** 适配层最终结果：允许 0 条（无候选时），并记录是否走了降级 */
export interface MatchingResult {
  recommendations: MatchingRecommendation[];
  modelVersion: string;
  promptVersion: string;
  /** true = 未使用模型输出，结果来自规则降级 */
  fallbackUsed: boolean;
  /** 输入快照摘要，用于审计追溯，不含原文 */
  inputSnapshotHash: string;
}

export type MatchOutcomeStatus = 'ai' | 'fallback' | 'disabled' | 'no_candidate';

export interface MatchOutcome {
  status: MatchOutcomeStatus;
  result: MatchingResult;
  /** 是否处于降级路径 */
  degraded: boolean;
  /** 降级原因码；成功调用时为 undefined */
  errorCode?: string;
  /** 面向用户的安全提示 */
  message?: string;
  attempts: number;
  durationMs: number;
}
