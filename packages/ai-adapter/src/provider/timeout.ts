import { AiAdapterError, AiErrorCode } from '../errors';

/** 超时控制：AbortController + Promise.race；超时后中断底层请求，避免悬挂连接 */
export async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new AiAdapterError(AiErrorCode.Timeout, `AI 调用超时（${timeoutMs}ms）`, { timeoutMs }),
      );
    }, timeoutMs);
  });

  const taskPromise = Promise.resolve().then(() => task(controller.signal));
  // 超时后迟到的失败不能变成 unhandled rejection
  taskPromise.catch(() => undefined);

  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** 可中断的等待，用于重试退避 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      reject(abortError);
    }
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
