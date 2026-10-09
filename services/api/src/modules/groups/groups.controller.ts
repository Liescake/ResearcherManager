import { Body, Controller, Get, Headers, Inject, Post, Query } from '@nestjs/common';
import { okPaginated } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import type { GroupView } from './groups.contract';
import { GroupsService } from './groups.service';

/**
 * 小组（分页浏览与创建）：
 * - `GET  /api/v1/groups`  分页浏览对服务端主体可见的开放小组
 * - `POST /api/v1/groups`  创建小组
 *
 * 路径与权限点对齐 docs/P2-API契约基线.md §「小组与申请」（`/groups`）；
 * 小组详情（`GET /groups/{groupId}`）与修改/停用（`PATCH`）不在本切片。
 *
 * 认证与授权分工（刻意不用全局 Guard，避免「看起来覆盖所有路由」的假象）：
 * 1. 每个方法显式声明它需要会话：`@Headers('authorization')` → `requireSubject()`
 *    → 无有效会话即 401；主体只来自服务端会话存储，控制器不解析任何角色字段。
 * 2. 资源级判定在 service 内经由 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口）完成，
 *    且**先于任何仓储访问**，拒绝即 403；控制器不自行判断权限，也不拼接判定入参。
 * 3. 列表只声明 `page`/`pageSize` 两个查询参数（其上下界由共享 `paginationSchema` 校验）；
 *    查询串出现 `?groupId=`/`?scope=`/`?userId=`/`?roles=` 这类客户端声明时由 service 的
 *    查询串闭集**显式 400**（不是静默忽略，也不是过滤器）；创建接口**不声明任何查询参数**，
 *    出现任何查询键同样 400；自定义头
 *    `x-user-id`/`x-roles`/`x-scope`/`x-group-id` 同理，永不进入判定。
 *
 * 响应：默认由 `ApiResponseInterceptor` 包成 `{ data, meta, error }`；列表额外返回共享
 * `okPaginated(...)` 构建的信封，由拦截器补齐 `requestId`/`generatedAt` 后把
 * `page`/`pageSize`/`total`/`totalPages` 写入 `meta`（docs/P2-API契约基线.md「分页元数据」）。
 * 异常统一由 `ApiExceptionFilter` 映射为稳定错误码（401/403/400/500）。
 */
@Controller('groups')
export class GroupsController {
  constructor(
    @Inject(GroupsService) private readonly groups: GroupsService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  @Get()
  async listGroups(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<ApiEnvelope<GroupView[]>> {
    const page = await this.groups.listGroups(
      await requireSubject(this.sessions, authorization),
      query,
    );
    return okPaginated(page.items, page.total, page.pagination);
  }

  @Post()
  async createGroup(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<GroupView> {
    return this.groups.createGroup(await requireSubject(this.sessions, authorization), body, query);
  }
}
