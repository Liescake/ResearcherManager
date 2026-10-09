import { matchingModelOutputSchema } from './schema';
import type {
  GroupCandidate,
  MatchFeatureBundle,
  MatchingRecommendation,
  StudentFeatureSnapshot,
} from './types';

/**
 * 输出校验：结构校验（schema）→ 候选白名单 → 去重 → 理由可解释性。
 * 验收指标要求「非法小组 ID、越权字段、空理由和超范围分数为 0」，因此任一失败都不得放行。
 */

export type MatchValidationCode =
  'SCHEMA_INVALID' | 'GROUP_ID_NOT_IN_CANDIDATES' | 'DUPLICATE_GROUP_ID' | 'REASON_NOT_GROUNDED';

export interface MatchValidationIssue {
  code: MatchValidationCode;
  path?: string;
  message: string;
}

export interface MatchValidationSuccess {
  ok: true;
  recommendations: MatchingRecommendation[];
}

export interface MatchValidationFailure {
  ok: false;
  issues: MatchValidationIssue[];
  primaryCode: MatchValidationCode;
  /** 是否出现非法（未召回）小组 ID：属于安全类失败，必须单独监控 */
  hasIllegalGroupId: boolean;
}

export type MatchValidationResult = MatchValidationSuccess | MatchValidationFailure;

export type GroundingMode = 'any' | 'both';

export interface MatchValidationOptions {
  /** 是否校验推荐理由能对应真实字段，默认开启 */
  requireGroundedReasons?: boolean;
  /** any = 命中学生或小组任一侧即可；both = 两侧都要命中（用于离线评测） */
  groundingMode?: GroundingMode;
}

const CJK_CHAR = /[\u4e00-\u9fff]/u;
const LATIN_WORD = /[a-z0-9+#.]+/gu;

/**
 * 轻量分词：拉丁词按整词，中文按二元组。
 * 目的只是判断「理由是否与真实字段有重叠」，不是通用分词器。
 */
export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(LATIN_WORD)) {
    const token = match[0];
    if (token.length >= 2) {
      tokens.add(token);
    }
  }
  const cjk = [...normalized].filter((char) => CJK_CHAR.test(char)).join('');
  for (let index = 0; index + 2 <= cjk.length; index += 1) {
    tokens.add(cjk.slice(index, index + 2));
  }
  return [...tokens];
}

export interface ReasonGroundingResult {
  grounded: boolean;
  hitsCandidateFields: boolean;
  hitsStudentFields: boolean;
}

export function checkReasonGrounding(
  reason: string,
  candidate: GroupCandidate,
  student: StudentFeatureSnapshot,
  mode: GroundingMode = 'any',
): ReasonGroundingResult {
  const reasonTokens = new Set(tokenize(reason));
  const candidateTokens = new Set([
    ...tokenize(candidate.name),
    ...candidate.researchDirections.flatMap((value) => tokenize(value)),
    ...candidate.requiredSkills.flatMap((value) => tokenize(value)),
  ]);
  const studentTokens = new Set([
    ...student.skills.flatMap((value) => tokenize(value)),
    ...student.researchInterests.flatMap((value) => tokenize(value)),
    ...student.intendedFields.flatMap((value) => tokenize(value)),
    ...tokenize(student.major),
    ...tokenize(student.experienceSummary ?? ''),
    ...tokenize(student.strengthsSummary ?? ''),
  ]);

  const hitsCandidateFields = [...reasonTokens].some((token) => candidateTokens.has(token));
  // A reason that only describes the group (for example, “机器学习小组招募中”)
  // must not be treated as evidence about the student merely because both sides
  // happen to contain the same research topic.
  const hasStudentEvidenceCue =
    /(?:你|您的|学生|兴趣|技能|专业|经验|擅长|能力|项目|your|student|interest|skill|major|experience)/iu.test(
      reason,
    );
  const hitsStudentFields =
    hasStudentEvidenceCue && [...reasonTokens].some((token) => studentTokens.has(token));

  return {
    grounded:
      mode === 'both'
        ? hitsCandidateFields && hitsStudentFields
        : hitsCandidateFields || hitsStudentFields,
    hitsCandidateFields,
    hitsStudentFields,
  };
}

function compareRecommendations(
  left: MatchingRecommendation,
  right: MatchingRecommendation,
): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  return left.groupId < right.groupId ? -1 : left.groupId > right.groupId ? 1 : 0;
}

export function validateMatchingOutput(
  raw: unknown,
  bundle: MatchFeatureBundle,
  options: MatchValidationOptions = {},
): MatchValidationResult {
  const { requireGroundedReasons = true, groundingMode = 'any' } = options;
  const parsed = matchingModelOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: MatchValidationIssue[] = parsed.error.issues.map((issue) => ({
      code: 'SCHEMA_INVALID',
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return {
      ok: false,
      issues,
      primaryCode: 'SCHEMA_INVALID',
      hasIllegalGroupId: false,
    };
  }

  const candidateById = new Map(
    bundle.candidates.map((candidate) => [candidate.groupId, candidate]),
  );
  const issues: MatchValidationIssue[] = [];
  const seen = new Set<string>();
  let hasIllegalGroupId = false;

  parsed.data.recommendations.forEach((recommendation, index) => {
    const candidate = candidateById.get(recommendation.groupId);
    if (!candidate) {
      hasIllegalGroupId = true;
      issues.push({
        code: 'GROUP_ID_NOT_IN_CANDIDATES',
        path: `recommendations[${index}].groupId`,
        message: '推荐的小组不在候选集合内',
      });
      return;
    }
    if (seen.has(recommendation.groupId)) {
      issues.push({
        code: 'DUPLICATE_GROUP_ID',
        path: `recommendations[${index}].groupId`,
        message: '同一个小组被重复推荐',
      });
      return;
    }
    seen.add(recommendation.groupId);

    if (requireGroundedReasons) {
      const grounding = checkReasonGrounding(
        recommendation.reason,
        candidate,
        bundle.student,
        groundingMode,
      );
      if (!grounding.grounded) {
        issues.push({
          code: 'REASON_NOT_GROUNDED',
          path: `recommendations[${index}].reason`,
          message: '推荐理由未引用学生或小组的真实字段',
        });
      }
    }
  });

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      primaryCode: issues[0]?.code ?? 'SCHEMA_INVALID',
      hasIllegalGroupId,
    };
  }

  return {
    ok: true,
    recommendations: [...parsed.data.recommendations].sort(compareRecommendations),
  };
}
