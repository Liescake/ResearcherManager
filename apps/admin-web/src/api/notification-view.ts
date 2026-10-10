import type { NotificationView } from './types';

/**
 * 通知响应的**出口白名单读取器**（纯函数，无 React / 无网络依赖）。
 *
 * 为什么需要它，而不是 `data as NotificationView[]`：
 * 1. **只读白名单字段**：服务端视图的闭集是
 *    `id / type / title / body / status / createdAt / readAt / updatedAt`，这里逐字段显式赋值，
 *    永远不把响应里的其它键带进界面——`userId` / `ownerUserId`（归属）、会话票据、深链路径、
 *    投递渠道 / provider、存储句柄、原始异常文本，即使服务端多下发了，界面也不会渲染它们，
 *    更不会据它们做任何判定；
 * 2. **契约漂移 fail-closed**：任何一条形态非法都返回 `null`（而不是悄悄丢掉那一条），
 *    调用方据此抛 `INVALID_RESPONSE_CODE`：把「少展示一条通知」变成一次可排查的契约故障，
 *    绝不把「解析失败」伪装成「没有这条通知」；
 * 3. **服务端跨字段不变式同样在前端复核**：`read` 必须带服务端 `readAt`、`unread` 不得携带
 *    `readAt`（与服务端 `notifications.contract.ts` 的读取契约同口径）。这不是界面在判定状态，
 *    而是拒绝把自相矛盾的状态渲染成一个确定的界面结论。
 *
 * 注意：读取器**不**校验枚举取值（`type` / `status` 只要求非空字符串）。服务端将来新增取值时，
 * 界面按「未知类型 / 未知状态（原值）」如实呈现，而不是把整页判成故障；可执行动作则始终由
 * 白名单闭集（`isNotificationUnread`）决定，因此未知取值天然是「没有入口」。
 */

/** 必需的非空字符串字段（顺序用于文档与回归断言） */
export const NOTIFICATION_REQUIRED_FIELDS = [
  'id',
  'type',
  'title',
  'status',
  'createdAt',
  'updatedAt',
] as const;

/**
 * 读取一条通知视图；形态非法返回 `null`。
 * 未在返回值里出现的键一个都不会进入界面（逐字段显式赋值，不做对象展开）。
 */
export function readNotificationView(raw: unknown): NotificationView | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;

  for (const field of NOTIFICATION_REQUIRED_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string' || value === '') {
      return null;
    }
  }

  // 正文允许为空串（服务端契约下限为 0），但必须是字符串
  const body = record['body'];
  if (typeof body !== 'string') {
    return null;
  }

  const status = record['status'] as string;
  const rawReadAt = record['readAt'];
  let readAt: string | undefined;
  if (rawReadAt === undefined || rawReadAt === null) {
    readAt = undefined;
  } else if (typeof rawReadAt === 'string' && rawReadAt !== '') {
    readAt = rawReadAt;
  } else {
    return null;
  }
  // 与服务端读取契约同口径的跨字段不变式：自相矛盾的状态不渲染成界面结论
  if (status === 'read' && readAt === undefined) {
    return null;
  }
  if (status === 'unread' && readAt !== undefined) {
    return null;
  }

  const view: NotificationView = {
    id: record['id'] as string,
    type: record['type'] as string,
    title: record['title'] as string,
    body,
    status,
    createdAt: record['createdAt'] as string,
    updatedAt: record['updatedAt'] as string,
  };
  return readAt === undefined ? view : { ...view, readAt };
}

/**
 * 读取本人通知列表；任何一行非法即整表返回 `null`。
 * `data === null` 按空数组处理（与其它列表端点同口径：服务端空集可能表现为 null）。
 */
export function readNotificationList(data: unknown): NotificationView[] | null {
  const rows = data === null ? [] : data;
  if (!Array.isArray(rows)) {
    return null;
  }

  const items: NotificationView[] = [];
  for (const row of rows) {
    const view = readNotificationView(row);
    if (view === null) {
      return null;
    }
    items.push(view);
  }
  return items;
}

/**
 * 把服务端**已确认**的已读视图合并进列表项：成功即以服务端返回的视图为准更新本地视图，
 * 不重新拉整表（避免请求失败时把已确认的结果一起丢掉）。
 * 合并只认 `id`，不按位置——列表顺序由服务端决定，前端不假设它稳定。
 *
 * 注意方向是单向的：这里只覆盖**已读**结果，未读状态不会被本地推断出来。
 */
export function mergeReadNotifications(
  items: readonly NotificationView[],
  read: Readonly<Record<string, NotificationView>>,
): NotificationView[] {
  return items.map((item) => read[item.id] ?? item);
}
