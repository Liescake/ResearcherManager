import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import { assertExportPageWindow, compareExportKeysets } from './exports.port';
import type {
  ExportPage,
  ExportPageWindow,
  ExportRepository,
  ExportRepositoryCapabilities,
  ExportRequest,
} from './exports.port';

/**
 * 导出请求仓储的**内存基线**：开发与测试用，缺失真实持久化实现时的显式替身。
 *
 * 刻意做成「显式、实例级、非持久」：
 * - 只持有本实例的 `Map`，不是模块级/全局单例，不跨进程、不跨重启，进程退出即丢失；
 * - `capabilities` 如实声明 `persistent = false`、`productionReady = false`；
 * - `NODE_ENV=production` 下**直接拒绝构造**，迫使生产把 `EXPORT_REPOSITORY`
 *   换绑到数据库实现（见 `exports.port.ts` 的替换说明），
 *   而不是让「重启即丢数据」的内存结构悄悄承担生产导出事实的持久化职责；
 * - 不做授权判定、不生成归属/状态/时间戳：这些只由 service 从服务端会话、状态机与时钟写入；
 * - **不做读取契约校验**：存储层损坏（未知枚举、字段不在白名单、状态与产物不自洽）必须能被
 *   出口的 fail-closed 门禁看见，因此基线不代替出口做校验，也不静默修正非法记录；
 *   写入只保证「主键唯一」「归属不可改写」「服务端有效期不可改写」这三条存储自身的完整性约束
 *   （第三条与数据库 adapter 的 `expires_at` 不可变列同语义）；
 * - **没有**删除/归档方法：本切片不提供「删除导出请求」的能力；
 * - **没有**不带归属条件的单条读取：单条读取只有 `findByIdForOwner(id, ownerUserId)`，
 *   归属是取数条件本身（不存在 `findById` / `findByOwner` / `query` 这类入口）；
 * - **列表只有两个归属受限入口**：`listByOwnerId`（无窗口）与 `listByOwnerIdPage`（键集窗口）。
 *   后者是 `GET /me/exports` 的唯一取数入口；两者共用同一份排序与归属过滤，语义不漂移。
 */
@Injectable()
export class InMemoryExportRepository implements ExportRepository {
  readonly capabilities: ExportRepositoryCapabilities = {
    backend: 'in-memory-baseline',
    persistent: false,
    productionReady: false,
  };

  private readonly requests = new Map<string, ExportRequest>();

