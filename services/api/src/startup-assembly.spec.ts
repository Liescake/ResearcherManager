import 'reflect-metadata';
import type { IncomingHttpHeaders } from 'node:http';
import { request } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ApiEnvelope } from '@rm/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module';
import { APP_ENV } from './config/config.module';
import { loadEnv } from './config/env';
import { DatabaseConfigError, resolveDatabaseConfig } from './db/config/database-config';
import { PersistenceBoundaryService } from './db/database.module';
import { DependencyReadinessError } from './db/persistence/dependency-readiness';
import { PersistenceBoundaryError } from './db/persistence/production-guard';
import {
  DatabaseUnavailableError,
  SQL_CONNECTION_FACTORY,
  UNVERIFIED_DRIVER_BACKEND,
} from './db/ports/sql-executor.port';
import { createApp } from './main';
import { InMemoryAchievementRepository } from './modules/achievements/achievements.in-memory-repository';
import { POSTGRES_ACHIEVEMENT_REPOSITORY_CAPABILITIES } from './modules/achievements/achievements.postgres-repository';
import { ACHIEVEMENT_REPOSITORY } from './modules/achievements/achievements.port';
import type { AchievementRepository } from './modules/achievements/achievements.port';
import { InMemoryAuditRepository } from './modules/audit/audit.in-memory-repository';
import { POSTGRES_AUDIT_REPOSITORY_CAPABILITIES } from './modules/audit/audit.postgres-repository';
import { AUDIT_REPOSITORY } from './modules/audit/audit.port';
import type { AuditRepository } from './modules/audit/audit.port';
import { POSTGRES_SESSION_STORE_CAPABILITIES } from './modules/auth/session-store.postgres-repository';
import { SESSION_STORE, SESSION_SUBJECT_RESOLVER } from './modules/auth/session-subject.port';
import type { SessionStore, SessionSubjectResolver } from './modules/auth/session-subject.port';
import { InMemoryComplianceRepository } from './modules/compliance/compliance.in-memory-repository';
import { POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES } from './modules/compliance/compliance.postgres-repository';
import { COMPLIANCE_REPOSITORY } from './modules/compliance/compliance.port';
import type { ComplianceRepository } from './modules/compliance/compliance.port';
import { InMemoryEducationRecordRepository } from './modules/education/education-records.in-memory-repository';
import { POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES } from './modules/education/education-records.postgres-repository';
import { EDUCATION_RECORD_REPOSITORY } from './modules/education/education-records.port';
import type { EducationRecordRepository } from './modules/education/education-records.port';
import { InMemoryApplicationRepository } from './modules/memberships/applications.in-memory-repository';
import { POSTGRES_APPLICATION_REPOSITORY_CAPABILITIES } from './modules/memberships/applications.postgres-repository';
import { APPLICATION_REPOSITORY } from './modules/memberships/applications.port';
import type { ApplicationRepository } from './modules/memberships/applications.port';
import { InMemoryProfileRepository } from './modules/profiles/student-profile.in-memory-repository';
import { POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES } from './modules/profiles/student-profile.postgres-repository';
import { PROFILE_REPOSITORY } from './modules/profiles/student-profile.port';
import type { ProfileRepository } from './modules/profiles/student-profile.port';

/**
 * **启动装配验证**：真实 `AppModule` 组装 + 真实装配生命周期，验证
 * 「生产环境 fail-closed、开发/测试环境不因未配置数据库而破坏既有路由」这条边界。
 *
 * 与 `db/database.module.spec.ts` 的分工：那里用**伪造 `ModuleRef`/能力声明**穷举守卫的
 * 判定规则（单元级）；这里走**真实装配**——不替换任何 controller/provider，只替换配置来源，
 * 因此能守住「真实启动链路」上的行为：装配失败必须发生在任何数据库连接之前。
 *
 * 生产判定发生在**实例化阶段**（内存基线仓储的构造函数即拒绝生产环境，配置工厂也在同一阶段
 * 解析），所以这里的 `abortOnError: false` 只影响「错误如何呈现」：默认 `true` 时 Nest 走
 * `process.abort()` 终止进程（`main` 入口的真实行为，已用 `node dist/main.js` 实测退出码 1）；
 * 测试里改成重新抛出，以便断言失败原因（`process.abort()` 在 vitest worker 中不可用）。
 *
 * 明确不做的事（与生产边界的要求一致）：
 * - 不连接任何真实数据库（本仓库尚无可信驱动，`SQL_CONNECTION_FACTORY` 仍是未验证驱动工厂）；
 * - 不把任何业务 repository provider 换绑到未验证数据库实现；
 * - 断言失败信息里不出现口令/连接串原文。
 */

