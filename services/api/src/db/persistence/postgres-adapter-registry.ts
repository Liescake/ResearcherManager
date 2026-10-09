/**
 * 跨 adapter 持久化边界登记表与判定器（**已落地 Postgres 切片的唯一事实来源**）。
 *
 * ## 为什么需要这一层
 * `modules/**\/*.postgres-repository.ts` 的十二个 PostgreSQL adapter 分成两组：两个是「已写好但
 * **未装配**」的实现（它们不参与依赖注入、不进入任何业务 Module 的 provider、不引入任何驱动
 * 依赖，能力声明固定为 `backend = postgres` / `persistent = true` / `productionReady = false`），
 * 十个已按「是否配置数据库」绑定到端口（见下 `POSTGRES_BOUND_SLICE_REGISTRY`）。
 * 每个 adapter 自己的 spec 只能证明「本 adapter 的装配状态」，**无法回答跨 adapter 的问题**：
 * 新增了第十一个 adapter 但忘了登记、两个 adapter 争抢同一个模块、登记表指向了不存在的文件、
 * 有人偷偷把 adapter 写进 provider 或引入 `pg` —— 这些都必须由一道**跨 adapter 的门禁**发现。
 *
 * 因此这里做三件事：
 * 1. `POSTGRES_ADAPTER_REGISTRY`：按模块登记每个 adapter 的身份（文件、能力导出名、自检导出名、
 *    仓储类名、对应业务模块文件）。登记表只写「哪个 adapter 必须存在」，**不硬编码能力值** ——
 *    能力判定读运行时真实导出（见 spec 的动态 import），换实现后判定自动跟随；
 * 2. `POSTGRES_ADAPTER_EXEMPTIONS`：有持久化端口但**尚未**落地 Postgres adapter 的模块必须显式
 *    登记理由，不允许「没有 adapter」与「忘了写 adapter」在门禁上无法区分；
 * 3. `evaluatePostgresAdapterBoundary`：纯函数判定器（不读文件、不建连接、不写日志），把「磁盘
 *    枚举到的 adapter 文件 + 运行时能力 + 模块装配事实 + 依赖事实」判成违规清单，任何缺失 /
 *    重复 / 错误登记一律 fail-closed。
 *
 * 判定口径与 `production-guard.ts` 一致：只输出端口名 / 模块名 / adapter id / 布尔与枚举能力值，
 * **绝不包含连接串、口令、字段取值**（本层根本不接触这些数据）。
 */

import type { PersistenceCapabilities } from '../ports/sql-executor.port';

/** adapter 文件名后缀：磁盘自动枚举与登记表共用这一口径 */
export const POSTGRES_ADAPTER_FILE_SUFFIX = '.postgres-repository.ts';

/** 未装配 adapter 唯一允许的后端标识（与各 adapter 的 `POSTGRES_*_BACKEND` 一致） */
export const POSTGRES_ADAPTER_BACKEND = 'postgres';

/**
 * 一个未装配 Postgres adapter 的登记项。
 *
 * `file` / `moduleFile` 一律是 **posix 形式、相对 `services/api/src`** 的路径，
 * 与磁盘扫描结果同口径（扫描一侧用 `relative()` + 分隔符归一化），避免 Windows 反斜杠造成
 * 「登记了但比对不上」的假阴性。
 */
export interface PostgresAdapterDescriptor {
  /** 稳定 id：同时用于违规信息定位与去重判定 */
  readonly id: string;
  /** 所属业务模块（必须等于 `file` 的目录名与 `moduleFile` 的目录名） */
  readonly module: string;
  /** adapter 源文件（相对 `services/api/src`，posix） */
  readonly file: string;
  /** 能力声明导出名（运行时必须存在且是能力对象） */
  readonly capabilitiesExport: string;
  /** adapter 自检函数导出名（运行时必须存在，且对错误能力声明必须抛错） */
  readonly assertExport: string;
  /** 仓储类导出名（运行时必须存在；用于「未被任何模块引用」的判定） */
  readonly repositoryClass: string;
  /** 该模块的 Nest 模块文件（相对 `services/api/src`，posix） */
  readonly moduleFile: string;
}

/**
 * 两个未装配 Postgres adapter 的登记表（按模块名字母序，便于人工比对）。
 *
 * 新增 adapter 时**必须同时**在此登记：门禁会拿磁盘枚举结果与这张表做双向比对，
 * 只加文件不登记（`ADAPTER_FILE_NOT_REGISTERED`）与只登记不加文件（`REGISTERED_FILE_MISSING`）
 * 都会失败。
 *
 * 合规切片已从本组移到 `POSTGRES_BOUND_SLICE_REGISTRY`（它的 `COMPLIANCE_REPOSITORY`
 * 现在按「是否配置 `DATABASE_URL`」换绑），因此这里只剩导出与匹配两个切片。
 */
export const POSTGRES_ADAPTER_REGISTRY: readonly PostgresAdapterDescriptor[] = [
  {
    id: 'exports',
    module: 'exports',
    file: 'modules/exports/exports.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_EXPORT_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresExportRepositoryCapabilities',
    repositoryClass: 'PostgresExportRepository',
    moduleFile: 'modules/exports/exports.module.ts',
  },
  {
    id: 'matching',
    module: 'matching',
    file: 'modules/matching/matching.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_MATCHING_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresMatchingRepositoryCapabilities',
    repositoryClass: 'PostgresMatchingRepository',
    moduleFile: 'modules/matching/matching.module.ts',
  },
];

