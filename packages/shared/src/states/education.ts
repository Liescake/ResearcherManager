import { ReviewStatus } from '../enums/status';
import { EducationStatus } from '../enums/taxonomy';

/**
 * 升学率口径（计划表 P2/P8 强制要求）：
 * - 分子：仅「已录取」。
 * - 分母：已审核通过、且已有结论的记录（已录取 + 未上岸）。
 * - 排除：「备考中」视为尚无结论，不进分母；未审核/驳回的记录不进分母。
 * 汇总口径必须与明细一致，任何展示升学率的接口都必须使用本函数。
 */
export const ADMISSION_RATE_FORMULA =
  '升学率 = 已录取人数 / (已录取人数 + 未上岸人数)，仅统计审核通过且已有结论的记录';

/** 可计入升学统计的结论状态 */
export const CONCLUDED_EDUCATION_STATUSES: readonly EducationStatus[] = [
  EducationStatus.Admitted,
  EducationStatus.NotAdmitted,
];

export interface EducationRecordLike {
  status: EducationStatus;
  /** 必须显式传入审核状态；未提供会导致该记录被排除，而不是被默认计入 */
  reviewStatus: ReviewStatus;
}

export interface AdmissionRateResult {
  /** 已录取人数 */
  numerator: number;
  /** 分母：已录取 + 未上岸（审核通过） */
  denominator: number;
  /** 分母为 0 时返回 null，避免出现无意义的 0% 或除零 */
  rate: number | null;
  /** 被排除的「备考中」记录数 */
  excludedPreparing: number;
  /** 被排除的未审核/驳回记录数 */
  excludedNotApproved: number;
  formula: string;
}

export function isAdmitted(status: EducationStatus): boolean {
  return status === EducationStatus.Admitted;
}

export function hasConcludedOutcome(status: EducationStatus): boolean {
  return CONCLUDED_EDUCATION_STATUSES.includes(status);
}

export function computeAdmissionRate(records: readonly EducationRecordLike[]): AdmissionRateResult {
  let numerator = 0;
  let concluded = 0;
  let excludedPreparing = 0;
  let excludedNotApproved = 0;

  for (const record of records) {
    if (record.reviewStatus !== ReviewStatus.Approved) {
      excludedNotApproved += 1;
      continue;
    }
    if (!hasConcludedOutcome(record.status)) {
      excludedPreparing += 1;
      continue;
    }
    concluded += 1;
    if (isAdmitted(record.status)) {
      numerator += 1;
    }
  }

  return {
    numerator,
    denominator: concluded,
    rate: concluded === 0 ? null : numerator / concluded,
    excludedPreparing,
    excludedNotApproved,
    formula: ADMISSION_RATE_FORMULA,
  };
}

/** 百分比展示值，分母为 0 时返回 null（前端展示为「暂无数据」而非 0%） */
export function toAdmissionRatePercent(result: AdmissionRateResult, digits = 1): number | null {
  if (result.rate === null) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(result.rate * 100 * factor) / factor;
}