/** 远端主机（非回环）：生产环境必须有 TLS */
const REMOTE_HOST = 'db.example.com';
/** 生产环境装配用的假口令：只用于断言错误消息不泄露，不会用于任何连接 */
const FAKE_PASSWORD = 'sup3r-s3cret-pw';
const REMOTE_URL = `postgresql://rm_user:${FAKE_PASSWORD}@${REMOTE_HOST}:5432/researcher_manager`;
const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';

/** 已装配/已监听的应用：统一在用例结束后关闭，避免悬挂句柄 */
const startedApps: INestApplication[] = [];

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

/** 测试内临时覆盖的环境变量（就地恢复，避免跨用例污染宿主环境） */
let savedEnv: Record<string, string | undefined> = {};

/**
 * 用真实配置来源驱动真实装配：把覆盖值写进 `process.env`，装配结束后逐键还原。
 *
 * 为什么不用 DI 覆盖 `APP_ENV`：`@nestjs/testing` 不在本项目依赖里（本切片不新增依赖）。
 * 而 `ConfigModule` 与 `DATABASE_CONFIG` 都从 `process.env` 解析同一份配置，
 * 所以直接设置环境变量既真实、也不会出现「应用实际使用的配置」与「判定用的配置」漂移。
 */
function applyEnv(overrides: Record<string, string | undefined>): void {
  savedEnv = {};
  for (const [key, value] of Object.entries(overrides)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv = {};
}

/** 真实装配（捕获式错误处理）：生产环境必须在装配阶段失败 */
function assemble(): Promise<INestApplication> {
  return createApp({ abortOnError: false });
}

/** 断言真实装配 fail-closed，并返回错误（供逐条断言错误消息） */
async function captureInitFailure(): Promise<Error> {
  let captured: unknown;
  try {
    const app = await assemble();
    startedApps.push(app);
  } catch (error) {
    captured = error;
  }
  if (!(captured instanceof Error)) {
    throw new Error('测试前置失败：期望装配阶段 fail-closed，但没有抛出错误');
  }
  return captured;
}

function httpGet(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: IncomingHttpHeaders }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(`${baseUrl}${path}`, { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = text;
        }
        resolvePromise({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    });
    req.on('error', rejectPromise);
    req.end();
  });
}

describe('启动装配：配置来源边界（默认导入路径不变）', () => {
  it('未显式提供配置时读取 process.env：测试/开发环境允许无数据库装配', async () => {
    const app = await assemble();
    startedApps.push(app);
    expect(app.get(APP_ENV)).toMatchObject({ NODE_ENV: expect.any(String) });
  });
});

describe('启动装配：生产环境 fail-closed', () => {
  it('生产环境未配置 DATABASE_URL：装配阶段即失败（不进入监听，也不连接任何数据库）', async () => {
    applyEnv({ NODE_ENV: 'production', DATABASE_URL: undefined, DATABASE_SSL: undefined });
    try {
      const error = await captureInitFailure();

      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect((error as DatabaseConfigError).code).toBe('DATABASE_URL_REQUIRED_IN_PRODUCTION');
      expect(error.message).toContain('生产环境必须配置 DATABASE_URL');
    } finally {
      restoreEnv();
    }
  });

  it('生产环境远端主机未启用 TLS（DATABASE_SSL=false）：装配阶段即失败，且不回显口令', async () => {
    applyEnv({ NODE_ENV: 'production', DATABASE_URL: REMOTE_URL, DATABASE_SSL: 'false' });
    try {
      const error = await captureInitFailure();

      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect((error as DatabaseConfigError).code).toBe('DATABASE_SSL_DISABLED_FOR_REMOTE_HOST');
      expect(error.message).toContain('生产环境禁止对非回环主机关闭 TLS');
      expect(error.message).not.toContain(FAKE_PASSWORD);
      expect(error.message).not.toContain('rm_user');
    } finally {
      restoreEnv();
    }
  });

  it('生产环境远端主机未设置 DATABASE_SSL：安全默认只是 require，按未验证身份拒绝启动', async () => {
    applyEnv({ NODE_ENV: 'production', DATABASE_URL: REMOTE_URL, DATABASE_SSL: undefined });
    try {
      // 「未配置 TLS」不再被上层默认成显式 false：解析结果必须是 require（远端主机安全默认值）；
      // 但生产只接受 verify-full ⇒ 缺配置同样 fail-closed（见下方用例）
      expect(loadEnv().DATABASE_SSL).toBeUndefined();
      expect(loadEnv().DATABASE_SSL_MODE).toBeUndefined();

      const error = await captureInitFailure();
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect((error as DatabaseConfigError).code).toBe('DATABASE_TLS_NOT_VERIFIED_IN_PRODUCTION');
      expect(error.message).toContain('verify-full');
      expect(error.message).not.toContain(FAKE_PASSWORD);
      expect(error.message).not.toContain('rm_user');
    } finally {
      restoreEnv();
    }
  });

  it('生产环境配置齐全（verify-full TLS）：装配仍 fail-closed，未验证 SQL 执行器与内存基线都不允许上线', async () => {
    applyEnv({
      NODE_ENV: 'production',
      DATABASE_URL: REMOTE_URL,
      DATABASE_SSL_MODE: 'verify-full',
      DATABASE_POOL_MAX: '10',
    });
    try {
      const error = await captureInitFailure();

      expect(error).not.toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toContain('生产环境禁止使用内存');
      expect(error.message).not.toContain(FAKE_PASSWORD);
      expect(error.message).not.toContain('rm_user');
    } finally {
      restoreEnv();
    }
  });
});

