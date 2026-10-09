import { describe, expect, it } from 'vitest';
import { describeSensitiveFindings, findSensitiveOutput } from './sensitive-output';

/**
 * 运维出口脱敏门禁的纯函数回归：既证明「敏感取值会被拦下」，也证明「合法运维载荷不被误伤」。
 * 误伤的代价是把健康探针打成 500，因此正反两个方向都必须有用例。
 */

/** 合法 /runtime-info 载荷（字段闭集 + 脱敏取值） */
const LEGAL_RUNTIME_INFO = {
  nodeEnv: 'production',
  apiPort: 8080,
  apiPrefix: '/api/v2',
  databaseConfigured: true,
  aiProvider: 'http-json',
  aiMatchingEnabled: true,
} as const;

/** 合法 /health/ready 载荷（含 detail 自由文本） */
const LEGAL_READINESS = {
  status: 'degraded',
  checks: [
    {
      name: 'database',
      status: 'not_configured',
      detail: '未配置 DATABASE_URL：P3 骨架允许无数据库启动',
    },
    { name: 'sessionSecret', status: 'not_configured', detail: '未配置 SESSION_SECRET' },
    { name: 'aiMatching', status: 'degraded', detail: 'AI 匹配未启用，走规则降级' },
  ],
} as const;

describe('findSensitiveOutput：合法运维载荷不误伤', () => {
  it('runtime-info 的脱敏字段与枚举取值全部放行', () => {
    expect(findSensitiveOutput(LEGAL_RUNTIME_INFO)).toEqual([]);
  });

  it('health/ready 的检查项与文案（含 DATABASE_URL / SESSION_SECRET 字样）全部放行', () => {
    expect(findSensitiveOutput(LEGAL_READINESS)).toEqual([]);
  });

  it('ISO 时间戳、semver 版本、前缀与连字符后端名不误判为路径或连接串', () => {
    const payload = {
      timestamp: '2026-01-01T00:00:00.000Z',
      version: '0.1.0',
      prefix: '/api/v1',
      backend: 'in-memory-baseline',
      executorBackend: 'unverified-driver',
    };
    expect(findSensitiveOutput(payload)).toEqual([]);
  });
});

describe('findSensitiveOutput：命中的敏感取值', () => {
  it('连接串（含凭据）在任何白名单字段里都会被拦下', () => {
    const findings = findSensitiveOutput({
      ...LEGAL_RUNTIME_INFO,
      nodeEnv: 'postgresql://rm_user:sup3rsecret@db.internal:5432/researcher_manager',
    });
    expect(findings).toEqual([{ path: 'data.nodeEnv', kind: 'connection-string' }]);
  });

  it('https 内部地址同样拦下（运维响应不承载任何 scheme://）', () => {
    const findings = findSensitiveOutput({
      detail: 'https://ai-internal.example.com/secret-gateway',
    });
    expect(findings).toEqual([{ path: 'data.detail', kind: 'connection-string' }]);
  });

  it('口令键值与私钥块被识别', () => {
    expect(findSensitiveOutput({ detail: 'password=hunter2' })).toEqual([
      { path: 'data.detail', kind: 'credential-pair' },
    ]);
    expect(findSensitiveOutput({ note: '-----BEGIN RSA PRIVATE KEY-----' })).toEqual([
      { path: 'data.note', kind: 'private-key' },
    ]);
  });

  it('SQL 语句被识别（不区分大小写，覆盖读写删改）', () => {
    expect(
      findSensitiveOutput({ detail: 'SELECT id, name FROM student_profile WHERE id = $1' }),
    ).toEqual([{ path: 'data.detail', kind: 'sql-statement' }]);
    expect(findSensitiveOutput({ detail: 'update audit_event set removed = true' })).toEqual([
      { path: 'data.detail', kind: 'sql-statement' },
    ]);
  });

  it('内部路径被识别（Windows 盘符、UNC、系统目录）', () => {
    expect(
      findSensitiveOutput({ detail: 'D:\\WorkSpace\\ReseacherManager\\services\\api' }),
    ).toEqual([{ path: 'data.detail', kind: 'internal-path' }]);
    expect(findSensitiveOutput({ detail: '\\\\db-01\\pgdata\\base' })).toEqual([
      { path: 'data.detail', kind: 'internal-path' },
    ]);
    expect(findSensitiveOutput({ detail: '读取 /etc/postgresql/16/main/pg_hba.conf' })).toEqual([
      { path: 'data.detail', kind: 'internal-path' },
    ]);
  });

  it('证据 / 迁移 / 连接配置字段名属于内部证据，不允许出现在运维出口', () => {
    expect(findSensitiveOutput({ evidenceId: 'ci-run-1' })).toEqual([
      { path: 'data.evidenceId', kind: 'evidence-field' },
    ]);
    expect(findSensitiveOutput({ checks: [{ readinessRef: 'run-2' }] })).toEqual([
      { path: 'data.checks[0].readinessRef', kind: 'evidence-field' },
    ]);
    expect(findSensitiveOutput({ migrationVersions: ['0001'] })).toEqual([
      { path: 'data.migrationVersions', kind: 'evidence-field' },
    ]);
  });

  it('嵌套与数组下标体现在命中路径上，便于定位且不泄露取值', () => {
    const findings = findSensitiveOutput({
      status: 'degraded',
      checks: [
        { name: 'database', status: 'ok' },
        { name: 'sessionSecret', status: 'degraded', detail: 'token: abc123' },
      ],
    });
    expect(findings).toEqual([{ path: 'data.checks[1].detail', kind: 'credential-pair' }]);
    expect(describeSensitiveFindings(findings)).toBe('data.checks[1].detail(credential-pair)');
    expect(describeSensitiveFindings(findings)).not.toContain('abc123');
  });
});

describe('findSensitiveOutput：结构化输入的健壮性', () => {
  it('自引用对象不会死循环，仍能报出同层的违规', () => {
    const cyclic: Record<string, unknown> = { detail: 'postgresql://u:p@h/db' };
    cyclic['self'] = cyclic;
    expect(findSensitiveOutput(cyclic)).toEqual([
      { path: 'data.detail', kind: 'connection-string' },
    ]);
  });

  it('超过扫描深度的嵌套按异常处理（fail-closed 而不是静默跳过）', () => {
    let deep: unknown = 'ok';
    for (let index = 0; index < 12; index += 1) {
      deep = { nested: deep };
    }
    const findings = findSensitiveOutput(deep);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('internal-path');
    expect(findings[0]?.path.startsWith('data.')).toBe(true);
  });

  it('非对象载荷不抛错（空/标量都返回空命中或直接判定）', () => {
    expect(findSensitiveOutput(undefined)).toEqual([]);
    expect(findSensitiveOutput(null)).toEqual([]);
    expect(findSensitiveOutput(42)).toEqual([]);
    expect(findSensitiveOutput('postgresql://u:p@h/db')).toEqual([
      { path: 'data', kind: 'connection-string' },
    ]);
  });
});
