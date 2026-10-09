import { ACHIEVEMENT_REPOSITORY } from '../modules/achievements/achievements.port';
import { AUDIT_REPOSITORY } from '../modules/audit/audit.port';
import { SESSION_STORE } from '../modules/auth/session-subject.port';
import { COMPLIANCE_REPOSITORY } from '../modules/compliance/compliance.port';
import { EDUCATION_RECORD_REPOSITORY } from '../modules/education/education-records.port';
import { EXPORT_ARTIFACT_STORE, EXPORT_REPOSITORY } from '../modules/exports/exports.port';
import { GROUP_REPOSITORY } from '../modules/groups/groups.port';
import { MATCHING_AI_PROVIDER, MATCHING_FEATURE_SOURCE } from '../modules/matching/matching.port';
import { MATCHING_REPOSITORY } from '../modules/matching/matching.port';
import { APPLICATION_REPOSITORY } from '../modules/memberships/applications.port';
import { NOTIFICATION_REPOSITORY } from '../modules/notifications/notifications.port';
import { PROFILE_REPOSITORY } from '../modules/profiles/student-profile.port';
import { RUOYI_AUTHZ_ADAPTER } from '../modules/ruoyi-adapter/ruoyi-adapter.port';
import { SESSION_SUBJECT_RESOLVER } from '../modules/auth/session-subject.port';
import {
  ACHIEVEMENT_STATISTICS_REPOSITORY,
  APPLICATION_STATISTICS_REPOSITORY,
  EDUCATION_STATISTICS_REPOSITORY,
  MATCHING_STATISTICS_REPOSITORY,
} from '../modules/statistics/statistics.port';
import { SQL_CONNECTION_FACTORY } from './ports/sql-executor.port';

/**
 * 持久化绑定登记表（**生产边界的唯一事实来源**）。
 *
 * 每个业务 repository port 都必须在下面登记，或者进入 `NON_PERSISTENCE_PORTS` 并给出理由。
 * `database.module.spec.ts` 的漂移门禁会扫描 `src/**\/*.port.ts` 里的 DI 令牌，任何新增
 * 端口若既未登记也没有理由，测试直接失败 —— 避免「新写一个内存仓储，生产边界悄悄漏检」。
 *
 * 登记项只描述「哪个端口需要被检查」，不硬编码能力值：能力从容器里实际绑定的实现读取
 * （见 `PersistenceBoundaryService`），因此换绑实现后判定自动跟随，无需改登记表。
 */
/**
 * 端口角色：决定该端口在生产门禁里的归属与判定顺序。
 * - `authentication`：认证链路的根（会话存储），必须最先就绪（见
 *   `persistence/dependency-readiness.ts` 的「认证先行」阶段判定）；
 * - `business`：业务持久化依赖（画像、小组、成果、审计、导出……）；
 * - `infrastructure`：执行器形态的连接端口，其生产准入由 SQL 执行器契约承担
 *   （`ports/sql-executor-verification.ts`），因此不进入依赖就绪契约的角色阶段。
 */
export type PersistenceBindingRole = 'authentication' | 'business' | 'infrastructure';

export interface PersistenceBindingDescriptor {
  readonly token: symbol;
  /** 端口所在模块（便于定位违规来源） */
  readonly module: string;
  /** 一句话说明该端口承载的持久化职责 */
  readonly responsibility: string;
  /** 端口角色：决定生产门禁按「认证 → 业务」分阶段判定时的归属 */
  readonly role: PersistenceBindingRole;
}