describe('启动装配：未验证 SQL 执行器（不建立任何连接）', () => {
  it('生产配置可解析出连接串，但真实装配出来的工厂仍是 fail-closed 的未验证驱动', async () => {
    const resolution = resolveDatabaseConfig({
      NODE_ENV: 'production',
      DATABASE_URL: REMOTE_URL,
      DATABASE_SSL_MODE: 'verify-full',
    });
    expect(resolution).toMatchObject({ status: 'configured', config: { ssl: 'verify-full' } });
    if (resolution.status !== 'configured') {
      throw new Error('测试前置失败：配置应为 configured');
    }

    applyEnv({
      NODE_ENV: 'test',
      DATABASE_URL: undefined,
      DATABASE_SSL: undefined,
      DATABASE_SSL_MODE: undefined,
    });
    try {
      const app = await assemble();
      startedApps.push(app);

      const factory = app.get(SQL_CONNECTION_FACTORY);
      expect(factory.capabilities).toEqual({
        backend: UNVERIFIED_DRIVER_BACKEND,
        persistent: false,
        productionReady: false,
      });
      await expect(factory.connect(resolution.config)).rejects.toBeInstanceOf(
        DatabaseUnavailableError,
      );
    } finally {
      restoreEnv();
    }
  });
});

describe('启动装配：DATABASE_URL 存在时的 SQL 执行器 attest 门禁', () => {
  /**
   * 与生产同构的配置，但 `NODE_ENV=test`：门禁口径是「数据库存在」而不是「环境名叫 production」，
   * 因此这里必须同样 fail-closed。
   */
  const CONFIGURED_REMOTE = {
    DATABASE_URL: REMOTE_URL,
    DATABASE_SSL_MODE: 'verify-full',
    DATABASE_POOL_MAX: '10',
  } as const;

  it('测试环境配置了 DATABASE_URL：两道门禁都在真实装配里存在，且依赖就绪门禁先触发', async () => {
    applyEnv({ NODE_ENV: 'test', ...CONFIGURED_REMOTE });
    try {
      // 配置本身合法：失败必须来自门禁，而不是配置解析。
      expect(resolveDatabaseConfig(loadEnv())).toMatchObject({
        status: 'configured',
        config: { ssl: 'verify-full' },
      });

      // 先只 create（不 init）：此时引导钩子尚未执行，可以直接观察**能力边界与执行器契约**仍然
      // 拒绝默认装配（未验证驱动工厂没有 attest 事实）。
      const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
      try {
        const boundary = app.get(PersistenceBoundaryService);
        expect(boundary.readinessReport()).toBeUndefined();

        // 换绑事实（在 init 之前即可观察）：配置了 DATABASE_URL ⇒ SESSION_STORE 不再是内存基线，
        // 而是如实声明「持久 + 未验证」的 PostgreSQL 实现，且装配阶段**没有**建立任何连接。
        const store = app.get<SessionStore>(SESSION_STORE);
        expect(store.capabilities).toEqual(POSTGRES_SESSION_STORE_CAPABILITIES);
        expect(store.capabilities).not.toEqual({
          backend: 'in-memory-baseline',
          persistent: false,
          productionReady: false,
        });

        // 同一装配、同一时刻：**学生画像仓储**也按「是否配置数据库」换绑到 PostgreSQL 实现
        // （绑定登记表 `POSTGRES_BOUND_SLICE_REGISTRY` 的第 3 个切片）。它同样延迟建连，因此
        // 这里能观察到「如实声明持久 + 未验证」的能力声明，而不是内存基线 —— 这正是
        // 「数据库已配置 ⇒ 业务端口不再是内存实现」这条运行路径的证据。
        const profiles = app.get<ProfileRepository>(PROFILE_REPOSITORY);
        expect(profiles).not.toBeInstanceOf(InMemoryProfileRepository);
        expect(profiles.capabilities).toEqual(POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES);

        // 同一装配、同一时刻：**成果仓储**也按同一分流口径换绑（登记表里的第 2 个切片）。
        // 它同样延迟建连 —— 因此这里既不出现内存基线，也不会因为装配而建连接；
        // 这正是本切片要求的运行路径证据：「数据库已配置 ⇒ ACHIEVEMENT_REPOSITORY 走 PostgreSQL 实现」。
        const achievements = app.get<AchievementRepository>(ACHIEVEMENT_REPOSITORY);
        expect(achievements).not.toBeInstanceOf(InMemoryAchievementRepository);
        expect(achievements.capabilities).toEqual(POSTGRES_ACHIEVEMENT_REPOSITORY_CAPABILITIES);

        // 同一装配、同一时刻：**升学记录仓储**同样按「是否配置数据库」换绑（登记表里的第 3 个切片），
        // 且同样延迟建连。这正是本切片要求的运行路径证据：
        // 「数据库已配置 ⇒ EDUCATION_RECORD_REPOSITORY 走 PostgreSQL 实现，而不是内存基线」。
        const education = app.get<EducationRecordRepository>(EDUCATION_RECORD_REPOSITORY);
        expect(education).not.toBeInstanceOf(InMemoryEducationRecordRepository);
        expect(education.capabilities).toEqual(POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES);
        // 换绑后仍是「持久 + 未验证」：装配期不建连，因此没有可用的数据库连接被观察为成功。
        expect(education.capabilities.persistent).toBe(true);
        expect(education.capabilities.productionReady).toBe(false);

        // 同一装配、同一时刻：**入组申请仓储**同样按「是否配置数据库」换绑（登记表里的第 4 个切片），
        // 且同样延迟建连。这正是本切片要求的运行路径证据：
        // 「数据库已配置 ⇒ APPLICATION_REPOSITORY 走 PostgreSQL 实现，而不是内存基线」。
        const applications = app.get<ApplicationRepository>(APPLICATION_REPOSITORY);
        expect(applications).not.toBeInstanceOf(InMemoryApplicationRepository);
        expect(applications.capabilities).toEqual(POSTGRES_APPLICATION_REPOSITORY_CAPABILITIES);
        expect(applications.capabilities.persistent).toBe(true);
        expect(applications.capabilities.productionReady).toBe(false);
        // 换绑后仍是「持久 + 未验证」：非 UUID 的会话主体在进 SQL 之前就被拒绝，
        // 这一判断发生在**任何连接之前**（否则这里会拿到连接错误而不是存储 ID 域错误）。
        await expect(applications.listByUserId('u-student-1')).rejects.toMatchObject({
          code: 'INVALID_SUBJECT',
        });

        // 同一装配、同一时刻：**审计仓储**同样按「是否配置数据库」换绑（登记表里的第 7 个切片），
        // 且同样延迟建连。这正是本切片要求的运行路径证据：
        // 「数据库已配置 ⇒ AUDIT_REPOSITORY 走 PostgreSQL 实现，而不是内存基线」。
        const audit = app.get<AuditRepository>(AUDIT_REPOSITORY);
        expect(audit).not.toBeInstanceOf(InMemoryAuditRepository);
        expect(audit.capabilities).toEqual(POSTGRES_AUDIT_REPOSITORY_CAPABILITIES);
        expect(audit.capabilities.persistent).toBe(true);
        expect(audit.capabilities.productionReady).toBe(false);
        // 换绑后仍是「持久 + 未验证」：非 UUID 的会话主体在解析执行器之前就被拒绝，
        // 因此这里拿到的是存储 ID 域错误，而不是连接错误（装配与调用都没有建连）。
        await expect(audit.listVisibleByActor('u-student-1')).rejects.toMatchObject({
          code: 'INVALID_SUBJECT',
        });

        // 同一装配、同一时刻：**合规状态仓储**同样按「是否配置数据库」换绑（登记表里的已绑定切片），
        // 且同样延迟建连。这正是本切片要求的运行路径证据：
        // 「数据库已配置 ⇒ COMPLIANCE_REPOSITORY 走 PostgreSQL 实现，而不是内存基线」。
        const compliance = app.get<ComplianceRepository>(COMPLIANCE_REPOSITORY);
        expect(compliance).not.toBeInstanceOf(InMemoryComplianceRepository);
        expect(compliance.capabilities).toEqual(POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES);
        expect(compliance.capabilities.persistent).toBe(true);
        expect(compliance.capabilities.productionReady).toBe(false);
        // 换绑后仍是「持久 + 未验证」：非 UUID 的会话主体在**解析执行器之前**就被拒绝，
        // 因此这里拿到的是存储 ID 域错误，而不是连接错误（装配与调用都没有建连）。
        await expect(compliance.findByUserId('u-student-1')).rejects.toMatchObject({
          code: 'INVALID_SUBJECT',
        });

        let boundaryError: unknown;
        try {
          boundary.verify();
        } catch (error) {
          boundaryError = error;
        }
        expect(boundaryError).toBeInstanceOf(PersistenceBoundaryError);
        expect((boundaryError as PersistenceBoundaryError).message).toContain(
          'SQL_CONNECTION_FACTORY[SQL_EXECUTOR_VERIFICATION_FAILED]',
        );

        // 再 init：引导钩子按「依赖就绪（认证 → 业务）→ 能力边界」执行，因此这里先拿到的是
        // **认证依赖就绪**的拒绝。会话存储已按「是否配置数据库」换绑到 PostgreSQL 实现（延迟建连），
        // 它如实声明 persistent=true / productionReady=false，因此在生效档位被判「未验证」——
        // 注意这与「内存基线」是**不同的违规码**，两者的区分正是「换绑确实发生了」的证据。
        let initError: unknown;
        try {
          await app.init();
        } catch (error) {
          initError = error;
        }
        expect(initError).toBeInstanceOf(DependencyReadinessError);
        expect((initError as DependencyReadinessError).message).toContain(
          'SESSION_STORE[DEPENDENCY_NOT_VERIFIED]',
        );
        // 顺序证据：默认工厂的 connect 会抛 DatabaseUnavailableError；若门禁之前先建连接，
        // 这里拿到的就会是 DatabaseUnavailableError。断言不是它 ⇒ 判定先于任何连接。
        expect(initError).not.toBeInstanceOf(DatabaseUnavailableError);
        // 装配失败信息只承载端口名与契约码，不回显口令/用户名/主机
        for (const secret of [FAKE_PASSWORD, 'rm_user', REMOTE_HOST]) {
          expect((initError as Error).message).not.toContain(secret);
          expect((boundaryError as Error).message).not.toContain(secret);
        }
      } finally {
        await app.close();
      }
    } finally {
      restoreEnv();
    }
  });

  it('生产环境配置齐全：装配仍 fail-closed，且不回显口令/主机（执行器门禁在服务级用例覆盖）', async () => {
    applyEnv({ NODE_ENV: 'production', ...CONFIGURED_REMOTE });
    try {
      const error = await captureInitFailure();

      // 生产环境下内存基线仓储在实例化阶段就拒绝构造（早于引导钩子），因此这里拿到的是
      // 仓储自身的错误；关键是：既不是配置错误，也不是连接错误（门禁不会先建连接）。
      expect(error).not.toBeInstanceOf(DatabaseConfigError);
      expect(error).not.toBeInstanceOf(DatabaseUnavailableError);
      expect(error.message).toContain('生产环境禁止使用内存');
      expect(error.message).not.toContain(FAKE_PASSWORD);
      expect(error.message).not.toContain('rm_user');
      expect(error.message).not.toContain(REMOTE_HOST);
    } finally {
      restoreEnv();
    }
  });

  it('无数据库时门禁不生效：未验证执行器仍可装配（无数据库默认启动不受影响）', async () => {
    applyEnv({ NODE_ENV: 'test', DATABASE_URL: undefined, DATABASE_SSL: undefined });
    try {
      const app = await assemble();
      startedApps.push(app);

      expect(app.get(PersistenceBoundaryService).verify().ok).toBe(true);
      // 依赖就绪门禁在无数据库的开发/测试环境**不读取任何端口**：档位 not-required、零检查
      const readiness = app.get(PersistenceBoundaryService).readinessReport();
      expect(readiness).toMatchObject({
        ok: true,
        tier: 'not-required',
        authentication: 'not-required',
        business: 'not-required',
        checkedTokens: [],
        violations: [],
      });
      // 仍然没有任何真实驱动接入：默认工厂如实声明未验证驱动
      expect(app.get(SQL_CONNECTION_FACTORY).capabilities).toMatchObject({
        backend: UNVERIFIED_DRIVER_BACKEND,
        persistent: false,
        productionReady: false,
      });
    } finally {
      restoreEnv();
    }
  });
});

