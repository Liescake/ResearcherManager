import 'reflect-metadata';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import { ApiErrorCode, fail } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { describe, expect, it } from 'vitest';
import { resolveDatabaseConfig } from '../db/config/database-config';
import { DependencyReadinessService, type DependencyReadinessOptions } from '../db/database.module';
import {
  createDependencyReadinessRegistry,
  evaluateDependencyReadiness,
  describeDependencyReadinessTier,
  type DependencyReadinessCandidate,
} from '../db/persistence/dependency-readiness';
import { loadEnv, describeEnv } from '../config/env';
import { HealthService } from '../modules/health/health.service';
import type { HealthPayload, ReadinessPayload } from '../modules/health/health.service';
import {
  HEALTH_ALLOWED_FIELDS,
  HEALTH_REQUIRED_FIELDS,
} from '../modules/ruoyi-adapter/contract/health-contract';
import { RUNTIME_INFO_FIELDS, toRuntimeInfo } from '../modules/runtime-info/runtime-info.service';
import type { RuntimeInfoPayload } from '../modules/runtime-info/runtime-info.service';
import {
  OPERATIONAL_OUTPUT_SCHEMAS,
  REGISTERED_ERROR_NAMES,
  STARTUP_BANNER_PLACEHOLDER,
  STARTUP_ERROR_NAME_PLACEHOLDER,
  STARTUP_FAILURE_TEXT_PLACEHOLDER,
  STARTUP_LOG_FIELDS,
  assertOperationalOutput,
  checkOperationalOutput,
  describeOperationalIssues,
  describeStartupBanner,
  describeStartupFailure,
  normalizeLogText,
  projectApiErrorBody,
  renderOperationalLogValue,
  stableInternalErrorBody,
  type OperationalOutputProfile,
} from './operational-output';
import { findSensitiveOutput } from './sensitive-output';

/**
 * 统一运维出口契约（readiness output contract）的纯函数回归。
 *
 * 覆盖三件事：
 * 1. **闭集来源唯一**：五个出口的字段闭集直接引用生产常量（不抄第二份），并与真实生产者输出对齐；
 * 2. **每个拒绝类别都真的会拦下**：连接串、口令、SQL、证据 ID、内部路径、owner/user ID、
 *    provider 名称、原始异常；
 * 3. **合法运维输出不被误伤**，且违规信息只含路径与类别、**不含取值**。
 */

const degradedEnv = loadEnv({});
const fullEnv = loadEnv({
  NODE_ENV: 'production',
  API_PORT: '8080',
  API_PREFIX: '/api/v2',
  DATABASE_URL: 'postgresql://rm_user:pg-sup3rsecret@127.0.0.1:5432/researcher_manager',
  SESSION_SECRET: 'session-sup3rsecret-a1b2c3d4e5f6',
  AI_PROVIDER: 'http-json',
  AI_BASE_URL: 'https://ai-internal.example.com/secret-gateway',
  AI_API_KEY: 'sk-ai-sup3rsecret-abcdef0123456789',
  AI_MATCHING_ENABLED: 'true',
});

const legalHealth: HealthPayload = new HealthService(degradedEnv).getHealth(
  new Date('2026-01-01T00:00:00.000Z'),
);
const legalReadiness: ReadinessPayload = new HealthService(degradedEnv).getReadiness();
const legalRuntimeInfo: RuntimeInfoPayload = toRuntimeInfo(fullEnv);
const legalStartupLog = describeEnv(fullEnv);
const legalApiError = fail(ApiErrorCode.NotFound, { requestId: 'req-1' });

const LEGAL_BY_PROFILE: Readonly<Record<OperationalOutputProfile, unknown>> = {
  health: legalHealth,
  readiness: legalReadiness,
  runtimeInfo: legalRuntimeInfo,
  apiError: legalApiError,
  startupLog: legalStartupLog,
};

