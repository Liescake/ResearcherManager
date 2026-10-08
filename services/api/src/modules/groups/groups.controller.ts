import { Body, Controller, Get, Headers, Inject, Post } from '@nestjs/common';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import type { GroupView } from './groups.contract';
import { GroupsService } from './groups.service';

/**
 * 小组（浏览与创建）：
 * - `GET  /api/v1/groups`  浏览对服务端主体可见的开放小组
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
 * 3. 本控制器**不声明任何查询参数**：`?groupId=`/`?scope=`/`?userId=`/`?roles=`
 *    这类客户端声明既不被读取也不被信任，可见范围只由服务端主体决定
 *    （自定义头 `x-user-id`/`x-roles`/`x-scope`/`x-group-id` 同理，永不进入判定）。
 *
 * 响应统一由 `ApiResponseInterceptor` 包成 `{ data, meta, error }`，
 * 异常统一由 `ApiExceptionFilter` 映射为稳定错误码（401/400/403/500）。
 */
@Controller('groups')
export class GroupsController {
  constructor(
    @Inject(GroupsService) private readonly groups: GroupsService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  @Get()
  listGroups(@Headers('authorization') authorization: string | undefined): GroupView[] {
    return this.groups.listGroups(requireSubject(this.sessions, authorization));
  }

  @Post()
  createGroup(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): GroupView {
    return this.groups.createGroup(requireSubject(this.sessions, authorization), body);
  }
}
