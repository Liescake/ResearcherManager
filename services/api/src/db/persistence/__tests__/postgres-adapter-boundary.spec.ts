import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../config/env';
import { createAppSqlConnectionFactory, resolveAppDatabaseConfig } from '../../database.module';
import { bindingTokenName, PERSISTENCE_BINDINGS } from '../../persistence-bindings';
import {
  DatabaseUnavailableError,
  assertProductionReadyExecutor,
  UNVERIFIED_DRIVER_BACKEND,
  type PersistenceCapabilities,
} from '../../ports/sql-executor.port';
import {
  assertPersistenceBoundary,
  evaluatePersistenceBoundary,
  PersistenceBoundaryError,
  type PersistenceBinding,
} from '../production-guard';
import {
  assertPostgresAdapterBoundary,
  evaluatePostgresAdapterBoundary,
  isAuthorizedDriverSpecifier,
  isForbiddenDriverPackageName,
  isForbiddenDriverSpecifier,
  normalizeInstalledPackageName,
  POSTGRES_ADAPTER_BACKEND,
  POSTGRES_ADAPTER_EXEMPTIONS,
  POSTGRES_ADAPTER_FILE_SUFFIX,
  POSTGRES_ADAPTER_REDIRECT_PATTERN,
  POSTGRES_ADAPTER_REGISTRY,
  POSTGRES_BOUND_SLICE_REGISTRY,
  POSTGRES_CAPABILITY_PROBE_VARIANTS,
  PostgresAdapterBoundaryError,
  type PersistencePortModule,
  type PostgresAdapterBoundaryInput,
  type PostgresAdapterDescriptor,
  type PostgresAdapterFacts,
} from '../postgres-adapter-registry';

/**
 * 跨 adapter 持久化边界契约门禁（**自动枚举 + fail-closed**）。
 *
 * ## 这道门禁回答什么问题
 * 十二个 `*.postgres-repository.ts` 分两组：八个是「写好但未装配」的实现，四个已绑定到端口
 * （auth / achievements / profiles / statistics）。每个 adapter 自己的 spec 只能证明自身状态。本文件从**磁盘自动
 * 枚举**全部 adapter 文件，与登记表双向比对，并读**运行时
 * 真实导出**判定：
 * - 能力声明必须是 `backend = postgres`、`persistent = true`、`productionReady = false`；
 * - 未装配组不得被任何业务 Module 装配（provider / import / 类名引用一律不允许），也不得带 Nest
 *   痕迹；已绑定组必须在 Module 源文件里出现登记好的令牌名与工厂导出名；
 * - 不得声明、import 或安装 `pg` / ORM / 查询构建器等驱动依赖；
 * - 生产环境持久化边界守卫与执行器断言必须**仍然拒绝**这些未验证实现；
 * - 缺失登记、重复登记、错误登记（目录 / 模块文件 / 导出名 / 豁免陈旧）一律 fail-closed。
 *
 * 判定逻辑在 `../postgres-adapter-registry.ts`（纯函数），本文件只负责采集事实与固定断言；
 * 「发现即失败」本身另有合成用例逐条证明（见文件末尾的 fail-closed 用例组）。
 */

const REPO_ROOT = findRepoRoot(process.cwd());
const API_ROOT = join(REPO_ROOT, 'services', 'api');
const SRC_ROOT = join(API_ROOT, 'src');

/** 本文件与登记表自身：不参与「adapter 是否被边界之外引用」的扫描（它们本来就引用标识符） */
const BOUNDARY_FILES = new Set<string>([
  'db/persistence/postgres-adapter-registry.ts',
  'db/persistence/__tests__/postgres-adapter-boundary.spec.ts',
]);