describe('闭集来源唯一：契约直接引用生产常量，不抄第二份', () => {
  it('五个出口都已登记闭集', () => {
    expect(Object.keys(OPERATIONAL_OUTPUT_SCHEMAS).sort()).toEqual([
      'apiError',
      'health',
      'readiness',
      'runtimeInfo',
      'startupLog',
    ]);
  });

  it('/health 与 /health/ready 的闭集与契约适配器逐字段一致', () => {
    expect([...OPERATIONAL_OUTPUT_SCHEMAS.health.allowed]).toEqual([
      ...(HEALTH_ALLOWED_FIELDS.HealthData ?? []),
    ]);
    expect([...OPERATIONAL_OUTPUT_SCHEMAS.health.required]).toEqual([
      ...(HEALTH_REQUIRED_FIELDS.HealthData ?? []),
    ]);
    expect([...OPERATIONAL_OUTPUT_SCHEMAS.readiness.allowed]).toEqual([
      ...(HEALTH_ALLOWED_FIELDS.ReadinessData ?? []),
    ]);
    expect([...OPERATIONAL_OUTPUT_SCHEMAS.readiness.required]).toEqual([
      ...(HEALTH_REQUIRED_FIELDS.ReadinessData ?? []),
    ]);
    const checkSchema = OPERATIONAL_OUTPUT_SCHEMAS.readiness.children?.checks ?? {
      required: [],
      allowed: [],
    };
    expect([...checkSchema.allowed]).toEqual([...(HEALTH_ALLOWED_FIELDS.ReadinessCheck ?? [])]);
    expect([...checkSchema.required]).toEqual([...(HEALTH_REQUIRED_FIELDS.ReadinessCheck ?? [])]);
  });

  it('/runtime-info 的闭集就是运行时白名单本身', () => {
    expect([...OPERATIONAL_OUTPUT_SCHEMAS.runtimeInfo.allowed]).toEqual([...RUNTIME_INFO_FIELDS]);
    expect([...OPERATIONAL_OUTPUT_SCHEMAS.runtimeInfo.required]).toEqual([...RUNTIME_INFO_FIELDS]);
  });

  it('启动日志闭集与 describeEnv 的实际输出逐字段一致，且是运维摘要的子集', () => {
    expect([...OPERATIONAL_OUTPUT_SCHEMAS.startupLog.allowed]).toEqual([...STARTUP_LOG_FIELDS]);
    expect(Object.keys(legalStartupLog)).toEqual([...STARTUP_LOG_FIELDS]);
    for (const field of STARTUP_LOG_FIELDS) {
      expect([...RUNTIME_INFO_FIELDS]).toContain(field);
    }
  });
});

describe('合法运维输出零违规（不误伤）', () => {
  it.each(Object.entries(LEGAL_BY_PROFILE))('%s：合法载荷无任何违规', (profile, payload) => {
    expect(checkOperationalOutput(profile as OperationalOutputProfile, payload)).toEqual([]);
  });

  it('配置齐全时的启动日志摘要不含任何敏感取值', () => {
    const text = JSON.stringify(legalStartupLog);
    for (const secret of ['sup3rsecret', 'postgresql://', 'ai-internal', 'sk-ai']) {
      expect(text).not.toContain(secret);
    }
    expect(findSensitiveOutput(legalStartupLog, 'log')).toEqual([]);
  });

  it('合法输出原样返回：同一对象引用，不复制、不改写', () => {
    expect(assertOperationalOutput('health', legalHealth)).toBe(legalHealth);
    expect(assertOperationalOutput('runtimeInfo', legalRuntimeInfo)).toBe(legalRuntimeInfo);
  });
});

describe('闭集违规：缺失、越界、一致性', () => {
  it('缺失闭集字段 → missing', () => {
    const { prefix: _prefix, ...rest } = legalHealth;
    const issues = checkOperationalOutput('health', rest);
    expect(issues).toContainEqual({
      kind: 'missing',
      path: 'data.prefix',
      detail: '缺少闭集字段',
    });
  });

  it('越界字段 → unexpected（并同时报出该字段的取值级命中）', () => {
    const leaked = { ...legalRuntimeInfo, DATABASE_URL: 'x' };
    const issues = checkOperationalOutput('runtimeInfo', leaked);
    expect(issues).toContainEqual({
      kind: 'unexpected',
      path: 'data.DATABASE_URL',
      detail: '闭集之外的字段',
    });
    expect(issues).toContainEqual({
      kind: 'sensitive',
      path: 'data.DATABASE_URL',
      detail: '脱敏规则命中（evidence-field）',
    });
  });

  it('status 与 checks 不一致 → invalid（ready ⇔ 全部 ok）', () => {
    const issues = checkOperationalOutput('readiness', {
      status: 'ready',
      checks: [{ name: 'database', status: 'not_configured' }],
    });
    expect(issues).toContainEqual({
      kind: 'invalid',
      path: 'data.status',
      detail: 'status 必须与 checks 一致（ready ⇔ 全部检查项为 ok）',
    });
  });

  it('错误信封：data 非 null / meta 越界 / requestId 不一致都算违规', () => {
    const issues = checkOperationalOutput('apiError', {
      data: { leaked: true },
      meta: { requestId: 'req-1', page: 1 },
      error: { code: ApiErrorCode.NotFound, message: '目标资源不存在', requestId: 'req-2' },
    });
    expect(issues).toContainEqual({
      kind: 'invalid',
      path: 'envelope.data',
      detail: '错误响应的 data 必须是 null',
    });
    expect(issues).toContainEqual({
      kind: 'unexpected',
      path: 'envelope.meta.page',
      detail: '闭集之外的字段',
    });
    expect(issues).toContainEqual({
      kind: 'invalid',
      path: 'envelope.error.requestId',
      detail: 'error.requestId 必须与 meta.requestId 一致',
    });
  });
});