/** 需要按「持久 + 生产可用」判定能力的端口（业务数据与会话存储） */
export const PERSISTENCE_BINDINGS: readonly PersistenceBindingDescriptor[] = [
  {
    token: SESSION_STORE,
    module: 'auth',
    responsibility: '会话存储：跨进程/重启保留会话主体',
    role: 'authentication',
  },
  {
    token: PROFILE_REPOSITORY,
    module: 'profiles',
    responsibility: '学生画像存储',
    role: 'business',
  },
  {
    token: GROUP_REPOSITORY,
    module: 'groups',
    responsibility: '科研小组存储',
    role: 'business',
  },
  {
    token: APPLICATION_REPOSITORY,
    module: 'memberships',
    responsibility: '入组申请存储',
    role: 'business',
  },
  {
    token: ACHIEVEMENT_REPOSITORY,
    module: 'achievements',
    responsibility: '成果记录存储',
    role: 'business',
  },
  {
    token: EDUCATION_RECORD_REPOSITORY,
    module: 'education',
    responsibility: '升学记录存储',
    role: 'business',
  },
  {
    token: MATCHING_REPOSITORY,
    module: 'matching',
    responsibility: '匹配记录存储',
    role: 'business',
  },
  {
    token: NOTIFICATION_REPOSITORY,
    module: 'notifications',
    responsibility: '站内通知存储',
    role: 'business',
  },
  {
    token: AUDIT_REPOSITORY,
    module: 'audit',
    responsibility: '审计事件存储（只追加）',
    role: 'business',
  },
  {
    token: EXPORT_REPOSITORY,
    module: 'exports',
    responsibility: '导出任务存储',
    role: 'business',
  },
  {
    token: EXPORT_ARTIFACT_STORE,
    module: 'exports',
    responsibility: '导出产物存储（文件体）',
    role: 'business',
  },
  {
    token: COMPLIANCE_REPOSITORY,
    module: 'compliance',
    responsibility: '合规/隐私同意记录存储',
    role: 'business',
  },
  {
    token: EDUCATION_STATISTICS_REPOSITORY,
    module: 'statistics',
    responsibility: '升学记录计数来源',
    role: 'business',
  },
  {
    token: APPLICATION_STATISTICS_REPOSITORY,
    module: 'statistics',
    responsibility: '入组申请计数来源',
    role: 'business',
  },
  {
    token: ACHIEVEMENT_STATISTICS_REPOSITORY,
    module: 'statistics',
    responsibility: '成果计数来源',
    role: 'business',
  },
  {
    token: MATCHING_STATISTICS_REPOSITORY,
    module: 'statistics',
    responsibility: '匹配计数来源',
    role: 'business',
  },
  {
    token: SQL_CONNECTION_FACTORY,
    module: 'db',
    responsibility: 'SQL 连接工厂：默认绑定 fail-closed 的未验证驱动工厂',
    role: 'infrastructure',
  },
];

/** 非持久化端口：不承担存储职责，因此不参与「持久 + 生产可用」判定（必须给出理由） */
export interface NonPersistencePortDescriptor {
  readonly token: symbol;
  readonly module: string;
  readonly reason: string;
}

export const NON_PERSISTENCE_PORTS: readonly NonPersistencePortDescriptor[] = [
  {
    token: SESSION_SUBJECT_RESOLVER,
    module: 'auth',
    reason:
      '会话解析器：能力声明镜像 SESSION_STORE，存储职责由 SESSION_STORE 单独承担，避免同一后端被重复计数',
  },
  {
    token: MATCHING_FEATURE_SOURCE,
    module: 'matching',
    reason:
      '派生特征源：能力声明为 connectedToDomainData（而非 persistent），只读其他存储，不承担存储职责',
  },
  {
    token: MATCHING_AI_PROVIDER,
    module: 'matching',
    reason: 'AI 供应商适配器：外部服务调用，不是存储',
  },
  {
    token: RUOYI_AUTHZ_ADAPTER,
    module: 'ruoyi-adapter',
    reason: '授权判定适配器：能力声明描述判定入口与 RBAC 接入状态，不是存储',
  },
];

/** 端口名的可读形式（DI 令牌的 description，例如 `GROUP_REPOSITORY`） */
export function bindingTokenName(token: symbol): string {
  return token.description ?? '(anonymous-symbol)';
}
