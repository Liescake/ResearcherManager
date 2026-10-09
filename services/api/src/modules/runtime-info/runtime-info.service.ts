import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import {
  describeDependencyReadinessTier,
  type DependencyReadinessTier,
} from '../../db/persistence/dependency-readiness';

/**
 * 运维信息白名单（字段闭集）。
 * 这是对外契约的唯一来源：新增字段必须先登记到这里，并由
 * `runtime-info.controller.spec.ts` 的「字段闭集」与「敏感值不泄露」用例守住。
 */
export const RUNTIME_INFO_FIELDS = [
  'nodeEnv',
  'apiPort',
  'apiPrefix',
  'databaseConfigured',
  'dependencyGate',
  'aiProvider',
  'aiMatchingEnabled',
] as const;

export type RuntimeInfoField = (typeof RUNTIME_INFO_FIELDS)[number];

/**
 * 对外运行期摘要：只有非敏感的运行开关与布尔状态。
 * 该接口没有索引签名，因此 `DATABASE_URL`、`SESSION_SECRET`、`AI_API_KEY`、`AI_BASE_URL`、
 * 证据引用 / 后端标识以及原始 `process.env` 在结构上无法成为响应字段。
 */
export interface RuntimeInfoPayload {
  nodeEnv: AppEnv['NODE_ENV'];
  apiPort: number;
  apiPrefix: string;
  databaseConfigured: boolean;
  /**
   * 生产依赖就绪门禁的**档位**（`required` = 生产或已配置数据库，`not-required` = 开发/测试且无库）。
   *
   * 只报档位，不报证据、后端标识、验证时间或端口清单：档位由
   * `describeDependencyReadinessTier`（与启动门禁同一函数）从**已校验配置**推导，
   * 是唯一不会泄漏内部事实、又与启动判定不可能漂移的口径。`required` 档位下的「已验证」由启动
   * 阶段的 fail-closed 保证：能对外服务本身就意味着依赖就绪门禁已通过，因此无需（也不应）
   * 把证据内容暴露给运维出口。
   */
  dependencyGate: DependencyReadinessTier;
  aiProvider: AppEnv['AI_PROVIDER'];
  aiMatchingEnabled: boolean;
}

export interface RuntimeInfoFieldIssue {
  kind: 'missing' | 'unexpected';
  field: string;
}

/**
 * 从**已校验配置**构造对外摘要：逐字段显式赋值，不使用对象展开，
 * 因此不可能把整份 env 顺带带出去。`databaseConfigured` 只表达「是否配置」，
 * 不暴露连接串本身；同理 AI 侧只回供应商枚举与匹配开关，依赖就绪门禁只回档位枚举。
 */
export function toRuntimeInfo(env: AppEnv): RuntimeInfoPayload {
  const databaseConfigured = Boolean(env.DATABASE_URL);
  return {
    nodeEnv: env.NODE_ENV,
    apiPort: env.API_PORT,
    apiPrefix: env.API_PREFIX,
    databaseConfigured,
    dependencyGate: describeDependencyReadinessTier(env.NODE_ENV, databaseConfigured),
    aiProvider: env.AI_PROVIDER,
    aiMatchingEnabled: env.AI_MATCHING_ENABLED,
  };
}

/**
 * 运行期字段闭集检查：越界字段与缺失字段都算问题（空数组表示合法）。
 * 类型系统只能约束本仓库的调用点；这里为「运行时被注入别的形状」兜底，fail-closed。
 */
export function checkRuntimeInfoFields(payload: RuntimeInfoPayload): RuntimeInfoFieldIssue[] {
  const actualKeys =
    typeof payload === 'object' && payload !== null ? Object.keys(payload) : ([] as string[]);
  const allowed = new Set<string>(RUNTIME_INFO_FIELDS);
  const issues: RuntimeInfoFieldIssue[] = actualKeys
    .filter((key) => !allowed.has(key))
    .map((field): RuntimeInfoFieldIssue => ({ kind: 'unexpected', field }));

  for (const field of RUNTIME_INFO_FIELDS) {
    if (!actualKeys.includes(field)) {
      issues.push({ kind: 'missing', field });
    }
  }

  return issues;
}

/**
 * 运维信息：只读配置摘要。
 * 显式 `@Inject(APP_ENV)`：依赖解析不依赖 `design:paramtypes`（部分转译链不生成该元数据），
 * 生产与测试行为一致；配置只能通过该令牌获得，业务代码不直接读 `process.env`。
 */
@Injectable()
export class RuntimeInfoService {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  getRuntimeInfo(): RuntimeInfoPayload {
    return toRuntimeInfo(this.env);
  }
}
