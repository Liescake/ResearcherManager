import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  Optional,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { resolveDatabaseConfig, type DatabaseConfigResolution } from './config/database-config';
import { bindingTokenName, PERSISTENCE_BINDINGS } from './persistence-bindings';
import {
  DEFAULT_DEPENDENCY_READINESS_REGISTRY,
  DependencyReadinessError,
  describeDependencyReadinessTier,
  evaluateDependencyReadiness,
  type DependencyReadinessCandidate,
  type DependencyReadinessRegistry,
  type DependencyReadinessReport,
  type DependencyRole,
} from './persistence/dependency-readiness';
import {
  assertPersistenceBoundary,
  type PersistenceBoundaryReport,
  type PersistenceBinding,
  type PersistenceExecutorVerificationInput,
} from './persistence/production-guard';
import {
  collectSqlExecutorVerificationInput,
  DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
  type SqlExecutorVerificationRegistry,
} from './ports/sql-executor-verification';
import {
  createUnavailableSqlConnectionFactory,
  SQL_CONNECTION_FACTORY,
  type PersistenceCapabilities,
  type SqlConnectionFactory,
} from './ports/sql-executor.port';
import {
  POSTGRES_ATTESTATION_ABSENT,
  registerPostgresExecutorAttestation,
  resolvePostgresAttestationRegistration,
} from './postgres/postgres-attestation';
import { createPostgresSqlConnectionFactory } from './postgres/postgres-executor';
import type { PostgresPoolFactory } from './postgres/postgres-pool';

/**
 * 数据库基础设施模块（PostgreSQL 持久化基础层）。
 *
 * 本模块只提供**配置与边界**，不提供任何可用数据库连接：
 * - `DATABASE_CONFIG`：由 `APP_ENV` 解析出的共享数据库配置（fail-closed：
 *   生产环境缺少 `DATABASE_URL` 时启动即失败；配置非法一律抛错，不静默降级）；
 * - `SQL_CONNECTION_FACTORY`：默认绑定 `createUnavailableSqlConnectionFactory(...)`，
 *   它如实声明「未验证驱动」，任何 `connect` 调用都抛错 —— 因此**运行时不会**悄悄把
 *   业务 provider 切到未验证数据库；
 * - `PersistenceBoundaryService`：启动阶段检查每个已登记持久化端口的能力声明，
 *   生产环境出现内存基线或未验证后端即拒绝启动（见 `persistence/production-guard.ts`）；
 *   同时把 SQL 执行器（若有）交给 `ports/sql-executor-verification.ts` 的准入契约：执行器必须持有
 *   不可伪造/不可变的封存声明、参数化查询与事务能力、已登记的验证来源与 schema/迁移就绪证据，
 *   否则启动即失败。
 *
 * **数据库已配置时的强门禁（本次加固）**：只要 `DATABASE_URL` 解析成功（任何 `NODE_ENV`），
 * 装配就必须提供**经过 attest 且证据完整**的 SQL 执行器契约事实 —— 没有事实判
 * `SQL_EXECUTOR_VERIFICATION_REQUIRED`，有事实但未封存/证据过期/迁移不一致判
 * `SQL_EXECUTOR_VERIFICATION_FAILED`，两类都在 `onApplicationBootstrap` 阶段抛错终止启动，
 * 且发生在任何 `connect` 之前。未配置数据库时该要求不生效（无数据库默认启动保持放行）。
 *
 * **生产依赖就绪门禁（本次新增）**：业务与会话依赖不再接受「能力自述」。只要门禁生效
 * （`NODE_ENV=production`，或已配置 `DATABASE_URL`），`DependencyReadinessService` 就按
 * **认证 → 业务** 分阶段判定每个已登记端口：内存替身判 `DEPENDENCY_NOT_PERSISTENT`，
 * 未验证后端判 `DEPENDENCY_NOT_VERIFIED`，自称生产可用但没有封存声明/验证证据的一律判
 * `DEPENDENCY_NOT_SEALED` / `DEPENDENCY_EVIDENCE_*`（见 `persistence/dependency-readiness.ts`）。
 * 认证阶段不通过时业务阶段整体不评估，业务端口不会被读取。开发/测试且无数据库时门禁不生效，
 * 端口不会被触碰 —— 无数据库默认启动保持现状。
 *
 * 业务 repository 的 DI 绑定**不在本模块改动**：换绑到 Postgres 实现属于后续切片，
 * 且必须先有经评估的驱动依赖与集成测试证据。
 */

