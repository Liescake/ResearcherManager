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
 * 当前已有业务实现的是 `EducationModule`（升学记录学生自服务切片），其余仍为占位。
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
