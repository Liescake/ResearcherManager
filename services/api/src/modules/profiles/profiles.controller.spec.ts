import 'reflect-metadata';
import { request } from 'node:http';
import { Logger, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import {
  AvailablePeriod,
  Grade,
  ProgrammingLevel,
  Role,
  studentProfileInputSchema,
} from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { ApiExceptionFilter } from '../../common/api-exception.filter';
import { ApiResponseInterceptor } from '../../common/api-response.interceptor';
import { ConfigModule } from '../../config/config.module';
import { loadEnv } from '../../config/env';
import { AuthModule } from '../auth/auth.module';
import { InMemorySessionStore } from '../auth/session-store.in-memory';
import { SESSION_STORE } from '../auth/session-subject.port';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import { RUOYI_AUTHZ_ADAPTER } from '../ruoyi-adapter/ruoyi-adapter.port';
import type { AuthorizationDecision, RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import { RuoYiAdapterModule } from '../ruoyi-adapter/ruoyi-adapter.module';
import { PROFILE_INPUT_FIELDS } from './student-profile.contract';
import { InMemoryProfileRepository } from './student-profile.in-memory-repository';
import type { ProfileRepository, StudentProfile } from './student-profile.port';
import { PROFILE_REPOSITORY } from './student-profile.port';
import { ProfilesController } from './profiles.controller';
import { ProfilesModule } from './profiles.module';
import { ProfilesService } from './profiles.service';

/**
 * 画像切片（`/me/profile`）的真实 HTTP 回归：
 *
 * - 成功：本人读取与本人更新；归属、创建时间由服务端决定，
 *   响应不含 `userId`、高敏感字段（学号/联系方式）与隐私同意快照（只写不读）；
 * - 输入拒绝 400：未知枚举、越界数值、未同意隐私政策、控制字符、空对象、非对象请求体；
 * - 未知字段 fail-closed 400：`roles`/`scope`/`groupId`/`userId`/`reviewStatus`/`permissions`
 *   一律拒绝（不是静默忽略），且不落库、不产生对他人的写入；
 * - 认证 401：无凭证、scheme 不对、会话不存在、会话主体含未登记角色（fail-closed）；
 * - 越权 403：**授权先于取数**（被拒绝的请求不得触达仓储）；存储归属与主体不一致
 *   （异常仓储/横向越权）时同样 403 且与授权拒绝同文案；判定入参取自**服务端**
 *   （会话主体 + 常量权限点/范围），端口整体拒绝也是 403；
 * - 敏感字段不泄露：学号/联系方式只写不读，任何状态码的响应体都不得出现明文
 *   （隐私同意快照同理）；
 * - fail-closed 500：存储层出现未登记枚举/非法时间戳时不得作为正常输出返回，也不得泄露取值；
 * - 既有路由不变：同一 `AppModule` 下 health / runtime-info / education 行为不变，
 *   且默认装配不预置任何会话与画像。
 *
 * 说明：测试用真实 Nest 应用 + 真实 HTTP（与 `education-records.controller.spec.ts` 同构），
 * 只通过 DI 令牌/端口注入测试夹具（会话、仓储），不替换任何生产代码路径；
 * 唯一的模块替换是「仓储返回他人归属记录」这一缺陷场景，它需要把 `PROFILE_REPOSITORY`
 * 端口换成显式的测试替身，生产 controller/service/guard/adapter 均按真实实现装配。
 */

const SESSION_STUDENT_1 = 'session-student-1';
const SESSION_STUDENT_2 = 'session-student-2';
const SESSION_ADMIN_1 = 'session-admin-1';
const SESSION_UNKNOWN_ROLE = 'session-unknown-role';

const STUDENT_NO_1 = '2023123456';
const PHONE_1 = '13800138000';
const FIXTURE_NOW = '2026-01-01T00:00:00.000Z';

/** 成功响应的字段闭集：没有 userId / studentNo / phone，也没有任何客户端可回传的归属字段 */
const EXPECTED_PROFILE_VIEW_KEYS = [
  'availableTime',
  'college',
  'createdAt',
  'grade',
  'intendedFields',
  'major',
  'name',
  'programmingLevel',
  'researchExperience',
  'researchInterests',
  'skills',
  'strengths',
  'updatedAt',
];

/** 任何响应都不得出现的键：归属/身份、高敏感字段，以及只写不读的隐私同意快照 */
const FORBIDDEN_VIEW_KEYS = ['userId', 'studentNo', 'phone', 'privacyConsent'];

const validPatchBody = {
  college: '数学学院',
  major: '应用数学',
};

const startedApps: INestApplication[] = [];

/** 测试夹具画像：归属主体由调用方指定，模拟「存储里已存在画像」 */
function profileFixture(overrides: Partial<StudentProfile> = {}): StudentProfile {
  return {
    userId: 'u-student-1',
    name: '张三',
    studentNo: STUDENT_NO_1,
    college: '计算机学院',
    major: '软件工程',
    grade: Grade.Junior,
    phone: PHONE_1,
    skills: ['TypeScript', 'SQL'],
    programmingLevel: ProgrammingLevel.Intermediate,
    researchExperience: '参与过校级科研项目',
    availableTime: { weeklyHours: 10, periods: [AvailablePeriod.Weekend] },
    researchInterests: ['机器学习'],
    strengths: '沟通与文档能力',
    intendedFields: ['人工智能'],
    privacyConsent: { policyVersion: 'v1.0', consentedAt: FIXTURE_NOW },
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

@Module({
  imports: [ConfigModule, ProfilesModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class ProfilesHttpModule {}

/**
 * 测试替身：模拟「仓储返回了归属他人的记录」（横向读取缺陷或数据被外部篡改）。
 * 只实现端口语义 —— `findByUserId` 忽略入参、固定返回他人归属的记录，
 * 用于验证服务端对**存储归属**的 SELF 判定不会退化成「谁查谁就能看」；
 * `save` 直接失败，避免把越权写入误当成通过。
 */
class ForeignOwnerProfileRepository implements ProfileRepository {
  readonly capabilities = {
    backend: 'test-double-foreign-owner',
    persistent: false,
    productionReady: false,
  } as const;

  saveCalls = 0;

  constructor(private readonly foreign: StudentProfile) {}

  async findByUserId(_userId: string): Promise<StudentProfile | undefined> {
    return { ...this.foreign };
  }

  async save(_profile: StudentProfile): Promise<StudentProfile> {
    this.saveCalls += 1;
    throw new Error('归属不符时不得写入');
  }
}

const foreignOwnerRepository = new ForeignOwnerProfileRepository(
  profileFixture({
    userId: 'u-student-2',
    name: '李四',
    college: '他人学院',
    studentNo: '2023999999',
    phone: '13900139000',
  }),
);

/** 同一套生产 controller/service/guard，但画像仓储端口绑定为「返回他人归属」的替身 */
@Module({
  imports: [ConfigModule, AuthModule, RuoYiAdapterModule],
  controllers: [ProfilesController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    ProfilesService,
    AuthorizationGuard,
    { provide: PROFILE_REPOSITORY, useValue: foreignOwnerRepository },
  ],
})
class ForeignOwnerProfilesHttpModule {}

interface HttpResult {
  status: number;
  text: string;
  body: ApiEnvelope<unknown>;
}

/** 每次请求使用独立连接（agent: false），避免 keep-alive 让 app.close() 等待空闲连接 */
function call(
  baseUrl: string,
  method: 'GET' | 'PATCH',
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

/** 启动真实应用（画像切片）并注入会话夹具；画像按用例显式 seed，不做隐式全局状态 */
async function startProfilesApp(): Promise<{
  app: INestApplication;
  baseUrl: string;
  sessions: InMemorySessionStore;
  repository: InMemoryProfileRepository;
}> {
  const app = await NestFactory.create(ProfilesHttpModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  startedApps.push(app);

  const sessions = app.get<InMemorySessionStore>(SESSION_STORE);
  sessions.seed({
    sessionId: SESSION_STUDENT_1,
    subject: { userId: 'u-student-1', roles: [Role.Student] },
  });
  sessions.seed({
    sessionId: SESSION_STUDENT_2,
    subject: { userId: 'u-student-2', roles: [Role.Student] },
  });
  sessions.seed({
    sessionId: SESSION_ADMIN_1,
    subject: { userId: 'u-admin-1', roles: [Role.Admin] },
  });
  // 会话存储里出现未登记角色：主体不可信，必须在认证边界整体拒绝
  sessions.seed({
    sessionId: SESSION_UNKNOWN_ROLE,
    subject: { userId: 'u-unknown-1', roles: ['guest' as Role] },
  });

  return {
    app,
    baseUrl: `${await app.getUrl()}/api/v1`,
    sessions,
    // 绑定点是端口：内存基线不再是独立 provider（避免「容器里那个实例」与「端口上那个实例」两份状态）
    repository: app.get<InMemoryProfileRepository>(PROFILE_REPOSITORY),
  };
}

/** 启动「仓储返回他人归属记录」的缺陷装配（端口绑定为测试替身） */
async function startForeignOwnerApp(): Promise<{
  app: INestApplication;
  baseUrl: string;
}> {
  const app = await NestFactory.create(ForeignOwnerProfilesHttpModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  startedApps.push(app);

  const sessions = app.get<InMemorySessionStore>(SESSION_STORE);
  sessions.seed({
    sessionId: SESSION_STUDENT_1,
    subject: { userId: 'u-student-1', roles: [Role.Student] },
  });

  return { app, baseUrl: `${await app.getUrl()}/api/v1` };
}

interface ValidationIssue {
  path: string;
  message: string;
}

function issuesOf(body: ApiEnvelope<unknown>): ValidationIssue[] {
  const details = body.error?.details as { issues?: ValidationIssue[] } | undefined;
  return details?.issues ?? [];
}

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('画像：成功路径（真实 HTTP + 统一响应信封）', () => {
  it('本人读取：200、error 为 null、字段闭集不含 userId/学号/联系方式/隐私同意快照，且不泄露明文', async () => {
    const { baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture());

    const res = await call(baseUrl, 'GET', '/me/profile', {
      headers: { ...bearer(SESSION_STUDENT_1), 'x-request-id': 'test-profile-1' },
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.meta.requestId).toBe('test-profile-1');

    const data = res.body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(EXPECTED_PROFILE_VIEW_KEYS);
    for (const key of FORBIDDEN_VIEW_KEYS) {
      expect(Object.keys(data)).not.toContain(key);
    }
    expect(data).toMatchObject({
      name: '张三',
      college: '计算机学院',
      major: '软件工程',
      grade: Grade.Junior,
      programmingLevel: ProgrammingLevel.Intermediate,
      skills: ['TypeScript', 'SQL'],
      researchExperience: '参与过校级科研项目',
      availableTime: { weeklyHours: 10, periods: [AvailablePeriod.Weekend] },
      researchInterests: ['机器学习'],
      strengths: '沟通与文档能力',
      intendedFields: ['人工智能'],
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW,
    });

    // 高敏感明文（学号/联系方式）与只写不读的同意快照不出现在响应体的任何位置
    expect(res.text).not.toContain(STUDENT_NO_1);
    expect(res.text).not.toContain(PHONE_1);
    expect(res.text).not.toContain('u-student-1');
    expect(res.text).not.toContain('policyVersion');
    expect(res.text).not.toContain('consentedAt');
  });

  it('本人更新：200、只改提交字段、归属与创建时间不变、updatedAt 由服务端刷新', async () => {
    const { baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture());

    const res = await call(baseUrl, 'PATCH', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
      body: { ...validPatchBody, skills: ['TypeScript', 'Python'] },
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    const data = res.body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(EXPECTED_PROFILE_VIEW_KEYS);
    expect(data).toMatchObject({
      college: '数学学院',
      major: '应用数学',
      skills: ['TypeScript', 'Python'],
      // 未提交的字段保持原值
      name: '张三',
      grade: Grade.Junior,
      researchInterests: ['机器学习'],
      createdAt: FIXTURE_NOW,
    });

    const stored = await repository.findByUserId('u-student-1');
    expect(stored?.userId).toBe('u-student-1');
    expect(stored?.createdAt).toBe(FIXTURE_NOW);
    expect(stored?.updatedAt).toBe(data.updatedAt);
    expect(stored?.updatedAt).not.toBe(FIXTURE_NOW);
    expect(stored?.college).toBe('数学学院');
    // 归属与高敏感字段未被请求体影响：学号/联系方式沿用存储值
    expect(stored?.studentNo).toBe(STUDENT_NO_1);
    expect(stored?.phone).toBe(PHONE_1);
    expect(res.text).not.toContain(STUDENT_NO_1);
    expect(res.text).not.toContain(PHONE_1);
  });

  it('可选文本用空串清空：存储与响应都不再包含该字段', async () => {
    const { baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture());

    const res = await call(baseUrl, 'PATCH', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
      body: { researchExperience: '', strengths: '' },
    });

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    expect(Object.keys(data)).not.toContain('researchExperience');
    expect(Object.keys(data)).not.toContain('strengths');
    const stored = await repository.findByUserId('u-student-1');
    expect(stored?.researchExperience).toBeUndefined();
    expect(stored?.strengths).toBeUndefined();
  });

  it('隐私同意：提供时由服务端记录时间，未提供时沿用原快照（快照只写入存储，不回传）', async () => {
    const { baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture());

    const provided = await call(baseUrl, 'PATCH', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
      body: { privacyConsent: { policyVersion: 'v1.1', agreed: true } },
    });
    expect(provided.status).toBe(200);
    const providedData = provided.body.data as Record<string, unknown>;
    expect(Object.keys(providedData)).not.toContain('privacyConsent');
    expect(provided.text).not.toContain('policyVersion');

    const consent = (await repository.findByUserId('u-student-1'))?.privacyConsent;
    expect(consent?.policyVersion).toBe('v1.1');
    expect(consent?.consentedAt).toBeTruthy();
    expect(new Date(String(consent?.consentedAt)).toISOString()).toBe(consent?.consentedAt);

    const kept = await call(baseUrl, 'PATCH', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
      body: { college: '外国语学院' },
    });
    expect(kept.status).toBe(200);
    expect(kept.text).not.toContain('policyVersion');
    // 未提交隐私同意时沿用原快照（存储值不变）
    expect((await repository.findByUserId('u-student-1'))?.privacyConsent.policyVersion).toBe(
      'v1.1',
    );
  });

  it('两个用户各自读取与更新：只作用于本人记录，他人记录完全不变', async () => {
    const { baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture({ userId: 'u-student-1' }));
    repository.seed(
      profileFixture({
        userId: 'u-student-2',
        name: '李四',
        college: '他人学院',
        major: '他人专业',
      }),
    );

    const mine = await call(baseUrl, 'GET', '/me/profile', { headers: bearer(SESSION_STUDENT_1) });
    const others = await call(baseUrl, 'GET', '/me/profile', {
      headers: bearer(SESSION_STUDENT_2),
    });
    expect(mine.status).toBe(200);
    expect(others.status).toBe(200);
    expect((mine.body.data as Record<string, unknown>).name).toBe('张三');
    expect((others.body.data as Record<string, unknown>).name).toBe('李四');
    expect(mine.text).not.toContain('他人学院');
    expect(others.text).not.toContain('计算机学院');

    const patched = await call(baseUrl, 'PATCH', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
      body: validPatchBody,
    });
    expect(patched.status).toBe(200);
    expect((await repository.findByUserId('u-student-1'))?.college).toBe('数学学院');
    // 他人记录连时间戳都不变
    const untouched = await repository.findByUserId('u-student-2');
    expect(untouched?.college).toBe('他人学院');
    expect(untouched?.updatedAt).toBe(FIXTURE_NOW);
  });
});

describe('画像：输入拒绝（400 VALIDATION_FAILED，不落库）', () => {
  const invalidCases: ReadonlyArray<{ name: string; body: unknown }> = [
    { name: '未知 grade 枚举', body: { grade: 'postgraduate' } },
    { name: '未知 programmingLevel 枚举', body: { programmingLevel: 'expert' } },
    {
      name: '空余时间小时数越界',
      body: { availableTime: { weeklyHours: 200, periods: ['weekend'] } },
    },
    { name: '空余时间段为空数组', body: { availableTime: { weeklyHours: 10, periods: [] } } },
    { name: '未同意隐私政策', body: { privacyConsent: { policyVersion: 'v1.0', agreed: false } } },
    { name: '联系方式格式非法', body: { phone: '12345' } },
    { name: '姓名含控制字符', body: { name: '张\u0007三' } },
    { name: '标签列表为空', body: { skills: [] } },
    { name: '空对象（没有任何变更字段）', body: {} },
    // 数组是合法 JSON，会到达字段级校验（标量请求体属于 body-parser 的边界，见服务层用例）
    { name: '请求体是数组', body: ['not', 'an', 'object'] },
  ];

  it.each(invalidCases)('$name → 400 且不落库', async ({ body }) => {
    const { baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture());

    const res = await call(baseUrl, 'PATCH', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
      body,
    });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    expect(res.body.error?.requestId).toBeTruthy();
    expect(issuesOf(res.body).length).toBeGreaterThan(0);
    // 存储记录保持原样（连 updatedAt 都不变）
    const stored = await repository.findByUserId('u-student-1');
    expect(stored?.updatedAt).toBe(FIXTURE_NOW);
    expect(stored?.college).toBe('计算机学院');
    // 拒绝响应同样不泄露高敏感明文
    expect(res.text).not.toContain(STUDENT_NO_1);
    expect(res.text).not.toContain(PHONE_1);
  });

  it('客户端提交 roles/scope/groupId/userId/reviewStatus/permissions 一律拒绝，且没有任何写入', async () => {
    const { baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture());

    const injected: Record<string, unknown> = {
      ...validPatchBody,
      roles: [Role.SuperAdmin],
      scope: 'GLOBAL',
      groupId: 'g-1',
      userId: 'u-victim-1',
      reviewStatus: 'approved',
      permissions: ['profile:admin:correct'],
    };
    const unexpectedKeys = Object.keys(injected)
      .filter((key) => !(PROFILE_INPUT_FIELDS as readonly string[]).includes(key))
      .sort();
    expect(unexpectedKeys).toEqual([
      'groupId',
      'permissions',
      'reviewStatus',
      'roles',
      'scope',
      'userId',
    ]);

    const res = await call(baseUrl, 'PATCH', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
      body: injected,
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    const issues = issuesOf(res.body);
    // 每个未声明字段都有一条可定位的 issue（path 指向违规字段本身）
    for (const key of unexpectedKeys) {
      expect(issues.some((issue) => issue.path === key)).toBe(true);
    }
    // 身份/权限字段给出可区分的拒绝原因
    for (const key of ['userId', 'roles', 'scope', 'groupId', 'permissions', 'reviewStatus']) {
      expect(
        issues.some(
          (issue) => issue.message.includes('身份/权限字段') && issue.message.includes(key),
        ),
      ).toBe(true);
    }

    // 伪造的归属没有被采纳为写入目标，本人记录也未被改动
    expect(await repository.findByUserId('u-victim-1')).toBeUndefined();
    expect((await repository.findByUserId('u-student-1'))?.updatedAt).toBe(FIXTURE_NOW);
    expect((await repository.findByUserId('u-student-1'))?.userId).toBe('u-student-1');
  });

  it('无画像时更新 404、读取 404；非法画像 ID 之类的外部输入无从注入', async () => {
    const { baseUrl } = await startProfilesApp();

    const read = await call(baseUrl, 'GET', '/me/profile', { headers: bearer(SESSION_STUDENT_1) });
    expect(read.status).toBe(404);
    expect(read.body.error?.code).toBe('NOT_FOUND');

    const write = await call(baseUrl, 'PATCH', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
      body: validPatchBody,
    });
    expect(write.status).toBe(404);
    expect(write.body.error?.code).toBe('NOT_FOUND');
  });
});

describe('画像：认证边界 401（fail-closed）', () => {
  const unauthenticatedCases: ReadonlyArray<{ name: string; headers: Record<string, string> }> = [
    { name: '未携带 Authorization', headers: {} },
    { name: 'scheme 不是 Bearer', headers: { authorization: `Token ${SESSION_STUDENT_1}` } },
    { name: 'Bearer 凭证过短', headers: { authorization: 'Bearer short' } },
    { name: '会话不存在', headers: bearer('session-does-not-exist') },
    { name: '会话主体含未登记角色', headers: bearer(SESSION_UNKNOWN_ROLE) },
  ];

  it.each(unauthenticatedCases)('$name → 401 UNAUTHENTICATED', async ({ headers }) => {
    const { baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture());

    const read = await call(baseUrl, 'GET', '/me/profile', { headers });
    expect(read.status).toBe(401);
    expect(read.body.data).toBeNull();
    expect(read.body.error?.code).toBe('UNAUTHENTICATED');
    // 不区分失败原因，避免给探测者额外信息
    expect(read.body.error?.message).toBe('登录状态无效或已过期，请重新登录');
    expect(read.text).not.toContain(SESSION_UNKNOWN_ROLE);
    expect(read.text).not.toContain('guest');
    // 401 响应同样不得泄露已存在的画像明文
    expect(read.text).not.toContain(STUDENT_NO_1);
    expect(read.text).not.toContain(PHONE_1);

    // 未认证的写请求同样 401，且不产生写入
    const write = await call(baseUrl, 'PATCH', '/me/profile', {
      headers,
      body: validPatchBody,
    });
    expect(write.status).toBe(401);
    expect(write.body.error?.code).toBe('UNAUTHENTICATED');
    expect((await repository.findByUserId('u-student-1'))?.college).toBe('计算机学院');
  });

  it('未认证 + 非法请求体 → 仍是 401（认证先于字段校验）', async () => {
    const { baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture());

    const res = await call(baseUrl, 'PATCH', '/me/profile', {
      body: { roles: [Role.SuperAdmin], grade: 'unknown' },
    });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    expect((await repository.findByUserId('u-student-1'))?.updatedAt).toBe(FIXTURE_NOW);
  });
});

describe('画像：越权 403（AuthorizationGuard + RUOYI_AUTHZ_ADAPTER）', () => {
  it('存储归属与主体不一致（横向越权/仓储缺陷）：403，不泄露他人任何字段，也不写入', async () => {
    const { app, baseUrl } = await startForeignOwnerApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const read = await call(baseUrl, 'GET', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(read.status).toBe(403);
    expect(read.body.data).toBeNull();
    expect(read.body.error?.code).toBe('FORBIDDEN');
    expect(read.text).not.toContain('u-student-2');
    expect(read.text).not.toContain('李四');
    expect(read.text).not.toContain('他人学院');
    expect(read.text).not.toContain('2023999999');
    expect(read.text).not.toContain('13900139000');

    // 判定确实经适配器端口，且入参只来自服务端：
    // 先行判定取**会话主体**，取数后的二次 SELF 判定取**存储归属**（都不是请求体）；
    // 仓储返回他人归属时第二次判定必然拒绝，且与授权拒绝不区分。
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: 'u-student-1', roles: [Role.Student] },
      { permission: 'profile:self:read', scope: 'SELF', resourceUserId: 'u-student-1' },
    );
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: 'u-student-1', roles: [Role.Student] },
      { permission: 'profile:self:read', scope: 'SELF', resourceUserId: 'u-student-2' },
    );

    const write = await call(baseUrl, 'PATCH', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
      body: validPatchBody,
    });
    expect(write.status).toBe(403);
    expect(write.body.error?.code).toBe('FORBIDDEN');
    expect(write.body.error?.message).toBe('无权执行该操作');
    expect(foreignOwnerRepository.saveCalls).toBe(0);
  });

  it('判定入参是服务端主体与常量：本人读取/更新都只提交 SELF + 该权限点', async () => {
    const { app, baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture());
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const read = await call(baseUrl, 'GET', '/me/profile', { headers: bearer(SESSION_STUDENT_1) });
    expect(read.status).toBe(200);
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: 'u-student-1', roles: [Role.Student] },
      { permission: 'profile:self:read', scope: 'SELF', resourceUserId: 'u-student-1' },
    );

    const write = await call(baseUrl, 'PATCH', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
      body: validPatchBody,
    });
    expect(write.status).toBe(200);
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: 'u-student-1', roles: [Role.Student] },
      { permission: 'profile:self:update', scope: 'SELF', resourceUserId: 'u-student-1' },
    );
  });

  it('适配器端口整体拒绝 → 403（真实 HTTP，拒绝原因不外泄；且不访问仓储）', async () => {
    const { app, baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture());
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    vi.spyOn(adapter, 'checkAuthorization').mockReturnValue({
      allowed: false,
      reason: 'policy-denied',
    });
    const collegeBefore = (await repository.findByUserId('u-student-1'))?.college;
    const findByUserId = vi.spyOn(repository, 'findByUserId');

    const read = await call(baseUrl, 'GET', '/me/profile', { headers: bearer(SESSION_STUDENT_1) });
    expect(read.status).toBe(403);
    expect(read.body.error?.code).toBe('FORBIDDEN');
    expect(read.body.data).toBeNull();
    expect(read.text).not.toMatch(/unknown-|policy-denied/u);
    // 只读判定被拒绝时不得回吐任何画像内容
    expect(read.text).not.toContain('计算机学院');
    expect(read.text).not.toContain('张三');

    const write = await call(baseUrl, 'PATCH', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
      body: validPatchBody,
    });
    expect(write.status).toBe(403);
    // 授权先行：被拒绝的请求不得触达仓储（不泄露资源存在性，也不产生无谓读）
    expect(findByUserId).not.toHaveBeenCalled();
    expect(collegeBefore).toBe('计算机学院');
  });

  it('授权先于字段校验与取数：无权主体带非法请求体得到 403，而不是校验反馈', async () => {
    const { app, baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture());
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    vi.spyOn(adapter, 'checkAuthorization').mockReturnValue({
      allowed: false,
      reason: 'policy-denied',
    });
    const findByUserId = vi.spyOn(repository, 'findByUserId');

    const res = await call(baseUrl, 'PATCH', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
      body: { grade: 'unknown', roles: [Role.SuperAdmin] },
    });

    expect(res.status).toBe(403);
    expect(issuesOf(res.body)).toHaveLength(0);
    // 授权拒绝排在取数与字段校验之前
    expect(findByUserId).not.toHaveBeenCalled();
    expect((await repository.findByUserId('u-student-1'))?.updatedAt).toBe(FIXTURE_NOW);
  });

  it('端口抛出的拒绝决策不携带内部原因，403 文案固定', async () => {
    const { app, baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture());
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const denied: AuthorizationDecision = { allowed: false, reason: 'unknown-permission' };
    vi.spyOn(adapter, 'checkAuthorization').mockReturnValue(denied);

    const res = await call(baseUrl, 'GET', '/me/profile', { headers: bearer(SESSION_STUDENT_1) });
    expect(res.status).toBe(403);
    expect(res.body.error?.message).toBe('无权执行该操作');
    expect(res.text).not.toContain('unknown-permission');
  });
});