/** DI 令牌：共享数据库配置（`DatabaseConfigResolution`；机密只存在于 `config.connectionString`） */
export const DATABASE_CONFIG = Symbol('DATABASE_CONFIG');

/** 未注册真实驱动时的说明：出现在 `DatabaseUnavailableError` 里，便于定位「为什么连不上」 */
export const UNAVAILABLE_DRIVER_REASON =
  '尚未选定并验证 PostgreSQL 驱动（Prisma / TypeORM 选型未完成）：运行时不得切换到未验证数据库';

/** 应用执行器工厂的接线选项（测试与未来的多后端场景可换一份登记表 / 池工厂） */
export interface AppSqlConnectionFactoryOptions {
  /** 封存身份集合；省略时使用 `DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY` */
  readonly registry?: SqlExecutorVerificationRegistry;
  /** 判定时刻；省略时取当前时间 */
  readonly now?: string;
  /** 池工厂；省略时使用真实 `pg` 实现 */
  readonly poolFactory?: PostgresPoolFactory;
}

// ---------------------------------------------------------------------------
// 容器读取基元（能力边界与依赖就绪门禁共用同一实现，避免两份读取口径漂移）
// ---------------------------------------------------------------------------

/**
 * 读取端口绑定的实例本体；未在该装配中提供该令牌时返回 `undefined`。
 * 只做容器查找，**不调用**实例的任何方法（不建连接、不查库）。
 */
function readBoundInstance(moduleRef: ModuleRef, token: symbol): unknown {
  try {
    return moduleRef.get<unknown, unknown>(token, { strict: false });
  } catch {
    // 未绑定：不在这里抛错，交由守卫按对应规则统一判定
    return undefined;
  }
}

/** 读取端口实现的能力声明（**原始值**，形状未校验）；数组与本原语视为未声明 */
function readBoundCapabilities(moduleRef: ModuleRef, token: symbol): unknown {
  const instance = readBoundInstance(moduleRef, token);
  if (Array.isArray(instance) || typeof instance !== 'object' || instance === null) {
    return undefined;
  }
  return (instance as { capabilities?: unknown }).capabilities;
}

// ---------------------------------------------------------------------------
// 生产依赖就绪门禁（认证 → 业务）
// ---------------------------------------------------------------------------

/**
 * 门禁接线选项：生产一律使用默认值（空登记表 + 当前时刻）。
 * 只为测试与未来的多后端场景留出入口，避免把「换一份登记表」变成改全局状态。
 */
export interface DependencyReadinessOptions {
  /** 封存身份集合；省略时使用 `DEFAULT_DEPENDENCY_READINESS_REGISTRY`（空集） */
  readonly registry?: DependencyReadinessRegistry;
  /** 判定时刻；省略时取当前时间（测试应显式注入，保证判定可复现） */
  readonly now?: string;
}

/**
 * DI 令牌：依赖就绪门禁的接线选项（**可选**）。
 *
 * 生产装配不提供该令牌 ⇒ 两个服务都用默认值（空登记表 + 当前时刻）。测试与未来的多后端场景
 * 可以提供它，从而在**不改全局状态**的前提下换一份登记表。刻意做成可选令牌而不是普通构造参数：
 * 接口/类型别名会被 `emitDecoratorMetadata` 记成 `Object`，Nest 会把它当成第 4 个必填依赖，
 * 让整个应用装配失败（这正是本切片实测到的失败模式）。
 */
export const DEPENDENCY_READINESS_OPTIONS = Symbol('DEPENDENCY_READINESS_OPTIONS');

/** 能力边界服务的接线选项（把依赖就绪门禁的选项一起透传，保证两者读到同一份事实） */
export type PersistenceBoundaryOptions = DependencyReadinessOptions;

