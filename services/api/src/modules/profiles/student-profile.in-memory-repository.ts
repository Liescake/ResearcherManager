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
 * - 不做授权判定、不生成归属信息：`userId` 由 service 从服务端主体写入；
 * - 读写按端口的**异步契约**返回 Promise（与 PostgreSQL adapter 逐字段同语义），
 *   因此「无数据库」与「有数据库」两条路径可以被同一组 service/controller 用例覆盖。
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

  async findByUserId(userId: string): Promise<StudentProfile | undefined> {
    const profile = this.profiles.get(userId);
    return profile ? cloneProfile(profile) : undefined;
  }

  async save(profile: StudentProfile): Promise<StudentProfile> {
    this.profiles.set(profile.userId, cloneProfile(profile));
    return cloneProfile(profile);
  }

  /**
   * 仅供开发/测试装配：显式写入一条画像（同步，等价 `save` 的写入部分）。
   * 测试夹具需要「先落一条记录再发请求」，与端口契约无关，因此保持同步以免夹具代码变成异步。
   */
  seed(profile: StudentProfile): void {
    this.profiles.set(profile.userId, cloneProfile(profile));
  }
}