describe('启动装配：开发/测试环境不被未配置数据库破坏', () => {
  it('测试环境未配置 DATABASE_URL：真实装配可 init + listen，既有路由保持可用', async () => {
    applyEnv({ NODE_ENV: 'test', DATABASE_URL: '', DATABASE_SSL: undefined });
    try {
      expect(loadEnv().DATABASE_URL).toBeUndefined();

      const app = await createApp({ setGlobalPrefix: false, abortOnError: false });
      startedApps.push(app);
      await app.listen(0, '127.0.0.1');
      const baseUrl = await app.getUrl();

      const health = await httpGet(baseUrl, '/health');
      expect(health.status).toBe(200);
      expect((health.body as ApiEnvelope<unknown>).error).toBeNull();

      const runtimeInfo = await httpGet(baseUrl, '/runtime-info');
      expect(runtimeInfo.status).toBe(200);
      const data = (runtimeInfo.body as ApiEnvelope<Record<string, unknown>>).data;
      if (data === null) {
        throw new Error('测试前置失败：/runtime-info 响应缺少 data');
      }
      // 字段闭集：新增依赖就绪门禁档位后仍是同一份白名单（对外只有脱敏状态）
      expect(Object.keys(data).sort()).toEqual([
        'aiMatchingEnabled',
        'aiProvider',
        'apiPort',
        'apiPrefix',
        'databaseConfigured',
        'dependencyGate',
        'nodeEnv',
      ]);
      expect(data.databaseConfigured).toBe(false);
      // 无数据库 ⇒ 门禁档位 not-required，档位口径来自与启动门禁同一个函数
      expect(data.dependencyGate).toBe('not-required');
    } finally {
      restoreEnv();
    }
  });

  it('开发环境远端主机未设置 DATABASE_SSL：仍按安全默认值要求 TLS（不因本次改动变化）', () => {
    const remote = resolveDatabaseConfig({ NODE_ENV: 'development', DATABASE_URL: REMOTE_URL });
    expect(remote).toMatchObject({ status: 'configured', config: { ssl: 'require' } });

    const loopback = resolveDatabaseConfig({ NODE_ENV: 'development', DATABASE_URL: LOOPBACK_URL });
    expect(loopback).toMatchObject({ status: 'configured', config: { ssl: 'disable' } });
  });

  it('测试环境装配后持久化边界校验通过（内存基线在非生产环境放行）', async () => {
    applyEnv({ NODE_ENV: 'test', DATABASE_URL: undefined, DATABASE_SSL: undefined });
    try {
      const app = await assemble();
      startedApps.push(app);
      const boundary = app.get(PersistenceBoundaryService);
      expect(boundary.verify().ok).toBe(true);
      // 引导钩子已执行：门禁档位 not-required，且没有读取任何端口（无数据库默认启动保持现状）
      expect(boundary.readinessReport()).toMatchObject({
        tier: 'not-required',
        checkedTokens: [],
      });
    } finally {
      restoreEnv();
    }
  });

  it('未配置数据库：SESSION_STORE 仍是内存基线，且默认空存储不提供任何隐式会话', async () => {
    applyEnv({ NODE_ENV: 'test', DATABASE_URL: undefined, DATABASE_SSL: undefined });
    try {
      const app = await assemble();
      startedApps.push(app);

      const store = app.get<SessionStore>(SESSION_STORE);
      expect(store.capabilities).toEqual({
        backend: 'in-memory-baseline',
        persistent: false,
        productionReady: false,
      });

      // 「认证先于业务」在真实装配上的最小证据：未 seed 时任何票据都解析不到主体（→ 401）
      const resolver = app.get<SessionSubjectResolver>(SESSION_SUBJECT_RESOLVER);
      await expect(resolver.resolveSubject('Bearer session-student-1')).resolves.toBeUndefined();
      await expect(resolver.resolveSubject(undefined)).resolves.toBeUndefined();
    } finally {
      restoreEnv();
    }
  });

  it('未配置数据库：APPLICATION_REPOSITORY 落在内存基线（分流点生效，而不是「永远绑定数据库」）', async () => {
    applyEnv({ NODE_ENV: 'test', DATABASE_URL: undefined, DATABASE_SSL: undefined });
    try {
      const app = await assemble();
      startedApps.push(app);

      const repository = app.get<ApplicationRepository>(APPLICATION_REPOSITORY);
      expect(repository).toBeInstanceOf(InMemoryApplicationRepository);
      expect(repository.capabilities).toEqual({
        backend: 'in-memory-baseline',
        persistent: false,
        productionReady: false,
      });
    } finally {
      restoreEnv();
    }
  });

  it('未配置数据库：AUDIT_REPOSITORY 落在内存基线（无数据库继续内存实现，本切片不改变默认启动）', async () => {
    applyEnv({ NODE_ENV: 'test', DATABASE_URL: undefined, DATABASE_SSL: undefined });
    try {
      const app = await assemble();
      startedApps.push(app);

      const repository = app.get<AuditRepository>(AUDIT_REPOSITORY);
      expect(repository).toBeInstanceOf(InMemoryAuditRepository);
      expect(repository.capabilities).toEqual({
        backend: 'in-memory-baseline',
        persistent: false,
        productionReady: false,
      });
      // 端口的异步契约：无数据库时同样返回 Promise（两条路径可被同一组用例覆盖）
      await expect(repository.listVisibleByActor('u-nobody')).resolves.toEqual([]);
    } finally {
      restoreEnv();
    }
  });
});

