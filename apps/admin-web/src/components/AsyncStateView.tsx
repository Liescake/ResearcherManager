import type { ReactNode } from 'react';
import type { EndpointDescriptor } from '../api/endpoints';
import { looksLikePendingEndpoint } from '../api/errors';
import type { Loadable } from '../state/async';
import {
  EmptyPanel,
  ErrorPanel,
  ForbiddenPanel,
  LoadingPanel,
  PendingEndpointPanel,
  UnauthorizedPanel,
} from './StatePanel';

/**
 * 404 的语义**必须由页面显式声明**，不能由组件猜：
 * - `empty`：稳定端点的「资源尚不存在」（例：本人尚未提交画像）——显示空态，不算故障；
 * - `pending`：已登记但后端未实现的端点——显示「端点尚未实现」，绝不显示成空列表；
 * - `error`（默认）：当作错误处理并给出重试。
 */
export type NotFoundSemantics = 'empty' | 'pending' | 'error';

export interface AsyncStateViewProps<T> {
  state: Loadable<T>;
  descriptor: EndpointDescriptor;
  /** 加载文案（例：「本人画像」） */
  label?: string;
  onRetry?: () => void;
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  notFound?: NotFoundSemantics;
  children: (data: T) => ReactNode;
}

/**
 * 把 `Loadable<T>` 渲染成六种**语义互斥**的界面状态：
 * 加载中 / 空 / 未实现（pending）/ 无权限（403）/ 会话失效（401）/ 可重试错误。
 *
 * 这是「loading、empty、error、401、403」要求的落点：页面只提供数据与判定，
 * 状态与文案集中在这里，后续替换视觉设计时不必回到每个页面重写状态分支。
 */
export function AsyncStateView<T>({
  state,
  descriptor,
  label,
  onRetry,
  isEmpty,
  emptyTitle,
  emptyDescription,
  notFound = 'error',
  children,
}: AsyncStateViewProps<T>): ReactNode {
  if (state.status === 'idle') {
    return null;
  }

  if (state.status === 'loading') {
    return <LoadingPanel {...(label === undefined ? {} : { label })} />;
  }

  if (state.status === 'error') {
    const { error } = state;

    if (error.kind === 'unauthorized') {
      return <UnauthorizedPanel error={error} />;
    }

    if (error.kind === 'forbidden') {
      return looksLikePendingEndpoint(error, descriptor.status) ? (
        <PendingEndpointPanel descriptor={descriptor} error={error} />
      ) : (
        <ForbiddenPanel error={error} descriptor={descriptor} />
      );
    }

    if (error.kind === 'not-found') {
      if (notFound === 'pending') {
        return <PendingEndpointPanel descriptor={descriptor} error={error} />;
      }
      if (notFound === 'empty') {
        return (
          <EmptyPanel
            {...(emptyTitle === undefined ? { title: '暂无数据' } : { title: emptyTitle })}
            {...(emptyDescription === undefined ? {} : { description: emptyDescription })}
          />
        );
      }
    }

    return <ErrorPanel error={error} {...(onRetry === undefined ? {} : { onRetry })} />;
  }

  const { data } = state;
  if (isEmpty?.(data) === true) {
    return (
      <EmptyPanel
        {...(emptyTitle === undefined ? { title: '暂无数据' } : { title: emptyTitle })}
        {...(emptyDescription === undefined ? {} : { description: emptyDescription })}
        {...(onRetry === undefined
          ? {}
          : {
              action: (
                <button type="button" onClick={onRetry}>
                  重新加载
                </button>
              ),
            })}
      />
    );
  }

  return <>{children(data)}</>;
}
