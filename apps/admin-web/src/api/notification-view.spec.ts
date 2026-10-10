import { describe, expect, it } from 'vitest';
import { INVALID_RESPONSE_CODE, contractError } from './client';
import {
  NOTIFICATION_REQUIRED_FIELDS,
  mergeReadNotifications,
  readNotificationList,
  readNotificationView,
} from './notification-view';
import {
  NOTIFICATION_STATUS_LABELS,
  NOTIFICATION_TYPE_LABELS,
  isNotificationUnread,
  notificationStatusLabel,
  notificationTypeLabel,
} from './types';
import type { NotificationView } from './types';

const UNREAD: NotificationView = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'membership_review',
  title: '入组申请审核结果',
  body: '你的入组申请已通过审核。',
  status: 'unread',
  createdAt: '2026-10-10T01:00:00.000Z',
  updatedAt: '2026-10-10T01:00:00.000Z',
};

const READ: NotificationView = {
  ...UNREAD,
  id: '00000000-0000-4000-8000-000000000002',
  type: 'announcement',
  title: '站内公告',
  status: 'read',
  readAt: '2026-10-11T01:00:00.000Z',
  updatedAt: '2026-10-11T01:00:00.000Z',
};

describe('通知视图白名单读取', () => {
  it('只保留白名单字段：归属 / 票据 / 路径 / provider 即使出现也不进入界面', () => {
    const parsed = readNotificationView({
      ...UNREAD,
      userId: '99999999-0000-4000-8000-000000000001',
      ownerUserId: '99999999-0000-4000-8000-000000000002',
      sessionTicket: 'ticket-super-secret',
      deepLinkPath: 'pages/notifications/detail',
      provider: 'wechat-subscribe',
      storageHandle: '/var/notifications/1.json',
      rawError: 'TypeError: boom at notifications.service.ts:1',
    });

    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed ?? {}).sort()).toEqual(
      [...NOTIFICATION_REQUIRED_FIELDS, 'body'].sort(),
    );
    // 额外字段的**取值**一个都没有被带进来
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain('99999999');
    expect(serialized).not.toContain('ticket-super-secret');
    expect(serialized).not.toContain('pages/notifications/detail');
    expect(serialized).not.toContain('wechat-subscribe');
    expect(serialized).not.toContain('/var/notifications');
    expect(serialized).not.toContain('TypeError');
  });

  it('已读记录携带服务端 readAt，未读记录不带 readAt', () => {
    const read = readNotificationView(READ);
    expect(read?.readAt).toBe(READ.readAt);
    expect(read?.status).toBe('read');

    const unread = readNotificationView(UNREAD);
    expect(unread?.readAt).toBeUndefined();
  });

  it('正文允许为空串（服务端契约下限为 0），但仍必须是字符串', () => {
    expect(readNotificationView({ ...UNREAD, body: '' })?.body).toBe('');
    expect(readNotificationView({ ...UNREAD, body: 0 })).toBeNull();
  });

  it('形态非法一律返回 null（fail-closed），绝不当成一条合法通知', () => {
    expect(readNotificationView(null)).toBeNull();
    expect(readNotificationView([])).toBeNull();
    expect(readNotificationView('unread')).toBeNull();
    expect(readNotificationView({ ...UNREAD, id: '' })).toBeNull();
    expect(readNotificationView({ ...UNREAD, type: 1 })).toBeNull();
    expect(readNotificationView({ ...UNREAD, title: '' })).toBeNull();
    const missing: Record<string, unknown> = { ...UNREAD };
    delete missing['updatedAt'];
    expect(readNotificationView(missing)).toBeNull();
  });

  it('跨字段不变式不自洽即拒绝：read 缺 readAt 或 unread 带 readAt 都不渲染成结论', () => {
    expect(readNotificationView({ ...READ, readAt: undefined })).toBeNull();
    expect(readNotificationView({ ...READ, readAt: '' })).toBeNull();
    expect(readNotificationView({ ...UNREAD, readAt: '2026-10-11T01:00:00.000Z' })).toBeNull();
  });

  it('未知枚举取值不判成故障（按原值呈现由展示层负责），也不影响读取', () => {
    const parsed = readNotificationView({ ...UNREAD, type: 'brand_new_type', status: 'archived' });
    expect(parsed?.type).toBe('brand_new_type');
    expect(parsed?.status).toBe('archived');
  });
});

describe('通知列表读取', () => {
  it('逐条读取，顺序与条数原样保留', () => {
    const items = readNotificationList([UNREAD, READ]);
    expect(items?.map((item) => item.id)).toEqual([UNREAD.id, READ.id]);
  });

  it('data 为 null 是空集（服务端空页），不是崩溃', () => {
    expect(readNotificationList(null)).toEqual([]);
  });

  it('任一行非法即整表拒绝：绝不「悄悄少展示一条通知」', () => {
    expect(readNotificationList([UNREAD, { ...UNREAD, id: 7 }])).toBeNull();
    expect(readNotificationList({ items: [UNREAD] })).toBeNull();
    expect(readNotificationList([UNREAD, { ...UNREAD, status: 'unread', readAt: 'x' }])).toBeNull();
  });
});

describe('契约错误与本地合并', () => {
  it('契约违规复用既有稳定错误码（HTTP 层可能仍是 200）', () => {
    const error = contractError();
    expect(error.code).toBe(INVALID_RESPONSE_CODE);
    expect(error.status).toBe(200);
  });

  it('已读结果按 id 覆盖原条目，其它条目原样保留（不按位置假设顺序）', () => {
    const merged = mergeReadNotifications([UNREAD, READ], { [UNREAD.id]: READ });
    expect(merged[0]?.status).toBe('read');
    expect(merged[1]).toBe(READ);
  });

  it('没有已读记录时返回等价内容（不改变条数）', () => {
    const merged = mergeReadNotifications([UNREAD], {});
    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe('unread');
  });
});

describe('展示标签与可标记闭集', () => {
  it('只有服务端原文 unread 可标记：read 与未知取值都没有入口', () => {
    expect(isNotificationUnread('unread')).toBe(true);
    for (const status of ['read', 'archived', '', undefined, null, 1]) {
      expect(isNotificationUnread(status)).toBe(false);
    }
  });

  it('已知取值有确定文案；未知取值按「未知…（原值）」呈现，不猜成已知结论', () => {
    expect(notificationTypeLabel('membership_review')).toBe(
      NOTIFICATION_TYPE_LABELS.membership_review,
    );
    expect(notificationTypeLabel('brand_new_type')).toBe('未知类型（brand_new_type）');
    expect(notificationStatusLabel('read')).toBe(NOTIFICATION_STATUS_LABELS.read);
    expect(notificationStatusLabel('archived')).toBe('未知状态（archived）');
  });
});
