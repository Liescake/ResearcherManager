import { describe, expect, it } from 'vitest';
import { GroupStatus } from '@rm/shared';
import { buildFallbackRecommendations, scoreCandidate } from '../matching/fallback';
import { validateMatchingOutput } from '../matching/validate';
import type { MatchFeatureBundle } from '../matching/types';
import { groupCandidates, ML_GROUP_ID, studentSnapshot, validBundle } from './fixtures';

describe('规则降级推荐', () => {
  it('只推荐开放小组，按分数降序且不超过 3 条', () => {
    const recommendations = buildFallbackRecommendations(validBundle());
    expect(recommendations).toHaveLength(3);
    expect(recommendations.map((item) => item.groupId)).not.toContain(
      '44444444-4444-4444-8444-444444444444',
    );
    const scores = recommendations.map((item) => item.score);
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
  });

  it('确定性：同一输入两次调用结果完全一致', () => {
    expect(buildFallbackRecommendations(validBundle())).toEqual(
      buildFallbackRecommendations(validBundle()),
    );
  });

  it('理由同时引用学生侧与小组侧字段，可通过严格可解释性校验', () => {
    const recommendations = buildFallbackRecommendations(validBundle());
    const result = validateMatchingOutput({ recommendations }, validBundle(), {
      groundingMode: 'both',
    });
    expect(result.ok).toBe(true);
  });

  it('可按配置纳入非开放小组或限制条数', () => {
    const withClosed = buildFallbackRecommendations(validBundle(), { includeNonOpenGroups: true });
    expect(withClosed.map((item) => item.groupId)).toContain(
      '44444444-4444-4444-8444-444444444444',
    );
    expect(buildFallbackRecommendations(validBundle(), { maxRecommendations: 1 })).toHaveLength(1);
  });

  it('没有开放候选时返回空数组，由调用方标记为无候选', () => {
    const bundle: MatchFeatureBundle = {
      student: studentSnapshot,
      candidates: groupCandidates.filter((candidate) => candidate.status !== GroupStatus.Open),
    };
    expect(buildFallbackRecommendations(bundle)).toEqual([]);
  });

  it('给出可执行的补齐建议', () => {
    const mlRecommendation = buildFallbackRecommendations(validBundle()).find(
      (item) => item.groupId === ML_GROUP_ID,
    );
    expect(mlRecommendation?.reason).toContain('规则推荐');
    // 机器学习小组要求 PyTorch 与每周 8 小时：学生缺少 PyTorch，但时长满足
    expect(mlRecommendation?.advice).toContain('PyTorch');
  });

  it('分数拆解对名额、年级与时间缺口做出可解释判断', () => {
    const mlGroup = groupCandidates[0]!;
    const dataGroup = groupCandidates[1]!;
    const bioGroup = groupCandidates[2]!;

    const ml = scoreCandidate(studentSnapshot, mlGroup);
    expect(ml.matchedDirections).toEqual(['机器学习']);
    expect(ml.missingSkills).toEqual(['PyTorch']);
    expect(ml.gradeMatched).toBe(true);
    expect(ml.capacityOk).toBe(true);

    // memberCount 等于 headcount，视为名额已满
    expect(scoreCandidate(studentSnapshot, dataGroup).capacityOk).toBe(false);
    // 研究生年级要求与 20 小时时间要求都不满足
    const bio = scoreCandidate(studentSnapshot, bioGroup);
    expect(bio.gradeMatched).toBe(false);
    expect(bio.hoursShortfall).toBe(8);
    expect(ml.score).toBeGreaterThan(bio.score);
  });
});
