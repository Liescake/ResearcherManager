import { Inject, Injectable, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { resolveDatabaseConfig, type DatabaseConfigResolution } from './config/database-config';
import { bindingTokenName, PERSISTENCE_BINDINGS } from './persistence-bindings';
import {
  assertPersistenceBoundary,
  type PersistenceBoundaryReport,
  type PersistenceBinding,
} from './persistence/production-guard';
import {
  createUnavailableSqlConnectionFactory,
  SQL_CONNECTION_FACTORY,
  type PersistenceCapabilities,
  type SqlConnectionFactory,
} from './ports/sql-executor.port';

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
 *   生产环境出现内存基线或未验证后端即拒绝启动（见 `persistence/production-guard.ts`）。
 *
 * 业务 repository 的 DI 绑定**不在本模块改动**：换绑到 Postgres 实现属于后续切片，
 * 且必须先有经评估的驱动依赖与集成测试证据。
 */

/** DI 令牌：共享数据库配置（`DatabaseConfigResolution`；机密只存在于 `config.connectionString`） */
export const DATABASE_CONFIG = Symbol('DATABASE_CONFIG');

/** 未注册真实驱动时的说明：出现在 `DatabaseUnavailableError` 里，便于定位「为什么连不上」 */
export const UNAVAILABLE_DRIVER_REASON =
  '尚未选定并验证 PostgreSQL 驱动（Prisma / TypeORM 选型未完成）：运行时不得切换到未验证数据库';

/**
 * 启动期持久化边界检查。
 *
 * 为什么放在启动钩子而不是只放在 main.ts：任何以 `AppModule` 组装并 `listen()`/`init()`
 * 的入口（测试、未来的 worker、CLI）都必须经过同一道门，避免出现「绕过 main.ts 就能带内存存储上线」。
 */
@Injectable()
export class PersistenceBoundaryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PersistenceBoundaryService.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(DATABASE_CONFIG) private readonly database: DatabaseConfigResolution,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  onApplicationBootstrap(): void {
    this.verify();
  }

  /**
   * 收集已登记端口的能力声明并判定边界；违规时抛 `PersistenceBoundaryError`。
   * 未解析到实现（或实现未声明能力）判 `MISSING_CAPABILITIES`，任何环境都算代码缺陷。
   */
  verify(): PersistenceBoundaryReport {
    const bindings: PersistenceBinding[] = PERSISTENCE_BINDINGS.map((descriptor) => {
      const token = bindingTokenName(descriptor.token);
      return {
        token,
        label: `${token}（${descriptor.module}：${descriptor.responsibility}）`,
        capabilities: this.readCapabilities(descriptor.token),
      };
    });

    const report = assertPersistenceBoundary({
      nodeEnv: this.env.NODE_ENV,
      databaseConfigured: this.database.status === 'configured',
      bindings,
    });

    this.logger.log(
      `持久化边界校验通过：已检查 ${report.checkedTokens.length} 个端口；数据库配置=${JSON.stringify(
        this.describeForLog(),
      )}`,
    );
    return report;
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

  /** 读取端口实现的能力声明；未绑定或未声明能力时返回 undefined（由守卫判违规） */
  private readCapabilities(token: symbol): PersistenceCapabilities | undefined {
    try {
      const instance = this.moduleRef.get<unknown, { capabilities?: PersistenceCapabilities }>(
        token,
        { strict: false },
      );
      if (Array.isArray(instance)) {
        return undefined;
      }
      return instance?.capabilities;
    } catch {
      // 未在该装配中提供该令牌：不在这里抛错，交由守卫按 MISSING_CAPABILITIES 统一判定
      return undefined;
    }
  }
}

/**
 * `DATABASE_CONFIG` 的工厂（单独导出以便测试直接断言 fail-closed 行为）：
 * 生产环境缺少 `DATABASE_URL`、或配置非法时抛 `DatabaseConfigError`，启动即失败。
 */
export function resolveAppDatabaseConfig(env: AppEnv): DatabaseConfigResolution {
  return resolveDatabaseConfig(env, { defaultApplicationName: 'researcher-manager-api' });
}

/** `SQL_CONNECTION_FACTORY` 的工厂：当前一律返回 fail-closed 的未验证驱动工厂 */
export function createAppSqlConnectionFactory(): SqlConnectionFactory {
  return createUnavailableSqlConnectionFactory(UNAVAILABLE_DRIVER_REASON);
}

@Module({
  providers: [
    {
      provide: DATABASE_CONFIG,
      useFactory: (env: AppEnv): DatabaseConfigResolution => resolveAppDatabaseConfig(env),
      inject: [APP_ENV],
    },
    {
      provide: SQL_CONNECTION_FACTORY,
      useFactory: () => createAppSqlConnectionFactory(),
    },
    PersistenceBoundaryService,
  ],
  exports: [DATABASE_CONFIG, SQL_CONNECTION_FACTORY, PersistenceBoundaryService],
})
export class DatabaseModule {}
