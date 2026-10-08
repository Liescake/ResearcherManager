import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';
import {
  AvailablePeriod,
  DataScope,
  Grade,
  GroupStatus,
  MatchingRequestStatus,
  PermissionPoint,
  ProgrammingLevel,
  Role,
  matchingRequestInputSchema,
} from '@rm/shared';
import type { StateTransitionError } from '@rm/shared';
import {
  AiErrorCode,
  buildFallbackRecommendations,
  createMockProvider,
  type AiProvider,
  type MatchFeatureBundle,
} from '@rm/ai-adapter';
import { ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../config/env';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import { AuthorizationPolicy } from '../access-control/authorization-policy';
import { BaselineRuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.baseline';
import {
  MATCHING_REQUEST_INPUT_FIELDS,
  MATCHING_REQUEST_INTEGRITY_MESSAGE,
} from './matching.contract';
import type { MatchingFeatureSource, MatchingRepository, MatchingRequest } from './matching.port';
import { MatchingService } from './matching.service';

/**
 * 匹配服务层回归（不启 HTTP）：把「主体与归属只来自服务端」「授权先于字段校验与仓储访问」
 * 「AI 关闭走明确规则降级」「模型输出含个人标识即降级」「状态机只允许 pending → 终态」
 * 「召回数据损坏收敛为 failed 而不是 500」与「存储越界/损坏一律 fail-closed」
 * 这些约束固定在 service 这一层，避免它们只靠 HTTP 用例间接覆盖。
 */

const policy = new AuthorizationPolicy();
const guard = new AuthorizationGuard(new BaselineRuoYiAuthzAdapter(policy));

const GROUP_MATCHED = '11111111-1111-4111-8111-111111111111';
const GROUP_SECOND = '22222222-2222-4222-8222-222222222222';

/** 已脱敏的最小特征快照：不含姓名、学号、手机号、微信标识，也不含原始经历文本 */
function featureBundle(): MatchFeatureBundle {
  return {
    student: {
      grade: Grade.Junior,
      major: '软件工程',
      skills: ['TypeScript', 'PostgreSQL'],
      programmingLevel: ProgrammingLevel.Intermediate,
      researchInterests: ['机器学习', '数据可视化'],
      intendedFields: ['人工智能'],
      weeklyHours: 12,
      availablePeriods: [AvailablePeriod.Weekend],
      experienceSummary: '参与校级创新项目，负责数据处理',
    },
    candidates: [
      {
        groupId: GROUP_MATCHED,
        name: '机器学习小组',
        researchDirections: ['机器学习', '计算机视觉'],
        requiredSkills: ['TypeScript', 'PyTorch'],
        grades: [Grade.Junior, Grade.Senior],
        minWeeklyHours: 8,
        headcount: 6,
        memberCount: 3,
        status: GroupStatus.Open,
      },
      {
        groupId: GROUP_SECOND,
        name: '数据可视化小组',
        researchDirections: ['数据可视化', '人机交互'],
        requiredSkills: ['TypeScript'],
        minWeeklyHours: 6,
        headcount: 4,
        memberCount: 4,
        status: GroupStatus.Open,
      },
    ],
  };
}

/** 仓储替身：只实现端口语义，记录调用次数以证明访问顺序，并允许模拟损坏/越界返回 */
class StubMatchingRepository implements MatchingRepository {
  readonly capabilities = {
    backend: 'stub',
    persistent: false,
    productionReady: false,
  } as const;

  readonly created: MatchingRequest[] = [];
  readonly saved: MatchingRequest[] = [];
  createCalls = 0;
  saveCalls = 0;
  listCalls = 0;
  /** 供用例模拟「仓储返回非 pending 记录 / 越界记录 / 损坏记录」 */
  createOverride: MatchingRequest | undefined;
  listOverride: readonly MatchingRequest[] | undefined;

  private readonly records = new Map<string, MatchingRequest>();

  constructor(seed: readonly MatchingRequest[] = []) {
    for (const record of seed) this.records.set(record.id, record);
  }

  create(request: MatchingRequest): MatchingRequest {
    this.createCalls += 1;
    this.created.push(request);
    if (this.createOverride) return this.createOverride;
    this.records.set(request.id, request);
    return request;
  }

  save(request: MatchingRequest): MatchingRequest {
    this.saveCalls += 1;
    this.saved.push(request);
    this.records.set(request.id, request);
    return request;
  }

  findById(requestId: string): MatchingRequest | undefined {
    return this.records.get(requestId);
  }

  listByUserId(userId: string): readonly MatchingRequest[] {
    this.listCalls += 1;
    if (this.listOverride) return this.listOverride;
    return [...this.records.values()].filter((record) => record.userId === userId);
  }
}

/** 召回来源替身：允许注入损坏快照或缺失快照，并记录调用次数 */
class StubFeatureSource implements MatchingFeatureSource {
  readonly capabilities = {
    backend: 'stub',
    connectedToDomainData: false,
    productionReady: false,
  } as const;

  loadCalls = 0;
  bundle: MatchFeatureBundle | undefined;

  loadBundle(_userId: string): MatchFeatureBundle | undefined {
    this.loadCalls += 1;
    return this.bundle;
  }
}

const student = { userId: 'u-student-1', roles: [Role.Student] } as const;
const admin = { userId: 'u-admin-1', roles: [Role.Admin] } as const;
const leader = {
  userId: 'u-leader-1',
  roles: [Role.GroupLeader],
  groupIds: [GROUP_MATCHED],
} as const;

interface Harness {
  readonly service: MatchingService;
  readonly repository: StubMatchingRepository;
  readonly features: StubFeatureSource;
  readonly provider: AiProvider;
}

function harness(options: {
  bundle?: MatchFeatureBundle | undefined;
  aiEnabled?: boolean;
  providerResult?: unknown;
  provider?: AiProvider;
  seed?: readonly MatchingRequest[];
}): Harness {
  const repository = new StubMatchingRepository(options.seed ?? []);
  const features = new StubFeatureSource();
  features.bundle = 'bundle' in options ? options.bundle : featureBundle();
  const provider =
    options.provider ??
    createMockProvider(
      options.providerResult === undefined ? {} : { result: options.providerResult },
    );
  const env = loadEnv({
    NODE_ENV: 'test',
    AI_MATCHING_ENABLED: options.aiEnabled ? 'true' : 'false',
    AI_PROVIDER: 'mock',
    AI_MODEL: 'test-model',
  });
  return {
    service: new MatchingService(guard, repository, features, provider, env),
    repository,
    features,
    provider,
  };
}

function storedRequestFixture(overrides: Partial<MatchingRequest> = {}): MatchingRequest {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: randomUUID(),
    userId: 'u-student-1',
    status: MatchingRequestStatus.Completed,
    inputSnapshotHash: 'a'.repeat(64),
    recommendations: [
      {
        groupId: GROUP_MATCHED,
        score: 80,
        reason: '你的机器学习兴趣与该组方向一致',
        advice: '建议补充 PyTorch 后联系负责人',
      },
    ],
    modelVersion: 'test-model',
    promptVersion: 'v1',
    fallbackUsed: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** 规则路径的期望输出：直接调用适配层的纯函数，避免用例复述打分公式 */
function expectedRuleGroupIds(bundle: MatchFeatureBundle): string[] {
  return buildFallbackRecommendations(bundle).map((item) => item.groupId);
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出异常，但没有抛出');
}

/** 异步版本的捕获（service 的发起接口是 async，同步捕获会漏掉 Promise 拒绝） */
async function captureRejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出异常，但没有抛出');
}

describe('MatchingService：主体与归属只来自服务端', () => {
  it('发起：归属、状态、摘要与版本由服务端写入，视图不含 userId / 快照摘要', async () => {
    const { service, repository } = harness({});
    const view = await service.createMyMatchingRequest(student, { profileVersion: 4 });

    expect(repository.created).toHaveLength(1);
    const stored = repository.saved[0];
    expect(stored?.userId).toBe('u-student-1');
    expect(stored?.profileVersion).toBe(4);
    // completed 终态 + 规则降级标记（本用例 AI 关闭）
    expect(stored?.status).toBe(MatchingRequestStatus.Completed);
    expect(stored?.fallbackUsed).toBe(true);
    expect(stored?.degradationCode).toBe(AiErrorCode.Disabled);
    expect(stored?.inputSnapshotHash).toMatch(/^[0-9a-f]{64}$/u);
    // 入口记录与终态记录共享同一创建时间；更新时间由服务端再次写入
    expect(repository.created[0]?.createdAt).toBe(stored?.createdAt);
    expect(stored?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    expect(view.id).toBe(stored?.id);
    // 视图字段闭集：不含 userId、不含 inputSnapshotHash、不含任何画像原始字段
    expect(Object.keys(view).sort()).toEqual([
      'createdAt',
      'degradationCode',
      'fallbackUsed',
      'id',
      'modelVersion',
      'profileVersion',
      'promptVersion',
      'recommendations',
      'status',
      'updatedAt',
    ]);
    expect(JSON.stringify(view)).not.toContain('u-student-1');
    expect(JSON.stringify(view)).not.toContain(stored?.inputSnapshotHash ?? 'x');
  });

  it('发起：请求体不提供任何字段时也能工作（画像版本是可选的）', async () => {
    const { service, repository } = harness({});
    const view = await service.createMyMatchingRequest(student, {});
    expect(repository.created).toHaveLength(1);
    expect(view.profileVersion).toBeUndefined();

    // HTTP 层缺省请求体到达 service 时是 undefined，必须等价于空对象
    const { service: second, repository: secondRepository } = harness({});
    const withoutBody = await second.createMyMatchingRequest(student, undefined);
    expect(secondRepository.created).toHaveLength(1);
    expect(withoutBody.profileVersion).toBeUndefined();
  });

  it('列表：只取会话主体自己的记录，且视图不含归属字段', () => {
    const own = storedRequestFixture({ userId: 'u-student-1' });
    const other = storedRequestFixture({ userId: 'u-student-2' });
    const repository = new StubMatchingRepository([own, other]);
    const features = new StubFeatureSource();
    const service = new MatchingService(
      guard,
      repository,
      features,
      createMockProvider(),
      loadEnv({ NODE_ENV: 'test' }),
    );

    const list = service.listMyMatchingRequests(student);
    expect(list.map((item) => item.id)).toEqual([own.id]);
    expect(JSON.stringify(list)).not.toContain('u-student-2');
  });
});

describe('MatchingService：授权先于字段校验与仓储访问', () => {
  it('无该权限点的角色一律 403，且仓储与召回来源一次都不被调用', async () => {
    for (const subject of [admin, leader]) {
      const { service, repository, features } = harness({});
      const error = await captureRejection(() =>
        service.createMyMatchingRequest(subject, { userId: 'u-victim-1' }),
      );
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(repository.createCalls).toBe(0);
      expect(repository.saveCalls).toBe(0);
      expect(features.loadCalls).toBe(0);
    }
  });

  it('列表同样先授权：未授权主体看不到任何记录', () => {
    const { service, repository } = harness({});
    const error = captureError(() => service.listMyMatchingRequests(admin));
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(repository.listCalls).toBe(0);
  });

  it('授权先于字段校验：未授权主体的非法请求体得到 403 而不是 400', async () => {
    const { service } = harness({});
    const error = await captureRejection(() =>
      service.createMyMatchingRequest(admin, { profileVersion: 'v1', roles: [Role.SuperAdmin] }),
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error).not.toBeInstanceOf(ZodError);
  });

  it('判定入参只来自服务端：权限点/范围/资源归属恒为常量与会话主体', () => {
    const adapter = new BaselineRuoYiAuthzAdapter(policy);
    const spy = vi.spyOn(adapter, 'checkAuthorization');
    const service = new MatchingService(
      new AuthorizationGuard(adapter),
      new StubMatchingRepository(),
      new StubFeatureSource(),
      createMockProvider(),
      loadEnv({ NODE_ENV: 'test' }),
    );

    service.listMyMatchingRequests(student);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      { userId: 'u-student-1', roles: [Role.Student] },
      {
        permission: PermissionPoint.MatchingSelfRequest,
        scope: DataScope.Self,
        resourceUserId: 'u-student-1',
      },
    );
  });
});

describe('MatchingService：客户端提交的字段一律拒绝（不是静默剥离）', () => {
  const forbiddenBodies: readonly Record<string, unknown>[] = [
    { userId: 'u-victim-1' },
    { roles: [Role.SuperAdmin] },
    { scope: DataScope.Global },
    { groupId: GROUP_MATCHED },
    { groupIds: [GROUP_MATCHED] },
    { status: MatchingRequestStatus.Completed },
    { recommendations: [] },
    { modelVersion: 'gpt-x' },
    { fallbackUsed: false },
    { inputSnapshotHash: 'a'.repeat(64) },
    { createdAt: '2026-01-01T00:00:00.000Z' },
  ];

  it('逐项拒绝服务端独占字段（归属/角色/范围/状态/结果/版本/摘要/时间戳）', async () => {
    for (const body of forbiddenBodies) {
      const { service, repository, features } = harness({});
      const error = await captureRejection(() => service.createMyMatchingRequest(student, body));
      expect(error, `body=${JSON.stringify(body)}`).toBeInstanceOf(ZodError);
      expect(repository.createCalls).toBe(0);
      expect(features.loadCalls).toBe(0);
    }
  });

  it('非法画像版本被共享 schema 拒绝（字符串/0/小数/越界）', async () => {
    for (const profileVersion of ['3', 0, 1.5, 1_000_001]) {
      const { service, repository } = harness({});
      const error = await captureRejection(() =>
        service.createMyMatchingRequest(student, { profileVersion }),
      );
      expect(error).toBeInstanceOf(ZodError);
      expect(repository.createCalls).toBe(0);
    }
  });

  it('输入闭集与共享 matchingRequestInputSchema 的键集一致（防契约漂移）', () => {
    expect([...MATCHING_REQUEST_INPUT_FIELDS].sort()).toEqual(
      Object.keys(matchingRequestInputSchema.shape).sort(),
    );
  });
});

describe('MatchingService：AI 关闭时走明确的规则降级', () => {
  it('AI 关闭：不调用模型，结果来自规则打分并带稳定降级码', async () => {
    const bundle = featureBundle();
    const provider = createMockProvider({ result: { recommendations: [] } });
    const completeJson = vi.spyOn(provider, 'completeJson');
    const { service, repository } = harness({ bundle, provider });

    const view = await service.createMyMatchingRequest(student, {});

    expect(completeJson).not.toHaveBeenCalled();
    expect(view.fallbackUsed).toBe(true);
    expect(view.degradationCode).toBe(AiErrorCode.Disabled);
    expect(view.status).toBe(MatchingRequestStatus.Completed);
    expect(view.recommendations.map((item) => item.groupId)).toEqual(expectedRuleGroupIds(bundle));
    // 只暴露白名单字段：分数是 0—100 整数，理由/建议非空
    for (const item of view.recommendations) {
      expect(Object.keys(item).sort()).toEqual(['advice', 'groupId', 'reason', 'score']);
      expect(Number.isInteger(item.score)).toBe(true);
      expect(item.reason.length).toBeGreaterThan(0);
      expect(item.advice.length).toBeGreaterThan(0);
    }
    expect(repository.saved[0]?.fallbackUsed).toBe(true);
  });

  it('无召回结果（未画像/未召回）：no_candidate 终态，不是 500，也不是空推荐的成功态', async () => {
    const { service, repository } = harness({ bundle: undefined });
    const view = await service.createMyMatchingRequest(student, {});
    expect(view.status).toBe(MatchingRequestStatus.NoCandidate);
    expect(view.recommendations).toEqual([]);
    expect(view.fallbackUsed).toBe(true);
    expect(view.degradationCode).toBe(AiErrorCode.NoCandidate);
    expect(repository.saved[0]?.status).toBe(MatchingRequestStatus.NoCandidate);
  });
});

describe('MatchingService：AI 开启时只接受通过外发校验的模型输出', () => {
  const grounded = {
    groupId: GROUP_MATCHED,
    score: 88,
    reason: '你的机器学习兴趣与该组方向一致',
    advice: '建议补充 PyTorch 后联系负责人',
  };

  it('合法且可解释的模型输出被采用（fallbackUsed=false、无降级码）', async () => {
    const { service, repository } = harness({
      aiEnabled: true,
      providerResult: { recommendations: [grounded] },
    });

    const view = await service.createMyMatchingRequest(student, {});
    expect(view.fallbackUsed).toBe(false);
    expect(view.degradationCode).toBeUndefined();
    expect(view.recommendations).toEqual([grounded]);
    expect(repository.saved[0]?.modelVersion).toBe('test-model');
  });

  it('模型输出含未召回小组 → 适配层校验拦截并按规则降级', async () => {
    const { service } = harness({
      aiEnabled: true,
      providerResult: {
        recommendations: [{ ...grounded, groupId: randomUUID() }],
      },
    });

    const view = await service.createMyMatchingRequest(student, {});
    expect(view.fallbackUsed).toBe(true);
    expect(view.degradationCode).toBe(AiErrorCode.IllegalGroupId);
    expect(view.recommendations.map((item) => item.groupId)).toEqual(
      expectedRuleGroupIds(featureBundle()),
    );
  });

  it('模型输出的理由含手机号 → 丢弃模型结果并按规则降级，敏感内容不进入记录', async () => {
    // 理由必须同时「可解释」（引用真实字段）又「含个人标识」，才能落到 API 层的外发校验上：
    // 适配层只校验结构与可解释性，值级敏感内容由本切片的最后一道门负责
    const { service, repository } = harness({
      aiEnabled: true,
      providerResult: {
        recommendations: [
          { ...grounded, reason: '你的机器学习兴趣与该组方向一致，请联系 13800138000 报名' },
        ],
      },
    });

    const view = await service.createMyMatchingRequest(student, {});
    expect(view.fallbackUsed).toBe(true);
    expect(view.degradationCode).toBe(AiErrorCode.OutputInvalid);
    expect(view.recommendations.map((item) => item.groupId)).toEqual(
      expectedRuleGroupIds(featureBundle()),
    );
    expect(JSON.stringify(view)).not.toContain('13800138000');
    expect(JSON.stringify(repository.saved[0])).not.toContain('13800138000');
  });

  it('provider 故障 → 适配层降级为规则结果（仍然给出可展示推荐）', async () => {
    const { service } = harness({
      aiEnabled: true,
      provider: createMockProvider({ failWith: 'error' }),
    });
    const view = await service.createMyMatchingRequest(student, {});
    expect(view.fallbackUsed).toBe(true);
    expect(view.degradationCode).toBe(AiErrorCode.ProviderError);
    expect(view.recommendations.length).toBeGreaterThan(0);
  });
});

describe('MatchingService：状态机与处理失败', () => {
  it('仓储返回非 pending 记录（重复处理/被改写）→ STATE_TRANSITION_INVALID，且既有结果不被覆盖', async () => {
    const { service, repository } = harness({});
    repository.createOverride = storedRequestFixture({
      id: 'fixed-id',
      status: MatchingRequestStatus.Completed,
    });

    const error = await captureRejection(() => service.createMyMatchingRequest(student, {}));
    expect(error).toBeInstanceOf(Error);
    expect((error as StateTransitionError).code).toBe('STATE_TRANSITION_INVALID');
    expect(repository.saveCalls).toBe(0);
  });

  it('召回数据损坏 → 收敛为 failed 终态（不 500、不输出半成品）', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const bundle = featureBundle();
    const corrupted = {
      ...bundle,
      candidates: [{ ...bundle.candidates[0], researchDirections: null }],
    } as unknown as MatchFeatureBundle;

    const { service, repository } = harness({ bundle: corrupted });
    const view = await service.createMyMatchingRequest(student, {});

    expect(view.status).toBe(MatchingRequestStatus.Failed);
    expect(view.recommendations).toEqual([]);
    expect(view.degradationCode).toBe(AiErrorCode.ProviderError);
    expect(repository.saved[0]?.status).toBe(MatchingRequestStatus.Failed);
  });

  it('规则产出含敏感内容（召回源违规）→ failed 终态且不泄露内容', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // 让规则理由带手机号：候选组名里含号码（快照未过 seed 门禁，模拟被外部改写的召回源）
    const bundle = featureBundle();
    const tampered = {
      ...bundle,
      candidates: [{ ...bundle.candidates[0], name: '小组13800138000' }],
    } as unknown as MatchFeatureBundle;

    const { service } = harness({ bundle: tampered });
    const view = await service.createMyMatchingRequest(student, {});
    expect(view.status).toBe(MatchingRequestStatus.Failed);
    expect(JSON.stringify(view)).not.toContain('13800138000');
  });
});