/**
 * 容器健康检查路径回归：`createApp()` 的**默认**装配必须真的把 `API_PREFIX` 应用到路由上。
 *
 * 为什么单独立一组：`createApp` 曾经先 `init()` 再 `setGlobalPrefix()`，而 Nest 的
 * `registerRouter()` 在注册路由时读取前缀（@nestjs/core `nest-application.js`），
 * 于是构建产物以**不带前缀**的路径服务（`/health` 200、`/api/v1/health` 404），
 * 容器健康检查（探针打 `<API_PREFIX>/health`）永远不可能通过 —— 这个缺陷只能由
 * 「走默认 `createApp()` 并真实 `listen` 后按前缀访问」的用例守住，上面的
 * `setGlobalPrefix: false` 用例按设计绕开了前缀，捕捉不到。
 */
describe('启动装配：默认装配应用全局前缀（容器健康检查路径）', () => {
  it('默认 createApp：<API_PREFIX>/health 可用、无前缀路径不可用', async () => {
    applyEnv({
      NODE_ENV: 'test',
      DATABASE_URL: undefined,
      DATABASE_SSL: undefined,
      API_PREFIX: '/api/v1',
    });
    try {
      const app = await createApp({ abortOnError: false });
      startedApps.push(app);
      await app.listen(0, '127.0.0.1');
      const baseUrl = await app.getUrl();

      const prefixed = await httpGet(baseUrl, '/api/v1/health');
      expect(prefixed.status).toBe(200);
      expect((prefixed.body as ApiEnvelope<unknown>).error).toBeNull();

      // 前缀生效的**反证**：无前缀路径必须不存在，否则前缀只是被额外接受了一次
      const unprefixed = await httpGet(baseUrl, '/health');
      expect(unprefixed.status).toBe(404);
    } finally {
      restoreEnv();
    }
  });

  it('自定义 API_PREFIX：探针路径跟随配置而非硬编码', async () => {
    applyEnv({
      NODE_ENV: 'test',
      DATABASE_URL: undefined,
      DATABASE_SSL: undefined,
      API_PREFIX: '/internal-api',
    });
    try {
      const app = await createApp({ abortOnError: false });
      startedApps.push(app);
      await app.listen(0, '127.0.0.1');
      const baseUrl = await app.getUrl();

      const prefixed = await httpGet(baseUrl, '/internal-api/health');
      expect(prefixed.status).toBe(200);

      // 旧默认前缀在改配置后不再可用：证明前缀来自运行时配置，不是两套并存
      const previousDefault = await httpGet(baseUrl, '/api/v1/health');
      expect(previousDefault.status).toBe(404);
    } finally {
      restoreEnv();
    }
  });
});

