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

  it('裸 host:port 与 IPv4:port 拓扑信息被拦下，且不误伤 ISO 时间戳', () => {
    for (const detail of ['db.internal:5432', '10.0.0.1:5432', '连接 localhost:3000 失败']) {
      expect(findSensitiveOutput({ detail })).toEqual([
        { path: 'data.detail', kind: 'internal-path' },
      ]);
    }
    expect(findSensitiveOutput({ detail: '2026-01-01T00:00:00.000Z' })).toEqual([]);
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

  it('连接配置字段名的大小写与分隔符变体一律命中（DATABASE_URL / connectionString / api_key）', () => {
    for (const field of [
      'DATABASE_URL',
      'database_url',
      'databaseUrl',
      'connectionString',
      'connection_string',
      'API_KEY',
      'apiKey',
      'api_key',
      'PRIVATE_KEY',
      'VERIFIED_AT',
    ]) {
      expect(findSensitiveOutput({ [field]: 'x' }), field).toEqual([
        { path: `data.${field}`, kind: 'evidence-field' },
      ]);
    }
    // 反向：正常运维字段名不会被这条规则误判
    expect(findSensitiveOutput({ databaseConfigured: true })).toEqual([]);
    expect(findSensitiveOutput({ dependencyGate: 'required', aiMatchingEnabled: true })).toEqual(
      [],
    );
  });

  it('owner / user 标识字段名（camelCase 与 snake_case）一律拦下', () => {
    for (const [payload, path] of [
      [{ userId: 'x' }, 'data.userId'],
      [{ user_id: 'x' }, 'data.user_id'],
      [{ ownerId: 'x' }, 'data.ownerId'],
      [{ owner_id: 'x' }, 'data.owner_id'],
      [{ ownerUserId: 'x' }, 'data.ownerUserId'],
      [{ leaderUserId: 'x' }, 'data.leaderUserId'],
      [{ reviewedByUserId: 'x' }, 'data.reviewedByUserId'],
      [{ createdAt: 1, targetUserIds: ['x'] }, 'data.targetUserIds'],
    ] as const) {
      expect(findSensitiveOutput(payload), path).toContainEqual({ path, kind: 'owner-id' });
    }
  });

  it('owner / user 标识字面量同样拦下（会话基线的 u-… 主体 ID）', () => {
    expect(findSensitiveOutput({ detail: '主体 u-student-1 未就绪' })).toEqual([
      { path: 'data.detail', kind: 'owner-id' },
    ]);
    expect(findSensitiveOutput({ detail: '已连接 userId=u-victim-9' })).toEqual([
      { path: 'data.detail', kind: 'owner-id' },
    ]);
    // 边界：普通英文词、ISO 时间戳与 UUID 请求 ID 不会被误判为主体 ID
    expect(
      findSensitiveOutput({
        timestamp: '2026-01-01T00:00:00.000Z',
        requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        version: '0.1.0',
        backend: 'in-memory-baseline',
      }),
    ).toEqual([]);
  });

  it('provider 名称（真实第三方品牌与模型族）拦下，本项目枚举取值放行', () => {
    for (const provider of [
      'openai',
      'OpenAI',
      'anthropic',
      'claude',
      'gemini',
      'deepseek',
      'gpt-4o-mini',
      'qwen',
      'glm',
      'azure',
      'ollama',
    ]) {
      expect(findSensitiveOutput({ detail: `上游 ${provider} 不可达` })).toEqual([
        { path: 'data.detail', kind: 'provider-name' },
      ]);
    }
    // 脱敏事实（本项目自己的枚举）不是供应商身份
    expect(findSensitiveOutput({ aiProvider: 'mock' })).toEqual([]);
    expect(findSensitiveOutput({ aiProvider: 'http-json' })).toEqual([]);
    expect(findSensitiveOutput({ aiProvider: 'disabled' })).toEqual([]);
  });

  it('原始异常（堆栈帧、依赖路径、Error: 文本与异常字段名）一律拦下', () => {
    expect(
      findSensitiveOutput({ detail: 'boom\n    at Object.<anonymous> (/app/dist/x.js:1:1)' }),
    ).toEqual([{ path: 'data.detail', kind: 'raw-exception' }]);
    expect(findSensitiveOutput({ detail: '异常来源 node_modules/pg/lib/index.js' })).toEqual([
      { path: 'data.detail', kind: 'raw-exception' },
    ]);
    expect(findSensitiveOutput({ message: 'TypeError: x is not a function' })).toEqual([
      { path: 'data.message', kind: 'raw-exception' },
    ]);
    for (const field of ['stack', 'stackTrace', 'exception', 'cause']) {
      expect(findSensitiveOutput({ [field]: 'x' }), field).toEqual([
        { path: `data.${field}`, kind: 'raw-exception' },
      ]);
    }
    // 边界：异常**类名**（无冒号、无堆栈）是可安全写法，不误伤
    expect(findSensitiveOutput({ detail: 'DependencyReadinessError' })).toEqual([]);
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