describe('拒绝类别：八类敏感取值在运维出口一律拦下', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly path: string;
    readonly kind: string;
    readonly payload: RuntimeInfoPayload;
  }> = [
    {
      name: '连接串',
      path: 'data.nodeEnv',
      kind: 'connection-string',
      payload: {
        ...legalRuntimeInfo,
        nodeEnv: 'postgresql://rm_user:pg-sup3rsecret@db.internal:5432/app' as never,
      },
    },
    {
      name: '口令键值',
      path: 'data.nodeEnv',
      kind: 'credential-pair',
      payload: { ...legalRuntimeInfo, nodeEnv: 'password=hunter2' as never },
    },
    {
      name: 'SQL 语句',
      path: 'data.nodeEnv',
      kind: 'sql-statement',
      payload: {
        ...legalRuntimeInfo,
        nodeEnv: 'SELECT id FROM student_profile WHERE id = $1' as never,
      },
    },
    {
      name: '内部路径',
      path: 'data.apiPrefix',
      kind: 'internal-path',
      payload: { ...legalRuntimeInfo, apiPrefix: 'D:\\WorkSpace\\ReseacherManager' },
    },
    {
      name: 'owner/user ID',
      path: 'data.nodeEnv',
      kind: 'owner-id',
      payload: { ...legalRuntimeInfo, nodeEnv: 'u-student-1' as never },
    },
    {
      name: 'provider 名称',
      path: 'data.aiProvider',
      kind: 'provider-name',
      payload: { ...legalRuntimeInfo, aiProvider: 'openai' as never },
    },
    {
      name: '原始异常',
      path: 'data.nodeEnv',
      kind: 'raw-exception',
      payload: {
        ...legalRuntimeInfo,
        nodeEnv: 'boom\n    at Object.<anonymous> (/app/x.js:1:1)' as never,
      },
    },
  ];

  it.each(cases)('$name：$path 命中 $kind', ({ path, kind, payload }) => {
    const issues = checkOperationalOutput('runtimeInfo', payload);
    expect(issues).toContainEqual({ kind: 'sensitive', path, detail: `脱敏规则命中（${kind}）` });
  });

  it('证据 ID 字段名（evidenceId / readinessRef）属于内部证据', () => {
    const issues = checkOperationalOutput('runtimeInfo', {
      ...legalRuntimeInfo,
      evidenceId: 'ci-1',
    });
    expect(issues).toContainEqual({
      kind: 'sensitive',
      path: 'data.evidenceId',
      detail: '脱敏规则命中（evidence-field）',
    });
  });

  it('就绪检查项的 detail 自由文本同样受门禁约束', () => {
    const issues = checkOperationalOutput('readiness', {
      status: 'ready',
      checks: [
        { name: 'database', status: 'ok', detail: '已连接 postgresql://u:p@h/db' },
        { name: 'sessionSecret', status: 'ok' },
        { name: 'aiMatching', status: 'ok' },
      ],
    });
    expect(issues).toContainEqual({
      kind: 'sensitive',
      path: 'data.checks[0].detail',
      detail: '脱敏规则命中（connection-string）',
    });
  });

  it('错误响应文案里的敏感原文同样被拦下', () => {
    const issues = checkOperationalOutput(
      'apiError',
      fail('INTERNAL_ERROR', {
        message: 'connect failed: postgresql://user:sup3rsecret@db:5432/app',
        requestId: 'req-1',
      }),
    );
    expect(issues).toContainEqual({
      kind: 'sensitive',
      path: 'envelope.error.message',
      detail: '脱敏规则命中（connection-string）',
    });
  });
});

