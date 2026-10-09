import { Inject, Injectable } from '@nestjs/common';
import type { MatchingRecommendationItem } from '@rm/shared';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import type {
  MatchingAccessScope,
  MatchingRepository,
  MatchingRepositoryCapabilities,
  MatchingRequest,
} from './matching.port';

/**
 * 匹配请求仓储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久」：
 * - 只持有本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下直接拒绝构造，迫使生产把 `MATCHING_REPOSITORY`
 *   换绑到数据库实现（见 `matching.port.ts` 的替换说明），
 *   而不是让「重启即丢数据」的内存结构悄悄承担生产存储职责；
 * - 不做授权判定、不生成归属与状态：`userId`/`status`/摘要/时间戳只由 service 写入。
 *
 * ## 与运行时端口同形状（异步 + 授权边界）
 * 四个方法都接收 `MatchingAccessScope` 并返回 Promise，语义与 PostgreSQL adapter
 * （`matching.postgres-repository.ts`）逐条对齐（两者都可被 `MatchingService` 使用，换绑不改变
 * service / controller）：
 *
 * | 不变量 | 本实现 |
 * |---|---|
 * | 归属只来自服务端 | 写入 / 覆盖写入都要求 `scope.ownerUserId === request.userId`，否则 `OWNER_VIOLATION` |
 * | 同 ID 冲突不得静默覆盖 | `create` 命中既有 ID 抛 `CONFLICT`（消息保留「匹配请求 ID 冲突」口径） |
 * | 未知 ID / 他人记录不得退化成插入 | `save` 未命中或归属不一致抛 `UPDATE_MISSING`（不区分原因） |
 * | 小组授权边界 | 记录里的推荐结果出现 `scope.authorizedGroupIds` 之外的小组即 `GROUP_SCOPE_VIOLATION` fail-closed（读 / 写都判，**不静默过滤**） |
 * | 返回副本 | 每次返回都构造新对象与数组，不把内部可变引用交给调用方 |
 *
 * ## 刻意与数据库实现不同的一点：**不做存储 ID 域（UUID）判定**
 * `u-student-1` 这类「安全 ID」是当前会话基线的正常形状，也是开发/测试路径的主体形状；
 * 把它拒掉会让未配置数据库的运行路径完全不可用。UUID 域是**存储层**的不变量（`ai_match_records`
 * 的 `id` / `user_id` 是 `uuid`），因此由 PostgreSQL adapter 在进入 SQL 之前 fail-closed 判定，
 * 内存基线只校验「边界形状自洽」而不引入 UUID 依赖。
 */
@Injectable()
export class InMemoryMatchingRepository implements MatchingRepository {
  readonly capabilities: MatchingRepositoryCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly requests = new Map<string, MatchingRequest>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存匹配仓储（InMemoryMatchingRepository）：请把 MATCHING_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  async create(request: MatchingRequest, scope: MatchingAccessScope): Promise<MatchingRequest> {
    const access = normalizeScope(scope);
    assertOwner(access, request.userId);
    assertRecommendationsWithinScope(request.recommendations, access);
    if (this.requests.has(request.id)) {
      // 主键冲突属于服务端缺陷（ID 由服务端生成），不得静默覆盖
      throw new InMemoryMatchingRepositoryError('CONFLICT', `匹配请求 ID 冲突: ${request.id}`, [
        'id',
      ]);
    }
    this.requests.set(request.id, clone(request));
    return clone(request);
  }

  async save(request: MatchingRequest, scope: MatchingAccessScope): Promise<MatchingRequest> {
    const access = normalizeScope(scope);
    assertOwner(access, request.userId);
    assertRecommendationsWithinScope(request.recommendations, access);
    const existing = this.requests.get(request.id);
    if (!existing) {
      // 覆盖写入未知 id 说明调用链已错（状态机推进只针对已创建的请求），不得退化成插入
      throw new InMemoryMatchingRepositoryError(
        'UPDATE_MISSING',
        `匹配请求不存在，无法更新: ${request.id}`,
        ['id'],
      );
    }
    if (existing.userId !== request.userId) {
      // 归属不得在更新中被改写：归属只来自服务端会话主体的首次写入
      throw new InMemoryMatchingRepositoryError(
        'OWNER_VIOLATION',
        `匹配请求归属不一致，拒绝更新: ${request.id}`,
        ['user_id'],
      );
    }
    this.requests.set(request.id, clone(request));
    return clone(request);
  }

  async findById(
    requestId: string,
    scope: MatchingAccessScope,
  ): Promise<MatchingRequest | undefined> {
    const access = normalizeScope(scope);
    const record = this.requests.get(requestId);
    // 未命中（不存在 / 存在但属于他人）统一返回 undefined：调用方据此判 404，且不区分两种情形
    if (!record || record.userId !== access.ownerUserId) {
      return undefined;
    }
    assertRecommendationsWithinScope(record.recommendations, access);
    return clone(record);
  }