/**
 * **已绑定**的持久化切片：adapter 已经进入业务 Module 的 provider（经工厂构造），因此
 * 「未装配」那一组规则（不得被 Module 引用）对它们**不成立** —— 但必须换成另一组同样可机器
 * 判定的规则，而不是简单地放行。
 *
 * 十个切片：
 * - `auth`：会话存储（`SESSION_STORE`）。「是否配置数据库」决定绑定哪个实现；未配置时绑定内存基线，
 *   配置时绑定 PostgreSQL 实现（延迟建连，见 `modules/auth/session-store.postgres-repository.ts`）。
 *   因此 `auth.module.ts` 里出现的是**工厂导出名**，而不是 adapter 类名；
 * - `compliance`：合规状态存储（`COMPLIANCE_REPOSITORY`，本人合规状态的只读取数）。分流口径与
 *   auth 完全一致：同一份纯函数 `resolveAppDatabaseConfig` + 可选注入的 `SQL_CONNECTION_FACTORY`，
 *   未配置数据库时内存基线，配置时 PostgreSQL 实现（延迟建连，见
 *   `modules/compliance/compliance.postgres-repository.ts` 的
 *   `createLazyPostgresComplianceRepository`，表 `user_compliance` 由迁移 `0012` 建立）。
 *   授权（`profile:self:read` + `SELF`）在 service 里**先于任何仓储访问与字段校验**；归属只来自
 *   服务端会话主体（客户端 `userId` / `owner` / `status` 既不进判定也不进 SQL），adapter 把归属
 *   下推进 SQL（`WHERE user_id = $1::uuid`）并在返回行上复核归属。**已登记前置**：
 *   `user_compliance.user_id` 是 `uuid`，而会话基线的 `userId` 形如 `u-student-1`，因此数据库路径
 *   对非 UUID 主体 fail-closed（`INVALID_SUBJECT`，且在**解析执行器之前**判定，不建立任何连接）；
 * - `audit`：审计事件存储（`AUDIT_REPOSITORY`，**只追加**）。分流口径与 auth 完全一致：同一份纯函数
 *   `resolveAppDatabaseConfig` + 可选注入的 `SQL_CONNECTION_FACTORY`，未配置数据库时内存基线，
 *   配置时 PostgreSQL 实现（延迟建连，见 `modules/audit/audit.postgres-repository.ts` 的
 *   `createLazyPostgresAuditRepository`，表由迁移 `0009` 建立，存储层另有触发器拒绝业务侧改写与
 *   删除）。装配阶段一次都不碰数据库，因此「数据库已配置但依赖不就绪」由启动期门禁给出结构化违规；
 * - `notifications`：站内通知存储（`NOTIFICATION_REPOSITORY`，本人通知箱读写）。分流口径与 auth
 *   完全一致：未配置数据库时内存基线，配置时 PostgreSQL 实现（延迟建连，见
 *   `modules/notifications/notifications.postgres-repository.ts` 的
 *   `createLazyPostgresNotificationRepository`，表由迁移 `0010` 建立）；单条读取把归属下推进 SQL
 *   （`findById(notificationId, ownerUserId)`），因此「不存在」与「他人通知」统一为 404、不可探测，
 *   而授权（`profile:self:*` + `SELF`）在 service 里**先于任何仓储访问**；
 * - `achievements`：成果存储（`ACHIEVEMENT_REPOSITORY`）。分流口径与 auth 完全一致：同一份纯函数
 *   `resolveAppDatabaseConfig` + 可选注入的 `SQL_CONNECTION_FACTORY`，未配置数据库时内存基线，
 *   配置时 PostgreSQL 实现（延迟建连，见 `modules/achievements/achievements.postgres-repository.ts`）；
 * - `education`：升学记录存储（`EDUCATION_RECORD_REPOSITORY`）。分流口径与 auth 完全一致：
 *   未配置数据库时内存基线，配置时 PostgreSQL 实现（延迟建连，见
 *   `modules/education/education-records.postgres-repository.ts`）；单条读取把归属下推进 SQL
 *   （`findById(recordId, ownerUserId)`），因此「不存在」与「他人记录」统一为 404、不可探测；
 * - `groups`：科研小组存储（`GROUP_REPOSITORY`，分页浏览可见的开放小组 + 创建小组）。分流口径与
 *   auth 完全一致：未配置数据库时内存基线，配置时 PostgreSQL 实现（延迟建连，见
 *   `modules/groups/groups.postgres-repository.ts` 的 `createLazyPostgresGroupRepository`，
 *   表 `research_groups` 由迁移 `0011` 建立）。授权（`group:read:open` 的多候选范围判定 /
 *   `group:manage` + `GLOBAL`）在 service 里**先于任何仓储访问与字段校验**；可见范围只来自
 *   服务端主体的判定产物（`includeAllOpenGroups` / `visibleGroupIds`），客户端 `groupId` /
 *   `scope` / `owner` 既不进判定也不进 SQL。**已登记前置**：`research_groups.id` 是 `uuid`，
 *   而会话主体的 `groupIds` / `assignedResourceIds` 目前只保证是「安全 ID」，因此数据库路径对
 *   资源级可见的主体 fail-closed（非 UUID 可见 ID 在进入 SQL 前被拒，`INVALID_QUERY`）——
 *   会话主体资源标识收敛为 UUID 属于后续切片；
 * - `memberships`：入组申请存储（`APPLICATION_REPOSITORY`，即入组申请学生自服务切片）。分流口径
 *   与 auth 完全一致：未配置数据库时内存基线，配置时 PostgreSQL 实现（延迟建连，见
 *   `modules/memberships/applications.postgres-repository.ts` 的
 *   `createLazyPostgresApplicationRepository`）；单条读取同样把归属下推进 SQL
 *   （`findById(applicationId, ownerUserId)`），因此「不存在」与「他人申请」统一为 404、不可探测，
 *   而授权（`membership:self:*` + `SELF`）在 service 里**先于任何仓储访问**；
 * - `profiles`：学生画像存储（`PROFILE_REPOSITORY`）。分流口径与 auth 完全一致：同一份纯函数
 *   `resolveAppDatabaseConfig` + 可选注入的 `SQL_CONNECTION_FACTORY`，未配置数据库时内存基线，
 *   配置时 PostgreSQL 实现（延迟建连，见 `modules/profiles/student-profile.postgres-repository.ts`）；
 * - `statistics`：本人统计聚合读（`SELF_STATISTICS_REPOSITORY`），同样的「按是否配置数据库分流」。
 *
 * 规则：
 * 1. adapter 文件仍然必须在磁盘上存在，且不得 import / 转发另一个 `*.postgres-repository`；
 * 2. 能力声明仍是 `backend = postgres`、`persistent = true`、`productionReady = false`
 *    （本阶段尚未取得 attest 证据，不得声称生产可用）；
 * 3. 能力自检仍必须拒绝「未验证就声称生产可用 / 降级为非持久 / 换后端」三类错误登记；
 * 4. 业务 Module **必须**引用绑定点（令牌名 + 工厂导出名）：换绑与登记表必须同时更新，
 *    只改其中一处即 fail-closed；
 * 5. adapter 源文件不得 import 任何驱动（含已授权的 `pg`）：驱动只允许出现在
 *    `db/postgres/` 驱动层；
 * 6. 其余两个 adapter 继续留在 `POSTGRES_ADAPTER_REGISTRY`（未装配组），两组互斥。
 */
export interface PostgresBoundSliceDescriptor {
  /** 稳定 id */
  readonly id: string;
  readonly module: string;
  /** adapter 源文件（相对 `services/api/src`，posix） */
  readonly file: string;
  readonly capabilitiesExport: string;
  readonly assertExport: string;
  readonly repositoryClass: string;
  /** 业务 Module 文件（相对 `services/api/src`，posix） */
  readonly moduleFile: string;
  /** 该切片换绑的 DI 令牌可读名（必须出现在 module 源文件里） */
  readonly token: string;
  /** adapter 侧提供给 Module 的工厂导出名（必须出现在 module 源文件里） */
  readonly factoryExport: string;
}