describe('画像：存储异常 fail-closed（不得当正常输出）', () => {
  it('存储记录 grade 为未登记枚举 → 500，且不把未知值/字段取值泄露给调用方', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture({ grade: 'unknown_grade' as Grade, college: '受损记录学院' }));

    const read = await call(baseUrl, 'GET', '/me/profile', { headers: bearer(SESSION_STUDENT_1) });
    expect(read.status).toBe(500);
    expect(read.body.data).toBeNull();
    expect(read.body.error?.code).toBe('INTERNAL_ERROR');
    expect(read.text).not.toContain('unknown_grade');
    expect(read.text).not.toContain('受损记录学院');
    expect(read.text).not.toContain('u-student-1');

    const write = await call(baseUrl, 'PATCH', '/me/profile', {
      headers: bearer(SESSION_STUDENT_1),
      body: validPatchBody,
    });
    expect(write.status).toBe(500);
    expect(write.body.error?.code).toBe('INTERNAL_ERROR');
    expect(read.text).not.toContain('unknown_grade');
  });

  it('存储记录时间戳非法 → 500（读取契约包含时间格式）', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture({ createdAt: '2026-01-01 00:00:00' }));

    const res = await call(baseUrl, 'GET', '/me/profile', { headers: bearer(SESSION_STUDENT_1) });
    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
  });

  it('存储记录缺少高敏感字段形状（学号非法）→ 500，说明读取契约覆盖全部存储字段', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startProfilesApp();
    repository.seed(profileFixture({ studentNo: '!!' }));

    const res = await call(baseUrl, 'GET', '/me/profile', { headers: bearer(SESSION_STUDENT_1) });
    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('!!');
  });
});

