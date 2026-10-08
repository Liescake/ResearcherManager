import 'reflect-metadata';
import { request } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { ApiEnvelope } from '@rm/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_ENV } from './config/config.module';
import { loadEnv } from './config/env';
import { DatabaseConfigError, resolveDatabaseConfig } from './db/config/database-config';
import { PersistenceBoundaryService } from './db/database.module';
import {
  DatabaseUnavailableError,
  SQL_CONNECTION_FACTORY,
  UNVERIFIED_DRIVER_BACKEND,
} from './db/ports/sql-executor.port';
import { createApp } from './main';

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

function httpGet(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(`${baseUrl}${path}`, { method: 'GET' }, (res) => {
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
        resolvePromise({ status: res.statusCode ?? 0, body });
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

  it('生产环境远端主机未设置 DATABASE_SSL：按安全默认要求 TLS，装配失败原因是内存基线', async () => {
    applyEnv({ NODE_ENV: 'production', DATABASE_URL: REMOTE_URL, DATABASE_SSL: undefined });
    try {
      // 「未配置 TLS」不再被上层默认成显式 false：解析结果必须是 require（远端主机安全默认值）
      expect(loadEnv().DATABASE_SSL).toBeUndefined();
      const resolution = resolveDatabaseConfig(loadEnv());
      expect(resolution).toMatchObject({ status: 'configured', config: { ssl: 'require' } });

      // 配置合法 ⇒ 装配失败来自「生产环境不得以内存基线承担存储」（与未验证 SQL 执行器同一条边界）
      const error = await captureInitFailure();
      expect(error).not.toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toContain('生产环境禁止使用内存');
      expect(error.message).not.toContain(FAKE_PASSWORD);
      expect(error.message).not.toContain('rm_user');
    } finally {
      restoreEnv();
    }
  });

  it('生产环境配置齐全（TLS 打开）：装配仍 fail-closed，未验证 SQL 执行器与内存基线都不允许上线', async () => {
    applyEnv({
      NODE_ENV: 'production',
      DATABASE_URL: REMOTE_URL,
      DATABASE_SSL: 'true',
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
      DATABASE_SSL: 'true',
    });
    expect(resolution).toMatchObject({ status: 'configured', config: { ssl: 'require' } });
    if (resolution.status !== 'configured') {
      throw new Error('测试前置失败：配置应为 configured');
    }

    applyEnv({ NODE_ENV: 'test', DATABASE_URL: undefined, DATABASE_SSL: undefined });
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
      // 字段闭集不变（既有路由契约不受本次改动影响）
      expect(Object.keys(data).sort()).toEqual([
        'aiMatchingEnabled',
        'aiProvider',
        'apiPort',
        'apiPrefix',
        'databaseConfigured',
        'nodeEnv',
      ]);
      expect(data.databaseConfigured).toBe(false);
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
      expect(app.get(PersistenceBoundaryService).verify().ok).toBe(true);
    } finally {
      restoreEnv();
    }
  });
});
