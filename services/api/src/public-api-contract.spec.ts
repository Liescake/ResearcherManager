import 'reflect-metadata';
import { request } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Role } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module';
import { InMemorySessionStore } from './modules/auth/session-store.in-memory';
import { SESSION_STORE } from './modules/auth/session-subject.port';

/**
 * **公开 API 契约矩阵**（唯一一处把「对外方法/路径面」与「统一响应信封」放在一起核对的地方）。
 *
 * 各切片的 `*.controller.spec.ts` 各自验证本切片的业务语义（授权入参、字段闭集、状态机、
 * 失败收敛）；本文件只验证**跨切片共同的传输层契约**，因此刻意不做任何业务断言：
 *
 * 1. **方法/路径矩阵（正例）**：每个已声明的 `(method, path)` 在默认装配下都必须**已注册** ——
 *    公开端点（health、health/ready、runtime-info）无会话即 200，其余端点无会话即 401。
 *    这两类都不是 404：Nest 对未注册的路由/方法一律 404，因此「401 而不是 404」正是
 *    「这条路由以这个方法存在」的可判定证据。矩阵同时是**路由清单的回归**：新增/改名的
 *    公开路由会在这里显形，而不是悄悄出现在文档之外。
 * 2. **方法/路径矩阵（反例）**：未声明的方法与路径形态一律 404 `NOT_FOUND`
 *    （不是 405、不是 500、更不会被别的路由吞掉），且响应仍是统一信封。
 * 3. **统一响应信封**：成功与失败都**严格**是 `{ data, meta, error }` 三个键，且 `data` 与
 *    `error` 互斥；`meta.requestId` 来自服务端解析（客户端跟踪 ID 只在通过服务端字符集校验时
 *    被采用），失败时 `error.requestId` 与 `meta.requestId` 一致。
 * 4. **服务端主体不可由客户端覆盖**：无会话请求即使带上伪造的归属/角色/范围/小组声明
 *    （自定义头、查询串、请求体三路同时）仍是 401 —— 认证先于一切输入，伪造取值不回显；
 *    已认证主体带伪造的更高角色/更宽范围声明不会升级为放行（403 不变）。
 *
 * 只做 HTTP 断言，不替换任何生产代码路径，也不注入任何仓储夹具（默认装配即为内存基线）。
 */

const API_PREFIX = 'api/v1';
/** 路径参数样本：只用于「路由是否存在」的形状判定，因此取一个合法 UUID */
const SAMPLE_ID = '11111111-1111-4111-8111-111111111111';

const SESSION_STUDENT = 'contract-session-student';
const SESSION_ADMIN = 'contract-session-admin';
const STUDENT = 'u-contract-student';
const ADMIN = 'u-contract-admin';

/** 客户端伪造的声明：三路同时注入，任何一路被采信都违反契约 */
const FORGED_USER = 'u-forged-attacker';
const FORGED_GROUP = '22222222-2222-4222-8222-222222222222';
const FORGED_ROLE = 'super_admin';
const FORGED_SCOPE = 'GLOBAL';
const FORGED_HEADERS: Record<string, string> = {
  'x-user-id': FORGED_USER,
  'x-actor-user-id': FORGED_USER,
  'x-owner-user-id': FORGED_USER,
  'x-roles': `${FORGED_ROLE},admin`,
  'x-scope': FORGED_SCOPE,
  'x-group-id': FORGED_GROUP,
};
const FORGED_QUERY = `userId=${FORGED_USER}&roles=${FORGED_ROLE}&scope=${FORGED_SCOPE}&groupId=${FORGED_GROUP}`;
const FORGED_BODY = {
  userId: FORGED_USER,
  ownerUserId: FORGED_USER,
  leaderUserId: FORGED_USER,
  reviewedByUserId: FORGED_USER,
  roles: [FORGED_ROLE],
  scope: FORGED_SCOPE,
  groupId: FORGED_GROUP,
  status: 'approved',
  decision: 'approve',
  resource: 'profile',
};
/** 伪造取值一旦出现在响应里即为「服务端采信/回显」的证据 */
const FORGED_MARKERS: readonly string[] = [FORGED_USER, FORGED_GROUP, FORGED_ROLE, FORGED_SCOPE];

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface DeclaredRoute {
  readonly method: HttpMethod;
  readonly path: string;
  /** 无会话时的预期状态码：公开端点 200，需要会话的端点 401（两者都不是 404） */
  readonly anonymousStatus: 200 | 401;
}