describe('违规信息与日志只含路径与类别，绝不含取值', () => {
  const secret = 'postgresql://rm_user:pg-sup3rsecret@db.internal:5432/researcher_manager';

  it('describeOperationalIssues 不回显取值', () => {
    const issues = checkOperationalOutput('runtimeInfo', {
      ...legalRuntimeInfo,
      nodeEnv: secret as never,
    });
    const described = describeOperationalIssues(issues);
    expect(described).toContain('data.nodeEnv(sensitive)');
    expect(described).not.toContain('sup3rsecret');
    expect(described).not.toContain('postgresql');
  });

  it('assertOperationalOutput 抛错，错误消息不带取值', () => {
    let thrown: unknown;
    try {
      assertOperationalOutput('runtimeInfo', { ...legalRuntimeInfo, apiPrefix: secret });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error & { profile?: string; issues?: unknown[] };
    expect(error.name).toBe('OperationalOutputViolationError');
    expect(error.profile).toBe('runtimeInfo');
    expect(error.issues?.length).toBeGreaterThan(0);
    expect(error.message).not.toContain('sup3rsecret');
  });

  it('渲染日志时违规载荷只输出占位符', () => {
    const rendered = renderOperationalLogValue('startupLog', {
      ...legalStartupLog,
      apiPrefix: secret,
    });
    expect(rendered.clean).toBe(false);
    expect(rendered.text).toBe('<已按运维出口契约脱敏>');
    expect(rendered.text).not.toContain('sup3rsecret');
    expect(describeOperationalIssues(rendered.issues)).toContain('data.apiPrefix(sensitive)');
  });

  it('合规载荷渲染为 JSON 且标记 clean', () => {
    const rendered = renderOperationalLogValue('startupLog', legalStartupLog);
    expect(rendered.clean).toBe(true);
    expect(rendered.issues).toEqual([]);
    expect(JSON.parse(rendered.text)).toEqual(legalStartupLog);
  });
});

describe('错误响应投影：码与状态不变，只去掉不合规内容', () => {
  it('合规错误体逐字段保持一致（含字段级 issues）', () => {
    const body = fail(ApiErrorCode.ValidationFailed, {
      message: '提交内容不合法，请检查后重试',
      requestId: 'req-1',
      details: { issues: [{ path: 'name', message: '姓名不能为空' }] },
    });
    expect(projectApiErrorBody(body)).toEqual(body);
  });

  it('文案命中脱敏规则 → 替换为该错误码的稳定默认文案，码与 requestId 不变', () => {
    const projected = projectApiErrorBody(
      fail(ApiErrorCode.Conflict, {
        message: 'connect failed: postgresql://user:sup3rsecret@db:5432/app',
        requestId: 'req-7',
      }),
    );
    expect(projected.data).toBeNull();
    expect(projected.error?.code).toBe(ApiErrorCode.Conflict);
    expect(projected.error?.message).toBe('当前数据状态与请求冲突，请刷新后重试');
    expect(projected.error?.requestId).toBe('req-7');
    expect(projected.meta.requestId).toBe('req-7');
    expect(JSON.stringify(projected)).not.toContain('sup3rsecret');
  });

  it('details 命中脱敏规则 → 整体丢弃（不留可拼接线索）', () => {
    const projected = projectApiErrorBody(
      fail(ApiErrorCode.ValidationFailed, {
        requestId: 'req-8',
        details: { issues: [{ path: 'detail', message: '读取 /etc/postgresql/pg_hba.conf' }] },
      }),
    );
    expect(projected.error?.details).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain('pg_hba');
  });

  it('越界 meta 字段与非法错误码被收敛（闭集投影）', () => {
    const projected = projectApiErrorBody({
      data: null,
      meta: { requestId: 'req-9', page: 2 },
      error: { code: '', message: '' },
    } as unknown as ApiEnvelope<never>);
    expect(Object.keys(projected.meta)).toEqual(['requestId']);
    expect(projected.error?.code).toBe(ApiErrorCode.InternalError);
    expect(projected.error?.message).toBe('服务器内部错误，请稍后重试');
  });

  it('5xx 稳定脱敏体：恰好 { code: INTERNAL_ERROR, message 默认文案, requestId }', () => {
    const body = stableInternalErrorBody('req-500');
    expect(body).toEqual({
      data: null,
      meta: { requestId: 'req-500' },
      error: {
        code: ApiErrorCode.InternalError,
        message: '服务器内部错误，请稍后重试',
        requestId: 'req-500',
      },
    });
    // 与具体异常无关：不携带 details / 自定义文案
    expect(body.error?.details).toBeUndefined();
    expect(projectApiErrorBody(body)).toEqual(body);
  });

  it('单行化：换行与控制字符不会造成日志/响应注入', () => {
    expect(normalizeLogText('a\r\nb\tc\0d')).toBe('a b c d');
    expect(normalizeLogText('x'.repeat(500)).length).toBe(300);
  });
});

describe('启动失败日志：拒绝原始异常', () => {
  /** 扫描源文件里异常类名的赋值点（除测试文件），用于核对登记闭集 */
  function collectDeclaredErrorNames(): readonly string[] {
    // 与仓库内其他「读源文件」门禁同口径：以进程工作目录（包根）为基准，缺失即大声失败
    const sourceRoot = resolve(process.cwd(), 'src');
    expect(existsSync(sourceRoot), `源文件根目录不存在: ${sourceRoot}`).toBe(true);
    const names = new Set<string>();
    for (const relative of readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })) {
      if (!relative.endsWith('.ts') || relative.endsWith('.spec.ts')) {
        continue;
      }
      const text = readFileSync(join(sourceRoot, relative), 'utf8');
      for (const match of text.matchAll(/\bthis\.name\s*=\s*'([^']+)'/gu)) {
        const declared = match[1];
        // 只收 ASCII 标识符形态：注释里用省略号写的示例不会被当成赋值点
        if (declared !== undefined && /^[A-Za-z][A-Za-z0-9]*$/u.test(declared)) {
          names.add(declared);
        }
      }
    }
    return [...names].sort();
  }

  it('登记闭集无重复，且每个登记类名都原样可读', () => {
    expect(new Set(REGISTERED_ERROR_NAMES).size).toBe(REGISTERED_ERROR_NAMES.length);
    for (const name of REGISTERED_ERROR_NAMES) {
      const error = new Error('x');
      error.name = name;
      expect(describeStartupFailure(error), name).toBe(
        `启动失败: ${name}: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
      );
    }
  });

  it('登记闭集覆盖源码里所有 `this.name` 写入点（漏登记只会静默占位，必须先在此暴露）', () => {
    const declared = collectDeclaredErrorNames();
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect([...REGISTERED_ERROR_NAMES], name).toContain(name);
    }
  });

  it('登记闭集是唯一放行来源：未登记的 ASCII 类名一律占位（EvilName / InjectedError）', () => {
    for (const name of ['EvilName', 'InjectedError', 'Error2', 'RegisteredError', 'Zz']) {
      const error = new Error('内部细节 abc');
      error.name = name;
      const described = describeStartupFailure(error);
      expect(described, name).toBe(
        `启动失败: ${STARTUP_ERROR_NAME_PLACEHOLDER}: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
      );
      expect(described, name).not.toContain(name);
      expect(described, name).not.toContain('内部细节 abc');
    }
  });

  it('合规异常也只输出固定文案：保留登记类名与稳定 code，绝不回显 error.message', () => {
    class DatabaseConfigError extends Error {
      readonly code = 'DATABASE_URL_INVALID';
      constructor() {
        super('DATABASE_URL 不是合法 URL');
        this.name = 'DatabaseConfigError';
      }
    }
    const described = describeStartupFailure(new DatabaseConfigError());
    expect(described).toBe(
      `启动失败: DatabaseConfigError(DATABASE_URL_INVALID): ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
    );
    expect(described).not.toContain('DATABASE_URL 不是合法 URL');
    expect(described).not.toContain('不是合法');
  });

  it('没有任何敏感词的原始 error.message 同样不输出（省略不看内容）', () => {
    const raw = '磁盘配额已用尽（内部细节）';
    const described = describeStartupFailure(new Error(raw));
    expect(described).toBe(`启动失败: Error: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`);
    expect(described).not.toContain(raw);
    expect(described).not.toContain('内部细节');
  });

  it('敏感文本与无害文本的输出形态完全一致：不存在「按内容放行」的分支', () => {
    const sensitive = describeStartupFailure(
      new Error('connect failed: postgresql://rm_user:sup3rsecret@db.internal:5432/app'),
    );
    const benign = describeStartupFailure(new Error('数据库连接失败'));
    expect(sensitive).toBe(benign);
    expect(sensitive).toBe(`启动失败: Error: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`);
    for (const fragment of ['sup3rsecret', 'db.internal', 'postgresql', 'connection-string']) {
      expect(sensitive).not.toContain(fragment);
    }
  });

  it('固定文案本身就是安全文本（不会把兜底判定变成常驻退化）', () => {
    expect(findSensitiveOutput(STARTUP_FAILURE_TEXT_PLACEHOLDER, 'log')).toEqual([]);
    expect(findSensitiveOutput(STARTUP_ERROR_NAME_PLACEHOLDER, 'log')).toEqual([]);
  });

  it('非 Error 的抛出值不会把对象本体（可能含任意取值）写进日志', () => {
    const shape = `启动失败: object: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`;
    expect(describeStartupFailure({ detail: 'postgresql://u:p@h/db' })).toBe(shape);
    expect(describeStartupFailure(null)).toBe(shape);
    expect(describeStartupFailure(undefined)).toBe(
      `启动失败: undefined: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
    );
    expect(describeStartupFailure('postgresql://u:p@h/db')).toBe(
      `启动失败: string: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
    );
    expect(describeStartupFailure(42)).toBe(
      `启动失败: number: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
    );
  });

  it('登记命名的异常类名与内置类名仍可读（规范化后原样输出）', () => {
    expect(describeStartupFailure(new TypeError('参数类型不对'))).toBe(
      `启动失败: TypeError: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
    );
    const renamed = new TypeError('x');
    renamed.name = 'DependencyReadinessError';
    expect(describeStartupFailure(renamed)).toBe(
      `启动失败: DependencyReadinessError: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
    );
  });

  it('回归：error.name 不是可信字段，连接串 / 凭据 / 内部路径 / 主体 ID / provider 一律占位', () => {
    const hostileNames = [
      'postgresql://rm_user:sup3rsecret@db.internal:5432/app',
      'admin:sup3rsecret@10.0.0.5',
      'D:\\WorkSpace\\ReseacherManager\\services\\api',
      '/etc/postgresql/pg_hba.conf',
      'u-student-1',
      'openai',
      'Error: leaked',
      'boom name',
      '<script>',
      'EvilName',
      'InjectedError',
      '',
    ];
    for (const name of hostileNames) {
      const error = new Error('配置无效');
      error.name = name;
      const described = describeStartupFailure(error);
      expect(described, name).toBe(
        `启动失败: ${STARTUP_ERROR_NAME_PLACEHOLDER}: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
      );
      for (const fragment of [
        'sup3rsecret',
        'postgresql',
        'db.internal',
        'WorkSpace',
        'pg_hba',
        'u-student',
        'openai',
        'leaked',
        '<script>',
        'EvilName',
        'InjectedError',
        'boom',
      ]) {
        expect(described, `${name} / ${fragment}`).not.toContain(fragment);
      }
    }
  });

  it('被拒绝的类名不影响稳定 code 的保留（code 仍须满足形态闭集）', () => {
    const error: Error & { code?: string } = new Error('配置无效');
    error.name = 'u-student-1';
    error.code = 'DATABASE_URL_INVALID';
    expect(describeStartupFailure(error)).toBe(
      `启动失败: ${STARTUP_ERROR_NAME_PLACEHOLDER}(DATABASE_URL_INVALID): ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
    );
  });

  it('自由文本 / 小写 / 带空格 / 超长 code 不是稳定分类，一律丢弃（code 通道不得承载任意文本）', () => {
    for (const code of [
      'internal-token-abcdef',
      'database_url_invalid',
      ' DATABASE_URL_INVALID',
      'DATABASE_URL_INVALID ',
      `${'A'.repeat(64)}B`,
      '***',
    ]) {
      const error: Error & { code?: string } = new Error('配置无效');
      error.code = code;
      const described = describeStartupFailure(error);
      expect(described, code).toBe(`启动失败: Error: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`);
      expect(described, code).not.toContain('internal-token');
    }
  });

  it('带敏感词的形态合法 code 同样丢弃（形态闭集不是放行豁免）', () => {
    const error: Error & { code?: string } = new Error('配置无效');
    // `OPENAI` 满足大写蛇形，但命中 provider 名称规则，因此仍不得进入日志
    error.code = 'OPENAI';
    expect(describeStartupFailure(error)).toBe(
      `启动失败: Error: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
    );
  });

  it('类名属性读取抛错时同样占位（排障日志不成为崩溃点）', () => {
    const error = new Error('配置无效');
    Object.defineProperty(error, 'name', {
      get() {
        throw new Error('name getter boom');
      },
    });
    expect(describeStartupFailure(error)).toBe(
      `启动失败: ${STARTUP_ERROR_NAME_PLACEHOLDER}: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
    );
  });

  it('message / code 属性读取抛错也不再是崩溃点（实现根本不读 error.message）', () => {
    const messageBoom = new Error('x');
    Object.defineProperty(messageBoom, 'message', {
      get() {
        throw new Error('message getter boom');
      },
    });
    expect(describeStartupFailure(messageBoom)).toBe(
      `启动失败: Error: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
    );

    const codeBoom = new Error('x');
    Object.defineProperty(codeBoom, 'code', {
      get() {
        throw new Error('code getter boom');
      },
    });
    expect(describeStartupFailure(codeBoom)).toBe(
      `启动失败: Error: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
    );
  });

  it('类名与异常文本同时恶意时，整行仍不含任何取值', () => {
    const error = new Error(
      'connect failed: postgresql://rm_user:sup3rsecret@db.internal:5432/app',
    );
    error.name = 'postgresql://rm_user:sup3rsecret@db.internal:5432/app';
    const described = describeStartupFailure(error);
    expect(described).toBe(
      `启动失败: ${STARTUP_ERROR_NAME_PLACEHOLDER}: ${STARTUP_FAILURE_TEXT_PLACEHOLDER}`,
    );
    for (const fragment of ['sup3rsecret', 'db.internal', 'postgresql']) {
      expect(described).not.toContain(fragment);
    }
  });
});

