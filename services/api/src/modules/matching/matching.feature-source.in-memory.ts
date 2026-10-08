import { Inject, Injectable } from '@nestjs/common';
import { findPiiKeys, type GroupCandidate, type MatchFeatureBundle } from '@rm/ai-adapter';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type { MatchingFeatureSource, MatchingSourceCapabilities } from './matching.port';

/**
 * 特征最小化与召回的**内存基线**：开发与测试用，缺失真实 profiles / groups 数据源时的显式替身。
 *
 * 刻意做成「显式、实例级、默认空、不联动真实业务数据」：
 * - 不预置任何用户快照：未显式 `seed()` 时任何主体都召回不到候选，
 *   service 因此给出 `no_candidate` 终态，而不是「猜一组小组返回」；
 * - `capabilities` 如实声明 `connectedToDomainData = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下直接拒绝构造：生产必须把 `MATCHING_FEATURE_SOURCE`
 *   换绑到读真实画像/小组的实现（profiles / groups 仓储端口），而不是用测试快照冒充召回；
 * - `seed()` 入口即执行 **PII 门禁**（复用 `@rm/ai-adapter` 的出站防线 `findPiiKeys`）：
 *   快照里出现姓名、学号、手机号、微信标识等字段时直接拒绝写入，
 *   因此「敏感画像字段不进入匹配输入」不依赖调用方自觉，也不会随响应外泄；
 *   拒绝信息只含字段路径，不含字段值。
 */
@Injectable()
export class InMemoryMatchingFeatureSource implements MatchingFeatureSource {
  readonly capabilities: MatchingSourceCapabilities = {
    backend: 'in-memory-baseline',
    connectedToDomainData: false,
    productionReady: false,
  };

  private readonly bundles = new Map<string, MatchFeatureBundle>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存匹配特征源（InMemoryMatchingFeatureSource）：请把 MATCHING_FEATURE_SOURCE 绑定到读真实画像与小组的实现',
      );
    }
  }

  /**
   * 仅供开发/测试装配：显式写入某个主体的**已脱敏**快照。
   * 命中 PII 字段（或值里出现手机号/身份证号）时抛错，且错误信息只含字段路径。
   */
  seed(userId: string, bundle: MatchFeatureBundle): void {
    const findings = findPiiKeys(bundle);
    if (findings.length > 0) {
      throw new Error(
        `匹配特征快照含未脱敏字段，拒绝写入: ${findings
          .map((finding) => `${finding.path}(${finding.reason})`)
          .join(', ')}`,
      );
    }
    this.bundles.set(userId, cloneBundle(bundle));
  }

  loadBundle(userId: string): MatchFeatureBundle | undefined {
    const bundle = this.bundles.get(userId);
    // 返回副本：召回来源不得把内部可变引用（含数组）交给调用方
    return bundle ? cloneBundle(bundle) : undefined;
  }
}

function cloneCandidate(candidate: GroupCandidate): GroupCandidate {
  return {
    groupId: candidate.groupId,
    name: candidate.name,
    researchDirections: [...candidate.researchDirections],
    requiredSkills: [...candidate.requiredSkills],
    ...(candidate.grades ? { grades: [...candidate.grades] } : {}),
    ...(candidate.minWeeklyHours !== undefined ? { minWeeklyHours: candidate.minWeeklyHours } : {}),
    ...(candidate.headcount !== undefined ? { headcount: candidate.headcount } : {}),
    ...(candidate.memberCount !== undefined ? { memberCount: candidate.memberCount } : {}),
    status: candidate.status,
  };
}

function cloneBundle(bundle: MatchFeatureBundle): MatchFeatureBundle {
  const { student } = bundle;
  return {
    student: {
      grade: student.grade,
      major: student.major,
      skills: [...student.skills],
      programmingLevel: student.programmingLevel,
      researchInterests: [...student.researchInterests],
      intendedFields: [...student.intendedFields],
      weeklyHours: student.weeklyHours,
      availablePeriods: [...student.availablePeriods],
      ...(student.experienceSummary ? { experienceSummary: student.experienceSummary } : {}),
      ...(student.strengthsSummary ? { strengthsSummary: student.strengthsSummary } : {}),
    },
    candidates: bundle.candidates.map(cloneCandidate),
  };
}
