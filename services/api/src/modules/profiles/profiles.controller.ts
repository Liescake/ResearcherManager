import { Body, Controller, Get, Headers, Inject, Patch } from '@nestjs/common';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import type { StudentProfileView } from './student-profile.contract';
import { ProfilesService } from './profiles.service';

/**
 * 学生画像（本人）：
 * - `GET   /api/v1/me/profile`  读取本人画像（`profile:self:read`）
 * - `PATCH /api/v1/me/profile`  更新本人画像（`profile:self:update`）
 *
 * 路径对齐 `docs/P2-API契约基线.md` §「认证与个人信息」（`/me/profile`）。
 * 契约基线把首次提交写作 `PUT /me/profile`；本切片只落地「读取 + 未锁定更新」，
 * 因此只注册 `GET` 与 `PATCH`，首次提交与更正申请属于后续切片。
 *
 * 认证与授权分工（刻意不用全局 Guard，避免「看起来覆盖所有路由」的假象）：
 * 1. 每个方法显式声明它需要会话：`@Headers('authorization')` → `requireSubject()`
 *    → 无有效会话即 401；主体只来自服务端会话存储，控制器不解析任何角色字段；
 * 2. 资源级判定在 service 内经由 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口）完成，
 *    拒绝即 403；控制器不自行判断权限，也不拼接判定入参。
 *
 * 响应统一由 `ApiResponseInterceptor` 包成 `{ data, meta, error }`，
 * 异常统一由 `ApiExceptionFilter` 映射为稳定错误码（401/400/403/404/500）。
 */
@Controller('me/profile')
export class ProfilesController {
  constructor(
    @Inject(ProfilesService) private readonly profiles: ProfilesService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  @Get()
  getMyProfile(@Headers('authorization') authorization: string | undefined): StudentProfileView {
    return this.profiles.getMyProfile(requireSubject(this.sessions, authorization));
  }

  @Patch()
  updateMyProfile(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): StudentProfileView {
    return this.profiles.updateMyProfile(requireSubject(this.sessions, authorization), body);
  }
}
