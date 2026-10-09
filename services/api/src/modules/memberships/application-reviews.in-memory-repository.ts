import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import {
  ApplicationReviewConflictError,
  ApplicationReviewRejectedError,
  assertNonEmptyReviewScope,
  isWithinReviewScope,
  reviewStatusPredecessors,
} from './application-reviews.port';
import type {
  ApplicationReviewRepository,
  ApplicationReviewRepositoryCapabilities,
  ApplicationReviewScope,
} from './application-reviews.port';
import type { Application } from './applications.port';

/**
 * 审核端仓储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 与申请人端的内存基线（`applications.in-memory-repository.ts`）刻意**各自独立**：
 * 它们是两个端口、两份状态。内存模式下「申请人写入的记录不会自动出现在审核端」是一个
 * **已知且有意的**开发期限制 —— 让两份状态悄悄共享，就等于在内存里伪造了一条
 * 「申请人端口与审核端口读写同一份数据」的性质，而这条性质在真实部署里由**同一张
 * `join_applications` 表**（迁移 0003）承担。生产/集成路径由 PostgreSQL 实现共享该表，
 * 内存基线只服务于「不配置数据库时的可控替身」。
 *
 * 非持久化性质是显式的：
 * - 只持有本实例的 `Map`，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下**拒绝构造**，迫使生产把 `APPLICATION_REVIEW_REPOSITORY`
 *   换绑到数据库实现，而不是让内存结构悄悄承担生产存储职责。
 *
 * 语义与 PostgreSQL 实现**逐条一致**（同名 spec 有边界断言）：
 * 1. 三个方法都先把范围下推为谓词（`isWithinReviewScope`），范围外记录既不出库也不可写；
 * 2. **空范围 fail-closed**：`groups` 且 `groupIds` 为空 ⇒ 返回空集，绝不解释成「不限制」；
 * 3. 写入是**范围内的条件写入**：记录不存在、不在范围内、当前状态不是目标状态的合法前驱、
 *    或归属/目标小组被改写 —— 四条路径都不产生任何写入并显式抛错。
 */
@Injectable()
export class InMemoryApplicationReviewRepository implements ApplicationReviewRepository {
  readonly capabilities: ApplicationReviewRepositoryCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly applications = new Map<string, Application>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存审核仓储（InMemoryApplicationReviewRepository）：请把 APPLICATION_REVIEW_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  /**
   * **仅基线/测试可用**的种子写入：审核端端口本身**没有**创建申请的能力
   * （创建属于申请人切片，见 `applications.port.ts` 的 `create`），因此内存替身需要一个
   * 显式的装填入口，否则服务与控制器测试只能去骗过一个假仓储。
   *
   * 它不是端口的一部分、生产环境不可达（构造期已拒绝），也不做任何授权判定 ——
   * 调用方（测试）自己负责给定合法的存储记录形状。
   */
  seed(application: Application): void {
    this.applications.set(application.id, { ...application });
  }

  /** 按范围取数：范围谓词在内存里与 SQL 里表达同一条规则 */
  async listForReview(scope: ApplicationReviewScope): Promise<readonly Application[]> {
    assertNonEmptyReviewScope(scope);
    return [...this.applications.values()]
      .filter((record) => isWithinReviewScope(record, scope))
      .map((record) => ({ ...record }));
  }

  /** 范围内单条读取：范围外与「不存在」返回同一种结果（`undefined`） */
  async findForReview(
    applicationId: string,
    scope: ApplicationReviewScope,
  ): Promise<Application | undefined> {
    assertNonEmptyReviewScope(scope);
    const record = this.applications.get(applicationId);
    if (!record || !isWithinReviewScope(record, scope)) {
      return undefined;
    }
    return { ...record };
  }

  /**
   * 范围内的条件写入（与 PostgreSQL 实现的下推谓词同语义）。
   *
   * 四条拒绝路径都**先判后写**，因此不会留下部分修改；错误消息只含申请 ID 与原因，
   * 不含申请人归属、备注或审核意见原文。
   */
  async saveReviewed(
    application: Application,
    scope: ApplicationReviewScope,
  ): Promise<Application> {
    assertNonEmptyReviewScope(scope);

    const current = this.applications.get(application.id);
    if (!current) {
      // 只允许更新既有记录：插入必须走申请人切片的创建路径，避免绕过状态机入口
      throw new ApplicationReviewRejectedError(
        'NOT_FOUND',
        `入组申请不存在，拒绝审核写入: ${application.id}`,
      );
    }
    if (!isWithinReviewScope(current, scope)) {
      // 范围隔离的第二道闸：即便调用方拿到了范围外记录的 ID，也写不中数据
      throw new ApplicationReviewRejectedError(
        'OUT_OF_SCOPE',
        `入组申请不在审核范围内，拒绝审核写入: ${application.id}`,
      );
    }
    if (!reviewStatusPredecessors(application.status).includes(current.status)) {
      // 并发重复审核：客户端可见冲突（service 映射为 409 STATE_TRANSITION_INVALID）
      throw new ApplicationReviewConflictError(
        `非法审核状态转移，拒绝写入: ${current.status} -> ${application.status}`,
      );
    }
    if (current.userId !== application.userId || current.groupId !== application.groupId) {
      // 归属与目标小组不可变：改写它们等于把申请搬到别人名下或别的小组
      throw new ApplicationReviewRejectedError(
        'IDENTITY_MISMATCH',
        `审核写入不得改写申请归属或目标小组: ${application.id}`,
      );
    }

    this.applications.set(application.id, { ...application });
    return { ...application };
  }
}
