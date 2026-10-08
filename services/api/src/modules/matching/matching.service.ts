import { randomUUID } from 'node:crypto';
import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import {
  AiErrorCode,
  MATCHING_PROMPT_VERSION,
  buildFallbackRecommendations,
  computeInputSnapshotHash,
  invokeMatchingWithFallback,
  isAiErrorCode,
} from '@rm/ai-adapter';
import type { AiProvider, MatchFeatureBundle, MatchOutcome } from '@rm/ai-adapter';
import {
  DataScope,
  MATCHING_MAX_RECOMMENDATIONS,
  MATCHING_REQUEST_ENTRY_STATUS,
  MatchingRequestStatus,
  PermissionPoint,
  assertMatchingRequestTransition,
  matchingRequestInputSchema,
} from '@rm/shared';
import type { AuthorizationSubject, MatchingRecommendationItem } from '@rm/shared';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import { isMatchingEnabled, resolveModelVersion } from './matching.ai-provider';
import {
  MATCHING_REQUEST_INTEGRITY_MESSAGE,
  assertDeclaredMatchingRequestInputFields,
  checkMatchingRecommendations,
  parseStoredMatchingRequest,
  readMatchingRequestOwnerId,
  toMatchingRequestView,
} from './matching.contract';
import type { MatchingRequestView } from './matching.contract';
import {
  MATCHING_AI_PROVIDER,
  MATCHING_FEATURE_SOURCE,
  MATCHING_REPOSITORY,
} from './matching.port';
import type { MatchingFeatureSource, MatchingRepository, MatchingRequest } from './matching.port';

/**
 * 匹配切片（P7 最小垂直切片，学生自服务部分）：
 * - `POST /me/matching-requests`  发起本人匹配请求（`matching:self:request`）
 * - `GET  /me/matching-requests`  本人匹配请求列表与状态（同一权限点 + 固定 `SELF`）
 *
 * 六条硬约束：
 * 1. **主体与归属都来自服务端**：`userId` 取自会话主体，`status` 由状态机写入，
 *    快照摘要、版本号与时间戳也由服务端生成；客户端提交的 `userId`/`roles`/`scope`/`groupId`/
 *    `status`/`recommendations` 既不能进入判定，也不能落库——它们由输入闭集直接拒绝（400），
 *    不是静默剥离。自定义头（`x-user-id`/`x-roles`/`x-scope`/`x-group-id`）同样不参与任何判定。
 * 2. **授权先于任何仓储访问**：两条路由都先经 `AuthorizationGuard`（其下是
 *    `RUOYI_AUTHZ_ADAPTER` 端口 → canonical 谓词），权限点与范围是服务端常量
 *    （`matching:self:request` + `SELF`），`resourceUserId` 取会话主体；拒绝即 403，
 *    且此时仓储方法一次都不会被调用，未授权主体也拿不到任何字段级校验反馈。
 * 3. **复用共享契约**：输入只接受 `@rm/shared` 的 `matchingRequestInputSchema`
 *    （可选的画像版本）；状态流转复用共享状态机
 *    （入口恒为 `pending`，只允许推进到 `completed`/`no_candidate`/`failed`）。
 * 4. **AI 关闭时走明确的规则降级**：只有 `AI_MATCHING_ENABLED` 打开且 `AI_PROVIDER`
 *    不是 `disabled` 才调用模型；否则由适配层直接按规则打分产出推荐，
 *    并把 `fallbackUsed = true` 与稳定的降级原因码写进记录。模型输出即使返回了结构合法但
 *    **含个人标识**（手机号、身份证号）的文本，也会被丢弃并明确降级为规则结果。
 * 5. **不把敏感画像字段暴露给调用方**：召回来源只提供**已脱敏**的最小特征
 *    （`InMemoryMatchingFeatureSource.seed` 用适配层 PII 防线拒绝含姓名/学号/手机号/微信标识的
 *    快照）；对外视图是显式白名单，不含 `userId`、不含快照摘要、不含任何画像原始字段。
 * 6. **一次请求必定收敛到终态**：处理期任何异常（例如召回数据损坏）都记为 `failed` 终态并
 *    返回安全结果，而不是把半成品当推荐输出、或用 500 把用户卡在无状态的位置。
 *    存储记录离开进程前再按读取契约校验（枚举闭集 + 状态/条数自洽 + PII 扫描），
 *    违规或归属与会话主体不一致一律 500 且不泄露字段取值。
 *
 * 尚不包含（明确留给后续切片）：管理端 `/admin/matching-records`、推荐结果的历史回溯与导出、
 * 画像版本核对（需要 profiles 仓储端口）、候选召回的真实数据源（需要 groups 仓储端口）、
 * 异步化处理、幂等键与审计落库、列表分页与排序。
 */