export const POSTGRES_BOUND_SLICE_REGISTRY: readonly PostgresBoundSliceDescriptor[] = [
  {
    id: 'auth',
    module: 'auth',
    file: 'modules/auth/session-store.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_SESSION_STORE_CAPABILITIES',
    assertExport: 'assertPostgresSessionStoreCapabilities',
    repositoryClass: 'PostgresSessionStore',
    moduleFile: 'modules/auth/auth.module.ts',
    token: 'SESSION_STORE',
    factoryExport: 'createLazyPostgresSessionStore',
  },
  {
    id: 'compliance',
    module: 'compliance',
    file: 'modules/compliance/compliance.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresComplianceRepositoryCapabilities',
    repositoryClass: 'PostgresComplianceRepository',
    moduleFile: 'modules/compliance/compliance.module.ts',
    token: 'COMPLIANCE_REPOSITORY',
    factoryExport: 'createLazyPostgresComplianceRepository',
  },
  {
    id: 'audit',
    module: 'audit',
    file: 'modules/audit/audit.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_AUDIT_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresAuditRepositoryCapabilities',
    repositoryClass: 'PostgresAuditRepository',
    moduleFile: 'modules/audit/audit.module.ts',
    token: 'AUDIT_REPOSITORY',
    factoryExport: 'createLazyPostgresAuditRepository',
  },
  {
    id: 'achievements',
    module: 'achievements',
    file: 'modules/achievements/achievements.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_ACHIEVEMENT_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresAchievementRepositoryCapabilities',
    repositoryClass: 'PostgresAchievementRepository',
    moduleFile: 'modules/achievements/achievements.module.ts',
    token: 'ACHIEVEMENT_REPOSITORY',
    factoryExport: 'createLazyPostgresAchievementRepository',
  },
  {
    id: 'education',
    module: 'education',
    file: 'modules/education/education-records.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresEducationRecordRepositoryCapabilities',
    repositoryClass: 'PostgresEducationRecordRepository',
    moduleFile: 'modules/education/education.module.ts',
    token: 'EDUCATION_RECORD_REPOSITORY',
    factoryExport: 'createLazyPostgresEducationRecordRepository',
  },
  {
    id: 'groups',
    module: 'groups',
    file: 'modules/groups/groups.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_GROUP_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresGroupRepositoryCapabilities',
    repositoryClass: 'PostgresGroupRepository',
    moduleFile: 'modules/groups/groups.module.ts',
    token: 'GROUP_REPOSITORY',
    factoryExport: 'createLazyPostgresGroupRepository',
  },
  {
    id: 'memberships',
    module: 'memberships',
    file: 'modules/memberships/applications.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_APPLICATION_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresApplicationRepositoryCapabilities',
    repositoryClass: 'PostgresApplicationRepository',
    moduleFile: 'modules/memberships/memberships.module.ts',
    token: 'APPLICATION_REPOSITORY',
    factoryExport: 'createLazyPostgresApplicationRepository',
  },
  {
    id: 'notifications',
    module: 'notifications',
    file: 'modules/notifications/notifications.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresNotificationRepositoryCapabilities',
    repositoryClass: 'PostgresNotificationRepository',
    moduleFile: 'modules/notifications/notifications.module.ts',
    token: 'NOTIFICATION_REPOSITORY',
    factoryExport: 'createLazyPostgresNotificationRepository',
  },
  {
    id: 'profiles',
    module: 'profiles',
    file: 'modules/profiles/student-profile.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresStudentProfileRepositoryCapabilities',
    repositoryClass: 'PostgresStudentProfileRepository',
    moduleFile: 'modules/profiles/profiles.module.ts',
    token: 'PROFILE_REPOSITORY',
    factoryExport: 'createLazyPostgresStudentProfileRepository',
  },
  {
    id: 'statistics',
    module: 'statistics',
    file: 'modules/statistics/statistics.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_STATISTICS_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresStatisticsRepositoryCapabilities',
    repositoryClass: 'PostgresStatisticsRepository',
    moduleFile: 'modules/statistics/statistics.module.ts',
    token: 'SELF_STATISTICS_REPOSITORY',
    factoryExport: 'createLazyPostgresSelfStatisticsRepository',
  },
];

/**
 * 有持久化端口但**尚未**落地 Postgres adapter 的模块（必须给出理由，不允许悄悄缺席）。
 * 登记项与磁盘状态无关：门禁只要求「没 adapter 就必须有理由」，有理由也会被复核是否陈旧。
 *
 * 当前为空集：`PERSISTENCE_BINDINGS` 里的每个业务模块都已经有登记在
 * `POSTGRES_ADAPTER_REGISTRY`（未装配）或 `POSTGRES_BOUND_SLICE_REGISTRY`（已绑定）的 adapter。
 * 空集是有意义的断言 —— 一旦某个模块新增了持久化端口却既没有 adapter 也没有理由，
 * 门禁会以 `PERSISTENCE_PORT_WITHOUT_ADAPTER` 直接失败。
 */
export interface PostgresAdapterExemption {
  readonly module: string;
  /** 该模块上仍然只有内存基线的持久化端口（DI 令牌名） */
  readonly token: string;
  readonly reason: string;
}

export const POSTGRES_ADAPTER_EXEMPTIONS: readonly PostgresAdapterExemption[] = [];

/**
 * **已授权引入**的 PostgreSQL 驱动包（本阶段：官方 `pg` 驱动 + 其类型声明）。
 *
 * 用户已明确授权引入官方 `pg` 驱动。授权不是「随便 import」：`pg` 只允许出现在
 * `db/postgres/` 驱动层（见 `POSTGRES_DRIVER_LAYER_DIRECTORY` 与
 * `DRIVER_IMPORT_OUTSIDE_DRIVER_LAYER`），业务 adapter 仍只能依赖驱动无关的 `SqlExecutor` 端口。
 * `pg` 家族的传递依赖（`pg-pool` / `pg-types` / `pg-protocol` / `pg-connection-string` …）随官方
 * 驱动一起被安装，属于同一授权范围，但**不在本清单里**：清单只登记**直接声明**的包，
 * 传递依赖由 `AUTHORIZED_POSTGRES_DRIVER_PACKAGE_PATTERN` 覆盖。
 */
export const AUTHORIZED_POSTGRES_DRIVER_PACKAGES: readonly string[] = ['pg', '@types/pg'];

/** 已授权包名（含官方 `pg` 的家族传递依赖）的匹配口径 */
export const AUTHORIZED_POSTGRES_DRIVER_PACKAGE_PATTERN = /^(?:pg|pg-[a-z0-9-]+|@types\/pg)$/u;

/** 即使匹配家族前缀也**不允许**出现的包（原生绑定与第三方 wrapper：引入需单独评估） */
export const DENIED_POSTGRES_DRIVER_PACKAGES: readonly string[] = [
  'pg-native',
  'pg-promise',
  // 第三方 pg 之上/之外的驱动与查询构建器
  'postgres',
  'slonik',
  // ORM / 查询构建器 / Nest 集成
  'prisma',
  '@prisma/client',
  'typeorm',
  '@nestjs/typeorm',
  'sequelize',
  '@nestjs/sequelize',
  'knex',
  'kysely',
  'drizzle-orm',
  'drizzle-kit',
  'objection',
  'bookshelf',
  'mikro-orm',
  '@mikro-orm/core',
  // 其他关系型数据库驱动（同一类「未经评估的存储驱动」风险）
  'mysql',
  'mysql2',
  'mssql',
  'oracledb',
  'better-sqlite3',
  'sqlite3',
];

/**
 * 被禁驱动清单（保留导出名以兼容既有 spec 与调用方）。
 *
 * 与「未授权时代」的差异：官方 `pg` 驱动与 `@types/pg` 已从禁止集合转到
 * `AUTHORIZED_POSTGRES_DRIVER_PACKAGES`；`pg` 家族的前缀规则被收窄为
 * 「匹配前缀但不在 `DENIED_POSTGRES_DRIVER_PACKAGES` 里才算已授权」。
 */
