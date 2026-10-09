/**
 * 跨 adapter 持久化边界登记表与判定器（**未装配 Postgres adapter 的唯一事实来源**）。
 *
 * ## 为什么需要这一层
 * `modules/**\/*.postgres-repository.ts` 的十一个 PostgreSQL adapter 目前全部是「已写好但
 * **未装配**」的实现：它们不参与依赖注入、不进入任何业务 Module 的 provider、不引入任何驱动
 * 依赖，能力声明固定为 `backend = postgres` / `persistent = true` / `productionReady = false`。
 * 每个 adapter 自己的 spec 只能证明「本 adapter 没被装配」，**无法回答跨 adapter 的问题**：
 * 新增了第十二个 adapter 但忘了登记、两个 adapter 争抢同一个模块、登记表指向了不存在的文件、
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
 * 十一个未装配 Postgres adapter 的登记表（按模块名字母序，便于人工比对）。
 *
 * 新增 adapter 时**必须同时**在此登记：门禁会拿磁盘枚举结果与这张表做双向比对，
 * 只加文件不登记（`ADAPTER_FILE_NOT_REGISTERED`）与只登记不加文件（`REGISTERED_FILE_MISSING`）
 * 都会失败。
 */
export const POSTGRES_ADAPTER_REGISTRY: readonly PostgresAdapterDescriptor[] = [
  {
    id: 'achievements',
    module: 'achievements',
    file: 'modules/achievements/achievements.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_ACHIEVEMENT_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresAchievementRepositoryCapabilities',
    repositoryClass: 'PostgresAchievementRepository',
    moduleFile: 'modules/achievements/achievements.module.ts',
  },
  {
    id: 'audit',
    module: 'audit',
    file: 'modules/audit/audit.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_AUDIT_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresAuditRepositoryCapabilities',
    repositoryClass: 'PostgresAuditRepository',
    moduleFile: 'modules/audit/audit.module.ts',
  },
  {
    id: 'compliance',
    module: 'compliance',
    file: 'modules/compliance/compliance.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresComplianceRepositoryCapabilities',
    repositoryClass: 'PostgresComplianceRepository',
    moduleFile: 'modules/compliance/compliance.module.ts',
  },
  {
    id: 'education',
    module: 'education',
    file: 'modules/education/education-records.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresEducationRecordRepositoryCapabilities',
    repositoryClass: 'PostgresEducationRecordRepository',
    moduleFile: 'modules/education/education.module.ts',
  },
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
    id: 'groups',
    module: 'groups',
    file: 'modules/groups/groups.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_GROUP_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresGroupRepositoryCapabilities',
    repositoryClass: 'PostgresGroupRepository',
    moduleFile: 'modules/groups/groups.module.ts',
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
  {
    id: 'memberships',
    module: 'memberships',
    file: 'modules/memberships/applications.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_APPLICATION_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresApplicationRepositoryCapabilities',
    repositoryClass: 'PostgresApplicationRepository',
    moduleFile: 'modules/memberships/memberships.module.ts',
  },
  {
    id: 'notifications',
    module: 'notifications',
    file: 'modules/notifications/notifications.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_NOTIFICATION_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresNotificationRepositoryCapabilities',
    repositoryClass: 'PostgresNotificationRepository',
    moduleFile: 'modules/notifications/notifications.module.ts',
  },
  {
    id: 'profiles',
    module: 'profiles',
    file: 'modules/profiles/student-profile.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresStudentProfileRepositoryCapabilities',
    repositoryClass: 'PostgresStudentProfileRepository',
    moduleFile: 'modules/profiles/profiles.module.ts',
  },
  {
    id: 'statistics',
    module: 'statistics',
    file: 'modules/statistics/statistics.postgres-repository.ts',
    capabilitiesExport: 'POSTGRES_STATISTICS_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresStatisticsRepositoryCapabilities',
    repositoryClass: 'PostgresStatisticsRepository',
    moduleFile: 'modules/statistics/statistics.module.ts',
  },
];

/**
 * 有持久化端口但**尚未**落地 Postgres adapter 的模块（必须给出理由，不允许悄悄缺席）。
 * 登记项与磁盘状态无关：门禁只要求「没 adapter 就必须有理由」，有理由也会被复核是否陈旧。
 */
export interface PostgresAdapterExemption {
  readonly module: string;
  /** 该模块上仍然只有内存基线的持久化端口（DI 令牌名） */
  readonly token: string;
  readonly reason: string;
}

export const POSTGRES_ADAPTER_EXEMPTIONS: readonly PostgresAdapterExemption[] = [
  {
    module: 'auth',
    token: 'SESSION_STORE',
    reason:
      '会话存储 adapter 未落地：会话后端选型（数据库会话表 vs 独立会话存储）与驱动引入属于「启用数据库」那一步，本切片不预判；因此 auth 模块暂时只在登记表里出现端口、不出现 adapter',
  },
];

/**
 * 禁止出现在依赖 / import / 已安装包里的 PostgreSQL 驱动与 ORM / 查询构建器。
 *
 * 为什么连「已安装」也要判：只判 package.json 会漏掉「被传递依赖装进来、但没人声明」的驱动
 * ——那正是「运行时可以悄悄建连接」的前提。`pg` 家族另用前缀规则（`pg-pool` / `pg-types` /
 * `pg-native` …）覆盖，避免每出一个子包就漏一次。
 */
