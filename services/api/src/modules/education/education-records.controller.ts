import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { requireSubject } from '../auth/require-subject';
import { SESSION_SUBJECT_RESOLVER } from '../auth/session-subject.port';
import type { SessionSubjectResolver } from '../auth/session-subject.port';
import type { EducationRecordView } from './education-records.contract';
import { EducationRecordsService } from './education-records.service';

/**
 * 升学记录（本人）：
 * - `GET  /api/v1/me/education-records`              本人列表
 * - `POST /api/v1/me/education-records`              新建本人记录
 * - `GET  /api/v1/me/education-records/{recordId}`   本人单条
 *
 * 路径与权限点对齐 docs/P2-API契约基线.md §「成果、升学、匹配」（`/me/education-records`）。
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
@Controller('me/education-records')
export class EducationRecordsController {
  constructor(
    @Inject(EducationRecordsService) private readonly records: EducationRecordsService,
    @Inject(SESSION_SUBJECT_RESOLVER) private readonly sessions: SessionSubjectResolver,
  ) {}

  @Get()
  listMyRecords(
    @Headers('authorization') authorization: string | undefined,
  ): EducationRecordView[] {
    return this.records.listMyRecords(requireSubject(this.sessions, authorization));
  }

  @Post()
  createMyRecord(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): EducationRecordView {
    return this.records.createMyRecord(requireSubject(this.sessions, authorization), body);
  }

  @Get(':recordId')
  getMyRecord(
    @Headers('authorization') authorization: string | undefined,
    @Param('recordId') recordId: string,
  ): EducationRecordView {
    return this.records.getMyRecord(requireSubject(this.sessions, authorization), recordId);
  }
}
