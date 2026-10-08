import { Inject, Injectable } from '@nestjs/common';
import { isGroupApplicable } from '@rm/shared';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type {
  GroupRepository,
  GroupRepositoryCapabilities,
  GroupVisibilityQuery,
  ResearchGroup,
} from './groups.port';

/**
 * 小组仓储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久」：
 * - 只持有本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下直接拒绝构造，迫使生产把 `GROUP_REPOSITORY`
 *   换绑到数据库实现（见 `groups.port.ts` 的替换说明），
 *   而不是让「重启即丢数据」的内存结构悄悄承担生产存储职责；
 * - 不做授权判定、不生成归属信息：`leaderUserId`/`status` 由 service 从服务端主体与
 *   服务端常量写入；本类只执行「开放状态 + 授权范围」这两个**数据过滤**。
 */
@Injectable()
export class InMemoryGroupRepository implements GroupRepository {
  readonly capabilities: GroupRepositoryCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly groups = new Map<string, ResearchGroup>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存小组仓储（InMemoryGroupRepository）：请把 GROUP_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  create(group: ResearchGroup): ResearchGroup {
    if (this.groups.has(group.id)) {
      // 主键冲突属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new Error(`小组 ID 冲突: ${group.id}`);
    }
    this.groups.set(group.id, cloneGroup(group));
    return cloneGroup(group);
  }

  listVisibleGroups(query: GroupVisibilityQuery): readonly ResearchGroup[] {
    return (
      [...this.groups.values()]
        // 本端点只展示开放小组；暂停/关闭的小组不可见（复用共享 isGroupApplicable）
        .filter((group) => isGroupApplicable(group.status))
        .filter((group) => query.includeAllOpenGroups || query.visibleGroupIds.includes(group.id))
        .map(cloneGroup)
    );
  }
}

/** 返回副本：仓储不得把内部可变引用交给调用方（数组与嵌套对象逐层复制） */
function cloneGroup(group: ResearchGroup): ResearchGroup {
  const requirements = group.recruitmentRequirements;
  return {
    id: group.id,
    name: group.name,
    ...(group.description ? { description: group.description } : {}),
    researchDirections: [...group.researchDirections],
    recruitmentRequirements: {
      ...(requirements.skills ? { skills: [...requirements.skills] } : {}),
      ...(requirements.grades ? { grades: [...requirements.grades] } : {}),
      ...(requirements.minWeeklyHours !== undefined
        ? { minWeeklyHours: requirements.minWeeklyHours }
        : {}),
      ...(requirements.headcount !== undefined ? { headcount: requirements.headcount } : {}),
      ...(requirements.note ? { note: requirements.note } : {}),
    },
    leaderUserId: group.leaderUserId,
    status: group.status,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}
