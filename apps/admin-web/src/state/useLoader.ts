import { useCallback, useEffect, useRef, useState } from 'react';
import { toFailure } from './async';
import type { Loadable } from './async';

/**
 * 取数 Hook：把「发起 → loading → ready/error」与卸载/参数变更时的**结果丢弃**收敛到一处。
 *
 * 关键点：参数变化或卸载后，已经在飞的请求结果必须被丢弃（`active` 标志），否则会出现
 * 「切到新筛选条件，旧请求后到达并覆盖新结果」的经典竞态。401 不在这里处理：
 * 它在 client 层统一回调会话层，页面只渲染最终状态。
 */
export interface UseLoaderOptions {
  /** API 边界（`METHOD /path`），仅用于错误提示与排障 */
  endpoint?: string;
  /** false 时保持 idle 且不发请求（例如未登录时） */
  enabled?: boolean;
}

export interface UseLoaderResult<T> {
  state: Loadable<T>;
  reload: () => void;
}

export function useLoader<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  options: UseLoaderOptions = {},
): UseLoaderResult<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);

  const loadRef = useRef(load);
  const endpointRef = useRef(options.endpoint);
  const enabled = options.enabled ?? true;

  // 每次渲染后同步最新实现：effect 的依赖数组因此只需关心「业务参数」与 nonce
  useEffect(() => {
    loadRef.current = load;
    endpointRef.current = options.endpoint;
  });

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' });
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    loadRef.current().then(
      (data) => {
        if (active) setState({ status: 'ready', data });
      },
      (caught: unknown) => {
        if (active) setState(toFailure<T>(caught, endpointRef.current));
      },
    );
    return () => {
      active = false;
    };
    // deps 由调用方提供：这里刻意展开，语义是「这些业务参数变化就重新取数」。
    // 仓库未启用 react-hooks 插件（依赖准入未完成），因此这里不会有 exhaustive-deps 检查。
  }, [enabled, nonce, ...deps]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { state, reload };
}