describe('启动横幅：不承载任何连接串形态', () => {
  const bannerEnv = { API_HOST: '127.0.0.1', API_PORT: 8080, API_PREFIX: '/api/v2' };

  it('输出绑定地址、端口与探针路径，且零脱敏命中', () => {
    const lines = describeStartupBanner(bannerEnv);
    expect(lines).toEqual([
      '服务已启动: 监听 127.0.0.1:8080，前缀 /api/v2',
      '健康检查路径: /api/v2/health',
    ]);
    for (const line of lines) {
      expect(line).not.toContain('://');
    }
  });

  it('回归：`scheme://` 形态（含本机 http 地址）在运维出口被拒', () => {
    expect(findSensitiveOutput('服务已启动: http://127.0.0.1:8080/api/v1', 'log')).toEqual([
      { path: 'log', kind: 'connection-string' },
    ]);
  });

  it('合法变体不误伤：0.0.0.0 / 根前缀 / IPv6 回环 / DNS 名', () => {
    expect(describeStartupBanner({ API_HOST: '0.0.0.0', API_PORT: 3000, API_PREFIX: '/' })).toEqual(
      ['服务已启动: 监听 0.0.0.0:3000，前缀 /', '健康检查路径: /health'],
    );
    expect(
      describeStartupBanner({ API_HOST: '::1', API_PORT: 3000, API_PREFIX: '/api/v1' }),
    ).toEqual(['服务已启动: 监听 [::1]:3000，前缀 /api/v1', '健康检查路径: /api/v1/health']);
    expect(
      describeStartupBanner({ API_HOST: 'api.internal', API_PORT: 8080, API_PREFIX: '/api/v2' }),
    ).toEqual(['服务已启动: 监听 api.internal:8080，前缀 /api/v2', '健康检查路径: /api/v2/health']);
  });

  it('回归：恶意 API_HOST（连接串 / 凭据 / 盘符路径 / UNC / 主体 ID / provider）一律安全占位', () => {
    const hostileHosts = [
      'postgresql://rm_user:pg-sup3rsecret@db.internal:5432/app',
      'http://user:sup3rsecret@10.0.0.5',
      'admin:sup3rsecret@10.0.0.5',
      'D:\\WorkSpace\\ReseacherManager',
      '\\\\db-01\\pgdata',
      '/etc/postgresql',
      'u-student-1',
      'openai.internal',
      'host/path',
      'host with spaces',
      '',
    ];
    for (const API_HOST of hostileHosts) {
      const lines = describeStartupBanner({ ...bannerEnv, API_HOST });
      const joined = lines.join('\n');
      expect(joined, API_HOST).toContain(STARTUP_BANNER_PLACEHOLDER);
      expect(joined, API_HOST).not.toContain('://');
      for (const fragment of [
        'sup3rsecret',
        'postgresql',
        'db.internal',
        'WorkSpace',
        'pgdata',
        '/etc',
        'u-student',
        'openai',
      ]) {
        expect(joined, `${API_HOST} / ${fragment}`).not.toContain(fragment);
      }
      for (const line of lines) {
        expect(findSensitiveOutput(line, 'log'), API_HOST).toEqual([]);
      }
    }
  });

  it('回归：恶意 API_PREFIX（协议相对 / 凭据 / 路径穿越 / 主体 ID / provider）一律安全占位', () => {
    const hostilePrefixes = [
      '//evil.example.com/api',
      'http://user:sup3rsecret@evil.example.com',
      '/api/../../etc',
      '/etc/postgresql/16',
      '/u-student-1',
      '/api/openai',
      'D:\\WorkSpace\\ReseacherManager',
      '/api/v1\u0000/../secret',
    ];
    for (const API_PREFIX of hostilePrefixes) {
      const lines = describeStartupBanner({ ...bannerEnv, API_PREFIX });
      const joined = lines.join('\n');
      expect(joined, API_PREFIX).toContain(STARTUP_BANNER_PLACEHOLDER);
      expect(joined, API_PREFIX).not.toContain('://');
      for (const fragment of [
        'sup3rsecret',
        'WorkSpace',
        'u-student',
        'openai',
        'evil',
        'secret',
      ]) {
        expect(joined, `${API_PREFIX} / ${fragment}`).not.toContain(fragment);
      }
      // 被拒绝字段已投影为固定占位符；其余横幅文本不含原始输入。
      for (const line of lines) {
        expect(line).not.toContain(API_PREFIX);
      }
    }
  });

  it('回归：端口越界 / 非整数一律占位', () => {
    for (const API_PORT of [Number.NaN, Number.POSITIVE_INFINITY, -1, 70_000, 80.5]) {
      const lines = describeStartupBanner({ ...bannerEnv, API_PORT });
      const joined = lines.join('\n');
      expect(joined, String(API_PORT)).toContain(STARTUP_BANNER_PLACEHOLDER);
      for (const line of lines) {
        expect(findSensitiveOutput(line, 'log'), String(API_PORT)).toEqual([]);
      }
    }
  });
});