export const FORBIDDEN_POSTGRES_DRIVER_PACKAGES: readonly string[] = [
  // node-postgres 家族
  'pg',
  'pg-pool',
  'pg-native',
  'pg-types',
  'pgpass',
  'pg-connection-string',
  '@types/pg',
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

/** pg 家族前缀规则（`pg-*` / `pg/子路径`）；单独成规则便于注释与测试固定 */
const POSTGRES_DRIVER_FAMILY_PATTERN = /^pg(?:-|\/)/u;

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
  if (POSTGRES_DRIVER_FAMILY_PATTERN.test(specifier)) {
    return true;
  }
  return forbidden.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/** 判定一个已安装包名（已规范化）是否被禁 */
export function isForbiddenDriverPackageName(
  packageName: string,
  forbidden: readonly string[] = FORBIDDEN_POSTGRES_DRIVER_PACKAGES,
): boolean {
  if (POSTGRES_DRIVER_FAMILY_PATTERN.test(packageName)) {
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
  /** pnpm 存储目录里的已安装包名（原始目录名，判定前规范化） */
  readonly installedPackageDirectories: readonly string[];
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
  const exemptionTable = input.exemptions;

  // ---- 1. 登记表自洽性：命名、目录归属、id/文件/类/导出名唯一 ----
  const seenIds = new Map<string, string>();
  const seenFiles = new Map<string, string>();
  const seenClasses = new Map<string, string>();
  const seenCapabilityExports = new Map<string, string>();
  for (const descriptor of registry) {
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
          'ADAPTER_MODULE_DIRECTORY_MISMATCH',
          descriptor.id,
          `登记模块 ${descriptor.module} 与文件目录不一致（期望前缀 ${expectedPrefix}）：adapter 必须与被替换的端口同模块`,
        ),
      );
    }
    const expectedModuleFile = `${expectedPrefix}${descriptor.module}.module.ts`;
    if (descriptor.moduleFile !== expectedModuleFile) {
      violations.push(
        violation(
          'ADAPTER_MODULE_FILE_MISMATCH',
          descriptor.id,
          `登记模块文件 ${descriptor.moduleFile} 不是 ${expectedModuleFile}：无法据此判定「业务 Module 未绑定该 adapter」`,
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

  // ---- 2. 登记表 ↔ 磁盘：双向比对（缺失登记与陈旧登记都失败） ----
  const registeredFiles = new Set(registry.map((item) => item.file));
  const discoveredFiles = new Set(input.discoveredAdapterFiles);
  for (const file of discoveredFiles) {
    if (!registeredFiles.has(file)) {
      violations.push(
        violation(
          'ADAPTER_FILE_NOT_REGISTERED',
          file,
          '磁盘上存在未被登记的 *.postgres-repository.ts：新 adapter 必须在 POSTGRES_ADAPTER_REGISTRY 登记后才能进入门禁',
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

  // ---- 3. 逐 adapter 事实判定 ----
  const factsByFile = new Map(input.adapters.map((facts) => [facts.descriptor.file, facts]));
  const registeredIds = new Set(registry.map((item) => item.id));
  for (const descriptor of registry) {
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

    // 装配边界：adapter 不得带 Nest 痕迹，模块不得引用 adapter，其它文件不得引用 adapter
    for (const { label, pattern } of NEST_ARTIFACT_PATTERNS) {
      if (pattern.test(facts.source)) {
        violations.push(
          violation(
            'NEST_DECORATOR_IN_ADAPTER',
            descriptor.id,
            `adapter 源文件出现 Nest 装配痕迹（${label}）：未装配实现不得参与依赖注入`,
          ),
        );
      }
    }
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
    const exemptions = exemptionTable.filter((item) => item.module === business.module);
    if (adapters.length === 0 && exemptions.length === 0) {
      violations.push(
        violation(
          'PERSISTENCE_PORT_WITHOUT_ADAPTER',
          business.module,
          `模块 ${business.module} 有持久化端口（${business.tokens.join(', ')}）但既没有登记 adapter 也没有豁免理由：必须在 POSTGRES_ADAPTER_REGISTRY 或 POSTGRES_ADAPTER_EXEMPTIONS 登记`,
        ),
      );
    }
    if (adapters.length > 1) {
      violations.push(
        violation(
          'PERSISTENCE_PORT_ADAPTER_DUPLICATED',
          business.module,
          `模块 ${business.module} 登记了多个 adapter（${adapters.map((item) => item.id).join(', ')}）：一个模块只能有一个持久化适配切片，重复登记会让能力判定重复计数`,
        ),
      );
    }
    if (adapters.length > 0 && exemptions.length > 0) {
      violations.push(
        violation(
          'ADAPTER_EXEMPTION_CONFLICT',
          business.module,
          `模块 ${business.module} 同时有 adapter 与豁免理由：豁免必须删除，否则「未落地」与「已落地」互相矛盾`,
        ),
      );
    }
  }
  for (const descriptor of registry) {
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

  // ---- 5. 驱动 / ORM 依赖：声明、import、已安装三者都不得出现 ----
  for (const name of input.declaredDependencyNames) {
    if (isForbiddenDriverPackageName(name)) {
      violations.push(
        violation(
          'FORBIDDEN_DRIVER_DEPENDENCY',
          name,
          'package.json 声明了被禁的 PostgreSQL 驱动 / ORM 依赖：驱动引入属于「启用数据库」那一步，必须与能力声明、集成验证一起发生',
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

  const checkedAdapters = registry.map((item) => item.id);
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