  async listByUserId(scope: MatchingAccessScope): Promise<readonly MatchingRequest[]> {
    const access = normalizeScope(scope);
    const records = [...this.requests.values()].filter(
      (record) => record.userId === access.ownerUserId,
    );
    // 逐条复核小组授权边界：越权小组出现即说明存储被污染，绝不静默过滤后照常返回
    for (const record of records) {
      assertRecommendationsWithinScope(record.recommendations, access);
    }
    return records.map(clone);
  }
}

/** 内存基线仓储的 fail-closed 错误码（与 PostgreSQL adapter 的错误码口径同名） */
export type InMemoryMatchingRepositoryErrorCode =
  'INVALID_SCOPE' | 'OWNER_VIOLATION' | 'GROUP_SCOPE_VIOLATION' | 'CONFLICT' | 'UPDATE_MISSING';

/** fail-closed 错误：`issues` 只含字段路径 / 违规类型，不含任何取值 */
export class InMemoryMatchingRepositoryError extends Error {
  readonly code: InMemoryMatchingRepositoryErrorCode;
  readonly issues: readonly string[];

  constructor(code: InMemoryMatchingRepositoryErrorCode, message: string, issues: string[] = []) {
    super(message);
    this.name = 'InMemoryMatchingRepositoryError';
    this.code = code;
    this.issues = [...issues];
  }
}

/**
 * 授权边界形状自洽（**不做 UUID 判定**，见类注释）：对象、只允许两个键、
 * 主体是非空字符串、小组集合是字符串数组（去重按集合语义）。
 */
function normalizeScope(scope: unknown): MatchingAccessScope {
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    throw new InMemoryMatchingRepositoryError(
      'INVALID_SCOPE',
      '授权边界必须是对象（服务端 subject + 已授权小组集合）',
      ['scope'],
    );
  }
  const declared = new Set(['ownerUserId', 'authorizedGroupIds']);
  const unexpected = Object.keys(scope as Record<string, unknown>).filter(
    (key) => !declared.has(key),
  );
  if (unexpected.length > 0) {
    throw new InMemoryMatchingRepositoryError(
      'INVALID_SCOPE',
      '授权边界包含闭集之外的字段（客户端可控字段一律不得进入边界）',
      unexpected.map((key) => `${key}(unexpected)`),
    );
  }
  const candidate = scope as { ownerUserId?: unknown; authorizedGroupIds?: unknown };
  if (typeof candidate.ownerUserId !== 'string' || candidate.ownerUserId.trim() === '') {
    throw new InMemoryMatchingRepositoryError(
      'INVALID_SCOPE',
      '授权边界缺少服务端主体（ownerUserId 必须是非空字符串）',
      ['ownerUserId'],
    );
  }
  if (!Array.isArray(candidate.authorizedGroupIds)) {
    throw new InMemoryMatchingRepositoryError(
      'INVALID_SCOPE',
      '授权边界的小组集合必须是数组（服务端资源级判定产物）',
      ['authorizedGroupIds'],
    );
  }
  const authorizedGroupIds: string[] = [];
  for (const [index, value] of candidate.authorizedGroupIds.entries()) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InMemoryMatchingRepositoryError(
        'INVALID_SCOPE',
        '已授权小组 ID 必须全部是非空字符串',
        [`authorizedGroupIds.${index}`],
      );
    }
    authorizedGroupIds.push(value);
  }
  return {
    ownerUserId: candidate.ownerUserId,
    authorizedGroupIds: [...new Set(authorizedGroupIds)],
  };
}

/** 归属只来自服务端：写入记录的主体必须等于本次访问的服务端主体 */
function assertOwner(access: MatchingAccessScope, ownerUserId: string): void {
  if (access.ownerUserId !== ownerUserId) {
    throw new InMemoryMatchingRepositoryError(
      'OWNER_VIOLATION',
      '记录的归属与本次访问的服务端主体不一致（他人记录既不出库也不得回流）',
      ['user_id'],
    );
  }
}

/** 推荐结果闭集（小组授权边界）：越权小组 fail-closed，**不静默过滤** */
function assertRecommendationsWithinScope(
  recommendations: readonly MatchingRecommendationItem[],
  access: MatchingAccessScope,
): void {
  const authorized = new Set(access.authorizedGroupIds);
  const violations = recommendations.flatMap((item, index) =>
    authorized.has(item.groupId) ? [] : [`recommendations.${index}.groupId`],
  );
  if (violations.length > 0) {
    throw new InMemoryMatchingRepositoryError(
      'GROUP_SCOPE_VIOLATION',
      '推荐结果包含授权范围之外的小组（他人小组既不得落库也不得出库）；错误信息不回显小组标识',
      violations,
    );
  }
}

/**
 * 返回副本：仓储不得把内部可变引用（含嵌套的推荐条目对象）交给调用方。
 *
 * 刻意**逐条展开**而不是复用同一批条目对象：只复制数组会让 `record.recommendations[0].score`
 * 仍然指向存储内部对象，外部一次赋值就能改写「已落库」的结果。
 */
function clone(record: MatchingRequest): MatchingRequest {
  return { ...record, recommendations: record.recommendations.map((item) => ({ ...item })) };
}