  constructor(@Inject(APP_ENV) env: AppEnv) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '生产环境禁止使用内存导出仓储（InMemoryExportRepository）：请把 EXPORT_REPOSITORY 绑定到持久化实现',
      );
    }
  }

  async create(request: ExportRequest): Promise<ExportRequest> {
    if (this.requests.has(request.id)) {
      // 主键冲突属于服务端缺陷（ID 由服务端生成），不得静默覆盖既有导出请求
      throw new Error(`导出请求 ID 冲突: ${request.id}`);
    }
    this.requests.set(request.id, copyRequest(request));
    return copyRequest(request);
  }

  async save(request: ExportRequest): Promise<ExportRequest> {
    const existing = this.requests.get(request.id);
    if (!existing) {
      // 覆盖写入未知 id 说明调用链已错（状态机推进只针对已创建的请求），不得退化成插入
      throw new Error(`导出请求不存在，无法更新: ${request.id}`);
    }
    if (existing.ownerUserId !== request.ownerUserId) {
      // 归属不得在更新中被改写：归属只来自服务端会话主体的首次写入
      throw new Error(`导出请求归属不一致，拒绝更新: ${request.id}`);
    }
    if (existing.expiresAt !== request.expiresAt) {
      // **有效期不可改写**（与实测的存储层不变式同语义：数据库 adapter 的
      // `POSTGRES_EXPORT_IMMUTABLE_COLUMNS` 含 `expires_at`，写回后逐列复核）。
      // 有效期只是「这条记录什么时候到期」这一服务端事实，写回路径（状态机推进）没有
      // 任何理由改动它；允许改写就等于允许把已过期的交付物「续期」回可下载状态。
      throw new Error(`导出请求有效期不可改写，拒绝更新: ${request.id}`);
    }
    this.requests.set(request.id, copyRequest(request));
    return copyRequest(request);
  }

  /**
   * 只返回该服务端主体名下的记录，按**键集全序**（毫秒粒度的 `createdAt ASC`，同刻按 `id ASC`）
   * 排列。
   *
   * 排序口径与数据库实现的 `ORDER BY date_trunc($n::text, created_at) ASC, id ASC`
   * **逐条一致**：内存基线此前按插入顺序返回，而插入顺序只在「创建时刻严格递增」时才等于键集序；
   * 同一毫秒内创建的两条记录会因此在两条实现之间出现顺序漂移，而分页边界正是建立在这个序上。
   * 让两条实现共用 `compareExportKeysets` 是「同一份序」的唯一事实来源。
   *
   * 过滤行为**不作为安全边界**：service 仍会逐条复核归属（纵深防御）。
   */
  async listByOwnerId(ownerUserId: string): Promise<readonly ExportRequest[]> {
    return this.ownedRecords(ownerUserId).map((record) => copyRequest(record));
  }

  /**
   * 按服务端主体取**一页**记录（键集分页）。
   *
   * 语义与数据库 adapter 的
   * `WHERE requester_id = $1::uuid AND (date_trunc($2::text, created_at), id)
   *  > ($3::timestamptz, $4::uuid) ORDER BY date_trunc($5::text, created_at) ASC, id ASC
   *  LIMIT $6::int` **完全一致**：
   * - 窗口先过 `assertExportPageWindow`（`limit` 越界 / 键集形态非法属服务端缺陷，直接抛错，
   *   绝不「夹到上界继续」）；
   * - 边界是**严格大于**：`after` 那一行不会再出现在下一页；
   * - 排序与边界判定都在**毫秒粒度**（与数据库侧使用同一个截断表达式），因此亚毫秒
   *   `createdAt` 不会让边界行在下一页被再取一次；
   * - 多取一行判定 `hasNext`，多取的行**不进** `records`（与 SQL 的 `LIMIT limit + 1` 同构）；
   * - 返回副本，调用方拿不到内部可变引用。
   *
   * 复杂度：每次取页都是全量扫描 + 排序（`O(n log n)`）。这是内存基线的**如实形态**
   * （它是开发/测试替身，不声称生产可用；`productionReady = false` 已在能力声明里）。
   */
  async listByOwnerIdPage(ownerUserId: string, window: ExportPageWindow): Promise<ExportPage> {
    const { limit, after } = assertExportPageWindow(window);
    const candidates =
      after === undefined
        ? this.ownedRecords(ownerUserId)
        : this.ownedRecords(ownerUserId).filter(
            (record) => compareExportKeysets(record, after) > 0,
          );

    // 多取一行：取到 limit + 1 行即证明后面还有行（与 SQL 的 LIMIT limit + 1 同构）
    const probed = candidates.slice(0, limit + 1);
    const hasNext = probed.length > limit;
    return {
      records: probed.slice(0, limit).map((record) => copyRequest(record)),
      hasNext,
    };
  }

  /**
   * 主体名下的记录，按键集全序排列（**唯一的排序点**，两个列表入口共用）。
   *
   * 比较用 `compareExportKeysets`（按**毫秒粒度**的绝对时刻比较，同刻按规范 UUID 文本序），
   * 而不是按 ISO 字面量：同一瞬时点的合法 ISO 形态不止一种（带 / 不带小数秒、微秒位不同），
   * 逐字节比较会排出与时间先后不同的顺序，也会与 `timestamptz` 的比较结果漂移。
   */
  private ownedRecords(ownerUserId: string): readonly ExportRequest[] {
    return [...this.requests.values()]
      .filter((record) => record.ownerUserId === ownerUserId)
      .sort(compareExportKeysets);
  }

  /**
   * 按「记录 ID + 服务端主体归属」取单条记录（下载切片的取数入口）。
   *
   * **归属是取数条件的一部分**（等价于数据库实现的 `WHERE id = … AND requester_id = …`），
   * 因此这里**没有**「先按 id 取出再比较归属」的中间状态：他人的作业 ID 与不存在的 ID
   * 返回同一个 `undefined`，端口层面就不可能泄露「该 ID 是否存在」。
   */
  async findByIdForOwner(id: string, ownerUserId: string): Promise<ExportRequest | undefined> {
    const record = this.requests.get(id);
    if (record === undefined || record.ownerUserId !== ownerUserId) {
      return undefined;
    }
    return copyRequest(record);
  }
}

/** 返回副本：仓储不得把内部可变引用（含字段数组）交给调用方 */
function copyRequest(request: ExportRequest): ExportRequest {
  return { ...request, fields: [...request.fields] };
}
