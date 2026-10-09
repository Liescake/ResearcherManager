import { AiAdapterError, AiErrorCode } from '../errors';
import type { AiCompletionRequest, AiProvider } from './provider-port';
import { sleep } from './timeout';

/**
 * 本地桩 Provider：不联网，用于开发、测试和 CI。
 * 明确不是生产实现；生产环境必须配置真实 Provider（见 docs/P3-依赖清单与版本决策.md）。
 */

export interface MockProviderOptions {
  /** 直接返回的 JSON 负载；缺省时返回一条基于候选的合法结果 */
  result?: unknown;
  /** 模拟失败类型 */
  failWith?: 'error' | 'timeout';
  /** 模拟耗时，配合外部超时测试 */
  delayMs?: number;
}

export function createMockProvider(options: MockProviderOptions = {}): AiProvider {
  const { result, failWith, delayMs = 0 } = options;

  return {
    id: 'mock',
    async completeJson(request: AiCompletionRequest): Promise<unknown> {
      if (delayMs > 0) {
        await sleep(delayMs, request.signal);
      }
      if (failWith === 'error') {
        throw new AiAdapterError(AiErrorCode.ProviderError, 'mock provider 模拟失败');
      }
      if (failWith === 'timeout') {
        // 永不返回，交由外部超时中断
        await new Promise<never>(() => undefined);
      }
      return result ?? { recommendations: [] };
    },
  };
}
