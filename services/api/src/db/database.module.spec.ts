import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ModuleRef } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { loadEnv, type AppEnv } from '../config/env';
import { DatabaseConfigError, describeDatabaseConfig } from './config/database-config';
import {
  createAppSqlConnectionFactory,
  DATABASE_CONFIG,
  PersistenceBoundaryService,
  resolveAppDatabaseConfig,
} from './database.module';
import {
  bindingTokenName,
  NON_PERSISTENCE_PORTS,
  PERSISTENCE_BINDINGS,
} from './persistence-bindings';
import { PersistenceBoundaryError } from './persistence/production-guard';
import {
  DatabaseUnavailableError,
  SQL_CONNECTION_FACTORY,
  UNVERIFIED_DRIVER_BACKEND,
  type PersistenceCapabilities,
} from './ports/sql-executor.port';

const IN_MEMORY: PersistenceCapabilities = {
  backend: 'in-memory-baseline',
  persistent: false,
  productionReady: false,
};

const VERIFIED_POSTGRES: PersistenceCapabilities = {
  backend: 'postgres',
  persistent: true,
  productionReady: true,
};

const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';

function devEnv(overrides: Record<string, string> = {}): AppEnv {
  return loadEnv({ NODE_ENV: 'test', ...overrides });
}

/** 最小 ModuleRef 替身：只实现本服务用到的 `get(token, { strict: false })` */
class FakeModuleRef {
  private readonly instances: Map<symbol, unknown>;

  constructor(instances: Map<symbol, unknown>) {
    this.instances = instances;
  }

  get(token: symbol): unknown {
    if (!this.instances.has(token)) {
      throw new Error(`未找到令牌: ${bindingTokenName(token)}`);
    }
    return this.instances.get(token);
  }
}

function bindingInstances(capabilities: PersistenceCapabilities): Map<symbol, unknown> {
  return new Map(PERSISTENCE_BINDINGS.map((descriptor) => [descriptor.token, { capabilities }]));
}

function buildService(
  env: AppEnv,
  capabilities: PersistenceCapabilities | undefined,
): PersistenceBoundaryService {
  const instances =
    capabilities === undefined ? new Map<symbol, unknown>() : bindingInstances(capabilities);
  const resolution = resolveAppDatabaseConfig(env);
  return new PersistenceBoundaryService(
    new FakeModuleRef(instances) as unknown as ModuleRef,
    resolution,
    env,
  );
}

describe('数据库配置工厂：fail-closed', () => {
  it('开发/测试环境未配置 DATABASE_URL 时返回 absent（允许无库启动）', () => {
    expect(resolveAppDatabaseConfig(devEnv())).toMatchObject({ status: 'absent' });
  });

  it('生产环境未配置 DATABASE_URL 时抛 DatabaseConfigError（启动即失败）', () => {
    const env = loadEnv({ NODE_ENV: 'production' });
    expect(() => resolveAppDatabaseConfig(env)).toThrowError(DatabaseConfigError);
    try {
      resolveAppDatabaseConfig(env);
    } catch (error) {
      expect((error as DatabaseConfigError).code).toBe('DATABASE_URL_REQUIRED_IN_PRODUCTION');
    }
  });

  it('生产环境对非回环主机关闭 TLS 时同样拒绝（配置 fail-closed）', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://rm:pw@db.example.com:5432/researcher_manager',
      DATABASE_SSL: 'false',
    });
    expect(() => resolveAppDatabaseConfig(env)).toThrowError(DatabaseConfigError);
  });

  it('生产环境配置完整时解析出共享配置，且对外摘要不含口令', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: LOOPBACK_URL,
      DATABASE_SSL: 'false',
      DATABASE_POOL_MAX: '20',
    });
    const resolution = resolveAppDatabaseConfig(env);
    expect(resolution).toMatchObject({
      status: 'configured',
      config: { poolMax: 20, applicationName: 'researcher-manager-api', ssl: 'disable' },
    });
    if (resolution.status !== 'configured') {
      throw new Error('测试前置失败：配置应为 configured');
    }

    // 机密只允许存在于交给驱动的 connectionString 里
    expect(resolution.config.connectionString).toBe(LOOPBACK_URL);
    // 可写日志/可对外展示的投影必须已脱敏
    const summary = JSON.stringify(describeDatabaseConfig(resolution));
    expect(summary).not.toContain('postgres:postgres');
    expect(summary).toContain('postgresql://***:***@127.0.0.1:5432/researcher_manager');
  });
});

describe('SQL 连接工厂：默认绑定未验证驱动（不切换运行时 provider）', () => {
  it('能力声明为未验证驱动，且 connect 一律拒绝', async () => {
    const factory = createAppSqlConnectionFactory();
    expect(factory.capabilities).toEqual({
      backend: UNVERIFIED_DRIVER_BACKEND,
      persistent: false,
      productionReady: false,
    });

    const env = devEnv({ DATABASE_URL: LOOPBACK_URL });
    const resolution = resolveAppDatabaseConfig(env);
    if (resolution.status !== 'configured') {
      throw new Error('测试前置失败：配置应为 configured');
    }
    await expect(factory.connect(resolution.config)).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    );
  });
});