/**
 * 「认证先于业务」在**运维出口**上的可判定形态：
 * 认证阶段未通过时，报告与启动日志不得出现任何「业务阶段已就绪」的表述。
 */
describe('认证先于业务：出口不报告未被评估的业务阶段', () => {
  const registry = createDependencyReadinessRegistry();
  const authentication: readonly DependencyReadinessCandidate[] = [
    { token: 'SESSION_STORE', role: 'authentication', capabilities: undefined },
  ];
  const business: readonly DependencyReadinessCandidate[] = [
    { token: 'PROFILE_REPOSITORY', role: 'business', capabilities: undefined },
  ];

  it('认证失败时业务候选提供者根本不会被调用，业务状态为 not-checked', () => {
    let businessReads = 0;
    const report = evaluateDependencyReadiness({
      required: true,
      authentication: () => authentication,
      business: () => {
        businessReads += 1;
        return business;
      },
      registry,
      now: '2026-01-01T00:00:00.000Z',
    });

    expect(businessReads).toBe(0);
    expect(report.authentication).toBe('rejected');
    expect(report.business).toBe('not-checked');
    expect(report.checkedTokens).toEqual(['SESSION_STORE']);
  });

  it('启动日志摘要如实反映「业务阶段未评估」，且文本本身通过脱敏门禁', () => {
    const options: DependencyReadinessOptions = { registry, now: '2026-01-01T00:00:00.000Z' };
    const service = new DependencyReadinessService(
      { get: () => undefined } as unknown as ModuleRef,
      { status: 'absent', detail: '测试用' },
      loadEnv({ NODE_ENV: 'production' }),
      options,
    );
    const report = evaluateDependencyReadiness({
      required: true,
      authentication: () => authentication,
      business: () => business,
      registry,
      now: '2026-01-01T00:00:00.000Z',
    });

    const summary = service.describeForLog(report);
    expect(summary).toContain('档位=required');
    expect(summary).toContain('认证阶段=拒绝');
    expect(summary).toContain('业务阶段=未评估（认证阶段未通过）');
    expect(findSensitiveOutput(summary, 'log')).toEqual([]);
  });
});