/**
 * 公开路由清单（默认装配，`apiPrefix = /api/v1`）。顺序按模块目录排列，便于对照 diff。
 * `SAMPLE_ID` 只代表路径参数形状，不代表任何真实资源。
 */
const DECLARED_ROUTES: readonly DeclaredRoute[] = [
  { method: 'GET', path: '/health', anonymousStatus: 200 },
  { method: 'GET', path: '/health/ready', anonymousStatus: 200 },
  { method: 'GET', path: '/runtime-info', anonymousStatus: 200 },
  { method: 'GET', path: '/me/profile', anonymousStatus: 401 },
  { method: 'PATCH', path: '/me/profile', anonymousStatus: 401 },
  { method: 'GET', path: '/me/education-records', anonymousStatus: 401 },
  { method: 'POST', path: '/me/education-records', anonymousStatus: 401 },
  { method: 'GET', path: `/me/education-records/${SAMPLE_ID}`, anonymousStatus: 401 },
  { method: 'GET', path: '/me/achievements', anonymousStatus: 401 },
  { method: 'POST', path: '/me/achievements', anonymousStatus: 401 },
  { method: 'GET', path: '/me/statistics', anonymousStatus: 401 },
  { method: 'GET', path: '/me/applications', anonymousStatus: 401 },
  { method: 'POST', path: '/me/applications', anonymousStatus: 401 },
  { method: 'POST', path: `/me/applications/${SAMPLE_ID}/withdraw`, anonymousStatus: 401 },
  { method: 'GET', path: '/admin/applications', anonymousStatus: 401 },
  { method: 'POST', path: `/admin/applications/${SAMPLE_ID}/review`, anonymousStatus: 401 },
  { method: 'GET', path: '/me/matching-requests', anonymousStatus: 401 },
  { method: 'POST', path: '/me/matching-requests', anonymousStatus: 401 },
  { method: 'GET', path: '/me/notifications', anonymousStatus: 401 },
  { method: 'PATCH', path: `/me/notifications/${SAMPLE_ID}/read`, anonymousStatus: 401 },
  { method: 'GET', path: '/me/exports', anonymousStatus: 401 },
  { method: 'POST', path: '/me/exports', anonymousStatus: 401 },
  { method: 'GET', path: `/me/exports/${SAMPLE_ID}/download`, anonymousStatus: 401 },
  { method: 'GET', path: '/me/compliance-status', anonymousStatus: 401 },
  { method: 'GET', path: '/me/audit-events', anonymousStatus: 401 },
  { method: 'GET', path: '/groups', anonymousStatus: 401 },
  { method: 'POST', path: '/groups', anonymousStatus: 401 },
];

/**
 * 未声明的方法/路径形态：必须 404，且不得被「相邻」路由吸收
 * （例如 `GET /me/exports/{id}` 不能被 `GET /me/exports` 吞掉、`PATCH /me/notifications/{id}`
 * 不能落进 `PATCH /me/notifications/{id}/read`）。同一路径的每个未声明方法都要单独验证，
 * 因为方法匹配是路由注册的一部分，而不是路径匹配的附属条件。
 */
