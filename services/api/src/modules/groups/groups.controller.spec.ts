import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { Logger, Module } from '@nestjs/common';
import type { FactoryProvider, INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import {
  DataScope,
  Grade,
  GroupStatus,
  PermissionPoint,
  Role,
  researchGroupInputSchema,
} from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { ApiExceptionFilter } from '../../common/api-exception.filter';
import { ApiResponseInterceptor } from '../../common/api-response.interceptor';
import { APP_ENV, ConfigModule } from '../../config/config.module';
import { loadEnv } from '../../config/env';
import { SQL_CONNECTION_FACTORY } from '../../db/ports/sql-executor.port';
import { AuthModule } from '../auth/auth.module';
import { InMemorySessionStore } from '../auth/session-store.in-memory';
import { SESSION_STORE } from '../auth/session-subject.port';
import { AccessControlModule } from '../access-control/access-control.module';
import { RUOYI_AUTHZ_ADAPTER } from '../ruoyi-adapter/ruoyi-adapter.port';
import type { RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import {
  FORBIDDEN_GROUP_FIELDS,
  GROUP_CREATE_INPUT_FIELDS,
  groupCreateInputSchema,
} from './groups.contract';
import { GroupsController } from './groups.controller';
import { InMemoryGroupRepository } from './groups.in-memory-repository';
import { GROUP_REPOSITORY } from './groups.port';
import type { ResearchGroup } from './groups.port';
import { GroupsService } from './groups.service';
import { GroupsModule } from './groups.module';

/**
 * 小组切片（`/groups`）的**真实 HTTP 回归**（真实 Nest 应用 + 真实 HTTP 套接字，
 * 只通过 DI 令牌/端口注入测试夹具：会话、仓储记录，不替换任何生产代码路径）。
 *
 * 覆盖：
 * - 成功：`GET /groups` 的可见集合（开放状态过滤 + 学生集合级 / 负责人逐组 / 管理员受派 /
 *   系统与超级管理员集合级），`POST /groups` 的创建（负责人与状态由服务端写入、视图不含负责人）；
 * - 输入拒绝 400：共享 schema 的字段级规则（长度、控制字符、枚举、招募要求范围）与**字段闭集**
 *   （`leaderUserId`/`status`/`groupId`/`userId`/`roles`/`scope`/时间戳等一律显式拒绝，不是静默剥离）；
 * - 认证 401：无凭证、scheme 错误、凭证过短、会话不存在、会话主体含未登记角色（整体 fail-closed）；
 * - 越权 403：缺 `group:manage` 的角色创建、负责人没有服务端解析的 `groupIds`、管理员没有任何
 *   `assignedResourceIds`，且判定**先于任何仓储访问**；
 * - 判定入参只来自服务端：请求体 / 查询串 / 自定义头里的归属、角色、范围、小组声明一律无效；
 * - fail-closed 500：存储记录未知枚举 / 非法时间戳 / 非开放小组 / 授权集合之外的小组 /
 *   非 UUID 负责人 / 仓储改写负责人，一律 500 且不泄露字段取值；
 * - 切片装配、契约复用回归与既有路由回归。
 *
 * 已知口径（与 `groups.port.ts` / `groups.service.ts` 的注释一致）：
 * 1. `GET /groups` 尚未分页（契约基线的「分页浏览」由后续切片在仓储端口上加窗口参数实现），
 *    本切片固定返回服务端判定可见的全部开放小组；控制器**不声明任何查询参数**，
 *    因此查询串里的 `groupId`/`scope`/`userId`/`roles` 既不被读取也不被信任（见「伪造无效」用例）；
 * 2. 对外视图不含 `leaderUserId`（数据字典标注为「内部」的负责人标识）。
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const SESSION_STUDENT_1 = 'session-student-1';
const SESSION_STUDENT_2 = 'session-student-2';
const SESSION_ADMIN_NO_ASSIGNMENT = 'session-admin-1';
const SESSION_ADMIN_ASSIGNED = 'session-admin-2';
const SESSION_LEADER = 'session-leader-1';
const SESSION_LEADER_NO_GROUP = 'session-leader-2';
const SESSION_SYSTEM_ADMIN = 'session-sys-1';
const SESSION_SUPER_ADMIN = 'session-super-1';
const SESSION_UNKNOWN_ROLE = 'session-unknown-role';
/** 会话主体 userId 形状合法（认证边界允许不透明 ID）但不是共享契约要求的 UUID */
const SESSION_NON_UUID_SUPER_ADMIN = 'session-super-legacy';

/** 服务端会话里的负责人 ID：共享 `researchGroupInputSchema` 要求其为 UUID */
const SUPER_ADMIN_UUID = '3f1c2a4b-5d6e-4f70-8a91-0b1c2d3e4f50';
const LEADER_UUID = '2f6a1f2e-9c31-4d2b-8f0a-6a1b2c3d4e5f';
/** 负责人所属小组（服务端解析的 groupIds）：同时是存储记录主键，因此必须是 UUID */
const LEADER_OWN_GROUP_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

/** 合法请求体：负责人 `leaderUserId` 与状态 `status` 由服务端补齐，不在请求字段闭集内 */
const validCreateBody = {
  name: '智能机器人小组',
  description: '面向校内竞赛的机器人方向小组',
  researchDirections: ['机器人', '嵌入式'],
  recruitmentRequirements: {
    skills: ['C++'],
    grades: [Grade.Sophomore, Grade.Junior],
    minWeeklyHours: 6,
    headcount: 4,
    note: '需要能参与周末调试',
  },
};

const VIEW_KEYS = [
  'createdAt',
  'description',
  'id',
  'name',
  'recruitmentRequirements',
  'researchDirections',
  'status',
  'updatedAt',
];

const startedApps: INestApplication[] = [];

@Module({
  imports: [ConfigModule, GroupsModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class GroupsHttpModule {}

interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly store: InMemorySessionStore;
  readonly repository: InMemoryGroupRepository;
}

/** 启动真实应用并注入会话夹具（内存基线的显式 seed，不做隐式全局状态） */
async function startGroupsApp(): Promise<TestApp> {
  const app = await NestFactory.create(GroupsHttpModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  startedApps.push(app);

  const store = app.get<InMemorySessionStore>(SESSION_STORE);
  store.seed({
    sessionId: SESSION_STUDENT_1,
    subject: { userId: 'u-student-1', roles: [Role.Student] },
  });
  store.seed({
    sessionId: SESSION_STUDENT_2,
    subject: { userId: 'u-student-2', roles: [Role.Student] },
  });
  // 普通管理员：没有任何服务端分配的可见资源
  store.seed({
    sessionId: SESSION_ADMIN_NO_ASSIGNMENT,
    subject: { userId: 'u-admin-1', roles: [Role.Admin] },
  });
  // 普通管理员：服务端分配了一个可见小组
  store.seed({
    sessionId: SESSION_ADMIN_ASSIGNED,
    subject: {
      userId: 'u-admin-2',
      roles: [Role.Admin],
      assignedResourceIds: [LEADER_OWN_GROUP_ID],
    },
  });
  store.seed({
    sessionId: SESSION_LEADER,
    subject: { userId: LEADER_UUID, roles: [Role.GroupLeader], groupIds: [LEADER_OWN_GROUP_ID] },
  });
  store.seed({
    sessionId: SESSION_LEADER_NO_GROUP,
    subject: { userId: LEADER_UUID, roles: [Role.GroupLeader], groupIds: [] },
  });
  store.seed({
    sessionId: SESSION_SYSTEM_ADMIN,
    subject: { userId: 'u-sys-1', roles: [Role.SystemAdmin] },
  });
  store.seed({
    sessionId: SESSION_SUPER_ADMIN,
    subject: { userId: SUPER_ADMIN_UUID, roles: [Role.SuperAdmin] },
  });
  store.seed({
    sessionId: SESSION_NON_UUID_SUPER_ADMIN,
    subject: { userId: 'u-super-legacy', roles: [Role.SuperAdmin] },
  });
  // 会话存储里出现未登记角色：主体不可信，必须在认证边界整体拒绝
  store.seed({
    sessionId: SESSION_UNKNOWN_ROLE,
    subject: { userId: 'u-unknown-1', roles: ['guest' as Role] },
  });

  return {
    app,
    baseUrl: `${await app.getUrl()}/api/v1`,
    store,
    repository: app.get<InMemoryGroupRepository>(GROUP_REPOSITORY),
  };
}

interface HttpResult {
  status: number;
  text: string;
  body: ApiEnvelope<unknown>;
}

/** 每次请求使用独立连接（agent: false），避免 keep-alive 让 app.close() 等待空闲连接 */
function call(
  baseUrl: string,
  method: 'GET' | 'POST',
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
    return req.end();
  });
}

function bearer(sessionId: string): Record<string, string> {
  return { authorization: `Bearer ${sessionId}` };
}

/** 测试夹具记录：状态与负责人由调用方指定，模拟「存储里已存在的小组」 */
function fixtureGroup(overrides: Partial<ResearchGroup> = {}): ResearchGroup {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: randomUUID(),
    name: '机器人小组',
    researchDirections: ['机器人'],
    recruitmentRequirements: { headcount: 3 },
    leaderUserId: LEADER_UUID,
    status: GroupStatus.Open,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface ValidationIssue {
  path: string;
  message: string;
}

function issuesOf(body: ApiEnvelope<unknown>): ValidationIssue[] {
  const details = body.error?.details as { issues?: ValidationIssue[] } | undefined;
  return details?.issues ?? [];
}

function itemsOf(body: ApiEnvelope<unknown>): Array<Record<string, unknown>> {
  return body.data as Array<Record<string, unknown>>;
}

/** 从真实仓储读出全部记录（只用于断言落库结果，不参与生产路径） */
const ALL_RECORDS_WINDOW = { offset: 0, limit: 100 } as const;

async function storedGroups(
  repository: InMemoryGroupRepository,
): Promise<readonly ResearchGroup[]> {
  return repository.listVisibleGroups(
    { includeAllOpenGroups: true, visibleGroupIds: [] },
    ALL_RECORDS_WINDOW,
  );
}

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('小组：成功路径（真实 HTTP + 统一响应信封）', () => {
  it('学生浏览：集合级可见，只返回开放小组；暂停/关闭的小组与其字段不出现在任何响应文本里', async () => {
    const { baseUrl, repository } = await startGroupsApp();
    const opened = await repository.create(
      fixtureGroup({ name: '开放小组甲', description: '开放小组甲说明' }),
    );
    const opened2 = await repository.create(fixtureGroup({ name: '开放小组乙' }));
    const paused = await repository.create(
      fixtureGroup({ name: '暂停小组', status: GroupStatus.Paused }),
    );
    const closed = await repository.create(
      fixtureGroup({ name: '关闭小组', status: GroupStatus.Closed }),
    );

    const res = await call(baseUrl, 'GET', '/groups', {
      headers: { ...bearer(SESSION_STUDENT_1), 'x-request-id': 'test-request-groups-list' },
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.meta.requestId).toBe('test-request-groups-list');
    // 分页元数据写在 meta（docs/P2-API契约基线.md「分页元数据」），且 total 只统计可见小组
    expect(res.body.meta).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 2,
      totalPages: 1,
    });

    const items = itemsOf(res.body);
    expect(items.map((item) => item.id)).toEqual([opened.id, opened2.id]);
    // 视图字段闭集：不含 leaderUserId（内部负责人标识），也不含任何审核/审计字段
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(VIEW_KEYS);
    expect(items[0]).toMatchObject({
      name: '开放小组甲',
      researchDirections: ['机器人'],
      recruitmentRequirements: { headcount: 3 },
      status: GroupStatus.Open,
    });
    expect(res.text).not.toContain('暂停小组');
    expect(res.text).not.toContain(paused.id);
    expect(res.text).not.toContain('关闭小组');
    expect(res.text).not.toContain(closed.id);
    // 负责人标识（内部字段）不随响应回传
    expect(res.text).not.toContain(LEADER_UUID);
  });

  it('负责人浏览：只看到服务端解析的 groupIds 里的开放小组（逐条资源级判定）', async () => {
    const { baseUrl, repository } = await startGroupsApp();
    const own = await repository.create(
      fixtureGroup({ id: LEADER_OWN_GROUP_ID, name: '本人负责小组' }),
    );
    const other = await repository.create(fixtureGroup({ name: '他人小组' }));

    const res = await call(baseUrl, 'GET', '/groups', { headers: bearer(SESSION_LEADER) });

    expect(res.status).toBe(200);
    const items = itemsOf(res.body);
    expect(items.map((item) => item.id)).toEqual([own.id]);
    expect(res.text).not.toContain('他人小组');
    expect(res.text).not.toContain(other.id);
  });

  it('管理员浏览：只看到服务端分配（assignedResourceIds）的小组；系统管理员为集合级可见', async () => {
    const { baseUrl, repository } = await startGroupsApp();
    const assigned = await repository.create(
      fixtureGroup({ id: LEADER_OWN_GROUP_ID, name: '受派小组' }),
    );
    const notAssigned = await repository.create(fixtureGroup({ name: '未受派小组' }));

    const assignedRes = await call(baseUrl, 'GET', '/groups', {
      headers: bearer(SESSION_ADMIN_ASSIGNED),
    });
    expect(assignedRes.status).toBe(200);
    expect(itemsOf(assignedRes.body).map((item) => item.id)).toEqual([assigned.id]);
    expect(assignedRes.text).not.toContain('未受派小组');
    expect(assignedRes.text).not.toContain(notAssigned.id);

    const systemRes = await call(baseUrl, 'GET', '/groups', {
      headers: bearer(SESSION_SYSTEM_ADMIN),
    });
    expect(systemRes.status).toBe(200);
    expect(itemsOf(systemRes.body)).toHaveLength(2);
  });

  it('空集合：没有任何小组时返回 []，error 为 null', async () => {
    const { baseUrl } = await startGroupsApp();

    const res = await call(baseUrl, 'GET', '/groups', { headers: bearer(SESSION_STUDENT_1) });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data).toEqual([]);
  });

  it('创建：201、负责人与状态由服务端写入、视图不含 leaderUserId，且确实落库', async () => {
    const { baseUrl, repository } = await startGroupsApp();

    const res = await call(baseUrl, 'POST', '/groups', {
      headers: { ...bearer(SESSION_SUPER_ADMIN), 'x-request-id': 'test-request-groups-create' },
      body: validCreateBody,
    });

    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    expect(res.body.meta.requestId).toBe('test-request-groups-create');

    const data = res.body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(VIEW_KEYS);
    expect(UUID_V4.test(String(data.id))).toBe(true);
    expect(data).toMatchObject({
      name: '智能机器人小组',
      description: '面向校内竞赛的机器人方向小组',
      researchDirections: ['机器人', '嵌入式'],
      recruitmentRequirements: validCreateBody.recruitmentRequirements,
      // 新建小组一律由服务端置为开放
      status: GroupStatus.Open,
    });
    // 负责人标识（会话主体）不出现在响应里
    expect(res.text).not.toContain(SUPER_ADMIN_UUID);

    const stored = await storedGroups(repository);
    expect(stored).toHaveLength(1);
    // 负责人取会话主体（服务端解析值），不是任何客户端字段
    expect(stored[0]?.leaderUserId).toBe(SUPER_ADMIN_UUID);
    expect(stored[0]?.status).toBe(GroupStatus.Open);
    expect(stored[0]?.id).toBe(data.id);
    // 创建时间与更新时间由服务端写入且为 ISO 8601
    expect(stored[0]?.createdAt).toBe(stored[0]?.updatedAt);
    expect(new Date(String(stored[0]?.createdAt)).toISOString()).toBe(stored[0]?.createdAt);
  });

  it('创建：可选字段缺省时视图只输出必填字段（逐字段显式投影）', async () => {
    const { baseUrl } = await startGroupsApp();

    const res = await call(baseUrl, 'POST', '/groups', {
      headers: bearer(SESSION_SUPER_ADMIN),
      body: {
        name: '极简小组',
        researchDirections: ['方向'],
        recruitmentRequirements: {},
      },
    });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body.data as Record<string, unknown>).sort()).toEqual(
      VIEW_KEYS.filter((key) => key !== 'description'),
    );
  });
});