describe('PersistenceBoundaryService：生产边界守卫', () => {
  it('测试环境放行内存基线（不因默认装配失败）', () => {
    const service = buildService(devEnv(), IN_MEMORY);
    const report = service.verify();
    expect(report.ok).toBe(true);
    expect(report.checkedTokens).toHaveLength(PERSISTENCE_BINDINGS.length);
  });

  it('生产环境 + 内存基线：拒绝启动并逐端口报告违规', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: LOOPBACK_URL,
      DATABASE_SSL: 'false',
    });
    const service = buildService(env, IN_MEMORY);

    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PersistenceBoundaryError);
    const boundaryError = captured as PersistenceBoundaryError;
    expect(boundaryError.violations).toHaveLength(PERSISTENCE_BINDINGS.length);
    expect(
      boundaryError.violations.every((item) => item.rule === 'IN_MEMORY_BACKEND_IN_PRODUCTION'),
    ).toBe(true);
    expect(boundaryError.message).toContain('GROUP_REPOSITORY[IN_MEMORY_BACKEND_IN_PRODUCTION]');
  });

  it('生产环境 + 未配置 DATABASE_URL：报配置 fail-closed（内存基线的第二个违规来源）', () => {
    const env = loadEnv({ NODE_ENV: 'production' });
    // 直接构造服务（跳过配置工厂），验证守卫自身的配置判定
    const service = new PersistenceBoundaryService(
      new FakeModuleRef(bindingInstances(VERIFIED_POSTGRES)) as unknown as ModuleRef,
      { status: 'absent', detail: '测试构造' },
      env,
    );

    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }
    const violations = (captured as PersistenceBoundaryError).violations;
    expect(violations.map((item) => item.rule)).toEqual(['DATABASE_NOT_CONFIGURED_IN_PRODUCTION']);
    expect(violations[0]?.token).toBe('DATABASE_CONFIG');
  });

  it('生产环境 + 已声明持久且生产可用的后端 + 已配置数据库：放行', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: LOOPBACK_URL,
      DATABASE_SSL: 'false',
    });
    const service = buildService(env, VERIFIED_POSTGRES);
    expect(service.verify().ok).toBe(true);
  });

  it('端口未绑定（或未声明能力）时在任何环境都判 MISSING_CAPABILITIES', () => {
    const service = buildService(devEnv(), undefined);
    let captured: unknown;
    try {
      service.verify();
    } catch (error) {
      captured = error;
    }
    const violations = (captured as PersistenceBoundaryError).violations;
    expect(violations).toHaveLength(PERSISTENCE_BINDINGS.length);
    expect(violations.every((item) => item.rule === 'MISSING_CAPABILITIES')).toBe(true);
  });
});

describe('完整 AppModule 装配：运行时仍是内存基线 + fail-closed 连接工厂', () => {
  let app: INestApplication | undefined;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    // 固定配置来源，避免宿主环境的 DATABASE_URL 影响断言（ConfigModule 读 process.env）
    process.env.DATABASE_URL = '';
    process.env.NODE_ENV = 'test';
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('启动阶段完成持久化边界校验，且所有已登记端口都能解析到能力声明', () => {
    const service = app?.get(PersistenceBoundaryService);
    expect(service).toBeInstanceOf(PersistenceBoundaryService);
    const report = service?.verify();
    expect(report?.ok).toBe(true);
    expect(report?.checkedTokens).toEqual(
      PERSISTENCE_BINDINGS.map((d) => bindingTokenName(d.token)),
    );
  });

  it('DATABASE_CONFIG 未配置时是 absent，SQL_CONNECTION_FACTORY 是未验证驱动工厂', () => {
    expect(app?.get(DATABASE_CONFIG)).toMatchObject({ status: 'absent' });
    expect(app?.get(SQL_CONNECTION_FACTORY)).toMatchObject({
      capabilities: { backend: UNVERIFIED_DRIVER_BACKEND, productionReady: false },
    });
  });
});

describe('端口登记表：漂移门禁与卫生检查', () => {
  it('src 下所有 *.port.ts 的 DI 令牌都已登记（或给出非持久化理由）', () => {
    const repoRoot = findRepoRoot(process.cwd());
    const discovered = collectPortTokenNames(join(repoRoot, 'services', 'api', 'src'));
    const registered = [
      ...PERSISTENCE_BINDINGS.map((descriptor) => bindingTokenName(descriptor.token)),
      ...NON_PERSISTENCE_PORTS.map((descriptor) => bindingTokenName(descriptor.token)),
    ];

    // 双向比对：新增端口未登记会失败，登记表里的陈旧条目同样会失败
    expect([...registered].sort()).toEqual([...new Set(discovered)].sort());
  });

  it('登记表无重复，且非持久化端口都给出了理由', () => {
    const names = [
      ...PERSISTENCE_BINDINGS.map((descriptor) => bindingTokenName(descriptor.token)),
      ...NON_PERSISTENCE_PORTS.map((descriptor) => bindingTokenName(descriptor.token)),
    ];
    expect(new Set(names).size).toBe(names.length);

    for (const descriptor of NON_PERSISTENCE_PORTS) {
      expect(descriptor.reason.length).toBeGreaterThanOrEqual(10);
    }
    for (const descriptor of PERSISTENCE_BINDINGS) {
      expect(descriptor.responsibility.length).toBeGreaterThan(0);
    }
  });
});

/** 从当前工作目录向上寻找仓库根（含 pnpm-workspace.yaml） */
function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error('未找到仓库根目录（缺少 pnpm-workspace.yaml）');
}

/** 扫描 `*.port.ts` 里的 `export const X = Symbol(...)` 声明，收集令牌名 */
function collectPortTokenNames(root: string): string[] {
  const names: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.port.ts')) {
        continue;
      }
      const content = readFileSync(fullPath, 'utf8');
      for (const match of content.matchAll(/export const ([A-Z0-9_]+) = Symbol\(/gu)) {
        const name = match[1];
        if (name !== undefined) {
          names.push(name);
        }
      }
    }
  };
  walk(root);
  return names;
}