const UNREGISTERED_SHAPES: readonly { readonly method: HttpMethod; readonly path: string }[] = [
  { method: 'POST', path: '/health' },
  { method: 'GET', path: '/health/ready/now' },
  { method: 'POST', path: '/runtime-info' },
  { method: 'POST', path: '/me/profile' },
  { method: 'PUT', path: '/me/profile' },
  { method: 'DELETE', path: '/me/profile' },
  { method: 'GET', path: `/me/profile/${SAMPLE_ID}` },
  { method: 'PATCH', path: '/me/education-records' },
  { method: 'DELETE', path: '/me/education-records' },
  { method: 'PUT', path: '/me/education-records' },
  { method: 'PATCH', path: `/me/education-records/${SAMPLE_ID}` },
  { method: 'DELETE', path: `/me/education-records/${SAMPLE_ID}` },
  { method: 'GET', path: `/me/education-records/${SAMPLE_ID}/history` },
  { method: 'PATCH', path: '/me/achievements' },
  { method: 'PUT', path: '/me/achievements' },
  { method: 'DELETE', path: '/me/achievements' },
  { method: 'GET', path: `/me/achievements/${SAMPLE_ID}` },
  { method: 'POST', path: '/me/statistics' },
  { method: 'PATCH', path: '/me/statistics' },
  { method: 'DELETE', path: '/me/statistics' },
  { method: 'POST', path: `/me/applications/${SAMPLE_ID}` },
  { method: 'GET', path: `/me/applications/${SAMPLE_ID}/withdraw` },
  { method: 'PATCH', path: `/me/applications/${SAMPLE_ID}/withdraw` },
  { method: 'POST', path: '/admin/applications' },
  { method: 'PATCH', path: '/admin/applications' },
  { method: 'DELETE', path: '/admin/applications' },
  { method: 'GET', path: `/admin/applications/${SAMPLE_ID}` },
  { method: 'GET', path: `/admin/applications/${SAMPLE_ID}/review` },
  { method: 'PUT', path: `/admin/applications/${SAMPLE_ID}/review` },
  { method: 'DELETE', path: `/admin/applications/${SAMPLE_ID}/review` },
  { method: 'PATCH', path: '/me/matching-requests' },
  { method: 'PUT', path: '/me/matching-requests' },
  { method: 'DELETE', path: '/me/matching-requests' },
  { method: 'GET', path: `/me/matching-requests/${SAMPLE_ID}` },
  { method: 'GET', path: `/me/notifications/${SAMPLE_ID}/read` },
  { method: 'PATCH', path: `/me/notifications/${SAMPLE_ID}` },
  { method: 'DELETE', path: `/me/notifications/${SAMPLE_ID}/read` },
  { method: 'PATCH', path: '/me/exports' },
  { method: 'DELETE', path: '/me/exports' },
  { method: 'GET', path: `/me/exports/${SAMPLE_ID}` },
  { method: 'POST', path: `/me/exports/${SAMPLE_ID}/download` },
  { method: 'DELETE', path: `/me/exports/${SAMPLE_ID}/download` },
  { method: 'POST', path: '/me/exports/download' },
  { method: 'POST', path: '/me/compliance-status' },
  { method: 'PATCH', path: '/me/compliance-status' },
  { method: 'GET', path: '/me/compliance-status/history' },
  { method: 'POST', path: '/me/audit-events' },
  { method: 'GET', path: `/me/audit-events/${SAMPLE_ID}` },
  { method: 'PATCH', path: '/groups' },
  { method: 'DELETE', path: '/groups' },
  { method: 'GET', path: `/groups/${SAMPLE_ID}` },
  { method: 'PUT', path: `/groups/${SAMPLE_ID}` },
  { method: 'GET', path: '/me/unknown-slice' },
  { method: 'GET', path: '/unknown-slice' },
];

const startedApps: INestApplication[] = [];

let baseUrl: string;

interface HttpResult {
  status: number;
  text: string;
  body: ApiEnvelope<unknown>;
}

/** 每次请求使用独立连接（agent: false），避免 keep-alive 让 app.close() 等待空闲连接 */
function call(
  method: HttpMethod,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { ...options.headers };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }

    const req = request(`${baseUrl}${path}`, { method, agent: false, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          text,
          body: JSON.parse(text) as ApiEnvelope<unknown>,
        });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function bearer(sessionId: string): Record<string, string> {
  return { authorization: `Bearer ${sessionId}` };
}

/**
 * 响应中「业务内容」部分的文本：去掉 `meta`（`requestId` 随机、`generatedAt` 是时间戳）
 * 与 `error.requestId`。回显与「不回显伪造值」的断言必须建立在这部分上。
 */
function contentText(res: HttpResult): string {
  const error = res.body.error;
  return JSON.stringify({
    data: res.body.data,
    error: error
      ? { code: error.code, message: error.message, details: error.details ?? null }
      : null,
  });
}

/** 统一信封的严格形状：恰好三个键，且互斥性由调用方按场景补充断言 */
function expectEnvelopeShape(res: HttpResult): void {
  expect(Object.keys(res.body).sort()).toEqual(['data', 'error', 'meta']);
  expect(typeof res.body.meta).toBe('object');
  expect(res.body.meta).not.toBeNull();
}

function expectNoForgedEcho(res: HttpResult): void {
  const content = contentText(res);
  for (const marker of FORGED_MARKERS) {
    expect(content).not.toContain(marker);
  }
}

beforeAll(async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix(API_PREFIX);
  await app.listen(0, '127.0.0.1');
  startedApps.push(app);
  baseUrl = `${await app.getUrl()}/${API_PREFIX}`;

  // 夹具会话只经端口注入：不预置任何记录，因此授权之后的取数一律是「空集合/未授权」
  const store = app.get<InMemorySessionStore>(SESSION_STORE);
  store.seed({
    sessionId: SESSION_STUDENT,
    subject: { userId: STUDENT, roles: [Role.Student] },
  });
  store.seed({ sessionId: SESSION_ADMIN, subject: { userId: ADMIN, roles: [Role.Admin] } });
});

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