@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  constructor(
    @Inject(AuthorizationGuard) private readonly guard: AuthorizationGuard,
    @Inject(MATCHING_REPOSITORY) private readonly repository: MatchingRepository,
    @Inject(MATCHING_FEATURE_SOURCE) private readonly features: MatchingFeatureSource,
    @Inject(MATCHING_AI_PROVIDER) private readonly provider: AiProvider,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /** 本人匹配请求列表与状态：先做集合级 SELF 判定，再按服务端主体取数 */
  listMyMatchingRequests(subject: AuthorizationSubject): MatchingRequestView[] {
    this.authorizeSelf(subject);
    return this.repository
      .listByUserId(subject.userId)
      .map((record) => this.toView(record, subject.userId));
  }

  /** 发起本人匹配请求：归属、状态、摘要与版本都由服务端决定，请求体只提供可选的画像版本 */
  async createMyMatchingRequest(
    subject: AuthorizationSubject,
    body: unknown,
  ): Promise<MatchingRequestView> {
    // 1. 授权先于字段校验与任何仓储访问（未授权主体连字段级反馈都拿不到）
    this.authorizeSelf(subject);

    // 2. 输入闭集 → 共享 schema：未知字段（含归属/角色/范围/状态）与非法版本一律 400。
    //    缺省请求体等价于空对象（画像版本是可选的）；`null`/数组/标量仍按非法输入拒绝
    const rawBody = body === undefined ? {} : body;
    assertDeclaredMatchingRequestInputFields(rawBody);
    const input = matchingRequestInputSchema.parse(rawBody);

    const modelVersion = resolveModelVersion(this.env, this.provider);
    const bundle = this.features.loadBundle(subject.userId);
    const inputSnapshotHash = computeInputSnapshotHash(bundle ?? EMPTY_FEATURE_SNAPSHOT);
    const now = new Date().toISOString();

    // 3. 入口记录：状态恒为 pending，结果为空；此时不得声称结果来自模型
    const created = this.repository.create({
      id: randomUUID(),
      userId: subject.userId,
      status: MATCHING_REQUEST_ENTRY_STATUS,
      ...(input.profileVersion !== undefined ? { profileVersion: input.profileVersion } : {}),
      inputSnapshotHash,
      recommendations: [],
      modelVersion,
      promptVersion: MATCHING_PROMPT_VERSION,
      fallbackUsed: true,
      createdAt: now,
      updatedAt: now,
    });

    const outcome = await this.runMatching(bundle, modelVersion);

    // 4. 状态机只允许 pending → 某一个终态：仓储若返回非 pending 记录（重复处理/数据被改写），
    //    这里会以 STATE_TRANSITION_INVALID（409）拒绝，而不是覆盖既有结果
    assertMatchingRequestTransition(created.status, outcome.status);

    const saved = this.repository.save({
      ...created,
      status: outcome.status,
      recommendations: [...outcome.recommendations],
      fallbackUsed: outcome.fallbackUsed,
      ...(outcome.degradationCode ? { degradationCode: outcome.degradationCode } : {}),
      updatedAt: new Date().toISOString(),
    });

    return this.toView(saved, subject.userId);
  }

  /**
   * 处理流程：适配层负责「模型调用 + 超时/重试 + schema/白名单/可解释性校验 + 规则降级」，
   * 本方法只做三件事 —— 处理无召回结果、外发前再校验一次推荐文本、把异常收敛成 failed 终态。
   */
  private async runMatching(
    bundle: MatchFeatureBundle | undefined,
    modelVersion: string,
  ): Promise<MatchingProcessingOutcome> {
    if (!bundle) {
      // 无画像/无候选：这是业务事实（no_candidate），不是错误，也不是 500
      return {
        status: MatchingRequestStatus.NoCandidate,
        recommendations: [],
        fallbackUsed: true,
        degradationCode: AiErrorCode.NoCandidate,
      };
    }

    let outcome: MatchOutcome;
    try {
      outcome = await invokeMatchingWithFallback({
        provider: this.provider,
        bundle,
        modelVersion,
        matchingEnabled: isMatchingEnabled(this.env),
        timeoutMs: this.env.AI_TIMEOUT_MS,
        maxRetries: this.env.AI_MAX_RETRIES,
        fallback: { maxRecommendations: MATCHING_MAX_RECOMMENDATIONS },
        onDegrade: (info) => {
          // 只记录稳定错误码，不记录提示词、模型原文或任何特征取值
          this.logger.warn(`[matching] 匹配降级: ${info.code}`);
        },
      });

      const checked = checkMatchingRecommendations(outcome.result.recommendations);
      if (checked.ok) {
        // 适配层把 errorCode 声明为 string；只有登记在案的错误码才允许落库/外发
        const degradationCode = isAiErrorCode(outcome.errorCode) ? outcome.errorCode : undefined;
        return {
          status:
            checked.value.length === 0
              ? MatchingRequestStatus.NoCandidate
              : MatchingRequestStatus.Completed,
          recommendations: checked.value,
          fallbackUsed: outcome.result.fallbackUsed,
          ...(degradationCode ? { degradationCode } : {}),
        };
      }

      if (outcome.status === 'ai') {
        // 模型输出不可信（结构或含个人标识）：丢弃模型结果，**明确**按规则重算，绝不回传原文
        this.logger.warn(`[matching] 模型输出未通过外发校验(${checked.cause})，已按规则降级`);
        return this.ruleBasedOutcome(bundle, AiErrorCode.OutputInvalid);
      }

      // 规则路径自身的产出不合法 ⇒ 召回/特征源违规（例如把原始画像塞进了推荐理由）
      this.logger.error(`[matching] 规则推荐结果不合法(${checked.cause})`);
      return {
        status: MatchingRequestStatus.Failed,
        recommendations: [],
        fallbackUsed: true,
        degradationCode: AiErrorCode.OutputInvalid,
      };
    } catch (error) {
      // 适配层承诺「任何失败都降级」；越过该承诺说明召回数据或适配层本身损坏。
      // 不 500、不覆盖历史结果、不输出半成品：记录一个 failed 终态并只记错误名。
      this.logger.error(
        `[matching] 匹配处理失败: ${error instanceof Error ? error.name : typeof error}`,
      );
      return {
        status: MatchingRequestStatus.Failed,
        recommendations: [],
        fallbackUsed: true,
        degradationCode: AiErrorCode.ProviderError,
      };
    }
  }

  /** 明确的规则降级路径：纯函数、确定性打分，理由由真实字段拼出（可解释） */
  private ruleBasedOutcome(
    bundle: MatchFeatureBundle,
    degradationCode: AiErrorCode,
  ): MatchingProcessingOutcome {
    const recommendations = buildFallbackRecommendations(bundle, {
      maxRecommendations: MATCHING_MAX_RECOMMENDATIONS,
    });
    const checked = checkMatchingRecommendations(recommendations);
    if (!checked.ok) {
      this.logger.error(`[matching] 规则推荐结果不合法(${checked.cause})`);
      return {
        status: MatchingRequestStatus.Failed,
        recommendations: [],
        fallbackUsed: true,
        degradationCode: AiErrorCode.OutputInvalid,
      };
    }
    return {
      status:
        checked.value.length === 0
          ? MatchingRequestStatus.NoCandidate
          : MatchingRequestStatus.Completed,
      recommendations: checked.value,
      fallbackUsed: true,
      degradationCode: checked.value.length === 0 ? AiErrorCode.NoCandidate : degradationCode,
    };
  }

  /**
   * 授权判定：权限点恒为 `matching:self:request`（本人自服务），范围恒为服务端常量 `SELF`，
   * `resourceUserId` 取**会话主体**（服务端解析值）；不接受任何客户端提交的字段。
   */
  private authorizeSelf(subject: AuthorizationSubject): void {
    this.guard.assertAuthorized(subject, {
      permission: PermissionPoint.MatchingSelfRequest,
      scope: DataScope.Self,
      resourceUserId: subject.userId,
    });
  }

  /**
   * 输出边界：记录必须满足读取契约（状态闭集、状态/条数自洽、推荐文本无个人标识），
   * 且归属必须与调用方主体一致（纵深防御：仓储未按主体过滤 / 数据被外部改写）。
   * 两种情况共用同一文案，调用方无法据此区分「数据损坏」与「越权取数」，
   * 也不会看到他人记录的任何字段。日志只写字段路径与违规类型。
   */
  private toView(record: MatchingRequest, expectedOwnerId: string): MatchingRequestView {
    const parsed = parseStoredMatchingRequest(record);
    if (!parsed.ok) {
      this.logger.error(
        `[matching] 存储记录违反读取契约: ${parsed.issues
          .map((issue) => `${issue.path}(${issue.kind})`)
          .join(', ')}`,
      );
      throw new InternalServerErrorException(MATCHING_REQUEST_INTEGRITY_MESSAGE);
    }
    if (readMatchingRequestOwnerId(parsed.value) !== expectedOwnerId) {
      this.logger.error('[matching] 存储记录归属与会话主体不一致（仓储未按主体过滤）');
      throw new InternalServerErrorException(MATCHING_REQUEST_INTEGRITY_MESSAGE);
    }
    return toMatchingRequestView(parsed.value);
  }
}

/** 处理结果：状态、推荐结果与外发所需的降级标记（快照摘要由调用方单独计算） */
interface MatchingProcessingOutcome {
  readonly status: MatchingRequestStatus;
  readonly recommendations: readonly MatchingRecommendationItem[];
  readonly fallbackUsed: boolean;
  readonly degradationCode?: AiErrorCode;
}

/**
 * 无召回结果时的快照占位：只用于让 `input_snapshot_hash` 保持「同输入同摘要」的语义，
 * 不包含任何用户数据（因此也不存在原文可泄露）。
 */
const EMPTY_FEATURE_SNAPSHOT = { student: null, candidates: [] } as const;
