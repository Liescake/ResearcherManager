import { describe, expect, it } from 'vitest';
import { checkReasonGrounding, tokenize, validateMatchingOutput } from '../matching/validate';
import { groupCandidates, groundedRecommendation, ML_GROUP_ID, validBundle } from './fixtures';

const bundle = validBundle();
const mlGroup = groupCandidates[0]!;

describe('结构化输出校验', () => {
  it('合法且可解释的输出通过，并按分数降序排序', () => {
    const result = validateMatchingOutput(
      {
        recommendations: [
          groundedRecommendation(ML_GROUP_ID, '你的机器学习兴趣与该组方向一致', 70),
          groundedRecommendation(
            '22222222-2222-4222-8222-222222222222',
            '你的数据可视化兴趣与该组方向一致',
            90,
          ),
        ],
      },
      bundle,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recommendations.map((item) => item.score)).toEqual([90, 70]);
    }
  });

  it('未召回的小组 ID 被拒绝并标记为安全失败', () => {
    const result = validateMatchingOutput(
      { recommendations: [groundedRecommendation('99999999-9999-4999-8999-999999999999')] },
      bundle,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.primaryCode).toBe('GROUP_ID_NOT_IN_CANDIDATES');
      expect(result.hasIllegalGroupId).toBe(true);
    }
  });

  it('分数越界、空理由和空数组都是非法结构', () => {
    expect(
      validateMatchingOutput(
        { recommendations: [groundedRecommendation(ML_GROUP_ID, '你的机器学习兴趣', 120)] },
        bundle,
      ).ok,
    ).toBe(false);
    expect(
      validateMatchingOutput(
        { recommendations: [{ groupId: ML_GROUP_ID, score: 50, reason: ' ' }] },
        bundle,
      ).ok,
    ).toBe(false);
    expect(validateMatchingOutput({ recommendations: [] }, bundle).ok).toBe(false);
    expect(validateMatchingOutput('not-json', bundle).ok).toBe(false);
  });

  it('重复推荐同一小组被拒绝', () => {
    const result = validateMatchingOutput(
      {
        recommendations: [
          groundedRecommendation(ML_GROUP_ID, '你的机器学习兴趣与该组方向一致', 80),
          groundedRecommendation(ML_GROUP_ID, '你的机器学习兴趣与该组方向一致', 60),
        ],
      },
      bundle,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.primaryCode).toBe('DUPLICATE_GROUP_ID');
    }
  });

  it('理由与真实字段完全无重叠时拒绝（默认严格）', () => {
    const result = validateMatchingOutput(
      { recommendations: [groundedRecommendation(ML_GROUP_ID, '这段文字没有任何可对应内容')] },
      bundle,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.primaryCode).toBe('REASON_NOT_GROUNDED');
    }
  });

  it('可通过开关关闭可解释性校验（离线评测对比用）', () => {
    const result = validateMatchingOutput(
      { recommendations: [groundedRecommendation(ML_GROUP_ID, '这段文字没有任何可对应内容')] },
      bundle,
      { requireGroundedReasons: false },
    );
    expect(result.ok).toBe(true);
  });
});

describe('理由可解释性判定', () => {
  it('both 模式要求同时命中学生侧与小组侧字段', () => {
    const both = checkReasonGrounding(
      '你的机器学习兴趣与该组方向一致',
      mlGroup,
      bundle.student,
      'both',
    );
    expect(both.grounded).toBe(true);
    expect(both.hitsCandidateFields).toBe(true);
    expect(both.hitsStudentFields).toBe(true);

    const onlyCandidate = checkReasonGrounding(
      '机器学习小组招募中',
      mlGroup,
      bundle.student,
      'both',
    );
    expect(onlyCandidate.hitsCandidateFields).toBe(true);
    expect(onlyCandidate.hitsStudentFields).toBe(false);
    expect(onlyCandidate.grounded).toBe(false);
  });

  it('分词对中文与英文标签都能产出重叠标记', () => {
    expect(tokenize('机器学习 TypeScript')).toContain('typescript');
    expect(tokenize('机器学习')).toContain('机器');
  });
});