/**
 * 安全响应头在**真实启动链路**上的回归。
 *
 * 与 `common/security-headers.spec.ts` 的分工：那里用最小模块覆盖「生产 + 已确认 HTTPS ⇒
 * 真的发出 HSTS」等条件分支（`AppModule` 在生产档位按设计 fail-closed，无法起监听）；
 * 这里走**默认 `createApp()` + 真实 listen + 真实 HTTP**，守住三件只能在这一层观察到的事：
 * 1. 装配真的把中间件挂上了（`applySecurityHeaders` 被调用，且早于路由注册 ⇒ 404 也带头）；
 * 2. 非生产档位即使配置了 https 公开地址也不发 HSTS；
 * 3. CORS 保持默认关闭：带 `Origin` 的请求不出现任何 `Access-Control-Allow-*`、不回显来源。
 */
describe('启动装配：安全响应头与 CORS 默认关闭（真实 HTTP）', () => {
  it('测试环境真实装配：/health 与 404 都带安全响应头，且配置了 https 也不发 HSTS', async () => {
    applyEnv({
      NODE_ENV: 'test',
      DATABASE_URL: undefined,
      DATABASE_SSL: undefined,
      API_PREFIX: '/api/v1',
      // 显式给一个 https 公开地址：HSTS 仍然不出现，证明闸门是**环境档位**而不是「没配置」
      API_PUBLIC_URL: 'https://api.example.com',
    });
    try {
      const app = await createApp({ abortOnError: false });
      startedApps.push(app);
      await app.listen(0, '127.0.0.1');
      const baseUrl = await app.getUrl();

      const health = await httpGet(baseUrl, '/api/v1/health');
      expect(health.status).toBe(200);
      expect(health.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
      expect(health.headers['x-content-type-options']).toBe('nosniff');
      expect(health.headers['x-frame-options']).toBe('DENY');
      expect(health.headers['referrer-policy']).toBe('no-referrer');
      expect(health.headers['permissions-policy']).toContain('camera=()');
      // 开发/测试的 HTTP 上绝不设置 HSTS（否则会把开发机锁死，也是错误的 HTTPS 承诺）
      expect(health.headers['strict-transport-security']).toBeUndefined();
      // JSON API 不受安全头影响：状态码与响应信封保持原样
      expect((health.body as ApiEnvelope<unknown>).error).toBeNull();

      // 未命中路由（含前缀之外的路径）同样带头：中间件必须先于路由注册
      const missing = await httpGet(baseUrl, '/definitely-not-a-route');
      expect(missing.status).toBe(404);
      expect(missing.headers['x-content-type-options']).toBe('nosniff');
      expect(missing.headers['x-frame-options']).toBe('DENY');
      expect(missing.headers['content-security-policy']).toContain("default-src 'none'");
      expect(missing.headers['strict-transport-security']).toBeUndefined();
    } finally {
      restoreEnv();
    }
  });

  it('带 Origin 的跨源请求：不回显 Origin、不出现 Access-Control-Allow-*', async () => {
    applyEnv({ NODE_ENV: 'test', DATABASE_URL: undefined, DATABASE_SSL: undefined });
    try {
      const app = await createApp({ setGlobalPrefix: false, abortOnError: false });
      startedApps.push(app);
      await app.listen(0, '127.0.0.1');
      const baseUrl = await app.getUrl();

      const crossOrigin = await httpGet(baseUrl, '/health', {
        Origin: 'https://admin.example.com',
      });
      expect(crossOrigin.status).toBe(200);

      for (const name of [
        'access-control-allow-origin',
        'access-control-allow-credentials',
        'access-control-allow-methods',
        'access-control-allow-headers',
        'access-control-expose-headers',
        'access-control-max-age',
      ]) {
        expect(crossOrigin.headers[name]).toBeUndefined();
      }
      // 来源只在请求里，绝不出现在响应里（本用例的 Origin 是唯一出现该字符串的地方）
      expect(JSON.stringify(crossOrigin.headers)).not.toContain('admin.example.com');
      // 安全头仍必须存在：CORS 关闭不是「什么都不做」
      expect(crossOrigin.headers['x-content-type-options']).toBe('nosniff');
      // 不泄露值：头值都是固定常量，不含数据库/密钥等配置片段
      const serialized = JSON.stringify(crossOrigin.headers);
      expect(serialized).not.toMatch(/postgres|password|secret|bearer|token/iu);
    } finally {
      restoreEnv();
    }
  });
});
