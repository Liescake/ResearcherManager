import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { EducationRecordsController } from './education-records.controller';
import { InMemoryEducationRecordRepository } from './education-records.in-memory-repository';
import { EDUCATION_RECORD_REPOSITORY } from './education-records.port';
import { EducationRecordsService } from './education-records.service';

/**
 * 升学记录切片：P4 第一个**有业务实现**的领域模块（升学记录的学生自服务部分）。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `education → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `education → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * 持久化绑定：`EDUCATION_RECORD_REPOSITORY → InMemoryEducationRecordRepository`
 * （内存基线，非生产存储：`persistent = false`，`NODE_ENV=production` 下拒绝构造）。
 * 引入数据库后只替换这一个 provider 的绑定，controller/service 不改动。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖，也不改动 health /
 * runtime-info 等既有路由；对外只新增 `/me/education-records*` 三条路由。
 */
@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [EducationRecordsController],
  providers: [
    EducationRecordsService,
    InMemoryEducationRecordRepository,
    { provide: EDUCATION_RECORD_REPOSITORY, useExisting: InMemoryEducationRecordRepository },
  ],
})
export class EducationModule {}