describe('MatchingService：存储损坏与越界取数 fail-closed（500，不泄露字段取值）', () => {
  function serviceWithList(records: readonly MatchingRequest[]): MatchingService {
    const repository = new StubMatchingRepository();
    repository.listOverride = records;
    return new MatchingService(
      guard,
      repository,
      new StubFeatureSource(),
      createMockProvider(),
      loadEnv({ NODE_ENV: 'test' }),
    );
  }

  it('未知状态枚举 → 500，且不泄露未知值与字段取值', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = serviceWithList([
      storedRequestFixture({ status: 'unknown_status' as MatchingRequestStatus }),
    ]);
    const error = captureError(() => service.listMyMatchingRequests(student));
    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect((error as Error).message).toBe(MATCHING_REQUEST_INTEGRITY_MESSAGE);
  });

  it('状态与推荐条数矛盾（completed 却 0 条 / failed 却有条数）→ 500', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    for (const record of [
      storedRequestFixture({ status: MatchingRequestStatus.Completed, recommendations: [] }),
      storedRequestFixture({
        status: MatchingRequestStatus.Failed,
        recommendations: storedRequestFixture().recommendations,
      }),
    ]) {
      const error = captureError(() => serviceWithList([record]).listMyMatchingRequests(student));
      expect(error).toBeInstanceOf(InternalServerErrorException);
    }
  });

  it('存储记录里的推荐文本含手机号 → 500（内容不可外发），不把号码回给调用方', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = serviceWithList([
      storedRequestFixture({
        recommendations: [
          {
            groupId: GROUP_MATCHED,
            score: 70,
            reason: '请联系 13800138000 报名',
            advice: '建议尽快联系负责人',
          },
        ],
      }),
    ]);
    const error = captureError(() => service.listMyMatchingRequests(student));
    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect(JSON.stringify(error)).not.toContain('13800138000');
  });

  it('仓储返回他人归属 → 500，绝不把他人匹配请求当作本人列表输出', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const other = storedRequestFixture({ userId: 'u-student-2' });
    const error = captureError(() => serviceWithList([other]).listMyMatchingRequests(student));
    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect(JSON.stringify(error)).not.toContain('u-student-2');
  });

  it('快照摘要形状非法（非 sha256）→ 500', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = serviceWithList([storedRequestFixture({ inputSnapshotHash: 'plain' })]);
    const error = captureError(() => service.listMyMatchingRequests(student));
    expect(error).toBeInstanceOf(InternalServerErrorException);
  });
});