describe('公开 API 契约矩阵：已声明的方法/路径（正例）', () => {
  it.each(DECLARED_ROUTES)(
    '$method $path：无会话时 $anonymousStatus（已注册，而不是 404）',
    async ({ method, path, anonymousStatus }) => {
      const res = await call(method, path);

      // 404 即「路由不存在」：这里必须先排除它，后面的状态码断言才有意义
      expect(res.status, `${method} ${path}`).not.toBe(404);
      expect(res.status, `${method} ${path}`).toBe(anonymousStatus);
      expectEnvelopeShape(res);

      if (anonymousStatus === 200) {
        expect(res.body.error).toBeNull();
        expect(res.body.data).not.toBeNull();
      } else {
        expect(res.body.error?.code).toBe('UNAUTHENTICATED');
        expect(res.body.data).toBeNull();
      }
    },
  );

  it('矩阵按模块前缀登记：新增模块/前缀必须先显式进入契约，而不是悄悄上线', () => {
    const prefixes = [...new Set(DECLARED_ROUTES.map((route) => route.path.split('/')[1]))].sort();

    expect(prefixes).toEqual(['admin', 'groups', 'health', 'me', 'runtime-info']);
    // 公开面（无需会话）恰好三个端点：其余全部先认证
    expect(
      DECLARED_ROUTES.filter((route) => route.anonymousStatus === 200).map(
        (route) => `${route.method} ${route.path}`,
      ),
    ).toEqual(['GET /health', 'GET /health/ready', 'GET /runtime-info']);
  });
});

describe('公开 API 契约矩阵：未声明的方法/路径（反例一律 404）', () => {
  it.each(UNREGISTERED_SHAPES)(
    '$method $path → 404 NOT_FOUND（统一信封，不是 405/500）',
    async ({ method, path }) => {
      const res = await call(method, path);

      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.error?.code).toBe('NOT_FOUND');
      expect(res.body.data).toBeNull();
      expectEnvelopeShape(res);
    },
  );

  it('反例集合与正例集合不相交：不会把已声明的路由当作「未注册」断言', () => {
    const declared = new Set(DECLARED_ROUTES.map((route) => `${route.method} ${route.path}`));
    for (const shape of UNREGISTERED_SHAPES) {
      expect(declared.has(`${shape.method} ${shape.path}`)).toBe(false);
    }
    // 反例必须逐条独立：同一 (method, path) 不重复声明
    const shapes = UNREGISTERED_SHAPES.map((shape) => `${shape.method} ${shape.path}`);
    expect(new Set(shapes).size).toBe(shapes.length);
  });
});

describe('公开 API 契约矩阵：统一响应信封', () => {
  it('成功：严格 { data, meta, error }、error 为 null，requestId 取服务端解析结果', async () => {
    const res = await call('GET', '/health', { headers: { 'x-request-id': 'contract-request-1' } });

    expect(res.status).toBe(200);
    expectEnvelopeShape(res);
    expect(res.body.error).toBeNull();
    expect(res.body.meta.requestId).toBe('contract-request-1');
    expect(typeof res.body.meta.generatedAt).toBe('string');
    expect(Number.isFinite(Date.parse(String(res.body.meta.generatedAt)))).toBe(true);
  });

  it.each([
    {
      name: '401 未认证',
      method: 'GET' as HttpMethod,
      path: '/me/profile',
      headers: {},
      code: 'UNAUTHENTICATED',
    },
    {
      name: '403 越权（管理员没有 SELF 范围）',
      method: 'GET' as HttpMethod,
      path: '/me/exports',
      headers: bearer(SESSION_ADMIN),
      code: 'FORBIDDEN',
    },
    {
      name: '404 未注册路由',
      method: 'GET' as HttpMethod,
      path: `/me/exports/${SAMPLE_ID}`,
      headers: {},
      code: 'NOT_FOUND',
    },
    {
      name: '400 查询串闭集',
      method: 'GET' as HttpMethod,
      path: '/me/exports?status=completed',
      headers: bearer(SESSION_STUDENT),
      code: 'VALIDATION_FAILED',
    },
  ])(
    '失败（$name）：data 为 null、error 非空，且 error.requestId = meta.requestId',
    async ({ method, path, headers, code }) => {
      const res = await call(method, path, { headers });

      expectEnvelopeShape(res);
      expect(res.body.data).toBeNull();
      expect(res.body.error).not.toBeNull();
      expect(res.body.error?.code).toBe(code);
      expect(typeof res.body.error?.message).toBe('string');
      expect(res.body.meta.requestId).toBeTypeOf('string');
      expect(res.body.error?.requestId).toBe(res.body.meta.requestId);
    },
  );
});

