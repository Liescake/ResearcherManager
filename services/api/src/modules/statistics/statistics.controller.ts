import { Controller, Get, Headers, Inject, Query } from '@nestjs/common';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import type { SelfStatisticsView } from './statistics.contract';
import { StatisticsService } from './statistics.service';

/**
 * 本人统计（学生自服务）：
 * `GET /api/v1/me/statistics` —— 本人教育记录 / 入组申请 / 成果 / 匹配请求的条数。
 *
 * 响应 `data` 是**四个整数的白名单**（`educationRecords` / `applications` / `achievements` /
 * `matchingRequests`），不含归属、记录内容与任何 PII；无数据时稳定返回四个 0。
 * 小组/全局统计（`statistics:*:read`）与明细下钻属于后续切片。
 *
 * 认证与授权分工（刻意不用全局 Guard，避免「看起来覆盖所有路由」的假象）：
 * 1. 每个方法显式声明它需要会话：`@Headers('authorization')` → `requireSubject()`
 *    → 无有效会话即 401；主体只来自服务端会话存储，控制器不解析任何角色字段，
 *    也不读取任何自定义头（`x-user-id`/`x-roles`/`x-scope`/`x-group-id` 都不进入判定）；
 * 2. 资源级判定在 service 内经由 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口）完成，
 *    且**先于查询串校验与任何端口读取**，拒绝即 403；控制器不自行判断权限，
 *    也不拼接判定入参；
 * 3. 查询串闭集：控制器把 `@Query()` 原样交给 service，在授权之后判定。
 *    本端点不声明任何查询参数，因此 `?userId=`/`?roles=`/`?scope=`/`?groupId=` 等
 *    一律 400 `VALIDATION_FAILED`（给出可区分的拒绝原因），而不是静默忽略 ——
 *    客户端提交的授权声明既不被读取，也不被信任，更不能改变口径。
 *
 * 响应统一由 `ApiResponseInterceptor` 包成 `{ data, meta, error }`，
 * 异常统一由 `ApiExceptionFilter` 映射为稳定错误码（401/400/403/500）。
 */
@Controller('me/statistics')
export class StatisticsController {
  constructor(
    @Inject(StatisticsService) private readonly statistics: StatisticsService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  @Get()
  async getMyStatistics(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<SelfStatisticsView> {
    return this.statistics.getMyStatistics(
      await requireSubject(this.sessions, authorization),
      query,
    );
  }
}
