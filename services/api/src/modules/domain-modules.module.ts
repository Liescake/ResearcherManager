import { Module } from '@nestjs/common';
import { AccessControlModule } from './access-control/access-control.module';
import { AchievementsModule } from './achievements/achievements.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ComplianceModule } from './compliance/compliance.module';
import { EducationModule } from './education/education.module';
import { ExportsModule } from './exports/exports.module';
import { GroupsModule } from './groups/groups.module';
import { MatchingModule } from './matching/matching.module';
import { MembershipsModule } from './memberships/memberships.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ProfilesModule } from './profiles/profiles.module';
import { RuoYiAdapterModule } from './ruoyi-adapter/ruoyi-adapter.module';
import { StatisticsModule } from './statistics/statistics.module';

/**
 * 领域模块聚合入口：模块边界来自 docs/P2-架构与数据设计.md §2，并保持
 * 「API 是唯一业务规则入口」。
 *
 * P3 期间各模块只有边界声明；自 P4 起逐个填充 controller/service/repository，
 * 当前已有业务实现的是 `EducationModule`（升学记录学生自服务切片）、
 * `ProfilesModule`（学生画像自服务）、`MembershipsModule`（入组申请自服务）、
 * `AchievementsModule`（成果学生自服务：创建 / 本人列表）、
 * `GroupsModule`（小组最小垂直切片：浏览可见的开放小组 / 创建小组）、
 * `MatchingModule`（匹配最小垂直切片：发起本人匹配请求 / 本人列表与状态）、
 * `StatisticsModule`（本人统计：四类记录计数）、`NotificationsModule`
 * （本人通知箱：列表 / 标记已读）与 `AuditModule`
 * （本人审计摘要：本人可查看事件的脱敏摘要 + 该请求自身的服务端审计写入），其余仍为占位。
 */
@Module({
  imports: [
    AuthModule,
    AccessControlModule,
    ProfilesModule,
    GroupsModule,
    MembershipsModule,
    AchievementsModule,
    EducationModule,
    MatchingModule,
    StatisticsModule,
    ExportsModule,
    ComplianceModule,
    AuditModule,
    NotificationsModule,
    RuoYiAdapterModule,
  ],
})
export class DomainModulesModule {}