describe('公开 API 契约矩阵：不可处理输入一律 400（不使用 422）', () => {
  it.each([
    { name: '导出缺省资源', method: 'POST' as HttpMethod, path: '/me/exports', body: {} },
    {
      name: '导出资源不在白名单',
      method: 'POST' as HttpMethod,
      path: '/me/exports',
      body: { resource: 'users' },
    },
    { name: '导出查询串闭集', method: 'GET' as HttpMethod, path: '/me/exports?status=completed' },
    {
      name: '匹配画像版本越界',
      method: 'POST' as HttpMethod,
      path: '/me/matching-requests',
      body: { profileVersion: 0 },
    },
    {
      name: '升学记录缺必填字段',
      method: 'POST' as HttpMethod,
      path: '/me/education-records',
      body: {},
    },
    { name: '成果缺必填字段', method: 'POST' as HttpMethod, path: '/me/achievements', body: {} },
    {
      name: '入组申请缺 groupId',
      method: 'POST' as HttpMethod,
      path: '/me/applications',
      body: {},
    },
    {
      name: '通知路径参数非法',
      method: 'PATCH' as HttpMethod,
      path: '/me/notifications/not-a-uuid/read',
    },
  ])(
    '$name：$method $path → 400 VALIDATION_FAILED（不是 422，也不是 500）',
    async ({ method, path, body }) => {
      const res = await call(method, path, {
        headers: bearer(SESSION_STUDENT),
        ...(body === undefined ? {} : { body }),
      });

      // 契约只使用 400 表达「请求本身不合法」；422 不在错误码表内，任何端点都不得引入它
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(res.status).not.toBe(422);
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      expect(res.body.data).toBeNull();
      expectEnvelopeShape(res);
    },
  );

  it('越权先于输入校验：同一批非法输入在无权限主体上仍是 403（拿不到字段级反馈）', async () => {
    const res = await call('POST', '/me/exports', {
      headers: bearer(SESSION_ADMIN),
      body: { resource: 'users', userId: FORGED_USER },
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });
});

describe('公开 API 契约矩阵：服务端主体不可由客户端覆盖', () => {
  const sessionRoutes = DECLARED_ROUTES.filter((route) => route.anonymousStatus === 401);

  it.each(sessionRoutes)(
    '$method $path：无凭证 + 伪造头/查询串/请求体 → 仍 401，伪造取值不回显',
    async ({ method, path }) => {
      const res = await call(method, `${path}?${FORGED_QUERY}`, {
        headers: FORGED_HEADERS,
        body: FORGED_BODY,
      });

      // 认证先于授权、字段校验与任何取数：伪造声明连「字段级反馈」都拿不到
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
      expect(res.body.data).toBeNull();
      expectNoForgedEcho(res);
    },
  );

  it('公开端点：伪造声明不改变公开行为（仍 200、仍走统一信封）', async () => {
    for (const path of ['/health', '/health/ready', '/runtime-info']) {
      const res = await call('GET', `${path}?${FORGED_QUERY}`, { headers: FORGED_HEADERS });

      expect(res.status, path).toBe(200);
      expect(res.body.error).toBeNull();
      expectEnvelopeShape(res);
    }
  });

  it('已认证主体不能被伪造的更高角色升级：学生带超管声明访问审核端仍是 403', async () => {
    const escalated = await call('GET', '/admin/applications', {
      headers: { ...bearer(SESSION_STUDENT), ...FORGED_HEADERS },
    });

    expect(escalated.status).toBe(403);
    expect(escalated.body.error?.code).toBe('FORBIDDEN');
    expectNoForgedEcho(escalated);
  });

  it('已认证主体不能被伪造的 SELF/角色声明改变数据范围：管理员访问本人导出仍是 403', async () => {
    const narrowed = await call('GET', `/me/exports?${FORGED_QUERY}`, {
      headers: {
        ...bearer(SESSION_ADMIN),
        ...FORGED_HEADERS,
        'x-roles': 'student',
        'x-scope': 'SELF',
      },
    });

    expect(narrowed.status).toBe(403);
    expect(narrowed.body.error?.code).toBe('FORBIDDEN');
    expectNoForgedEcho(narrowed);
  });
});