export const FORBIDDEN_POSTGRES_DRIVER_PACKAGES: readonly string[] =
  DENIED_POSTGRES_DRIVER_PACKAGES;

/** 判定一个包名是否属于**已授权**的官方 pg 驱动家族 */
export function isAuthorizedDriverPackageName(packageName: string): boolean {
  return (
    AUTHORIZED_POSTGRES_DRIVER_PACKAGE_PATTERN.test(packageName) &&
    !DENIED_POSTGRES_DRIVER_PACKAGES.includes(packageName)
  );
}

/** 规范化 pnpm 存储目录名 → 包名（`pg@8.11.3` → `pg`，`@prisma+client@5.0.0_x` → `@prisma/client`） */
export function normalizeInstalledPackageName(directoryName: string): string {
  const withoutPeers = directoryName.split('_')[0] ?? directoryName;
  if (withoutPeers.startsWith('@')) {
    const secondAt = withoutPeers.indexOf('@', 1);
    const scoped = secondAt === -1 ? withoutPeers : withoutPeers.slice(0, secondAt);
    return scoped.replace('+', '/');
  }
  const firstAt = withoutPeers.indexOf('@');
  return firstAt === -1 ? withoutPeers : withoutPeers.slice(0, firstAt);
}

/**
 * 判定一个 import specifier 是否指向被禁驱动：相对路径与 `node:` 内置模块直接放行，
 * 其余按包名比对（含子路径 `pg/lib/client`、npm 别名前缀与 pg 家族前缀）。
 */
