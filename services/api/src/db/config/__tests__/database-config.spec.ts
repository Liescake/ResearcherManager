import { describe, expect, it } from 'vitest';
import {
  DatabaseConfigError,
  describeDatabaseConfig,
  isLoopbackHost,
  redactDatabaseUrl,
  resolveDatabaseConfig,
} from '../database-config';

/** 捕获并断言 `DatabaseConfigError`，同时校验错误码 */
function captureConfigError(run: () => unknown): DatabaseConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof DatabaseConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error('期望抛出 DatabaseConfigError，但未抛出');
}

const REMOTE_URL = 'postgresql://rm_user:sup3r-s3cret@db.example.com:5432/researcher_manager';
const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';

describe('resolveDatabaseConfig：配置 fail-closed', () => {
  it('开发环境未配置 DATABASE_URL 时返回 absent（允许无数据库启动）', () => {
    const resolution = resolveDatabaseConfig({ NODE_ENV: 'development' });
    expect(resolution.status).toBe('absent');
    expect(resolution).toMatchObject({ detail: expect.stringContaining('未配置 DATABASE_URL') });
  });

  it('生产环境未配置 DATABASE_URL 时拒绝解析', () => {
    const error = captureConfigError(() => resolveDatabaseConfig({ NODE_ENV: 'production' }));
    expect(error.code).toBe('DATABASE_URL_REQUIRED_IN_PRODUCTION');
    expect(error.message).toContain('生产环境必须配置 DATABASE_URL');
  });

  it('空串与纯空白视为未配置：开发环境 absent，生产环境拒绝', () => {
    expect(resolveDatabaseConfig({ NODE_ENV: 'test', DATABASE_URL: '   ' }).status).toBe('absent');
    expect(
      captureConfigError(() => resolveDatabaseConfig({ NODE_ENV: 'production', DATABASE_URL: '' }))
        .code,
    ).toBe('DATABASE_URL_REQUIRED_IN_PRODUCTION');
  });

  it('非法 URL 与不支持的协议一律抛错，且错误消息不含口令', () => {
    const invalid = captureConfigError(() => resolveDatabaseConfig({ DATABASE_URL: 'not-a-url' }));
    expect(invalid.code).toBe('DATABASE_URL_INVALID');

    const unsupported = captureConfigError(() =>
      resolveDatabaseConfig({ DATABASE_URL: 'mysql://user:pass@127.0.0.1:3306/db' }),
    );
    expect(unsupported.code).toBe('DATABASE_URL_SCHEME_UNSUPPORTED');
    expect(unsupported.message).not.toContain('pass');
  });

  it('缺少主机或库名时抛 DATABASE_URL_INCOMPLETE', () => {
    expect(
      captureConfigError(() => resolveDatabaseConfig({ DATABASE_URL: 'postgresql:///db' })).code,
    ).toBe('DATABASE_URL_INCOMPLETE');
    expect(
      captureConfigError(() =>
        resolveDatabaseConfig({ DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432' }),
      ).code,
    ).toBe('DATABASE_URL_INCOMPLETE');
  });

  it('端口非法时抛 DATABASE_URL_INVALID', () => {
    expect(
      captureConfigError(() =>
        resolveDatabaseConfig({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:70000/db' }),
      ).code,
    ).toBe('DATABASE_URL_INVALID');
  });

  it('未显式配置 TLS 时：回环主机不强制 TLS，远端主机默认要求 TLS', () => {
    const loopback = resolveDatabaseConfig({ DATABASE_URL: LOOPBACK_URL });
    expect(loopback).toMatchObject({
      status: 'configured',
      config: { ssl: 'disable', port: 5432 },
    });

    const remote = resolveDatabaseConfig({ DATABASE_URL: REMOTE_URL });
    expect(remote).toMatchObject({ status: 'configured', config: { ssl: 'require' } });
  });

  it('sslmode 查询参数生效，且宽松语义（allow/prefer）按安全优先升级', () => {
    expect(resolveDatabaseConfig({ DATABASE_URL: `${REMOTE_URL}?sslmode=disable` })).toMatchObject({
      status: 'configured',
      config: { ssl: 'disable' },
    });
    expect(
      resolveDatabaseConfig({ DATABASE_URL: `${LOOPBACK_URL}?sslmode=require` }),
    ).toMatchObject({ status: 'configured', config: { ssl: 'require' } });
    expect(resolveDatabaseConfig({ DATABASE_URL: `${LOOPBACK_URL}?sslmode=prefer` })).toMatchObject(
      { status: 'configured', config: { ssl: 'require' } },
    );
  });

  it('sslmode 取值不在允许清单内时抛 DATABASE_SSL_MODE_UNSUPPORTED', () => {
    expect(
      captureConfigError(() =>
        resolveDatabaseConfig({ DATABASE_URL: `${REMOTE_URL}?sslmode=whenever` }),
      ).code,
    ).toBe('DATABASE_SSL_MODE_UNSUPPORTED');
  });

  it('生产环境对非回环主机关闭 TLS 时拒绝解析', () => {
    const error = captureConfigError(() =>
      resolveDatabaseConfig({
        NODE_ENV: 'production',
        DATABASE_URL: REMOTE_URL,
        DATABASE_SSL: 'false',
      }),
    );
    expect(error.code).toBe('DATABASE_SSL_DISABLED_FOR_REMOTE_HOST');
    expect(error.message).not.toContain('sup3r-s3cret');
  });

  it('生产环境未显式配置 TLS（DATABASE_SSL 缺省）时：非回环主机按安全默认要求 TLS，不抛错', () => {
    // 「未配置」走安全默认值（require），不会被上层默认成显式 false 而静默降级；
    // 显式关闭 TLS 的情况由上一条用例拒绝
    expect(
      resolveDatabaseConfig({ NODE_ENV: 'production', DATABASE_URL: REMOTE_URL }),
    ).toMatchObject({ status: 'configured', config: { ssl: 'require' } });
  });

  it('生产环境允许回环地址关闭 TLS（本地/WSL 部署）', () => {
    expect(
      resolveDatabaseConfig({
        NODE_ENV: 'production',
        DATABASE_URL: LOOPBACK_URL,
        DATABASE_SSL: 'false',
      }),
    ).toMatchObject({ status: 'configured', config: { ssl: 'disable' } });
  });

  it('数值型配置非法时抛错，消息只含变量名与规则、不含取值', () => {
    const error = captureConfigError(() =>
      resolveDatabaseConfig({ DATABASE_URL: LOOPBACK_URL, DATABASE_POOL_MAX: 'abc' }),
    );
    expect(error.code).toBe('DATABASE_NUMERIC_OPTION_INVALID');
    expect(error.message).toContain('DATABASE_POOL_MAX');
    expect(error.message).not.toContain('abc');

    expect(
      captureConfigError(() =>
        resolveDatabaseConfig({ DATABASE_URL: LOOPBACK_URL, DATABASE_POOL_MAX: '0' }),
      ).code,
    ).toBe('DATABASE_NUMERIC_OPTION_INVALID');
    expect(
      captureConfigError(() =>
        resolveDatabaseConfig({
          DATABASE_URL: LOOPBACK_URL,
          DATABASE_STATEMENT_TIMEOUT_MS: '999999',
        }),
      ).code,
    ).toBe('DATABASE_NUMERIC_OPTION_INVALID');
  });

  it('数值型配置留空时使用安全默认值', () => {
    const resolution = resolveDatabaseConfig({ DATABASE_URL: LOOPBACK_URL, DATABASE_POOL_MAX: '' });
    expect(resolution).toMatchObject({
      status: 'configured',
      config: { poolMax: 10, connectTimeoutMs: 10000, statementTimeoutMs: 30000 },
    });
  });

  it('application_name 非法时抛 DATABASE_APPLICATION_NAME_INVALID', () => {
    expect(
      captureConfigError(() =>
        resolveDatabaseConfig({
          DATABASE_URL: LOOPBACK_URL,
          DATABASE_APPLICATION_NAME: 'RM API',
        }),
      ).code,
    ).toBe('DATABASE_APPLICATION_NAME_INVALID');
    expect(
      resolveDatabaseConfig({
        DATABASE_URL: LOOPBACK_URL,
        DATABASE_APPLICATION_NAME: 'rm-api-worker',
      }),
    ).toMatchObject({ status: 'configured', config: { applicationName: 'rm-api-worker' } });
  });
});

describe('describeDatabaseConfig / redactDatabaseUrl：不泄露机密', () => {
  it('摘要不含用户名、口令与原始连接串', () => {
    const resolution = resolveDatabaseConfig({ DATABASE_URL: REMOTE_URL });
    const summary = describeDatabaseConfig(resolution);
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      status: 'configured',
      host: 'db.example.com',
      database: 'researcher_manager',
    });
    expect(serialized).not.toContain('sup3r-s3cret');
    expect(serialized).not.toContain('rm_user');
    expect(serialized).not.toContain(REMOTE_URL);
    expect(String(summary.redactedUrl)).toContain('***:***@db.example.com');
  });

  it('未配置时摘要只暴露 absent', () => {
    expect(describeDatabaseConfig(resolveDatabaseConfig({ NODE_ENV: 'test' }))).toEqual({
      status: 'absent',
    });
  });

  it('脱敏覆盖 userinfo 与查询串里的口令参数，且对无法解析的输入安全', () => {
    expect(redactDatabaseUrl('postgresql://a:b@host:5432/db')).toBe(
      'postgresql://***:***@host:5432/db',
    );
    expect(redactDatabaseUrl('postgresql://host/db?password=abc&sslmode=require')).toBe(
      'postgresql://host/db?password=***&sslmode=require',
    );
    expect(redactDatabaseUrl('not a url')).toBe('not a url');
  });

  it('回环判定覆盖 127.0.0.0/8、localhost 与 ::1，且可扩展', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.8.8.8')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('db.example.com')).toBe(false);
    expect(isLoopbackHost('db.internal', ['db.internal'])).toBe(true);
  });
});