/** 阶段状态的可读文案（只用于日志，不含任何证据/取值） */
function describeStageState(state: string): string {
  switch (state) {
    case 'not-required':
      return '未要求';
    case 'not-checked':
      return '未评估（认证阶段未通过）';
    case 'verified':
      return '通过';
    default:
      return '拒绝';
  }
}

/**
 * 生产依赖就绪门禁：按「认证 → 业务」分阶段判定已登记持久化端口，违规即抛
 * `DependencyReadinessError`（fail-closed）。
 *
 * 为什么独立成类而不是塞进 `PersistenceBoundaryService` 的循环：**判定顺序是契约的一部分**。
 * 认证阶段（会话存储）必须先通过，业务阶段才被读取与判定；否则「业务依赖看着就绪」会把
 * 「认证不可信」稀释掉。两个阶段各自惰性读取容器，因此该性质在容器层可观测
 * （`FakeModuleRef` 记录到的令牌里不会出现业务端口）。
 *
 * 判定口径（与 `persistence/dependency-readiness.ts` 完全一致，本类只负责接线）：
 * - 门禁档位 = `NODE_ENV=production` 或已配置 `DATABASE_URL`；否则不生效、不读取任何端口；
 * - 内存替身（含 `InMemorySessionStore`）判 `DEPENDENCY_NOT_PERSISTENT`；
 * - `persistent=true` 但 `productionReady=false` 判 `DEPENDENCY_NOT_VERIFIED`；
 * - 自称「持久 + 生产可用」的绑定必须持登记表签发的**封存声明**与已登记、新鲜、一致的**验证证据**。
 */
@Injectable()
export class DependencyReadinessService {
  private readonly logger = new Logger(DependencyReadinessService.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(DATABASE_CONFIG) private readonly database: DatabaseConfigResolution,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Optional()
    @Inject(DEPENDENCY_READINESS_OPTIONS)
    private readonly options: DependencyReadinessOptions = {},
  ) {}

  /** 执行门禁；通过时返回可写日志的脱敏摘要，不通过时抛 `DependencyReadinessError` */
  verify(): DependencyReadinessReport {
    const tier = describeDependencyReadinessTier(
      this.env.NODE_ENV,
      this.database.status === 'configured',
    );
    const report = evaluateDependencyReadiness({
      required: tier === 'required',
      // 惰性读取：未生效时零读取；认证阶段未通过时业务端口不会被读到
      authentication: () => this.readCandidates('authentication'),
      business: () => this.readCandidates('business'),
      registry: this.options.registry ?? DEFAULT_DEPENDENCY_READINESS_REGISTRY,
      now: this.options.now ?? new Date().toISOString(),
    });

    if (!report.ok) {
      throw new DependencyReadinessError(report.violations);
    }

    this.logger.log(this.describeForLog(report));
    return report;
  }

  /** 启动日志摘要：只有档位、阶段状态、端口数量与违规码，**不含**后端名/证据引用/取值 */
  describeForLog(report: DependencyReadinessReport): string {
    const codes = [...new Set(report.violations.map((item) => item.code))];
    return [
      `生产依赖就绪门禁：档位=${report.tier}`,
      `认证阶段=${describeStageState(report.authentication)}`,
      `业务阶段=${describeStageState(report.business)}`,
      `已检查端口=${report.checkedTokens.length}`,
      `违规=${codes.length === 0 ? '无' : codes.join(',')}`,
    ].join('；');
  }

  /** 按角色收集候选：角色来自登记表（`persistence-bindings.ts`），不由调用方指定 */
  private readCandidates(role: DependencyRole): readonly DependencyReadinessCandidate[] {
    return PERSISTENCE_BINDINGS.filter((descriptor) => descriptor.role === role).map(
      (descriptor) => ({
        token: bindingTokenName(descriptor.token),
        role,
        capabilities: readBoundCapabilities(this.moduleRef, descriptor.token),
      }),
    );
  }
}

/**
 * 启动期持久化边界检查。
 *
 * 为什么放在启动钩子而不是只放在 main.ts：任何以 `AppModule` 组装并 `listen()`/`init()`
 * 的入口（测试、未来的 worker、CLI）都必须经过同一道门，避免出现「绕过 main.ts 就能带内存存储上线」。
 *
 * 引导钩子里的**固定顺序**：依赖就绪门禁（认证 → 业务）→ 本类的能力边界与 SQL 执行器契约。
 * 前者回答「这个依赖是否经过封存与证据验证」，后者回答「能力声明是否齐全、是否配置了数据库、
 * 执行器是否 attest」；任一不通过都终止启动，且都发生在任何 `connect` 之前。
 */
