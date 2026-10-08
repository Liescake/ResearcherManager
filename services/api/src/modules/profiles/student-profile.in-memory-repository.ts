import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type {
  ProfileRepository,
  ProfileRepositoryCapabilities,
  StudentProfile,
} from './student-profile.port';

/** 深拷贝一条画像：存储不得把内部可变引用交给调用方，也不得持有调用方的引用 */
function cloneProfile(profile: StudentProfile): StudentProfile {
  return {
    ...profile,
    skills: [...profile.skills],
    availableTime: {
      weeklyHours: profile.availableTime.weeklyHours,
      periods: [...profile.availableTime.periods],
      ...(profile.availableTime.note ? { note: profile.availableTime.note } : {}),
    },
    researchInterests: [...profile.researchInterests],
    intendedFields: [...profile.intendedFields],
    privacyConsent: {
      policyVersion: profile.privacyConsent.policyVersion,
      consentedAt: profile.privacyConsent.consentedAt,
    },
  };
}

/**
 * 画像仓储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久」：
 * - 只持有本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下直接拒绝构造，迫使生产把 `PROFILE_REPOSITORY` 换绑到数据库实现
 *   （见 `student-profile.port.ts` 的替换说明），而不是让「重启即丢数据」的内存结构
 *   悄悄承担生产存储职责；
 * - 不做授权判定、不生成归属信息：`userId` 由 service 从服务端主体写入。
 */
@Injectable()
export class InMemoryProfileRepository implements ProfileRepository {
  readonly capabilities: ProfileRepositoryCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly profiles = new Map<string, StudentProfile>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存画像仓储（InMemoryProfileRepository）：请把 PROFILE_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  findByUserId(userId: string): StudentProfile | undefined {
    const profile = this.profiles.get(userId);
    return profile ? cloneProfile(profile) : undefined;
  }

  save(profile: StudentProfile): StudentProfile {
    this.profiles.set(profile.userId, cloneProfile(profile));
    return cloneProfile(profile);
  }

  /** 仅供开发/测试装配：显式写入一条画像，不接受任何隐式全局状态（等价 `save`） */
  seed(profile: StudentProfile): StudentProfile {
    return this.save(profile);
  }
}
