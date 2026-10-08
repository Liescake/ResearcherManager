import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { InMemoryProfileRepository } from './student-profile.in-memory-repository';
import { PROFILE_REPOSITORY } from './student-profile.port';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

/**
 * 学生画像切片：P5 第一个**有业务实现**的本人自服务模块（读取 + 更新本人画像）。
 *
 * 依赖方向（单向、无环，见 `access-control.module.spec.ts` 的模块图回归）：
 * `profiles → access-control（AuthorizationGuard）→ ruoyi-adapter（端口）→ authorization-policy`
 * `profiles → auth（SESSION_SUBJECT_RESOLVER：会话 → 服务端主体）`
 *
 * 持久化绑定：`PROFILE_REPOSITORY → InMemoryProfileRepository`
 * （内存基线，非生产存储：`persistent = false`，`NODE_ENV=production` 下拒绝构造）。
 * 引入数据库后只替换这一个 provider 的绑定，controller/service 不改动。
 *
 * 边界事实：本模块不含 RuoYi/Java 源码、不引入 Maven 依赖，也不改动 health / runtime-info /
 * education 等既有路由；对外只新增 `/me/profile` 的 `GET` 与 `PATCH` 两条路由。
 */
@Module({
  imports: [AuthModule, AccessControlModule],
  controllers: [ProfilesController],
  providers: [
    ProfilesService,
    InMemoryProfileRepository,
    { provide: PROFILE_REPOSITORY, useExisting: InMemoryProfileRepository },
  ],
})
export class ProfilesModule {}