@Injectable()
export class PersistenceBoundaryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PersistenceBoundaryService.name);

  /** 与能力边界共用同一 ModuleRef / 配置：两者读到的「实际绑定」不可能漂移 */
  private readonly readiness: DependencyReadinessService;

  private lastReadiness: DependencyReadinessReport | undefined;

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(DATABASE_CONFIG) private readonly database: DatabaseConfigResolution,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Optional()
    @Inject(DEPENDENCY_READINESS_OPTIONS)
    options: PersistenceBoundaryOptions = {},
  ) {
    this.readiness = new DependencyReadinessService(moduleRef, database, env, options);
  }

  onApplicationBootstrap(): void {
    // 顺序固定，不依赖 Nest 对多个引导钩子的调用顺序
    this.lastReadiness = this.readiness.verify();
    this.verify();
  }

  /**
   * 最近一次依赖就绪判定结果（脱敏摘要；未执行引导钩子时为 `undefined`）。
   * 供运维信息与测试读取：只含档位、阶段状态、端口名与违规码，不含证据引用与取值。
   */
  readinessReport(): DependencyReadinessReport | undefined {
    return this.lastReadiness;
  }

  /**
   * 收集已登记端口的能力声明并判定边界；违规时抛 `PersistenceBoundaryError`。
   * 未解析到实现（或实现未声明能力）判 `MISSING_CAPABILITIES`，任何环境都算代码缺陷。
   *
   * 注意：本方法只判**能力边界**（自述是否齐全、生产环境是否禁止内存/未验证后端、数据库是否
   * 配置、SQL 执行器是否 attest）。更强的「封存 + 证据」准入由 `DependencyReadinessService`
   * 承担，并只在引导钩子里先于本方法执行；直接调用本方法不会重复判定依赖就绪。
   */
  verify(): PersistenceBoundaryReport {
    const bindings: PersistenceBinding[] = PERSISTENCE_BINDINGS.map((descriptor) => {
      const token = bindingTokenName(descriptor.token);
      return {
        token,
        label: `${token}（${descriptor.module}：${descriptor.responsibility}）`,
        // 原始能力声明：形状未校验，交由能力边界按 MISSING_CAPABILITIES 等规则统一判定
        capabilities: readBoundCapabilities(this.moduleRef, descriptor.token) as
          PersistenceCapabilities | undefined,
      };
    });

    const executorVerifications = this.collectExecutorVerifications();
    const databaseConfigured = this.database.status === 'configured';
    const report = assertPersistenceBoundary({
      nodeEnv: this.env.NODE_ENV,
      databaseConfigured,
      bindings,
      // DATABASE_URL 存在 ⇒ 装配必须提供经过 attest 且证据完整的 SQL 执行器（与 NODE_ENV 无关）：
      // 没有数据库时该要求不生效，无数据库启动保持默认放行。
      requireAttestedExecutor: databaseConfigured,
      ...(executorVerifications.length === 0 ? {} : { executorVerifications }),
    });

    const executorSummary =
      executorVerifications.length === 0
        ? '未参与（本装配没有执行器形态的绑定）'
        : `通过（${executorVerifications.length} 个执行器）`;
    this.logger.log(
      `持久化边界校验通过：已检查 ${report.checkedTokens.length} 个端口；SQL 执行器契约 ${executorSummary}；执行器 attest ${
        databaseConfigured ? '要求且满足' : '未要求（无数据库）'
      }；数据库配置=${JSON.stringify(this.describeForLog())}`,
    );
    return report;
  }

  /**
   * 采集 SQL 执行器契约事实：只对**执行器形态**的绑定（暴露 `connect` / `query`）生效，
   * 只读实例字段与方法存在性，**不调用** `connect` / `query` 建立任何连接。
   *
   * 返回空数组有两种含义，必须由边界层区分（见 `requireAttestedExecutor`）：
   * - 本装配没有执行器端口（无数据库装配）→ 无要求，放行；
   * - 绑定了**非执行器形态**的替身（只有 `capabilities` 的自述对象）→ 数据库已配置时
   *   判 `SQL_EXECUTOR_VERIFICATION_REQUIRED`，不允许能力自述绕过执行器契约。
   */
  private collectExecutorVerifications(): readonly PersistenceExecutorVerificationInput[] {
    const token = bindingTokenName(SQL_CONNECTION_FACTORY);
    const input = collectSqlExecutorVerificationInput(
      readBoundInstance(this.moduleRef, SQL_CONNECTION_FACTORY),
      {
        registry: DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY,
        nodeEnv: this.env.NODE_ENV,
        label: token,
      },
    );
    return input === undefined ? [] : [{ token, input }];
  }

  /** 可写日志的配置摘要：只含状态与开关，不含主机、用户名、口令或连接串 */
  private describeForLog(): Record<string, unknown> {
    if (this.database.status === 'absent') {
      return { status: 'absent' };
    }
    return {
      status: 'configured',
      ssl: this.database.config.ssl,
      poolMax: this.database.config.poolMax,
      applicationName: this.database.config.applicationName,
    };
  }
}

