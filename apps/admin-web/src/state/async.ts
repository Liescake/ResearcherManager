import type { UiError } from '../api/errors';
import { toUiError } from '../api/errors';

/**
 * 异步取数的状态机（纯数据，无 React 依赖，因此可在 node 环境直接单测）。
 *
 * 四个状态刻意互斥且穷尽：`idle`（尚未发起）/ `loading` / `ready`（含空集，由调用方按业务决定
 * 是否渲染空态）/ `error`。空集**不是**错误，也不在这里自动折叠成「无数据」——
 * 列表为空与「筛选后为空」与「服务端返回了 0 条」在界面上文案不同，必须由页面决定。
 */
export type Loadable<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly error: UiError };

export const IDLE: Loadable<never> = { status: 'idle' };

export function loading<T>(): Loadable<T> {
  return { status: 'loading' };
}

export function ready<T>(data: T): Loadable<T> {
  return { status: 'ready', data };
}

export function failed<T>(error: UiError): Loadable<T> {
  return { status: 'error', error };
}

/** 把任意异常收敛为 `error` 状态，并附带 API 边界信息（排障用） */
export function toFailure<T>(caught: unknown, endpoint?: string): Loadable<T> {
  return failed(toUiError(caught, endpoint));
}

/** 便于 JSX 里判断「结果已就绪且为空」 */
export function isEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}