describe('小组：输入拒绝（400 VALIDATION_FAILED，不落库）', () => {
  const invalidCases: ReadonlyArray<{ name: string; body: unknown }> = [
    { name: '空对象（缺全部必填字段）', body: {} },
    { name: '缺少小组名称', body: { ...validCreateBody, name: undefined } },
    { name: '小组名称为空串', body: { ...validCreateBody, name: '' } },
    { name: '小组名称超长（101 字符）', body: { ...validCreateBody, name: 'x'.repeat(101) } },
    { name: '小组名称含控制字符', body: { ...validCreateBody, name: '小组\u0007名称' } },
    { name: '简介超长（5001 字符）', body: { ...validCreateBody, description: 'x'.repeat(5001) } },
    { name: '简介含控制字符', body: { ...validCreateBody, description: '简介\u0000' } },
    { name: '研究方向为空数组', body: { ...validCreateBody, researchDirections: [] } },
    {
      name: '研究方向超过 10 项',
      body: {
        ...validCreateBody,
        researchDirections: Array.from({ length: 11 }, (_, i) => `方向${i}`),
      },
    },
    {
      name: '研究方向含控制字符',
      body: { ...validCreateBody, researchDirections: ['方向\u0000'] },
    },
    {
      name: '研究方向含空串（标签最小长度为 1）',
      body: { ...validCreateBody, researchDirections: [''] },
    },
    { name: '缺 recruitmentRequirements', body: { name: '小组', researchDirections: ['方向'] } },
    {
      name: '未知年级枚举',
      body: { ...validCreateBody, recruitmentRequirements: { grades: ['unknown_grade'] } },
    },
    {
      name: '招募人数为 0（越界）',
      body: { ...validCreateBody, recruitmentRequirements: { headcount: 0 } },
    },
    {
      name: '招募人数为 201（越界）',
      body: { ...validCreateBody, recruitmentRequirements: { headcount: 201 } },
    },
    {
      name: '每周投入 81 小时（越界）',
      body: { ...validCreateBody, recruitmentRequirements: { minWeeklyHours: 81 } },
    },
    {
      name: '每周投入非整数',
      body: { ...validCreateBody, recruitmentRequirements: { minWeeklyHours: 1.5 } },
    },
    {
      name: '技能标签超过 20 项',
      body: {
        ...validCreateBody,
        recruitmentRequirements: { skills: Array.from({ length: 21 }, (_, i) => `s${i}`) },
      },
    },
    {
      name: '招募说明超长（501 字符）',
      body: { ...validCreateBody, recruitmentRequirements: { note: 'x'.repeat(501) } },
    },
    {
      name: '招募要求不是对象',
      body: { ...validCreateBody, recruitmentRequirements: 'not-an-object' },
    },
    { name: '请求体是数组', body: ['not', 'an', 'object'] },
  ];

  it.each(invalidCases)('$name → 400 且不落库', async ({ body }) => {
    const { baseUrl, repository } = await startGroupsApp();

    const res = await call(baseUrl, 'POST', '/groups', {
      headers: bearer(SESSION_SUPER_ADMIN),
      body,
    });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    expect(res.body.error?.requestId).toBeTruthy();
    // 字段级错误（路径 + 消息）；不落库
    expect(issuesOf(res.body).length).toBeGreaterThan(0);
    expect(await storedGroups(repository)).toHaveLength(0);
  });

  it('非对象请求体（JSON 标量）→ 400 且不落库（拒绝发生在请求体解析层，无字段级 issues）', async () => {
    const { baseUrl, repository } = await startGroupsApp();

    const res = await call(baseUrl, 'POST', '/groups', {
      headers: bearer(SESSION_SUPER_ADMIN),
      body: 'not-an-object',
    });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    expect(res.body.error?.requestId).toBeTruthy();
    // 请求体解析层拒绝：不产生字段级 issues，且不回显原始请求体片段
    // （body-parser 的解析失败消息会回显原文，已由统一异常过滤器替换为安全文案，
    // 见 api-exception.filter.spec.ts 的「请求体解析失败」用例）
    expect(res.body.error?.details).toBeUndefined();
    expect(res.body.error?.message).toBe('提交内容不合法，请检查后重试');
    expect(res.text).not.toContain('not-an-object');
    expect(await storedGroups(repository)).toHaveLength(0);
  });

  it('客户端提交 leaderUserId/status/groupId/groupIds/userId/roles/scope/id/时间戳 一律拒绝，且没有任何小组被写入', async () => {
    const { baseUrl, repository } = await startGroupsApp();

    const victimId = 'u-victim-1';
    const forgedGroupId = randomUUID();
    const injected: Record<string, unknown> = {
      ...validCreateBody,
      id: randomUUID(),
      groupId: forgedGroupId,
      groupIds: [forgedGroupId],
      leaderUserId: randomUUID(),
      leaderUserIds: [randomUUID()],
      userId: victimId,
      ownerUserId: victimId,
      role: Role.SuperAdmin,
      roles: [Role.SuperAdmin],
      scope: DataScope.Global,
      dataScope: DataScope.Global,
      status: GroupStatus.Paused,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const unexpectedKeys = Object.keys(injected)
      .filter((key) => !(GROUP_CREATE_INPUT_FIELDS as readonly string[]).includes(key))
      .sort();
    // 对照组：上述键确实都是「服务端独占/未声明字段」，且都登记在禁止清单里
    expect(unexpectedKeys).toEqual([
      'createdAt',
      'dataScope',
      'groupId',
      'groupIds',
      'id',
      'leaderUserId',
      'leaderUserIds',
      'ownerUserId',
      'role',
      'roles',
      'scope',
      'status',
      'updatedAt',
      'userId',
    ]);
    for (const key of unexpectedKeys) {
      expect(FORBIDDEN_GROUP_FIELDS).toContain(key);
    }

    const res = await call(baseUrl, 'POST', '/groups', {
      headers: bearer(SESSION_SUPER_ADMIN),
      body: injected,
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    const messages = issuesOf(res.body).map((issue) => issue.message);
    for (const key of unexpectedKeys) {
      expect(messages.some((message) => message.includes(key))).toBe(true);
    }
    expect(await storedGroups(repository)).toHaveLength(0);
    // 伪造的归属没有被采纳为「写入目标」
    expect(res.text).not.toContain(victimId);
  });

  it('服务端独占字段即使与合法字段同值也被拒绝（拒绝的是声明本身，不是取值差异）', async () => {
    const { baseUrl, repository } = await startGroupsApp();

    const res = await call(baseUrl, 'POST', '/groups', {
      headers: bearer(SESSION_SUPER_ADMIN),
      // leaderUserId 与真实会话主体相同：仍然 400，客户端无权声明负责人
      body: { ...validCreateBody, leaderUserId: SUPER_ADMIN_UUID },
    });

    expect(res.status).toBe(400);
    expect(
      issuesOf(res.body)
        .map((issue) => issue.message)
        .join('|'),
    ).toContain('leaderUserId');
    expect(await storedGroups(repository)).toHaveLength(0);
  });
});

describe('小组：认证边界 401（fail-closed）', () => {
  const unauthenticatedCases: ReadonlyArray<{ name: string; headers: Record<string, string> }> = [
    { name: '未携带 Authorization', headers: {} },
    { name: 'scheme 不是 Bearer', headers: { authorization: `Token ${SESSION_STUDENT_1}` } },
    { name: 'Bearer 凭证过短', headers: { authorization: 'Bearer short' } },
    { name: '会话不存在', headers: bearer('session-does-not-exist') },
    { name: '会话主体含未登记角色', headers: bearer(SESSION_UNKNOWN_ROLE) },
  ];

  it.each(unauthenticatedCases)('$name → 401 UNAUTHENTICATED', async ({ headers }) => {
    const { baseUrl } = await startGroupsApp();

    const res = await call(baseUrl, 'GET', '/groups', { headers });

    expect(res.status).toBe(401);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    // 不区分失败原因，避免给探测者额外信息
    expect(res.body.error?.message).toBe('登录状态无效或已过期，请重新登录');
    expect(res.text).not.toContain(SESSION_UNKNOWN_ROLE);
    expect(res.text).not.toContain('guest');
  });

  it('未认证的创建请求同样 401，且不产生小组', async () => {
    const { baseUrl, repository } = await startGroupsApp();

    const res = await call(baseUrl, 'POST', '/groups', { body: validCreateBody });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    expect(await storedGroups(repository)).toHaveLength(0);
  });
});

describe('小组：越权 403（AuthorizationGuard + 服务端判定入参）', () => {
  it('角色缺少 group:manage：学生/负责人/普通管理员创建一律 403，且不产生小组', async () => {
    const { baseUrl, repository } = await startGroupsApp();

    for (const sessionId of [SESSION_STUDENT_1, SESSION_LEADER, SESSION_ADMIN_NO_ASSIGNMENT]) {
      const res = await call(baseUrl, 'POST', '/groups', {
        headers: bearer(sessionId),
        body: validCreateBody,
      });
      expect(res.status).toBe(403);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('FORBIDDEN');
      expect(res.body.error?.message).toBe('无权执行该操作');
    }
    expect(await storedGroups(repository)).toHaveLength(0);
  });

  it('负责人没有任何服务端解析的 groupIds、管理员没有 assignedResourceIds → 403（不退化成空列表）', async () => {
    const { baseUrl, repository } = await startGroupsApp();
    await repository.create(fixtureGroup({ name: '可见小组' }));

    for (const sessionId of [SESSION_LEADER_NO_GROUP, SESSION_ADMIN_NO_ASSIGNMENT]) {
      const res = await call(baseUrl, 'GET', '/groups', { headers: bearer(sessionId) });
      expect(res.status).toBe(403);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('FORBIDDEN');
      // 403 不回答「是否存在你看不见的小组」
      expect(res.text).not.toContain('可见小组');
    }
  });

  it('授权先于仓储访问：403 时仓储的读写方法一次都不被调用', async () => {
    const { app, baseUrl, repository } = await startGroupsApp();
    const listSpy = vi.spyOn(repository, 'listVisibleGroups');
    const createSpy = vi.spyOn(repository, 'create');
    expect(app.get(GROUP_REPOSITORY)).toBe(repository);

    const read = await call(baseUrl, 'GET', '/groups', {
      headers: bearer(SESSION_ADMIN_NO_ASSIGNMENT),
    });
    expect(read.status).toBe(403);

    const write = await call(baseUrl, 'POST', '/groups', {
      headers: bearer(SESSION_STUDENT_1),
      body: validCreateBody,
    });
    expect(write.status).toBe(403);

    expect(listSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('授权先于字段校验：无权限主体的非法请求体得到 403，而不是 400（拿不到字段级反馈）', async () => {
    const { baseUrl } = await startGroupsApp();

    const res = await call(baseUrl, 'POST', '/groups', {
      headers: bearer(SESSION_STUDENT_1),
      body: { name: '' },
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('判定入参只来自服务端：学生列表只用 group:read:open + SELF + 会话主体', async () => {
    const { app, baseUrl, repository } = await startGroupsApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');
    await repository.create(fixtureGroup());

    const res = await call(baseUrl, 'GET', '/groups', {
      headers: {
        ...bearer(SESSION_STUDENT_1),
        'x-user-id': 'u-victim-1',
        'x-roles': Role.SuperAdmin,
        'x-scope': DataScope.Global,
        'x-group-id': 'g-forged',
      },
    });

    expect(res.status).toBe(200);
    expect(checkAuthorization).toHaveBeenCalledTimes(1);
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: 'u-student-1', roles: [Role.Student] },
      {
        permission: PermissionPoint.GroupReadOpen,
        scope: DataScope.Self,
        resourceUserId: 'u-student-1',
      },
    );
    // 伪造的自定义头没有进入响应，也没有进入判定入参
    expect(checkAuthorization.mock.calls[0]?.[1]).not.toMatchObject({ scope: DataScope.Global });
    expect(res.text).not.toContain('u-victim-1');
    expect(res.text).not.toContain('g-forged');
  });

  it('判定入参只来自服务端：负责人列表逐个 groupId 判定，创建用 group:manage + GLOBAL', async () => {
    const { app, baseUrl } = await startGroupsApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const list = await call(baseUrl, 'GET', '/groups', {
      headers: { ...bearer(SESSION_LEADER), 'x-group-id': 'g-forged' },
    });
    expect(list.status).toBe(200);
    expect(checkAuthorization).toHaveBeenCalledTimes(1);
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: LEADER_UUID, roles: [Role.GroupLeader], groupIds: [LEADER_OWN_GROUP_ID] },
      {
        permission: PermissionPoint.GroupReadOpen,
        scope: DataScope.Group,
        groupId: LEADER_OWN_GROUP_ID,
      },
    );
    expect(list.text).not.toContain('g-forged');

    checkAuthorization.mockClear();
    const create = await call(baseUrl, 'POST', '/groups', {
      headers: bearer(SESSION_SUPER_ADMIN),
      body: validCreateBody,
    });
    expect(create.status).toBe(201);
    expect(checkAuthorization).toHaveBeenCalledTimes(1);
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: SUPER_ADMIN_UUID, roles: [Role.SuperAdmin] },
      { permission: PermissionPoint.GroupManage, scope: DataScope.Global },
    );
  });
});

describe('小组：客户端声明伪造无效（请求体 / 查询串 / 自定义头）', () => {
  it('查询串里的 groupId/scope/userId/roles 一律 400，不产生任何取数（不是静默忽略）', async () => {
    const { baseUrl, repository } = await startGroupsApp();
    const own = await repository.create(
      fixtureGroup({ id: LEADER_OWN_GROUP_ID, name: '本人负责小组' }),
    );
    const other = await repository.create(fixtureGroup({ name: '他人小组' }));
    const listSpy = vi.spyOn(repository, 'listVisibleGroups');
    const countSpy = vi.spyOn(repository, 'countVisibleGroups');

    const res = await call(
      baseUrl,
      'GET',
      `/groups?groupId=${other.id}&groupIds=${other.id}&scope=GLOBAL&userId=u-victim-1&roles=super_admin&x-group-id=g-forged`,
      { headers: bearer(SESSION_LEADER) },
    );

    // 查询串闭集：服务端独占键必须显式拒绝，且每个键都有可区分的拒绝原因
    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    const messages = issuesOf(res.body).map((issue) => issue.message);
    for (const key of ['groupId', 'groupIds', 'scope', 'userId', 'roles']) {
      expect(messages.some((message) => message.includes(key))).toBe(true);
    }
    // 拒绝发生在取数之前：仓储一次都没有被调用，也没有任何可见集合被泄露
    expect(listSpy).not.toHaveBeenCalled();
    expect(countSpy).not.toHaveBeenCalled();
    expect(res.text).not.toContain('本人负责小组');
    expect(res.text).not.toContain('他人小组');
    expect(res.text).not.toContain('u-victim-1');
    expect(res.text).not.toContain('g-forged');
    expect(own.id).toBe(LEADER_OWN_GROUP_ID);
  });

  it('创建接口不接受查询参数：POST 带 userId/roles/scope/groupId 等任何查询键一律 400，且不落库', async () => {
    const { baseUrl, repository } = await startGroupsApp();
    const createSpy = vi.spyOn(repository, 'create');

    for (const query of [
      'userId=u-victim-1',
      'roles=super_admin',
      'scope=GLOBAL',
      `groupId=${randomUUID()}`,
      `leaderUserId=${SUPER_ADMIN_UUID}`,
      'page=1',
      'x=1',
    ]) {
      const res = await call(baseUrl, 'POST', `/groups?${query}`, {
        headers: bearer(SESSION_SUPER_ADMIN),
        body: validCreateBody,
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      expect(res.text).not.toContain('u-victim-1');
    }
    expect(createSpy).not.toHaveBeenCalled();
    expect(await storedGroups(repository)).toHaveLength(0);

    // 对照组：同一请求体不带查询串即成功（拒绝来自查询键，而不是请求体本身）
    const accepted = await call(baseUrl, 'POST', '/groups', {
      headers: bearer(SESSION_SUPER_ADMIN),
      body: validCreateBody,
    });
    expect(accepted.status).toBe(201);
    expect(await storedGroups(repository)).toHaveLength(1);
  });

  it('授权先于查询串校验（写路径）：无权主体带伪造查询串仍得 403，而不是 400', async () => {
    const { baseUrl, repository } = await startGroupsApp();

    const res = await call(baseUrl, 'POST', '/groups?userId=u-victim-1&scope=GLOBAL', {
      headers: bearer(SESSION_STUDENT_1),
      body: validCreateBody,
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(await storedGroups(repository)).toHaveLength(0);
  });

  it('创建请求体里的归属/角色/范围声明不进入判定也不落库（伪造的归属不是写入目标）', async () => {
    const { baseUrl, repository } = await startGroupsApp();

    const res = await call(baseUrl, 'POST', '/groups', {
      headers: {
        ...bearer(SESSION_SUPER_ADMIN),
        'x-user-id': 'u-victim-1',
        'x-roles': Role.GroupLeader,
        'x-scope': DataScope.Global,
      },
      body: { ...validCreateBody, userId: 'u-victim-1', roles: [Role.Student] },
    });

    expect(res.status).toBe(400);
    const stored = await storedGroups(repository);
    expect(stored).toHaveLength(0);
    expect(res.text).not.toContain('u-victim-1');
  });

  it('自定义头里的角色/范围声明不能把学生提升为集合级可见之外的任何东西', async () => {
    const { baseUrl, repository } = await startGroupsApp();
    const opened = await repository.create(fixtureGroup({ name: '开放小组' }));
    await repository.create(fixtureGroup({ name: '暂时关闭', status: GroupStatus.Closed }));

    const plain = await call(baseUrl, 'GET', '/groups', { headers: bearer(SESSION_STUDENT_1) });
    const forged = await call(baseUrl, 'GET', '/groups', {
      headers: {
        ...bearer(SESSION_STUDENT_1),
        'x-user-id': 'u-admin-9',
        'x-roles': Role.SuperAdmin,
        'x-scope': DataScope.Global,
      },
    });

    expect(forged.status).toBe(200);
    // 与未伪造时逐字节一致（除 requestId 相关的 meta 外，data 必须相同）
    expect(forged.body.data).toEqual(plain.body.data);
    expect(itemsOf(forged.body).map((item) => item.id)).toEqual([opened.id]);
    expect(forged.text).not.toContain(Role.SuperAdmin);
    expect(forged.text).not.toContain('u-admin-9');
  });
});

describe('小组：存储异常与不变量破坏 fail-closed（500，不泄露字段取值）', () => {
  it('存储记录状态为未登记枚举 → 500，且不把未知值/字段取值泄露给调用方', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startGroupsApp();
    const corrupted = await repository.create(
      fixtureGroup({ status: 'unknown_status' as GroupStatus, name: '受损小组名称' }),
    );
    vi.spyOn(repository, 'listVisibleGroups').mockResolvedValue([corrupted]);

    const res = await call(baseUrl, 'GET', '/groups', { headers: bearer(SESSION_STUDENT_1) });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('unknown_status');
    expect(res.text).not.toContain('受损小组名称');
    expect(res.text).not.toContain(corrupted.id);
  });

  it('存储记录时间戳非法 → 500；仓储返回非开放小组 → 500', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startGroupsApp();
    vi.spyOn(repository, 'listVisibleGroups').mockResolvedValue([
      fixtureGroup({ createdAt: '2026-01-01 00:00:00' }),
    ]);

    const res = await call(baseUrl, 'GET', '/groups', { headers: bearer(SESSION_STUDENT_1) });
    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');

    vi.restoreAllMocks();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const paused = await repository.create(
      fixtureGroup({ status: GroupStatus.Paused, name: '暂停小组' }),
    );
    vi.spyOn(repository, 'listVisibleGroups').mockResolvedValue([paused]);

    const pausedRes = await call(baseUrl, 'GET', '/groups', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(pausedRes.status).toBe(500);
    expect(pausedRes.body.error?.code).toBe('INTERNAL_ERROR');
    expect(pausedRes.text).not.toContain('暂停小组');
  });

  it('仓储返回授权集合之外的小组（越权取数）→ 500，绝不当作正常输出', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startGroupsApp();
    const outOfScope = await repository.create(fixtureGroup({ name: '越权小组' }));
    vi.spyOn(repository, 'listVisibleGroups').mockResolvedValue([outOfScope]);

    const res = await call(baseUrl, 'GET', '/groups', { headers: bearer(SESSION_LEADER) });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('越权小组');
    expect(res.text).not.toContain(outOfScope.id);
  });

  it('创建：会话主体 userId 不是共享契约要求的负责人 UUID → 500，且不落库', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startGroupsApp();

    const res = await call(baseUrl, 'POST', '/groups', {
      headers: bearer(SESSION_NON_UUID_SUPER_ADMIN),
      body: validCreateBody,
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('u-super-legacy');
    expect(await storedGroups(repository)).toHaveLength(0);
  });

  it('创建：仓储改写了负责人 → 500，不把他人小组当作创建结果返回', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startGroupsApp();
    vi.spyOn(repository, 'create').mockImplementation(async (record) => ({
      ...record,
      leaderUserId: randomUUID(),
      name: '他人小组',
    }));

    const res = await call(baseUrl, 'POST', '/groups', {
      headers: bearer(SESSION_SUPER_ADMIN),
      body: validCreateBody,
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('他人小组');
    expect(res.text).not.toContain(SUPER_ADMIN_UUID);
  });
});

describe('小组：分页浏览（meta 分页元数据 + 服务端限制 page size）', () => {
  it('显式分页：page/pageSize 决定当前页，total/totalPages 覆盖全部可见小组', async () => {
    const { baseUrl, repository } = await startGroupsApp();
    const first = await repository.create(fixtureGroup({ name: '小组一' }));
    const second = await repository.create(fixtureGroup({ name: '小组二' }));
    await repository.create(fixtureGroup({ name: '已关闭', status: GroupStatus.Closed }));

    const page1 = await call(baseUrl, 'GET', '/groups?page=1&pageSize=1', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(page1.status).toBe(200);
    expect(itemsOf(page1.body).map((item) => item.id)).toEqual([first.id]);
    expect(page1.body.meta).toMatchObject({ page: 1, pageSize: 1, total: 2, totalPages: 2 });

    const page2 = await call(baseUrl, 'GET', '/groups?page=2&pageSize=1', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(page2.status).toBe(200);
    expect(itemsOf(page2.body).map((item) => item.id)).toEqual([second.id]);
    expect(page2.body.meta).toMatchObject({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
  });

  it('超出末页返回空页但元数据保持真实（不悄悄回退到第一页）', async () => {
    const { baseUrl, repository } = await startGroupsApp();
    await repository.create(fixtureGroup({ name: '唯一小组' }));

    const res = await call(baseUrl, 'GET', '/groups?page=5&pageSize=20', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ page: 5, pageSize: 20, total: 1, totalPages: 1 });
    expect(res.text).not.toContain('唯一小组');
  });

  it('服务端限制 page size：默认 20、上限 100，越界/非法值一律 400 且不取数', async () => {
    const { baseUrl, repository } = await startGroupsApp();
    const listSpy = vi.spyOn(repository, 'listVisibleGroups');

    const boundary = await call(baseUrl, 'GET', '/groups?page=1&pageSize=100', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(boundary.status).toBe(200);
    expect(boundary.body.meta).toMatchObject({ pageSize: 100 });

    for (const query of [
      'pageSize=101',
      'pageSize=0',
      'page=0',
      'page=-1',
      'page=abc',
      'page=1.5',
      'page=1&page=2',
    ]) {
      const res = await call(baseUrl, 'GET', `/groups?${query}`, {
        headers: bearer(SESSION_STUDENT_1),
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      expect(issuesOf(res.body).length).toBeGreaterThan(0);
    }
    // 边界值合法请求取了数，非法请求一个都没有进入仓储
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('未声明的查询键（排序/关键词等）→ 400，且给出「只支持 page/pageSize」的可区分原因', async () => {
    const { baseUrl, repository } = await startGroupsApp();
    await repository.create(fixtureGroup({ name: '小组' }));
    const listSpy = vi.spyOn(repository, 'listVisibleGroups');

    for (const query of ['sortBy=name', 'sortOrder=asc', 'keyword=机', 'status=open']) {
      const res = await call(baseUrl, 'GET', `/groups?${query}`, {
        headers: bearer(SESSION_STUDENT_1),
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    }
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('分页参数不参与授权判定：无权主体带合法分页参数仍是 403（先授权后校验）', async () => {
    const { baseUrl, repository } = await startGroupsApp();
    await repository.create(fixtureGroup({ name: '小组' }));

    const res = await call(baseUrl, 'GET', '/groups?page=1&pageSize=10', {
      headers: bearer(SESSION_ADMIN_NO_ASSIGNMENT),
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(res.text).not.toContain('小组');
  });
});

describe('小组：统一响应信封', () => {
  it('成功与失败的响应都严格是 { data, meta, error }，且互斥', async () => {
    const { baseUrl } = await startGroupsApp();

    const list = await call(baseUrl, 'GET', '/groups', { headers: bearer(SESSION_STUDENT_1) });
    expect(Object.keys(list.body).sort()).toEqual(['data', 'error', 'meta']);
    expect(list.body.error).toBeNull();

    const created = await call(baseUrl, 'POST', '/groups', {
      headers: bearer(SESSION_SUPER_ADMIN),
      body: validCreateBody,
    });
    expect(Object.keys(created.body).sort()).toEqual(['data', 'error', 'meta']);
    expect(created.body.error).toBeNull();

    const failure = await call(baseUrl, 'POST', '/groups', {
      headers: bearer(SESSION_SUPER_ADMIN),
      body: { name: '' },
    });
    expect(Object.keys(failure.body).sort()).toEqual(['data', 'error', 'meta']);
    expect(failure.body.data).toBeNull();
    expect(failure.body.error).not.toBeNull();
    expect(failure.body.error?.requestId).toBeTruthy();
  });
});

describe('小组：切片装配、契约复用与既有路由回归', () => {
  it('GroupsModule 只注册本切片的路由/服务，并把仓储令牌绑到「按是否配置数据库分流」的工厂', async () => {
    const providers = (Reflect.getMetadata('providers', GroupsModule) ?? []) as unknown[];
    const controllers = (Reflect.getMetadata('controllers', GroupsModule) ?? []) as unknown[];
    const moduleImports = (Reflect.getMetadata('imports', GroupsModule) ?? []) as unknown[];

    expect(controllers).toEqual([GroupsController]);
    expect(providers).toContain(GroupsService);
    // 内存基线**不再是独立 provider**：它是实现，不是绑定（否则会有两份状态）
    expect(providers).not.toContain(InMemoryGroupRepository);
    expect(providers).not.toContainEqual({
      provide: GROUP_REPOSITORY,
      useExisting: InMemoryGroupRepository,
    });
    // 换绑只发生在这一个 provider 的工厂里
    const binding = providers.find(
      (provider): provider is FactoryProvider =>
        typeof provider === 'object' &&
        provider !== null &&
        (provider as { provide?: unknown }).provide === GROUP_REPOSITORY,
    );
    expect(binding).toBeDefined();
    expect(typeof binding?.useFactory).toBe('function');
    // 可选注入执行器工厂：测试装配无需数据库模块
    expect(binding?.inject).toEqual([APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }]);
    // 依赖方向：认证（auth）与授权（access-control）各自只经端口/服务暴露
    expect(moduleImports).toContain(AuthModule);
    expect(moduleImports).toContain(AccessControlModule);
  });

  it('契约复用回归：创建字段闭集 = 共享 schema 去掉两个服务端独占字段后的键集', async () => {
    expect([...GROUP_CREATE_INPUT_FIELDS].sort()).toEqual(
      Object.keys(groupCreateInputSchema.shape).sort(),
    );
    // 服务端独占字段确实已从派生结果中移除，而共享 schema 本身仍要求它们
    expect(Object.keys(groupCreateInputSchema.shape).sort()).toEqual(
      Object.keys(researchGroupInputSchema.shape)
        .filter((key) => key !== 'leaderUserId' && key !== 'status')
        .sort(),
    );
    const sharedKeys = Object.keys(researchGroupInputSchema.shape);
    expect(sharedKeys).toContain('leaderUserId');
    expect(sharedKeys).toContain('status');
  });

  it('契约复用回归：同一请求体经派生 schema 与共享 schema 解析，剩余字段规则完全一致', async () => {
    const viaCreate = groupCreateInputSchema.parse(validCreateBody);
    const viaShared = researchGroupInputSchema.parse({
      ...validCreateBody,
      leaderUserId: SUPER_ADMIN_UUID,
    });

    expect(viaCreate).toEqual({
      name: validCreateBody.name,
      description: validCreateBody.description,
      researchDirections: validCreateBody.researchDirections,
      recruitmentRequirements: validCreateBody.recruitmentRequirements,
    });
    // 共享 schema 只多出「负责人（服务端写入）」与「状态（默认 open）」两个服务端字段
    expect(viaShared).toEqual({
      ...viaCreate,
      leaderUserId: SUPER_ADMIN_UUID,
      status: GroupStatus.Open,
    });
  });

  it('内存基线如实声明非持久化，并在生产环境拒绝构造（不用内存冒充生产存储）', async () => {
    const developmentEnv = loadEnv({});
    const productionEnv = loadEnv({ NODE_ENV: 'production' });

    expect(new InMemoryGroupRepository(developmentEnv).capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    expect(new InMemorySessionStore(developmentEnv).capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });

    expect(() => new InMemoryGroupRepository(productionEnv)).toThrow(
      /生产环境禁止使用内存小组仓储/u,
    );
    expect(() => new InMemorySessionStore(productionEnv)).toThrow(/生产环境禁止使用内存/u);
  });

  it('完整 AppModule：health / runtime-info 行为不变，小组与既有切片默认一律 401', async () => {
    const app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    startedApps.push(app);
    const baseUrl = `${await app.getUrl()}/api/v1`;

    const health = await call(baseUrl, 'GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body.error).toBeNull();
    expect(health.body.data).toMatchObject({ status: 'ok', prefix: '/api/v1' });

    const runtimeInfo = await call(baseUrl, 'GET', '/runtime-info');
    expect(runtimeInfo.status).toBe(200);
    expect(Object.keys(runtimeInfo.body.data as Record<string, unknown>).sort()).toEqual([
      'aiMatchingEnabled',
      'aiProvider',
      'apiPort',
      'apiPrefix',
      'databaseConfigured',
      'dependencyGate',
      'nodeEnv',
    ]);

    // 默认装配不预置任何会话，因此一律 401（而不是 500/404）
    for (const path of [
      '/groups',
      '/me/education-records',
      '/me/profile',
      '/me/applications',
      '/me/achievements',
    ]) {
      const res = await call(baseUrl, 'GET', path);
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    }
  });
});