/**
 * `DATABASE_CONFIG` 的工厂（单独导出以便测试直接断言 fail-closed 行为）：
 * 生产环境缺少 `DATABASE_URL`、或配置非法时抛 `DatabaseConfigError`，启动即失败。
 */
export function resolveAppDatabaseConfig(env: AppEnv): DatabaseConfigResolution {
  return resolveDatabaseConfig(env, { defaultApplicationName: 'researcher-manager-api' });
}

/**
 * `SQL_CONNECTION_FACTORY` 的工厂。
 *
 * - 未配置 `DATABASE_URL`（或未解析成功）→ **fail-closed 的未验证驱动工厂**（无数据库启动保持现状）；
 * - 已配置但缺 attest 取证事实（`DATABASE_EXECUTOR_*` / `DATABASE_SCHEMA_*` / `DATABASE_MIGRATION_*`）
 *   → 同样是未验证驱动工厂：代码**不生成**「已验证」，由启动期持久化边界判定拒绝；
 * - 已配置且取证事实齐全 → 登记证据并创建**受 attest 约束的真实 `pg` 执行器**。
 *   若证据形状非法 / 迁移版本不一致（例如仍有未应用迁移），这里会直接抛错终止启动。
 */
export function createAppSqlConnectionFactory(
  env?: AppEnv,
  resolution?: DatabaseConfigResolution,
  options: AppSqlConnectionFactoryOptions = {},
): SqlConnectionFactory {
  if (env === undefined || resolution === undefined || resolution.status !== 'configured') {
    return createUnavailableSqlConnectionFactory(UNAVAILABLE_DRIVER_REASON);
  }

  const registration = resolvePostgresAttestationRegistration(env);
  if (registration === undefined) {
    return createUnavailableSqlConnectionFactory(POSTGRES_ATTESTATION_ABSENT);
  }

  const registry = options.registry ?? DEFAULT_SQL_EXECUTOR_VERIFICATION_REGISTRY;
  const attestation = registerPostgresExecutorAttestation(registry, registration);
  return createPostgresSqlConnectionFactory({
    config: resolution.config,
    registry,
    attestation,
    nodeEnv: env.NODE_ENV,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.poolFactory === undefined ? {} : { poolFactory: options.poolFactory }),
  });
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CONFIG,
      useFactory: (env: AppEnv): DatabaseConfigResolution => resolveAppDatabaseConfig(env),
      inject: [APP_ENV],
    },
    {
      provide: SQL_CONNECTION_FACTORY,
      useFactory: (env: AppEnv, resolution: DatabaseConfigResolution): SqlConnectionFactory =>
        createAppSqlConnectionFactory(env, resolution),
      inject: [APP_ENV, DATABASE_CONFIG],
    },
    PersistenceBoundaryService,
  ],
  exports: [DATABASE_CONFIG, SQL_CONNECTION_FACTORY, PersistenceBoundaryService],
})
export class DatabaseModule {}
