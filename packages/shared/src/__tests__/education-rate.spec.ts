import { describe, expect, it } from 'vitest';
import { ReviewStatus } from '../enums/status';
import { EducationStatus } from '../enums/taxonomy';
import {
  computeAdmissionRate,
  hasConcludedOutcome,
  isAdmitted,
  toAdmissionRatePercent,
} from '../states/education';

describe('升学率口径', () => {
  it('分子只统计已录取，分母只统计已审核通过且已有结论的记录', () => {
    const result = computeAdmissionRate([
      { status: EducationStatus.Admitted, reviewStatus: ReviewStatus.Approved },
      { status: EducationStatus.NotAdmitted, reviewStatus: ReviewStatus.Approved },
      { status: EducationStatus.Admitted, reviewStatus: ReviewStatus.Approved },
      // 备考中：不进分母
      { status: EducationStatus.Preparing, reviewStatus: ReviewStatus.Approved },
      // 未审核：不进分母
      { status: EducationStatus.Admitted, reviewStatus: ReviewStatus.Pending },
      // 驳回：不进分母
      { status: EducationStatus.Admitted, reviewStatus: ReviewStatus.Rejected },
    ]);

    expect(result.numerator).toBe(2);
    expect(result.denominator).toBe(3);
    expect(result.excludedPreparing).toBe(1);
    expect(result.excludedNotApproved).toBe(2);
    expect(result.rate).toBeCloseTo(2 / 3, 10);
    expect(toAdmissionRatePercent(result)).toBe(66.7);
  });

  it('分母为 0 时返回 null，而不是 0%', () => {
    const result = computeAdmissionRate([
      { status: EducationStatus.Preparing, reviewStatus: ReviewStatus.Approved },
    ]);
    expect(result.denominator).toBe(0);
    expect(result.rate).toBeNull();
    expect(toAdmissionRatePercent(result)).toBeNull();
  });

  it('空数据集不抛错且口径公式随结果返回', () => {
    const result = computeAdmissionRate([]);
    expect(result.numerator).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.formula).toContain('已录取人数');
  });

  it('结论状态判断不复用备考中', () => {
    expect(isAdmitted(EducationStatus.Admitted)).toBe(true);
    expect(isAdmitted(EducationStatus.Preparing)).toBe(false);
    expect(hasConcludedOutcome(EducationStatus.NotAdmitted)).toBe(true);
    expect(hasConcludedOutcome(EducationStatus.Preparing)).toBe(false);
  });
});
