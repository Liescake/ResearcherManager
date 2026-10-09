import { Body, Controller, Get, Headers, Inject, Post } from '@nestjs/common';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import type { AchievementView } from './achievements.contract';
import { AchievementsService } from './achievements.service';

/**
 * 成果（本人自服务）：
 * - `GET  /api/v1/me/achievements`  本人成果列表
 * - `POST /api/v1/me/achievements`  创建本人成果
 *
 * 路径与权限点对齐 docs/P2-API契约基线.md §「成果、升学、匹配」（`/me/achievements`）。
 * 单条读取、更新（`PATCH`）、审核与管理端路径不在本切片。
 *
 * 认证与授权分工（刻意不用全局 Guard，避免「看起来覆盖所有路由」的假象）：
 * 1. 每个方法显式声明它需要会话：`@Headers('authorization')` → `requireSubject()`
 *    → 无有效会话即 401；主体只来自服务端会话存储，控制器不解析任何角色字段，
 *    也不读取任何自定义头（`x-user-id`/`x-roles`/`x-scope`/`x-group-id` 都不进入判定）；
 * 2. 资源级判定在 service 内经由 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口）完成，
 *    且**先于任何仓储访问**，拒绝即 403；控制器不自行判断权限，也不拼接判定入参。
 *
 * 响应统一由 `ApiResponseInterceptor` 包成 `{ data, meta, error }`，
 * 异常统一由 `ApiExceptionFilter` 映射为稳定错误码（401/400/403/500）。
 */
@Controller('me/achievements')
export class AchievementsController {
  constructor(
    @Inject(AchievementsService) private readonly achievements: AchievementsService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  @Get()
  async listMyAchievements(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<AchievementView[]> {
    return this.achievements.listMyAchievements(await requireSubject(this.sessions, authorization));
  }

  @Post()
  async createMyAchievement(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<AchievementView> {
    return this.achievements.createMyAchievement(
      await requireSubject(this.sessions, authorization),
      body,
    );
  }
}