/**
 * 「production required / not-required 状态一致」：
 * 启动期门禁与运维出口必须由同一份事实推导出同一档位，否则运维会看到一个
 * 「看起来没要求」的进程而实际已被门禁约束。
 */
describe('生产 required/not-required 档位一致性', () => {
  const cases: ReadonlyArray<{ name: string; env: ReturnType<typeof loadEnv> }> = [
    { name: '开发无库', env: loadEnv({}) },
    { name: '测试无库', env: loadEnv({ NODE_ENV: 'test' }) },
    {
      name: '开发已配置数据库',
      env: loadEnv({ DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/app' }),
    },
    {
      name: '生产已配置数据库（verify-full）',
      env: loadEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/app',
        DATABASE_SSL_MODE: 'verify-full',
      }),
    },
  ];

  it.each(cases)('$name：出口档位 === 启动门禁档位', ({ env }) => {
    const resolution = resolveDatabaseConfig(env);
    const startupConfigured = resolution.status === 'configured';

    // 两条推导路径的输入不同（一个是 env 里的连接串，一个是解析结果），档位必须一致
    const fromEnv = describeDependencyReadinessTier(env.NODE_ENV, Boolean(env.DATABASE_URL));
    const fromStartup = describeDependencyReadinessTier(env.NODE_ENV, startupConfigured);
    expect(fromEnv).toBe(fromStartup);
    expect(toRuntimeInfo(env).dependencyGate).toBe(fromStartup);
  });

  it('生产缺少 DATABASE_URL 时启动期解析直接抛错 —— 不可能出现档位漂移的服务', () => {
    const env = loadEnv({ NODE_ENV: 'production' });
    expect(() => resolveDatabaseConfig(env)).toThrowError(/必须配置 DATABASE_URL/u);
    // 出口侧同样报 required：即便进程被人为构造出来，运维看到的也不是 not-required
    expect(toRuntimeInfo(env).dependencyGate).toBe('required');
  });

  it('空白连接串按「未配置」处理，两条推导路径同样一致（经典漂移源）', () => {
    const env = loadEnv({ DATABASE_URL: '   ' });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(resolveDatabaseConfig(env).status).toBe('absent');
    expect(toRuntimeInfo(env).databaseConfigured).toBe(false);
    expect(toRuntimeInfo(env).dependencyGate).toBe('not-required');
  });

  it('已配置连接串时档位必为 required（与 NODE_ENV 无关）', () => {
    for (const nodeEnv of ['development', 'test', 'production'] as const) {
      const env = loadEnv({
        NODE_ENV: nodeEnv,
        DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/app',
        ...(nodeEnv === 'production' ? { DATABASE_SSL_MODE: 'verify-full' } : {}),
      });
      expect(describeDependencyReadinessTier(env.NODE_ENV, Boolean(env.DATABASE_URL))).toBe(
        'required',
      );
      expect(toRuntimeInfo(env).dependencyGate).toBe('required');
    }
  });
});