export function isForbiddenDriverSpecifier(
  specifier: string,
  forbidden: readonly string[] = FORBIDDEN_POSTGRES_DRIVER_PACKAGES,
): boolean {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:') ||
    specifier.startsWith('#')
  ) {
    return false;
  }
  const normalized = specifier.replace(/^npm:/u, '').replace(/@[^/]+$/u, '');
  if (isAuthorizedDriverPackageName(normalized)) {
    return false;
  }
  return forbidden.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`) || specifier.startsWith(name),
  );
}

/** 判定一个 import specifier 是否指向**已授权**的官方 pg 驱动（用于「驱动导入层」收敛判定） */
export function isAuthorizedDriverSpecifier(specifier: string): boolean {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:') ||
    specifier.startsWith('#')
  ) {
    return false;
  }
  const normalized = specifier.replace(/^npm:/u, '');
  const packageName = normalized.startsWith('@')
    ? normalized.split('/').slice(0, 2).join('/')
    : (normalized.split('/')[0] ?? normalized);
  return isAuthorizedDriverPackageName(packageName);
}

/** 判定一个已安装包名（已规范化）是否被禁 */
export function isForbiddenDriverPackageName(
  packageName: string,
  forbidden: readonly string[] = FORBIDDEN_POSTGRES_DRIVER_PACKAGES,
): boolean {
  if (isAuthorizedDriverPackageName(packageName)) {
    return false;
  }
  if (/^pg(?:-|\/)/u.test(packageName)) {
    // 家族前缀命中但不在已授权集合里 ⇒ 属于 `DENIED_POSTGRES_DRIVER_PACKAGES`
    return true;
  }
  return forbidden.includes(packageName);
}

/**
 * 能力自检探针的期望表：每个 adapter 的自检函数都必须对「错误登记」抛错，
 * 而对自己的真实声明放行。四类变体固定下来，spec 只负责调用并记录 `threw`。
 */
export const POSTGRES_CAPABILITY_PROBE_VARIANTS = [
  {
    variant: 'declared',
    mustThrow: false,
    description: '真实声明（postgres / persistent=true / productionReady=false）必须放行',
  },
  {
    variant: 'production-ready-claimed',
    mustThrow: true,
    description: '未完成验证就声称 productionReady=true 必须被自检拒绝',
  },
  {
    variant: 'persistent-downgraded',
    mustThrow: true,
    description: '把 persistent 降为 false（内存语义）必须被自检拒绝',
  },
  {
    variant: 'backend-swapped',
    mustThrow: true,
    description: '把 backend 换成非 postgres 必须被自检拒绝',
  },
] as const;

/** 探针变体名 */
export type PostgresCapabilityProbeVariant =
  (typeof POSTGRES_CAPABILITY_PROBE_VARIANTS)[number]['variant'];

/** 违规代码：每个代码对应一类可机器判定的「边界破坏」 */
export type PostgresAdapterBoundaryCode =
  // 登记表 ↔ 磁盘
  | 'ADAPTER_FILE_NOT_REGISTERED'
  | 'REGISTERED_FILE_MISSING'
  | 'DUPLICATE_ADAPTER_REGISTRATION'
  | 'ADAPTER_FILE_NAME_MISMATCH'
  | 'ADAPTER_MODULE_DIRECTORY_MISMATCH'
  | 'ADAPTER_MODULE_FILE_MISMATCH'
  | 'ADAPTER_MODULE_WITHOUT_PERSISTENCE_PORT'
  | 'ADAPTER_FACTS_MISSING'
  | 'ADAPTER_FACTS_UNKNOWN'
  // 声明与能力
  | 'ADAPTER_DECLARATION_MISSING'
  | 'ADAPTER_FILE_REDIRECTED'
  | 'CAPABILITY_MISSING'
  | 'CAPABILITY_BACKEND_MISMATCH'
  | 'CAPABILITY_NOT_PERSISTENT'
  | 'CAPABILITY_PRODUCTION_READY_CLAIMED'
  | 'CAPABILITY_PROBE_MISSING'
  | 'CAPABILITY_ASSERT_NOT_THROWING'
  | 'CAPABILITY_ASSERT_REJECTS_DECLARED'
  // 装配边界
  | 'NEST_DECORATOR_IN_ADAPTER'
  | 'MODULE_PROVIDER_BINDING'
  | 'ADAPTER_REFERENCED_ELSEWHERE'
  | 'PENDING_TOKEN_NOT_BOUND_IN_MODULE'
  // 已绑定切片（与「未装配」组互斥）
  | 'BOUND_SLICE_REGISTRATION_CONFLICT'
  | 'BOUND_SLICE_MODULE_DIRECTORY_MISMATCH'
  | 'BOUND_SLICE_MODULE_FILE_MISMATCH'
  | 'BOUND_SLICE_NOT_REFERENCED_BY_MODULE'
  | 'BOUND_SLICE_TOKEN_NOT_BOUND_IN_MODULE'
  // 驱动导入层收敛
  | 'DRIVER_IMPORT_OUTSIDE_DRIVER_LAYER'
  | 'DRIVER_IMPORT_IN_ADAPTER'
  | 'AUTHORIZED_DRIVER_NOT_DECLARED'
  // 端口覆盖
  | 'PERSISTENCE_PORT_WITHOUT_ADAPTER'
  | 'PERSISTENCE_PORT_ADAPTER_DUPLICATED'
  | 'ADAPTER_EXEMPTION_CONFLICT'
  | 'STALE_ADAPTER_EXEMPTION'
  | 'ADAPTER_EXEMPTION_WITHOUT_REASON'
  // 生产守卫
  | 'PRODUCTION_GUARD_NOT_REJECTING'
  | 'EXECUTOR_GUARD_NOT_REJECTING'
  // 驱动 / ORM 依赖
  | 'FORBIDDEN_DRIVER_DEPENDENCY'
  | 'FORBIDDEN_DRIVER_IMPORT'
  | 'FORBIDDEN_DRIVER_INSTALLED';

export interface PostgresAdapterBoundaryViolation {
  readonly code: PostgresAdapterBoundaryCode;
  /** 违规主体：adapter id / 模块名 / 端口令牌名 / 依赖类别 */
  readonly subject: string;
  /** 只含标识与布尔/枚举能力值，不含机密与字段取值 */
  readonly detail: string;
}

export interface PostgresAdapterBoundaryReport {
  readonly ok: boolean;
  readonly violations: readonly PostgresAdapterBoundaryViolation[];
  readonly checkedAdapters: readonly string[];
  readonly exemptedModules: readonly string[];
}

/** 边界判定失败：携带全部违规项，供门禁与启动日志使用 */
export class PostgresAdapterBoundaryError extends Error {
  readonly violations: readonly PostgresAdapterBoundaryViolation[];

  constructor(violations: readonly PostgresAdapterBoundaryViolation[]) {
    const summary = violations.map((item) => `${item.subject}[${item.code}]`).join(', ');
    super(`未装配 Postgres adapter 边界判定失败（${violations.length} 项）: ${summary}`);
    this.name = 'PostgresAdapterBoundaryError';
    this.violations = violations;
  }
}

/** 能力自检探针的实际结果（由 spec 调用 adapter 的 `assertExport` 得到） */
export interface PostgresCapabilityProbeResult {
  readonly variant: string;
  readonly threw: boolean;
}

/**
 * 单个 adapter 的**事实**（由 spec 采集，判定器只判事实，不自己读文件/不自己 import）。
 * `capabilities` 是运行时真实导出值（未导出时为 undefined）。
 */
export interface PostgresAdapterFacts {
  readonly descriptor: PostgresAdapterDescriptor;
  /** 磁盘上是否存在该 adapter 文件 */
  readonly fileExists: boolean;
  /** adapter 源文本（文件不存在时为空串） */
  readonly source: string;
  /** 对应业务模块文件源文本 */
  readonly moduleSource: string;
  /** adapter 运行时导出名集合 */
  readonly runtimeExports: readonly string[];
  /** 运行时读到的能力声明（未导出 / 非对象时 undefined） */
  readonly capabilities?: unknown;
  /** adapter 之外（已排除自身、自身 spec 与边界文件）引用了 adapter 模块的文件清单 */
  readonly externalReferences: readonly string[];
  /** 能力自检探针结果 */
  readonly capabilityProbes: readonly PostgresCapabilityProbeResult[];
  /** 生产环境边界守卫对真实能力声明的违规规则序列 */
  readonly productionViolationRules: readonly string[];
  /** `assertProductionReadyExecutor` 在生产环境对真实能力声明是否拒绝 */
  readonly executorGuardRejected: boolean;
}

/** 模块 → 该模块上的持久化端口令牌（由 `PERSISTENCE_BINDINGS` 派生，避免再手工维护一份） */
export interface PersistencePortModule {
  readonly module: string;
  readonly tokens: readonly string[];
}

export interface PostgresAdapterBoundaryInput {
  /** 登记表（生产值即 `POSTGRES_ADAPTER_REGISTRY`；作为输入便于穷举「重复 / 错误登记」） */
  readonly registry: readonly PostgresAdapterDescriptor[];
  /** 已绑定切片登记表（生产值即 `POSTGRES_BOUND_SLICE_REGISTRY`） */
  readonly boundSlices?: readonly PostgresBoundSliceDescriptor[];
  /** 豁免表（生产值即 `POSTGRES_ADAPTER_EXEMPTIONS`） */
  readonly exemptions: readonly PostgresAdapterExemption[];
  /** 磁盘自动枚举到的 adapter 文件（相对 `services/api/src`，posix） */
  readonly discoveredAdapterFiles: readonly string[];
  readonly adapters: readonly PostgresAdapterFacts[];
  /** 已登记持久化端口的模块（含 `db`；`db` 不属于业务模块，跳过 adapter 覆盖判定） */
  readonly persistencePortModules: readonly PersistencePortModule[];
  /** 声明依赖名（services/api 与仓库根 package.json） */
  readonly declaredDependencyNames: readonly string[];
  /** `services/api/src` 下所有 import/require 的 specifier */
  readonly importedSpecifiers: readonly string[];
  /** `services/api/src` 下**逐文件**的 import specifier（判定「驱动只允许出现在驱动层」） */
  readonly importedSpecifiersByFile?: readonly {
    readonly file: string;
    readonly specifier: string;
  }[];
  /** pnpm 存储目录里的已安装包名（原始目录名，判定前规范化） */
  readonly installedPackageDirectories: readonly string[];
  /** 驱动导入层目录（仓库相对 `services/api/src`，posix）；省略时用默认值 */
  readonly driverLayerDirectory?: string;
}

/**
 * 「adapter 转发」判定：adapter 源文件不得 import / re-export 另一个 `*.postgres-repository`
 * 文件来补齐枚举。只认 import 形状（`from '...'` / `require(...)` / `import(...)`），
 * 避免把 JSDoc 里提到的文件名（例如「与 `groups.postgres-repository.ts` 一致」）误判成转发。
 */
export const POSTGRES_ADAPTER_REDIRECT_PATTERN =
  /(?:from|require\(|import\()\s*['"][^'"]*\.postgres-repository(?:\.ts)?['"]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Nest 装配痕迹：adapter 一旦带上这些，就不再是「未装配的纯实现」 */
const NEST_ARTIFACT_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'import-from-@nestjs/common', pattern: /from\s+['"]@nestjs\/common['"]/u },
  { label: 'import-from-@nestjs/core', pattern: /from\s+['"]@nestjs\/core['"]/u },
  { label: '@Injectable', pattern: /@Injectable\s*\(/u },
  { label: '@Module', pattern: /@Module\s*\(/u },
  { label: '@Inject', pattern: /@Inject\s*\(/u },
  { label: '@Controller', pattern: /@Controller\s*\(/u },
];

function violation(
  code: PostgresAdapterBoundaryCode,
  subject: string,
  detail: string,
): PostgresAdapterBoundaryViolation {
  return { code, subject, detail };
}

/**
 * 纯函数判定：把登记表、磁盘枚举、运行时事实与依赖事实一起判成违规清单。
 * 不读环境变量、不读文件、不建连接、不写日志，便于在测试里穷举「缺失 / 重复 / 错误登记」。
 */
export function evaluatePostgresAdapterBoundary(
  input: PostgresAdapterBoundaryInput,
): PostgresAdapterBoundaryReport {
  const violations: PostgresAdapterBoundaryViolation[] = [];
  const registry = input.registry;
  const boundSliceTable = input.boundSlices ?? [];
  const exemptionTable = input.exemptions;
  const driverLayerDirectory = input.driverLayerDirectory ?? 'db/postgres/';

  // ---- 1. 登记表自洽性：命名、目录归属、id/文件/类/导出名唯一；两组互斥 ----
  const seenIds = new Map<string, string>();
  const seenFiles = new Map<string, string>();
  const seenClasses = new Map<string, string>();
  const seenCapabilityExports = new Map<string, string>();
  const allDescriptors: readonly (PostgresAdapterDescriptor | PostgresBoundSliceDescriptor)[] = [
    ...registry,
    ...boundSliceTable,
  ];
  for (const descriptor of allDescriptors) {
    const isBound = boundSliceTable.some((item) => item.id === descriptor.id);
    if (!descriptor.file.endsWith(POSTGRES_ADAPTER_FILE_SUFFIX)) {
      violations.push(
        violation(
          'ADAPTER_FILE_NAME_MISMATCH',
          descriptor.id,
          `登记文件 ${descriptor.file} 不以 ${POSTGRES_ADAPTER_FILE_SUFFIX} 结尾：自动枚举口径不一致`,
        ),
      );
    }
    const expectedPrefix = `modules/${descriptor.module}/`;
    if (!descriptor.file.startsWith(expectedPrefix)) {
      violations.push(
        violation(
          isBound ? 'BOUND_SLICE_MODULE_DIRECTORY_MISMATCH' : 'ADAPTER_MODULE_DIRECTORY_MISMATCH',
          descriptor.id,
          `登记模块 ${descriptor.module} 与文件目录不一致（期望前缀 ${expectedPrefix}）：adapter 必须与被替换的端口同模块`,
        ),
      );
    }
    const expectedModuleFile = `${expectedPrefix}${descriptor.module}.module.ts`;
    if (descriptor.moduleFile !== expectedModuleFile) {
      violations.push(
        violation(
          isBound ? 'BOUND_SLICE_MODULE_FILE_MISMATCH' : 'ADAPTER_MODULE_FILE_MISMATCH',
          descriptor.id,
          `登记模块文件 ${descriptor.moduleFile} 不是 ${expectedModuleFile}：无法据此判定业务 Module 的绑定事实`,
        ),
      );
    }
    for (const [label, map, value] of [
      ['id', seenIds, descriptor.id],
      ['file', seenFiles, descriptor.file],
      ['repositoryClass', seenClasses, descriptor.repositoryClass],
      ['capabilitiesExport', seenCapabilityExports, descriptor.capabilitiesExport],
    ] as const) {
      const previous = map.get(value);
      if (previous !== undefined) {
        violations.push(
          violation(
            'DUPLICATE_ADAPTER_REGISTRATION',
            descriptor.id,
            `登记 ${label} 重复（${value}）：已由 ${previous} 占用，重复登记会让能力判定张冠李戴`,
          ),
        );
        continue;
      }
      map.set(value, descriptor.id);
    }
  }
  for (const descriptor of boundSliceTable) {
    if (registry.some((item) => item.id === descriptor.id || item.file === descriptor.file)) {
      violations.push(
        violation(
          'BOUND_SLICE_REGISTRATION_CONFLICT',
          descriptor.id,
          '同一个 adapter 同时出现在「未装配」与「已绑定」两张登记表里：两组规则互斥，必须只留一处',
        ),
      );
    }
  }

  // ---- 2. 登记表 ↔ 磁盘：双向比对（缺失登记与陈旧登记都失败） ----
  const registeredFiles = new Set(allDescriptors.map((item) => item.file));
  const discoveredFiles = new Set(input.discoveredAdapterFiles);
  for (const file of discoveredFiles) {
    if (!registeredFiles.has(file)) {
      violations.push(
        violation(
          'ADAPTER_FILE_NOT_REGISTERED',
          file,
          '磁盘上存在未被登记的 *.postgres-repository.ts：新 adapter 必须在 POSTGRES_ADAPTER_REGISTRY 或 POSTGRES_BOUND_SLICE_REGISTRY 登记后才能进入门禁',
        ),
      );
    }
  }
  for (const file of registeredFiles) {
    if (!discoveredFiles.has(file)) {
      violations.push(
        violation(
          'REGISTERED_FILE_MISSING',
          file,
          '登记表指向的 adapter 文件在磁盘上不存在：登记已陈旧（文件被改名 / 删除 / 枚举口径变化）',
        ),
      );
    }
  }

  // ---- 3. 逐 adapter 事实判定（未装配组 / 已绑定组各自一套规则） ----
  const factsByFile = new Map(input.adapters.map((facts) => [facts.descriptor.file, facts]));
  const registeredIds = new Set(allDescriptors.map((item) => item.id));
  for (const descriptor of allDescriptors) {
    const isBound = boundSliceTable.some((item) => item.id === descriptor.id);
    const facts = factsByFile.get(descriptor.file);
    if (facts === undefined) {
      violations.push(
        violation(
          'ADAPTER_FACTS_MISSING',
          descriptor.id,
          '缺少该 adapter 的运行时事实（未采集导出 / 能力 / 装配 / 守卫结果）：门禁不得在信息不全时放行',
        ),
      );
      continue;
    }
    if (facts.descriptor.id !== descriptor.id) {
      violations.push(
        violation(
          'ADAPTER_FACTS_UNKNOWN',
          descriptor.id,
          `采集到的事实属于其它登记项（id=${facts.descriptor.id}）：事实与登记表必须一一对应`,
        ),
      );
    }

    const runtimeExports = new Set(facts.runtimeExports);
    for (const [label, value] of [
      ['capabilitiesExport', descriptor.capabilitiesExport],
      ['assertExport', descriptor.assertExport],
      ['repositoryClass', descriptor.repositoryClass],
    ] as const) {
      if (!runtimeExports.has(value)) {
        violations.push(
          violation(
            'ADAPTER_DECLARATION_MISSING',
            descriptor.id,
            `adapter 未导出登记的 ${label}（${value}）：登记名与实际导出不一致，能力判定会失去依据`,
          ),
        );
      }
    }

    if (POSTGRES_ADAPTER_REDIRECT_PATTERN.test(facts.source)) {
      violations.push(
        violation(
          'ADAPTER_FILE_REDIRECTED',
          descriptor.id,
          'adapter 源文件 import / 转发了另一个 *.postgres-repository：不得用转发 / 再导出来「补齐」枚举，adapter 必须自持实现',
        ),
      );
    }

    // 能力三元组：backend 必须是 postgres、持久必须为真、生产可用必须为假
    const capabilities = facts.capabilities;
    if (!isRecord(capabilities)) {
      violations.push(
        violation(
          'CAPABILITY_MISSING',
          descriptor.id,
          `adapter 未导出可读的能力声明对象（backend/persistent/productionReady）：${descriptor.capabilitiesExport} 必须是对象`,
        ),
      );
    } else {
      const backend = capabilities['backend'];
      if (backend !== POSTGRES_ADAPTER_BACKEND) {
        violations.push(
          violation(
            'CAPABILITY_BACKEND_MISMATCH',
            descriptor.id,
            `能力声明 backend=${String(backend)}，必须是 ${POSTGRES_ADAPTER_BACKEND}`,
          ),
        );
      }
      if (capabilities['persistent'] !== true) {
        violations.push(
          violation(
            'CAPABILITY_NOT_PERSISTENT',
            descriptor.id,
            `能力声明 persistent=${String(capabilities['persistent'])}，必须是 true：Postgres adapter 必须如实声明跨重启保留`,
          ),
        );
      }
      if (capabilities['productionReady'] !== false) {
        violations.push(
          violation(
            'CAPABILITY_PRODUCTION_READY_CLAIMED',
            descriptor.id,
            `能力声明 productionReady=${String(capabilities['productionReady'])}，必须是 false：未完成驱动引入与集成验证前不得声称生产可用`,
          ),
        );
      }
    }

    // 能力自检探针：真实声明放行、三类错误登记必须抛错
    const probes = new Map(facts.capabilityProbes.map((probe) => [probe.variant, probe.threw]));
    for (const expectation of POSTGRES_CAPABILITY_PROBE_VARIANTS) {
      const threw = probes.get(expectation.variant);
      if (threw === undefined) {
        violations.push(
          violation(
            'CAPABILITY_PROBE_MISSING',
            descriptor.id,
            `缺少能力自检探针 ${expectation.variant}：未验证「${expectation.description}」`,
          ),
        );
        continue;
      }
      if (expectation.mustThrow && !threw) {
        violations.push(
          violation(
            'CAPABILITY_ASSERT_NOT_THROWING',
            descriptor.id,
            `能力自检探针 ${expectation.variant} 未抛错：${expectation.description}`,
          ),
        );
      }
      if (!expectation.mustThrow && threw) {
        violations.push(
          violation(
            'CAPABILITY_ASSERT_REJECTS_DECLARED',
            descriptor.id,
            `能力自检拒绝了自己的真实声明（探针 ${expectation.variant}）：${expectation.description}`,
          ),
        );
      }
    }

    // 装配边界：
    // - 未装配 adapter：不得带 Nest 痕迹、模块不得引用、其它文件不得引用；
    // - 已绑定切片：模块**必须**引用绑定点（令牌 + 工厂导出），但 adapter 仍不得带 Nest 痕迹。
    for (const { label, pattern } of NEST_ARTIFACT_PATTERNS) {
      if (pattern.test(facts.source)) {
        violations.push(
          violation(
            'NEST_DECORATOR_IN_ADAPTER',
            descriptor.id,
            `adapter 源文件出现 Nest 装配痕迹（${label}）：实现不得自带依赖注入元数据，装配只允许发生在 Module 的工厂里`,
          ),
        );
      }
    }
    if (isBound) {
      const bound = descriptor as PostgresBoundSliceDescriptor;
      if (!facts.moduleSource.includes(bound.factoryExport)) {
        violations.push(
          violation(
            'BOUND_SLICE_NOT_REFERENCED_BY_MODULE',
            descriptor.id,
            `${descriptor.moduleFile} 未引用工厂导出 ${bound.factoryExport}：登记为「已绑定」但 Module 里找不到绑定，绑定事实不成立`,
          ),
        );
      }
      if (!facts.moduleSource.includes(bound.token)) {
        violations.push(
          violation(
            'BOUND_SLICE_TOKEN_NOT_BOUND_IN_MODULE',
            descriptor.id,
            `${descriptor.moduleFile} 里找不到绑定的端口令牌 ${bound.token}：换绑必须与登记表同时更新`,
          ),
        );
      }
    } else {
      const adapterBasename = descriptor.file.slice(descriptor.file.lastIndexOf('/') + 1);
      const adapterModuleName = adapterBasename.replace(/\.ts$/u, '');
      for (const [label, needle] of [
        ['adapter 模块名', adapterModuleName],
        ['仓储类名', descriptor.repositoryClass],
        ['能力导出名', descriptor.capabilitiesExport],
        ['自检导出名', descriptor.assertExport],
      ] as const) {
        if (facts.moduleSource.includes(needle)) {
          violations.push(
            violation(
              'MODULE_PROVIDER_BINDING',
              descriptor.id,
              `${descriptor.moduleFile} 出现 ${label}（${needle}）：业务 Module 仍必须绑定内存基线，换绑属于「启用数据库」那一步`,
            ),
          );
        }
      }
      if (facts.externalReferences.length > 0) {
        violations.push(
          violation(
            'ADAPTER_REFERENCED_ELSEWHERE',
            descriptor.id,
            `adapter 被边界之外的文件引用：${facts.externalReferences.join(', ')}`,
          ),
        );
      }
      for (const token of persistenceTokensOf(input, descriptor.module)) {
        if (!facts.moduleSource.includes(token)) {
          violations.push(
            violation(
              'PENDING_TOKEN_NOT_BOUND_IN_MODULE',
              descriptor.id,
              `${descriptor.moduleFile} 里找不到端口令牌 ${token}：登记模块文件与实际装配不符`,
            ),
          );
        }
      }
    }

    // 驱动导入收敛：adapter（无论是否已绑定）都不得直接 import 已授权的 `pg` 驱动。
    // 驱动只允许出现在 `db/postgres/` 驱动层，adapter 一律经 `SqlExecutor` 端口。
    for (const specifier of specifiersOfFile(input, descriptor.file)) {
      if (isAuthorizedDriverSpecifier(specifier)) {
        violations.push(
          violation(
            'DRIVER_IMPORT_IN_ADAPTER',
            descriptor.id,
            `adapter 直接 import 了驱动 ${specifier}：业务实现必须依赖驱动无关的 SqlExecutor 端口，驱动只允许出现在 ${driverLayerDirectory}`,
          ),
        );
      }
    }

    // 生产守卫：真实能力声明在生产环境必须被判违规，且执行器断言必须拒绝
    const guardRules = [...facts.productionViolationRules];
    if (guardRules.length !== 1 || guardRules[0] !== 'BACKEND_NOT_PRODUCTION_READY_IN_PRODUCTION') {
      violations.push(
        violation(
          'PRODUCTION_GUARD_NOT_REJECTING',
          descriptor.id,
          `生产环境持久化边界守卫对未验证 adapter 的判定是 [${guardRules.join(', ')}]，期望恰好 [BACKEND_NOT_PRODUCTION_READY_IN_PRODUCTION]`,
        ),
      );
    }
    if (!facts.executorGuardRejected) {
      violations.push(
        violation(
          'EXECUTOR_GUARD_NOT_REJECTING',
          descriptor.id,
          '生产环境下 assertProductionReadyExecutor 未拒绝该未验证执行器：生产可用性断言失效',
        ),
      );
    }
  }

  for (const facts of input.adapters) {
    if (!registeredIds.has(facts.descriptor.id)) {
      violations.push(
        violation(
          'ADAPTER_FACTS_UNKNOWN',
          facts.descriptor.id,
          '采集到登记表之外的事实：事实与登记表必须双向一致',
        ),
      );
    }
  }

  // ---- 4. 端口覆盖：有持久端口的业务模块必须有且只有一个 adapter，或一条有理由的豁免 ----
  const businessModules = input.persistencePortModules.filter((item) => item.module !== 'db');
  for (const business of businessModules) {
    const adapters = registry.filter((item) => item.module === business.module);
    const bound = boundSliceTable.filter((item) => item.module === business.module);
    const exemptions = exemptionTable.filter((item) => item.module === business.module);
    if (adapters.length === 0 && bound.length === 0 && exemptions.length === 0) {
      violations.push(
        violation(
          'PERSISTENCE_PORT_WITHOUT_ADAPTER',
          business.module,
          `模块 ${business.module} 有持久化端口（${business.tokens.join(', ')}）但既没有登记 adapter 也没有豁免理由：必须在 POSTGRES_ADAPTER_REGISTRY / POSTGRES_BOUND_SLICE_REGISTRY / POSTGRES_ADAPTER_EXEMPTIONS 登记`,
        ),
      );
    }
    if (adapters.length + bound.length > 1) {
      violations.push(
        violation(
          'PERSISTENCE_PORT_ADAPTER_DUPLICATED',
          business.module,
          `模块 ${business.module} 登记了多个 adapter（${[...adapters, ...bound].map((item) => item.id).join(', ')}）：一个模块只能有一个持久化适配切片，重复登记会让能力判定重复计数`,
        ),
      );
    }
    if ((adapters.length > 0 || bound.length > 0) && exemptions.length > 0) {
      violations.push(
        violation(
          'ADAPTER_EXEMPTION_CONFLICT',
          business.module,
          `模块 ${business.module} 同时有 adapter 与豁免理由：豁免必须删除，否则「未落地」与「已落地」互相矛盾`,
        ),
      );
    }
  }
  for (const descriptor of allDescriptors) {
    if (!businessModules.some((item) => item.module === descriptor.module)) {
      violations.push(
        violation(
          'ADAPTER_MODULE_WITHOUT_PERSISTENCE_PORT',
          descriptor.id,
          `登记模块 ${descriptor.module} 在持久化端口登记表里不存在：adapter 不得挂在没有持久化职责的模块上`,
        ),
      );
    }
  }
  for (const exemption of exemptionTable) {
    if (exemption.reason.trim().length < 10) {
      violations.push(
        violation(
          'ADAPTER_EXEMPTION_WITHOUT_REASON',
          exemption.module,
          `豁免 ${exemption.token} 缺少可核对的理由（不得只写声明）`,
        ),
      );
    }
    const business = businessModules.find((item) => item.module === exemption.module);
    if (business === undefined || !business.tokens.includes(exemption.token)) {
      violations.push(
        violation(
          'STALE_ADAPTER_EXEMPTION',
          exemption.module,
          `豁免令牌 ${exemption.token} 不在模块 ${exemption.module} 的持久化端口上：豁免已陈旧，必须删除`,
        ),
      );
    }
  }

  // ---- 5. 驱动依赖：被禁的不得声明 / import / 已安装；已授权的只允许出现在驱动层 ----
  for (const name of input.declaredDependencyNames) {
    if (isForbiddenDriverPackageName(name)) {
      violations.push(
        violation(
          'FORBIDDEN_DRIVER_DEPENDENCY',
          name,
          'package.json 声明了被禁的 PostgreSQL 驱动 / ORM 依赖：除官方 pg 驱动之外的驱动与 ORM 仍需单独评估',
        ),
      );
    }
  }
  for (const specifier of input.importedSpecifiers) {
    if (isForbiddenDriverSpecifier(specifier)) {
      violations.push(
        violation(
          'FORBIDDEN_DRIVER_IMPORT',
          specifier,
          '源码 import 了被禁的 PostgreSQL 驱动 / ORM：adapter 只允许依赖驱动无关的 SqlExecutor 端口',
        ),
      );
    }
  }

  // 已授权驱动的**导入层收敛**：`pg` 只允许出现在驱动层目录（`db/postgres/`）。
  const driverImports = (input.importedSpecifiersByFile ?? []).filter((item) =>
    isAuthorizedDriverSpecifier(item.specifier),
  );
  for (const item of driverImports) {
    if (!item.file.startsWith(driverLayerDirectory)) {
      violations.push(
        violation(
          'DRIVER_IMPORT_OUTSIDE_DRIVER_LAYER',
          item.file,
          `已授权的 PostgreSQL 驱动 ${item.specifier} 出现在驱动层之外（允许目录：${driverLayerDirectory}）：换驱动只应改动驱动层`,
        ),
      );
    }
  }
  // 反过来：真有人 import 驱动时，必须在 package.json 里**显式声明**（不能只靠传递依赖装上）
  if (driverImports.length > 0) {
    for (const required of AUTHORIZED_POSTGRES_DRIVER_PACKAGES) {
      if (!input.declaredDependencyNames.includes(required)) {
        violations.push(
          violation(
            'AUTHORIZED_DRIVER_NOT_DECLARED',
            required,
            `源码 import 了 ${required}，但 package.json 未显式声明该依赖：禁止依赖「被传递依赖悄悄装上」的驱动`,
          ),
        );
      }
    }
  }

  for (const directory of input.installedPackageDirectories) {
    const name = normalizeInstalledPackageName(directory);
    if (isForbiddenDriverPackageName(name)) {
      violations.push(
        violation(
          'FORBIDDEN_DRIVER_INSTALLED',
          name,
          'node_modules 里已安装被禁的 PostgreSQL 驱动 / ORM：只判声明会漏掉被传递依赖装进来的驱动',
        ),
      );
    }
  }

  const checkedAdapters = [...registry, ...boundSliceTable].map((item) => item.id);
  return {
    ok: violations.length === 0,
    violations,
    checkedAdapters,
    exemptedModules: exemptionTable.map((item) => item.module),
  };
}

function persistenceTokensOf(
  input: PostgresAdapterBoundaryInput,
  module: string,
): readonly string[] {
  return input.persistencePortModules.find((item) => item.module === module)?.tokens ?? [];
}

/** 某个源文件里出现的 import specifier（未提供逐文件事实时返回空数组，由调用方另行判定） */
function specifiersOfFile(input: PostgresAdapterBoundaryInput, file: string): readonly string[] {
  return (input.importedSpecifiersByFile ?? [])
    .filter((item) => item.file === file)
    .map((item) => item.specifier);
}

/**
 * 断言边界成立，失败即抛 `PostgresAdapterBoundaryError`（fail-closed）。
 * 当前调用点是专项门禁 spec；后续接入启动期闸门时复用同一判定器，不再各写一份。
 */
export function assertPostgresAdapterBoundary(
  input: PostgresAdapterBoundaryInput,
): PostgresAdapterBoundaryReport {
  const report = evaluatePostgresAdapterBoundary(input);
  if (!report.ok) {
    throw new PostgresAdapterBoundaryError(report.violations);
  }
  return report;
}

/** 便捷取用：能力声明的可读形（只用于错误文案与断言消息） */
export function describeAdapterCapabilities(capabilities: unknown): string {
  if (!isRecord(capabilities)) {
    return '(未声明)';
  }
  const typed = capabilities as Partial<PersistenceCapabilities>;
  return `backend=${String(typed.backend)}, persistent=${String(typed.persistent)}, productionReady=${String(typed.productionReady)}`;
}