describe('切片装配与既有路由不变', () => {
  it('ProfilesModule 只注册本切片的路由与服务，并把仓储端口绑到「按是否配置数据库分流」的工厂', () => {
    const providers = (Reflect.getMetadata('providers', ProfilesModule) ?? []) as unknown[];
    const controllers = (Reflect.getMetadata('controllers', ProfilesModule) ?? []) as unknown[];
    const imports = (Reflect.getMetadata('imports', ProfilesModule) ?? []) as unknown[];

    expect(controllers).toEqual([ProfilesController]);
    expect(providers).toContain(ProfilesService);
    // 绑定点是端口 + 工厂：不再有「内存基线 provider」这第二个实例（避免两份状态）
    expect(providers).not.toContain(InMemoryProfileRepository);
    expect(providers).toContainEqual(
      expect.objectContaining({ provide: PROFILE_REPOSITORY, useFactory: expect.any(Function) }),
    );
    // 依赖方向：认证（auth）与授权（access-control）各自只经端口/服务暴露
    expect(imports).toContain(AuthModule);
  });

  it('内存基线如实声明非持久化，并在生产环境拒绝构造（不用内存冒充生产存储）', () => {
    const developmentEnv = loadEnv({});
    const productionEnv = loadEnv({ NODE_ENV: 'production' });

    expect(new InMemoryProfileRepository(developmentEnv).capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    expect(() => new InMemoryProfileRepository(productionEnv)).toThrow(/生产环境禁止使用内存/u);
  });

  it('本地输入闭集与共享 studentProfileInputSchema 的字段集完全一致（防止契约漂移）', () => {
    expect(Object.keys(studentProfileInputSchema.shape).sort()).toEqual(
      [...PROFILE_INPUT_FIELDS].sort(),
    );
  });

  it('完整 AppModule：health / runtime-info / education 行为不变，画像默认 401（不预置任何会话与画像）', async () => {
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

    const education = await call(baseUrl, 'GET', '/me/education-records');
    expect(education.status).toBe(401);
    expect(education.body.error?.code).toBe('UNAUTHENTICATED');

    const profile = await call(baseUrl, 'GET', '/me/profile');
    expect(profile.status).toBe(401);
    expect(profile.body.error?.code).toBe('UNAUTHENTICATED');

    const profilePatch = await call(baseUrl, 'PATCH', '/me/profile', { body: validPatchBody });
    expect(profilePatch.status).toBe(401);
    expect(profilePatch.body.error?.code).toBe('UNAUTHENTICATED');
  });

  it('默认装配不预置任何画像：内存基线初始为空', async () => {
    const { repository } = await startProfilesApp();
    expect(await repository.findByUserId('u-student-1')).toBeUndefined();
  });
});