const NEST_ARTIFACT_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'import-from-@nestjs/common', pattern: /from\s+['"]@nestjs\/common['"]/u },
  { label: 'import-from-@nestjs/core', pattern: /from\s+['"]@nestjs\/core['"]/u },
  { label: '@Injectable', pattern: /@Injectable\s*\(/u },
  { label: '@Module', pattern: /@Module\s*\(/u },
  { label: '@Inject', pattern: /@Inject\s*\(/u },
  { label: '@Controller', pattern: /@Controller\s*\(/u },
];

const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';

// ---------------------------------------------------------------------------
// 事实采集（磁盘 / 运行时 / 依赖）
// ---------------------------------------------------------------------------

interface SourceFile {
  /** 相对 `services/api/src` 的 posix 路径 */
  readonly relative: string;
  readonly content: string;
}

let sourceFilesCache: readonly SourceFile[] | undefined;

/** `services/api/src` 下全部 `.ts` 文件（含 spec：引用扫描需要它们作为「其它文件」） */
function sourceFiles(): readonly SourceFile[] {
  sourceFilesCache ??= walkSourceFiles(SRC_ROOT).map((absolute) => ({
    relative: toPosix(relativeFromRoot(absolute)),
    content: readFileSync(absolute, 'utf8'),
  }));
  return sourceFilesCache;
}

/** 磁盘自动枚举：全部 `*.postgres-repository.ts`（本次门禁的被检对象） */
function discoverAdapterFiles(): readonly string[] {
  return sourceFiles()
    .map((file) => file.relative)
    .filter((relative) => relative.endsWith(POSTGRES_ADAPTER_FILE_SUFFIX))
    .sort();
}

/** 端口登记表 → 「模块 → 持久化端口令牌」：不手工再维护一份模块清单 */
function persistencePortModules(): readonly PersistencePortModule[] {
  const grouped = new Map<string, string[]>();
  for (const descriptor of PERSISTENCE_BINDINGS) {
    const tokens = grouped.get(descriptor.module) ?? [];
    tokens.push(bindingTokenName(descriptor.token));
    grouped.set(descriptor.module, tokens);
  }
  return [...grouped.entries()]
    .map(([module, tokens]) => ({ module, tokens: [...tokens].sort() }))
    .sort((left, right) => left.module.localeCompare(right.module));
}

function tokensOfModule(module: string): readonly string[] {
  return persistencePortModules().find((item) => item.module === module)?.tokens ?? [];
}

/** 声明依赖名：仓库根与 services/api 的 package.json（依赖引入的唯一声明入口） */
function declaredDependencyNames(): readonly string[] {
  const names = new Set<string>();
  for (const packagePath of [join(REPO_ROOT, 'package.json'), join(API_ROOT, 'package.json')]) {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const name of Object.keys(parsed[field] ?? {})) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

/** `services/api/src` 下所有 import / require / 动态 import 的 specifier（含所属文件） */
function importedSpecifiersByFile(): readonly {
  readonly file: string;
  readonly specifier: string;
}[] {
  const rows: { file: string; specifier: string }[] = [];
  for (const file of sourceFiles()) {
    for (const match of file.content.matchAll(IMPORT_SPECIFIER_PATTERN)) {
      const specifier =
        match.groups?.['fromSpecifier'] ??
        match.groups?.['sideEffect'] ??
        match.groups?.['require'] ??
        match.groups?.['dynamic'];
      if (specifier !== undefined) {
        rows.push({ file: file.relative, specifier });
      }
    }
  }
  return rows.sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.specifier.localeCompare(right.specifier),
  );
}

/** `services/api/src` 下所有 import / require / 动态 import 的 specifier（去重升序） */
function importedSpecifiers(): readonly string[] {
  return [...new Set(importedSpecifiersByFile().map((item) => item.specifier))].sort();
}

/**
 * 行锚定的 import 提取器：只认「行首 import/export ... from」与 require/import 调用，
 * 避免把 SQL 文本或普通字符串里的 `from '...'` 误判成依赖（adapter 里有大量 SQL 字面量）。
 */
const IMPORT_SPECIFIER_PATTERN =
  /^\s*(?:import|export)\b[^\n]*?\bfrom\s*['"](?<fromSpecifier>[^'"]+)['"]|^\s*import\s*['"](?<sideEffect>[^'"]+)['"]|\brequire\s*\(\s*['"](?<require>[^'"]+)['"]\s*\)|\bimport\s*\(\s*['"](?<dynamic>[^'"]+)['"]\s*\)/gmu;

/** pnpm 存储目录名与 node_modules 顶层目录名（判定「驱动是否已被装进来」） */
function installedPackageDirectories(): readonly string[] {
  const directories = new Set<string>();
  for (const nodeModules of [join(REPO_ROOT, 'node_modules'), join(API_ROOT, 'node_modules')]) {
    const store = join(nodeModules, '.pnpm');
    if (existsSync(store)) {
      for (const entry of readdirSync(store, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          directories.add(entry.name);
        }
      }
    }
    if (!existsSync(nodeModules)) {
      continue;
    }
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(join(nodeModules, entry.name), { withFileTypes: true })) {
          if (scoped.isDirectory()) {
            directories.add(`${entry.name}/${scoped.name}`);
          }
        }
        continue;
      }
      directories.add(entry.name);
    }
  }
  return [...directories].sort();
}

/** adapter 之外引用了该 adapter 模块的文件（排除自身、自身 spec 与边界文件） */
function externalReferences(descriptor: PostgresAdapterDescriptor): readonly string[] {
  const basename = descriptor.file.slice(descriptor.file.lastIndexOf('/') + 1);
  const moduleName = basename.replace(/\.ts$/u, '');
  const ownSpec = `${descriptor.file.replace(/\.ts$/u, '')}.spec.ts`;
  const importPattern = new RegExp(
    `(?:from|require\\(|import\\()\\s*['"][^'"]*${escapeRegExp(moduleName)}['"]`,
    'u',
  );
  const classPattern = new RegExp(`\\b${escapeRegExp(descriptor.repositoryClass)}\\b`, 'u');
  return sourceFiles()
    .filter((file) => file.relative !== descriptor.file && file.relative !== ownSpec)
    .filter((file) => !BOUNDARY_FILES.has(file.relative))
    .filter((file) => importPattern.test(file.content) || classPattern.test(file.content))
    .map((file) => file.relative)
    .sort();
}

let factsCache: Promise<readonly PostgresAdapterFacts[]> | undefined;

/** 采集全部 adapter 的运行时事实（每个文件只动态 import 一次；未装配组 + 已绑定组） */
function collectAdapterFacts(): Promise<readonly PostgresAdapterFacts[]> {
  factsCache ??= Promise.all(
    [...POSTGRES_ADAPTER_REGISTRY, ...POSTGRES_BOUND_SLICE_REGISTRY].map((descriptor) =>
      buildAdapterFacts(descriptor as PostgresAdapterDescriptor),
    ),
  );
  return factsCache;
}

async function buildAdapterFacts(
  descriptor: PostgresAdapterDescriptor,
): Promise<PostgresAdapterFacts> {
  const absolute = join(SRC_ROOT, descriptor.file);
  const fileExists = existsSync(absolute);
  const source = fileExists ? readFileSync(absolute, 'utf8') : '';
  const moduleSource = readFileSync(join(SRC_ROOT, descriptor.moduleFile), 'utf8');
  const namespace = fileExists
    ? ((await import(pathToFileURL(absolute).href)) as Record<string, unknown>)
    : {};
  const runtimeExports = Object.keys(namespace);
  const capabilities = namespace[descriptor.capabilitiesExport];
  const assertExport = namespace[descriptor.assertExport];
  const declared = isCapabilities(capabilities) ? capabilities : undefined;
  const token = tokensOfModule(descriptor.module)[0] ?? descriptor.module;
  const label = `${descriptor.id} 的未装配 Postgres adapter`;

  return {
    descriptor,
    fileExists,
    source,
    moduleSource,
    runtimeExports,
    capabilities,
    externalReferences: externalReferences(descriptor),
    capabilityProbes: buildCapabilityProbes(capabilities, assertExport),
    productionViolationRules: evaluatePersistenceBoundary({
      nodeEnv: 'production',
      databaseConfigured: true,
      bindings: [{ token, label, capabilities: declared }],
    }).violations.map((item) => item.rule),
    executorGuardRejected:
      declared === undefined
        ? false
        : didThrow(() => assertProductionReadyExecutor(declared, label, 'production')),
  };
}

/** 四类能力探针：真实声明必须放行，三类错误登记必须被 adapter 自检拒绝 */
function buildCapabilityProbes(
  capabilities: unknown,
  assertExport: unknown,
): readonly { readonly variant: string; readonly threw: boolean }[] {
  if (typeof assertExport !== 'function' || !isCapabilities(capabilities)) {
    return [];
  }
  const assertCapabilities = assertExport as (value: PersistenceCapabilities) => void;
  const variants: readonly { readonly variant: string; readonly value: PersistenceCapabilities }[] =
    [
      { variant: 'declared', value: { ...capabilities } },
      { variant: 'production-ready-claimed', value: { ...capabilities, productionReady: true } },
      { variant: 'persistent-downgraded', value: { ...capabilities, persistent: false } },
      { variant: 'backend-swapped', value: { ...capabilities, backend: 'in-memory-baseline' } },
    ];
  return variants.map(({ variant, value }) => ({
    variant,
    threw: didThrow(() => assertCapabilities(value)),
  }));
}

/** 生产值输入：登记表 + 磁盘枚举 + 运行时事实 + 依赖事实（判定器只认这份输入） */
async function collectedBoundaryInput(): Promise<PostgresAdapterBoundaryInput> {
  return {
    registry: POSTGRES_ADAPTER_REGISTRY,
    boundSlices: POSTGRES_BOUND_SLICE_REGISTRY,
    exemptions: POSTGRES_ADAPTER_EXEMPTIONS,
    discoveredAdapterFiles: discoverAdapterFiles(),
    adapters: await collectAdapterFacts(),
    persistencePortModules: persistencePortModules(),
    declaredDependencyNames: declaredDependencyNames(),
    importedSpecifiers: importedSpecifiers(),
    importedSpecifiersByFile: importedSpecifiersByFile(),
    installedPackageDirectories: installedPackageDirectories(),
  };
}

// ---------------------------------------------------------------------------
// 跨 adapter 边界：真实数据
// ---------------------------------------------------------------------------

describe('未装配 Postgres adapter 边界：磁盘自动枚举 + 登记表 + 运行时事实', () => {
  it('磁盘枚举到的 adapter 文件与登记表双向一致（数量与集合都固定）', async () => {
    const discovered = discoverAdapterFiles();
    const registered = [
      ...POSTGRES_ADAPTER_REGISTRY.map((item) => item.file),
      ...POSTGRES_BOUND_SLICE_REGISTRY.map((item) => item.file),
    ].sort();
    expect(discovered).toHaveLength(registered.length);
    expect(discovered).toEqual(registered);
    // 12 个 adapter：2 个未装配 + 10 个已绑定（auth=会话存储、compliance=合规状态读模型、
    // audit=审计事件存储、achievements=成果存储、education=升学记录存储、groups=科研小组存储、
    // memberships=入组申请存储、notifications=站内通知存储、profiles=学生画像、
    // statistics=本人统计聚合读）
    expect(POSTGRES_ADAPTER_REGISTRY).toHaveLength(2);
    expect(POSTGRES_BOUND_SLICE_REGISTRY.map((item) => item.id)).toEqual([
      'auth',
      'compliance',
      'audit',
      'achievements',
      'education',
      'groups',
      'memberships',
      'notifications',
      'profiles',
      'statistics',
    ]);
    // 枚举口径必须由后缀唯一决定：任何名字不以该后缀结尾的 adapter 都不在门禁范围内
    for (const file of discovered) {
      expect(file.endsWith(POSTGRES_ADAPTER_FILE_SUFFIX)).toBe(true);
    }
  });

  it('跨 adapter 边界判定通过：能力、装配、守卫、依赖四类事实全部合规', async () => {
    const report = evaluatePostgresAdapterBoundary(await collectedBoundaryInput());
    // 失败时打印全部违规项，便于定位（判定器不抛错，只返回清单）
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checkedAdapters).toEqual(
      [...POSTGRES_ADAPTER_REGISTRY, ...POSTGRES_BOUND_SLICE_REGISTRY].map((item) => item.id),
    );
    expect(report.exemptedModules).toEqual([]);
  });

  it('断言版在真实数据上不抛错（供后续接入启动期闸门复用）', async () => {
    const report = assertPostgresAdapterBoundary(await collectedBoundaryInput());
    expect(report.ok).toBe(true);
  });

  it('持久化端口登记表里的业务模块都被 adapter 或豁免覆盖（不手工列举模块）', async () => {
    const input = await collectedBoundaryInput();
    const covered = new Set([
      ...input.registry.map((item) => item.module),
      ...(input.boundSlices ?? []).map((item) => item.module),
      ...input.exemptions.map((item) => item.module),
    ]);
    const business = input.persistencePortModules
      .filter((item) => item.module !== 'db')
      .map((item) => item.module);
    expect(business.filter((module) => !covered.has(module))).toEqual([]);
    // db 自身（SQL_CONNECTION_FACTORY）不属于业务模块，必须被排除，否则会出现「没有 adapter」的假阳性
    expect(business).not.toContain('db');
    expect(business.length).toBeGreaterThanOrEqual(
      POSTGRES_ADAPTER_REGISTRY.length + POSTGRES_BOUND_SLICE_REGISTRY.length,
    );
  });

  it('无未授权驱动 / ORM 依赖：官方 pg 已授权，其余仍不得声明 / import / 安装', async () => {
    const input = await collectedBoundaryInput();
    expect(
      input.declaredDependencyNames.filter((name) => isForbiddenDriverPackageName(name)),
    ).toEqual([]);
    expect(input.importedSpecifiers.filter((value) => isForbiddenDriverSpecifier(value))).toEqual(
      [],
    );
    expect(
      input.installedPackageDirectories
        .map(normalizeInstalledPackageName)
        .filter((name) => isForbiddenDriverPackageName(name)),
    ).toEqual([]);

    // 官方 pg 驱动已显式声明；且驱动只允许出现在驱动层
    expect(input.declaredDependencyNames).toContain('pg');
    expect(input.declaredDependencyNames).toContain('@types/pg');
    const driverImports = (input.importedSpecifiersByFile ?? []).filter((item) =>
      isAuthorizedDriverSpecifier(item.specifier),
    );
    expect(driverImports.length).toBeGreaterThan(0);
    expect(driverImports.map((item) => item.file)).toEqual(['db/postgres/postgres-driver.ts']);

    // 提取器自身有效：未授权驱动仍必须被识别（否则上面的空数组可能是「没扫到」而不是「没有」）
    expect(isForbiddenDriverSpecifier('pg')).toBe(false);
    expect(isForbiddenDriverSpecifier('pg-native')).toBe(true);
    expect(isForbiddenDriverSpecifier('typeorm')).toBe(true);
    expect(isForbiddenDriverSpecifier('@prisma/client/edge')).toBe(true);
    expect(isForbiddenDriverSpecifier('./local-module')).toBe(false);
    expect(isForbiddenDriverSpecifier('node:fs')).toBe(false);
    expect(isAuthorizedDriverSpecifier('pg/lib/client')).toBe(true);
    expect(normalizeInstalledPackageName('@prisma+client@5.0.0_encoding@0.1.0')).toBe(
      '@prisma/client',
    );
    expect(normalizeInstalledPackageName('pg@8.11.3')).toBe('pg');
  });
});

describe.each([...POSTGRES_ADAPTER_REGISTRY])('adapter $id', (descriptor) => {
  it('能力声明固定为 backend=postgres / persistent=true / productionReady=false', async () => {
    const facts = (await collectAdapterFacts()).find(
      (item) => item.descriptor.id === descriptor.id,
    );
    expect(facts).toBeDefined();
    expect(facts?.capabilities).toMatchObject({
      backend: POSTGRES_ADAPTER_BACKEND,
      persistent: true,
      productionReady: false,
    });
    // 能力三元组必须是布尔/字符串字面量，不能是 'false' 字符串之类的伪值
    const capabilities = facts?.capabilities as Record<string, unknown>;
    expect(typeof capabilities['persistent']).toBe('boolean');
    expect(typeof capabilities['productionReady']).toBe('boolean');
  });

  it('能力自检对三类错误登记抛错、对真实声明放行', async () => {
    const facts = (await collectAdapterFacts()).find(
      (item) => item.descriptor.id === descriptor.id,
    );
    const probes = new Map(
      (facts?.capabilityProbes ?? []).map((probe) => [probe.variant, probe.threw]),
    );
    for (const expectation of POSTGRES_CAPABILITY_PROBE_VARIANTS) {
      expect(probes.get(expectation.variant)).toBe(expectation.mustThrow);
    }
  });

  it('未被任何业务 Module 装配：模块文件、登记表与其它文件都不引用它', async () => {
    const facts = (await collectAdapterFacts()).find(
      (item) => item.descriptor.id === descriptor.id,
    );
    const moduleSource = facts?.moduleSource ?? '';
    const basename = descriptor.file.slice(descriptor.file.lastIndexOf('/') + 1);
    expect(moduleSource).not.toContain(basename.replace(/\.ts$/u, ''));
    expect(moduleSource).not.toContain(descriptor.repositoryClass);
    expect(moduleSource).not.toContain(descriptor.capabilitiesExport);
    expect(moduleSource).not.toContain(descriptor.assertExport);
    expect(facts?.externalReferences).toEqual([]);
    // 模块文件仍必须绑定该模块的持久化端口令牌（否则「未装配」就无从判定）
    for (const token of tokensOfModule(descriptor.module)) {
      expect(moduleSource).toContain(token);
    }
  });

  it('adapter 源文件没有任何 Nest 装配痕迹（不是 provider）', async () => {
    const facts = (await collectAdapterFacts()).find(
      (item) => item.descriptor.id === descriptor.id,
    );
    const source = facts?.source ?? '';
    for (const { label, pattern } of NEST_ARTIFACT_PATTERNS) {
      expect({ label, matched: pattern.test(source) }).toEqual({ label, matched: false });
    }
    expect(source).not.toMatch(POSTGRES_ADAPTER_REDIRECT_PATTERN);
  });

  it('生产环境守卫与执行器断言都仍然拒绝该未验证实现', async () => {
    const facts = (await collectAdapterFacts()).find(
      (item) => item.descriptor.id === descriptor.id,
    );
    const capabilities = facts?.capabilities as PersistenceCapabilities;
    const token = tokensOfModule(descriptor.module)[0] ?? descriptor.module;
    const label = `${descriptor.id} adapter`;
    const bindings: readonly PersistenceBinding[] = [{ token, label, capabilities }];

    const report = evaluatePersistenceBoundary({
      nodeEnv: 'production',
      databaseConfigured: true,
      bindings,
    });
    expect(report.violations.map((item) => item.rule)).toEqual([
      'BACKEND_NOT_PRODUCTION_READY_IN_PRODUCTION',
    ]);

    let captured: unknown;
    try {
      assertPersistenceBoundary({ nodeEnv: 'production', databaseConfigured: true, bindings });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PersistenceBoundaryError);
    const violations = (captured as PersistenceBoundaryError).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('productionReady=false');
    expect(violations[0]?.detail).not.toContain('://');
    expect(violations[0]?.detail).not.toContain('@');

    // 执行器断言：生产拒绝、非生产放行（能力声明缺失才在任何环境失败）
    expect(didThrow(() => assertProductionReadyExecutor(capabilities, label, 'production'))).toBe(
      true,
    );
    expect(didThrow(() => assertProductionReadyExecutor(capabilities, label, 'test'))).toBe(false);

    // 拒绝必须来自能力值本身：把 productionReady 翻成 true 后守卫必须放行
    const flipped: PersistenceBinding = {
      token,
      label,
      capabilities: { ...capabilities, productionReady: true },
    };
    expect(
      evaluatePersistenceBoundary({
        nodeEnv: 'production',
        databaseConfigured: true,
        bindings: [flipped],
      }).ok,
    ).toBe(true);

    // 非生产环境不因未验证实现失败（内存基线与未验证实现都不算违规，只有生产才拦）
    expect(
      evaluatePersistenceBoundary({ nodeEnv: 'test', databaseConfigured: false, bindings }).ok,
    ).toBe(true);
  });
});

describe('默认装配的 SQL 连接工厂：仍是 fail-closed 的未验证驱动', () => {
  it('未验证驱动工厂的能力声明被生产守卫与执行器断言拒绝，connect 一律抛错', async () => {
    const factory = createAppSqlConnectionFactory();
    expect(factory.capabilities).toEqual({
      backend: UNVERIFIED_DRIVER_BACKEND,
      persistent: false,
      productionReady: false,
    });
    expect(
      didThrow(() =>
        assertProductionReadyExecutor(factory.capabilities, 'SQL_CONNECTION_FACTORY', 'production'),
      ),
    ).toBe(true);
    expect(
      evaluatePersistenceBoundary({
        nodeEnv: 'production',
        databaseConfigured: true,
        bindings: [
          {
            token: 'SQL_CONNECTION_FACTORY',
            label: 'SQL 连接工厂',
            capabilities: factory.capabilities,
          },
        ],
      }).violations.map((item) => item.rule),
    ).toEqual(['IN_MEMORY_BACKEND_IN_PRODUCTION']);

    const resolution = resolveAppDatabaseConfig(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
    );
    if (resolution.status !== 'configured') {
      throw new Error('测试前置失败：配置应为 configured');
    }
    await expect(factory.connect(resolution.config)).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    );
  });
});

// ---------------------------------------------------------------------------
// fail-closed：合成事实逐条证明「缺失 / 重复 / 错误登记」都会失败
// ---------------------------------------------------------------------------

const SYNTHETIC_FILE = `modules/synthetic/synthetic${POSTGRES_ADAPTER_FILE_SUFFIX}`;
const SYNTHETIC_MODULE = 'SYNTHETIC_REPOSITORY';

function syntheticDescriptor(
  overrides: Partial<PostgresAdapterDescriptor> = {},
): PostgresAdapterDescriptor {
  return {
    id: 'synthetic',
    module: 'synthetic',
    file: SYNTHETIC_FILE,
    capabilitiesExport: 'POSTGRES_SYNTHETIC_REPOSITORY_CAPABILITIES',
    assertExport: 'assertPostgresSyntheticRepositoryCapabilities',
    repositoryClass: 'PostgresSyntheticRepository',
    moduleFile: 'modules/synthetic/synthetic.module.ts',
    ...overrides,
  };
}

function syntheticFacts(
  overrides: Partial<PostgresAdapterFacts> = {},
  descriptor: PostgresAdapterDescriptor = syntheticDescriptor(),
): PostgresAdapterFacts {
  return {
    descriptor,
    fileExists: true,
    source:
      'export const POSTGRES_SYNTHETIC_REPOSITORY_CAPABILITIES = { backend: "postgres" };\n' +
      'export function assertPostgresSyntheticRepositoryCapabilities() {}\n' +
      'export class PostgresSyntheticRepository {}\n',
    moduleSource: `export const ${SYNTHETIC_MODULE} = Symbol('${SYNTHETIC_MODULE}');\n`,
    runtimeExports: [
      descriptor.capabilitiesExport,
      descriptor.assertExport,
      descriptor.repositoryClass,
    ],
    capabilities: { backend: POSTGRES_ADAPTER_BACKEND, persistent: true, productionReady: false },
    externalReferences: [],
    capabilityProbes: POSTGRES_CAPABILITY_PROBE_VARIANTS.map((item) => ({
      variant: item.variant,
      threw: item.mustThrow,
    })),
    productionViolationRules: ['BACKEND_NOT_PRODUCTION_READY_IN_PRODUCTION'],
    executorGuardRejected: true,
    ...overrides,
  };
}

function syntheticInput(
  overrides: Partial<PostgresAdapterBoundaryInput> = {},
): PostgresAdapterBoundaryInput {
  return {
    registry: [syntheticDescriptor()],
    boundSlices: [],
    exemptions: [],
    discoveredAdapterFiles: [SYNTHETIC_FILE],
    adapters: [syntheticFacts()],
    persistencePortModules: [{ module: 'synthetic', tokens: [SYNTHETIC_MODULE] }],
    declaredDependencyNames: [],
    importedSpecifiers: [],
    importedSpecifiersByFile: [],
    installedPackageDirectories: [],
    ...overrides,
  };
}

/** 输入与给定登记项保持一致（登记表、磁盘枚举、事实三者同源），便于只改一个变量 */
function inputForDescriptor(
  descriptor: PostgresAdapterDescriptor,
  overrides: Partial<PostgresAdapterBoundaryInput> = {},
): PostgresAdapterBoundaryInput {
  return syntheticInput({
    registry: [descriptor],
    discoveredAdapterFiles: [descriptor.file],
    adapters: [syntheticFacts({}, descriptor)],
    ...overrides,
  });
}

function codesOf(input: PostgresAdapterBoundaryInput): readonly string[] {
  return evaluatePostgresAdapterBoundary(input).violations.map((item) => item.code);
}

describe('fail-closed：合成事实下的缺失 / 重复 / 错误登记一律失败', () => {
  it('基线合成输入必须通过（保证下面的失败来自被测变量，而不是模板本身有问题）', () => {
    const report = evaluatePostgresAdapterBoundary(syntheticInput());
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it.each([
    {
      name: '磁盘上出现未登记 adapter',
      input: () =>
        syntheticInput({
          discoveredAdapterFiles: [SYNTHETIC_FILE, 'modules/other/other.postgres-repository.ts'],
        }),
      code: 'ADAPTER_FILE_NOT_REGISTERED',
    },
    {
      name: '登记了不存在的文件（陈旧登记）',
      input: () => syntheticInput({ discoveredAdapterFiles: [] }),
      code: 'REGISTERED_FILE_MISSING',
    },
    {
      name: '同一文件被登记两次',
      input: () =>
        syntheticInput({
          registry: [syntheticDescriptor(), syntheticDescriptor({ id: 'synthetic-copy' })],
        }),
      code: 'DUPLICATE_ADAPTER_REGISTRATION',
    },
    {
      name: '登记文件名后缀不符（逃出枚举口径）',
      input: () =>
        inputForDescriptor(syntheticDescriptor({ file: 'modules/synthetic/synthetic.ts' })),
      code: 'ADAPTER_FILE_NAME_MISMATCH',
    },
    {
      name: '登记模块与文件目录不一致',
      input: () => inputForDescriptor(syntheticDescriptor({ module: 'elsewhere' })),
      code: 'ADAPTER_MODULE_DIRECTORY_MISMATCH',
    },
    {
      name: '登记模块文件不是该模块的 module.ts',
      input: () =>
        inputForDescriptor(
          syntheticDescriptor({ moduleFile: 'modules/synthetic/other.module.ts' }),
        ),
      code: 'ADAPTER_MODULE_FILE_MISMATCH',
    },
    {
      name: 'adapter 挂在没有持久化端口的模块上',
      input: () => syntheticInput({ persistencePortModules: [] }),
      code: 'ADAPTER_MODULE_WITHOUT_PERSISTENCE_PORT',
    },
    {
      name: '缺少该 adapter 的运行时事实',
      input: () => syntheticInput({ adapters: [] }),
      code: 'ADAPTER_FACTS_MISSING',
    },
    {
      name: '事实属于登记表之外的 adapter',
      input: () =>
        syntheticInput({
          adapters: [syntheticFacts({}, syntheticDescriptor({ id: 'unregistered' }))],
        }),
      code: 'ADAPTER_FACTS_UNKNOWN',
    },
    {
      name: '登记的导出名不存在',
      input: () => syntheticInput({ adapters: [syntheticFacts({ runtimeExports: [] })] }),
      code: 'ADAPTER_DECLARATION_MISSING',
    },
    {
      name: 'adapter 转发到另一个 adapter 文件',
      input: () =>
        syntheticInput({
          adapters: [
            syntheticFacts({ source: `export * from './other${POSTGRES_ADAPTER_FILE_SUFFIX}';` }),
          ],
        }),
      code: 'ADAPTER_FILE_REDIRECTED',
    },
    {
      name: '能力声明缺失',
      input: () => syntheticInput({ adapters: [syntheticFacts({ capabilities: undefined })] }),
      code: 'CAPABILITY_MISSING',
    },
    {
      name: 'backend 不是 postgres',
      input: () =>
        syntheticInput({
          adapters: [
            syntheticFacts({
              capabilities: { backend: 'sqlite', persistent: true, productionReady: false },
            }),
          ],
        }),
      code: 'CAPABILITY_BACKEND_MISMATCH',
    },
    {
      name: 'persistent 被降级为 false',
      input: () =>
        syntheticInput({
          adapters: [
            syntheticFacts({
              capabilities: {
                backend: POSTGRES_ADAPTER_BACKEND,
                persistent: false,
                productionReady: false,
              },
            }),
          ],
        }),
      code: 'CAPABILITY_NOT_PERSISTENT',
    },
    {
      name: '未验证就声称 productionReady=true',
      input: () =>
        syntheticInput({
          adapters: [
            syntheticFacts({
              capabilities: {
                backend: POSTGRES_ADAPTER_BACKEND,
                persistent: true,
                productionReady: true,
              },
            }),
          ],
        }),
      code: 'CAPABILITY_PRODUCTION_READY_CLAIMED',
    },
    {
      name: '能力自检探针缺失',
      input: () => syntheticInput({ adapters: [syntheticFacts({ capabilityProbes: [] })] }),
      code: 'CAPABILITY_PROBE_MISSING',
    },
    {
      name: '自检未拒绝「声称生产可用」',
      input: () =>
        syntheticInput({
          adapters: [
            syntheticFacts({
              capabilityProbes: POSTGRES_CAPABILITY_PROBE_VARIANTS.map((item) => ({
                variant: item.variant,
                threw: false,
              })),
            }),
          ],
        }),
      code: 'CAPABILITY_ASSERT_NOT_THROWING',
    },
    {
      name: '自检拒绝了自己的真实声明',
      input: () =>
        syntheticInput({
          adapters: [
            syntheticFacts({
              capabilityProbes: POSTGRES_CAPABILITY_PROBE_VARIANTS.map((item) => ({
                variant: item.variant,
                threw: true,
              })),
            }),
          ],
        }),
      code: 'CAPABILITY_ASSERT_REJECTS_DECLARED',
    },
    {
      name: 'adapter 带上了 Nest 装饰器',
      input: () =>
        syntheticInput({
          adapters: [syntheticFacts({ source: '@Injectable()\nexport class X {}' })],
        }),
      code: 'NEST_DECORATOR_IN_ADAPTER',
    },
    {
      name: '业务模块引用了 adapter 类名',
      input: () =>
        syntheticInput({
          adapters: [
            syntheticFacts({
              moduleSource: `${SYNTHETIC_MODULE}\nconst x = PostgresSyntheticRepository;`,
            }),
          ],
        }),
      code: 'MODULE_PROVIDER_BINDING',
    },
    {
      name: 'adapter 被边界之外的文件引用',
      input: () =>
        syntheticInput({
          adapters: [syntheticFacts({ externalReferences: ['modules/other/other.module.ts'] })],
        }),
      code: 'ADAPTER_REFERENCED_ELSEWHERE',
    },
    {
      name: '模块文件里找不到待替换的端口令牌',
      input: () =>
        syntheticInput({
          adapters: [syntheticFacts({ moduleSource: 'export const nothing = 1;' })],
        }),
      code: 'PENDING_TOKEN_NOT_BOUND_IN_MODULE',
    },
    {
      name: '有持久化端口但没有 adapter 也没有豁免',
      input: () =>
        syntheticInput({
          registry: [],
          discoveredAdapterFiles: [],
          adapters: [],
          persistencePortModules: [{ module: 'auth', tokens: ['SESSION_STORE'] }],
        }),
      code: 'PERSISTENCE_PORT_WITHOUT_ADAPTER',
    },
    {
      name: '同一模块登记了多个 adapter',
      input: () =>
        syntheticInput({
          registry: [
            syntheticDescriptor(),
            syntheticDescriptor({
              id: 'synthetic-2',
              file: `modules/synthetic/synthetic-2${POSTGRES_ADAPTER_FILE_SUFFIX}`,
            }),
          ],
        }),
      code: 'PERSISTENCE_PORT_ADAPTER_DUPLICATED',
    },
    {
      name: '同一模块既有 adapter 又有豁免',
      input: () =>
        syntheticInput({
          exemptions: [
            {
              module: 'synthetic',
              token: SYNTHETIC_MODULE,
              reason: '理由文本足够长可以过长度门禁',
            },
          ],
        }),
      code: 'ADAPTER_EXEMPTION_CONFLICT',
    },
    {
      name: '豁免令牌已不在持久化端口上（陈旧豁免）',
      input: () =>
        syntheticInput({
          exemptions: [
            { module: 'synthetic', token: 'REMOVED_PORT', reason: '理由文本足够长可以过长度门禁' },
          ],
        }),
      code: 'STALE_ADAPTER_EXEMPTION',
    },
    {
      name: '豁免缺少可核对的理由',
      input: () =>
        syntheticInput({
          exemptions: [{ module: 'synthetic', token: SYNTHETIC_MODULE, reason: '短' }],
        }),
      code: 'ADAPTER_EXEMPTION_WITHOUT_REASON',
    },
    {
      name: '生产守卫放行了未验证 adapter',
      input: () => syntheticInput({ adapters: [syntheticFacts({ productionViolationRules: [] })] }),
      code: 'PRODUCTION_GUARD_NOT_REJECTING',
    },
    {
      name: '执行器断言放行了未验证执行器',
      input: () => syntheticInput({ adapters: [syntheticFacts({ executorGuardRejected: false })] }),
      code: 'EXECUTOR_GUARD_NOT_REJECTING',
    },
    {
      name: 'package.json 声明了未授权的驱动 / ORM 依赖',
      input: () => syntheticInput({ declaredDependencyNames: ['typeorm'] }),
      code: 'FORBIDDEN_DRIVER_DEPENDENCY',
    },
    {
      name: '源码 import 了被禁 ORM',
      input: () => syntheticInput({ importedSpecifiers: ['typeorm'] }),
      code: 'FORBIDDEN_DRIVER_IMPORT',
    },
    {
      name: 'node_modules 里已装进未授权驱动',
      input: () => syntheticInput({ installedPackageDirectories: ['typeorm@0.3.20'] }),
      code: 'FORBIDDEN_DRIVER_INSTALLED',
    },
    {
      name: '已授权驱动出现在驱动层之外（业务 adapter 直接 import pg）',
      input: () =>
        syntheticInput({
          declaredDependencyNames: ['pg', '@types/pg'],
          importedSpecifiersByFile: [{ file: SYNTHETIC_FILE, specifier: 'pg' }],
        }),
      code: 'DRIVER_IMPORT_IN_ADAPTER',
    },
    {
      name: '已授权驱动出现在驱动层之外（业务代码直接 import pg）',
      input: () =>
        syntheticInput({
          declaredDependencyNames: ['pg', '@types/pg'],
          importedSpecifiersByFile: [{ file: 'modules/other/other.service.ts', specifier: 'pg' }],
        }),
      code: 'DRIVER_IMPORT_OUTSIDE_DRIVER_LAYER',
    },
    {
      name: 'import 了驱动但 package.json 未显式声明',
      input: () =>
        syntheticInput({
          importedSpecifiersByFile: [{ file: 'db/postgres/postgres-driver.ts', specifier: 'pg' }],
        }),
      code: 'AUTHORIZED_DRIVER_NOT_DECLARED',
    },
    {
      name: '同一个切片同时登记为未装配与已绑定',
      input: () =>
        syntheticInput({
          boundSlices: [
            {
              id: 'synthetic',
              module: 'synthetic',
              file: SYNTHETIC_FILE,
              capabilitiesExport: 'SYNTHETIC_CAPABILITIES',
              assertExport: 'assertSyntheticCapabilities',
              repositoryClass: 'SyntheticRepository',
              moduleFile: 'modules/synthetic/synthetic.module.ts',
              token: SYNTHETIC_MODULE,
              factoryExport: 'createSyntheticRepository',
            },
          ],
        }),
      code: 'BOUND_SLICE_REGISTRATION_CONFLICT',
    },
    {
      name: '登记为已绑定但 Module 里没有引用工厂导出',
      input: () =>
        syntheticInput({
          registry: [],
          boundSlices: [
            {
              id: 'synthetic',
              module: 'synthetic',
              file: SYNTHETIC_FILE,
              capabilitiesExport: 'SYNTHETIC_CAPABILITIES',
              assertExport: 'assertSyntheticCapabilities',
              repositoryClass: 'SyntheticRepository',
              moduleFile: 'modules/synthetic/synthetic.module.ts',
              token: SYNTHETIC_MODULE,
              factoryExport: 'createSyntheticRepository',
            },
          ],
        }),
      code: 'BOUND_SLICE_NOT_REFERENCED_BY_MODULE',
    },
  ])('失败路径：$name → $code', ({ input, code }) => {
    expect(codesOf(input())).toContain(code);
  });

  it('存在违规时断言版抛 PostgresAdapterBoundaryError，并列出全部主体与代码', () => {
    const input = syntheticInput({
      adapters: [
        syntheticFacts({
          capabilities: {
            backend: POSTGRES_ADAPTER_BACKEND,
            persistent: true,
            productionReady: true,
          },
          externalReferences: ['modules/other/other.module.ts'],
        }),
      ],
      declaredDependencyNames: ['typeorm'],
    });
    let captured: unknown;
    try {
      assertPostgresAdapterBoundary(input);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PostgresAdapterBoundaryError);
    const boundaryError = captured as PostgresAdapterBoundaryError;
    expect(boundaryError.violations.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'CAPABILITY_PRODUCTION_READY_CLAIMED',
        'ADAPTER_REFERENCED_ELSEWHERE',
        'FORBIDDEN_DRIVER_DEPENDENCY',
      ]),
    );
    expect(boundaryError.message).toContain('synthetic[CAPABILITY_PRODUCTION_READY_CLAIMED]');
    expect(boundaryError.message).not.toContain('://');
    expect(boundaryError.message).not.toContain('@');
  });
});

// ---------------------------------------------------------------------------
// 采集辅助
// ---------------------------------------------------------------------------

function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = resolve(current, '..');
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error('未找到仓库根目录（缺少 pnpm-workspace.yaml）');
}

function walkSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function relativeFromRoot(absolute: string): string {
  return absolute.startsWith(`${SRC_ROOT}${sep}`) ? absolute.slice(SRC_ROOT.length + 1) : absolute;
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isCapabilities(value: unknown): value is PersistenceCapabilities {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function didThrow(run: () => void): boolean {
  try {
    run();
    return false;
  } catch {
    return true;
  }
}
