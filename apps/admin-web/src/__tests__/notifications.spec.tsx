import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../api/client';
import {
  NOTIFICATION_UNAVAILABLE_CODE,
  NOTIFICATION_READ_UNAVAILABLE_MESSAGE,
} from '../api/errors';
import { NOTIFICATION_TYPE_LABELS } from '../api/types';
import type { NotificationView } from '../api/types';
import { MyNotificationsPanel, NOTIFICATION_DEMO_NOTE } from '../components/MyNotificationsPanel';
import type { Loadable } from '../state/async';
import {
  INITIAL_NOTIFICATION_FLOW,
  markReadFailed,
  markReadSucceeded,
  startMarkRead,
} from '../state/notification-flow';
import type { NotificationFlowState } from '../state/notification-flow';

/**
 * 我的通知区的**静态渲染**测试（react-dom/server，不引入 jsdom）。
 *
 * 覆盖「哪个状态显示什么、入口在不在、字段白名单是否守住」这类结构断言；
 * 交互时序（防重复提交、成功 / 失败的状态迁移、失败不伪造成功）由
 * `state/notification-flow.spec.ts` 的纯函数测试固定，二者合起来等价于一次完整的交互验收。
 */
const UNREAD_ID = '00000000-0000-4000-8000-000000000001';
const READ_ID = '00000000-0000-4000-8000-000000000002';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000003';

function notification(overrides: Partial<NotificationView> & Pick<NotificationView, 'id'>) {
  return {
    type: 'membership_review',
    title: '入组申请审核结果',
    body: '你的入组申请已通过审核。',
    status: 'unread',
    createdAt: '2026-10-10T01:00:00.000Z',
    updatedAt: '2026-10-10T01:00:00.000Z',
    ...overrides,
  } satisfies NotificationView;
}

function readNotification(id: string): NotificationView {
  return notification({
    id,
    type: 'announcement',
    title: '站内公告',
    status: 'read',
    readAt: '2026-10-11T03:00:00.000Z',
    updatedAt: '2026-10-11T03:00:00.000Z',
  });
}

function renderPanel(
  data: Loadable<NotificationView[]>,
  options: { flow?: NotificationFlowState; mode?: 'live' | 'demo' } = {},
): string {
  return renderToStaticMarkup(
    <MyNotificationsPanel
      state={data}
      mode={options.mode ?? 'live'}
      flow={options.flow ?? INITIAL_NOTIFICATION_FLOW}
      onRequestMarkRead={() => undefined}
      onDismissNotice={() => undefined}
      onRetry={() => undefined}
    />,
  );
}

/** 统计渲染结果里出现的「标记已读」按钮个数（「正在标记…」文案不同，不会误计） */
function markButtonCount(html: string): number {
  return html.split('>标记已读</button>').length - 1;
}

/** 取出第一个「标记已读」按钮的标签，用于断言禁用态 */
function markButton(html: string): string {
  return /<button[^>]*>标记已读<\/button>/.exec(html)?.[0] ?? '';
}

describe('我的通知：列表与入口', () => {
  it('未读通知有「标记已读」入口，已读通知没有入口且写明原因', () => {
    const html = renderPanel({
      status: 'ready',
      data: [notification({ id: UNREAD_ID }), readNotification(READ_ID)],
    });
    expect(markButtonCount(html)).toBe(1);
    expect(html).toContain(NOTIFICATION_TYPE_LABELS.membership_review);
    expect(html).toContain('未读');
    expect(html).toContain('已读');
    expect(html).toContain('不可标记已读（已读）');
    // 已读时间来自服务端白名单字段
    expect(html).toContain('已读时间');
  });

  it('未知状态没有任何入口：不猜成「已读」也不提供可点击按钮', () => {
    const html = renderPanel({
      status: 'ready',
      data: [notification({ id: UNKNOWN_ID, status: 'archived' })],
    });
    expect(html).toContain('未知状态（archived）');
    expect(html).toContain('不可标记已读（未知状态（archived））');
    expect(markButtonCount(html)).toBe(0);
  });

  it('未知类型按原值呈现，不猜成某个已知类型', () => {
    const html = renderPanel({
      status: 'ready',
      data: [notification({ id: UNREAD_ID, type: 'brand_new_type' })],
    });
    expect(html).toContain('未知类型（brand_new_type）');
  });

  it('只渲染白名单字段：归属 / 票据 / 路径 / provider / 原始异常都不出现在界面', () => {
    const leaky = {
      ...notification({ id: UNREAD_ID }),
      userId: '99999999-0000-4000-8000-000000000001',
      ownerUserId: '99999999-0000-4000-8000-000000000002',
      sessionTicket: 'ticket-super-secret',
      deepLinkPath: 'pages/notifications/detail',
      provider: 'wechat-subscribe',
      storageHandle: '/var/notifications/1.json',
      rawError: 'TypeError: boom at notifications.service.ts:1',
    } as NotificationView;

    const html = renderPanel({ status: 'ready', data: [leaky] });
    for (const forbidden of [
      '99999999',
      'ticket-super-secret',
      'pages/notifications/detail',
      'wechat-subscribe',
      '/var/notifications',
      'TypeError',
      'userId',
      'ownerUserId',
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('空集显示合法空态（不是错误、也不是演示数据）', () => {
    const html = renderPanel({ status: 'ready', data: [] });
    expect(html).toContain('当前没有通知');
    expect(html).toContain('合法的空集');
  });
});

describe('我的通知：加载 / 错误状态复用既有面板', () => {
  it('加载中显示加载提示', () => {
    expect(renderPanel({ status: 'loading' })).toContain('正在加载通知');
  });

  it('403（stable 端点）显示无权限并列出所需权限点', () => {
    const html = renderPanel({
      status: 'error',
      error: { kind: 'forbidden', code: 'FORBIDDEN', message: '没有权限' },
    });
    expect(html).toContain('没有访问权限');
    expect(html).toContain('profile:self:read');
  });

  it('503 沿用「服务暂时不可用」，401 提示会话失效', () => {
    expect(
      renderPanel({
        status: 'error',
        error: {
          kind: 'service-unavailable',
          code: 'HTTP_503',
          message: '暂时不可用',
          status: 503,
        },
      }),
    ).toContain('服务暂时不可用');

    expect(
      renderPanel({
        status: 'error',
        error: { kind: 'unauthorized', code: 'UNAUTHENTICATED', message: '会话失效', status: 401 },
      }),
    ).toContain('登录状态已失效');
  });

  it('契约违规显示为接口契约问题，而不是空列表', () => {
    const html = renderPanel({
      status: 'error',
      error: { kind: 'contract', code: 'INVALID_RESPONSE', message: '响应不符合契约', status: 200 },
    });
    expect(html).toContain('响应不符合接口契约');
  });

  it('可重试错误带重试按钮', () => {
    const html = renderPanel({
      status: 'error',
      error: { kind: 'network', code: 'NETWORK_ERROR', message: '无法连接服务端' },
    });
    expect(html).toContain('重试');
  });
});

describe('我的通知：标记已读的提交与结果展示', () => {
  it('提交中：该条按钮显示「正在标记…」并禁用（防重复提交）', () => {
    const html = renderPanel(
      { status: 'ready', data: [notification({ id: UNREAD_ID })] },
      { flow: { ...INITIAL_NOTIFICATION_FLOW, pendingId: UNREAD_ID } },
    );
    expect(html).toContain('正在标记…');
    expect(/<button[^>]*disabled[^>]*aria-busy="true"[^>]*>正在标记…<\/button>/.test(html)).toBe(
      true,
    );
    // 提交中不存在可再次点击的「标记已读」按钮
    expect(markButtonCount(html)).toBe(0);
  });

  it('提交中其它未读通知的入口一并禁用（不会并发发出第二个请求）', () => {
    const html = renderPanel(
      { status: 'ready', data: [notification({ id: UNREAD_ID }), notification({ id: READ_ID })] },
      { flow: { ...INITIAL_NOTIFICATION_FLOW, pendingId: UNREAD_ID } },
    );
    expect(markButtonCount(html)).toBe(1);
    expect(/<button[^>]*disabled[^>]*>标记已读<\/button>/.test(html)).toBe(true);
  });

  it('成功：该条由本地视图更新为已读（以服务端返回视图为准）并移除入口，同时给出提示', () => {
    const started = startMarkRead(INITIAL_NOTIFICATION_FLOW, {
      id: UNREAD_ID,
      status: 'unread',
    });
    const flow = markReadSucceeded(started.state, readNotification(UNREAD_ID));
    const html = renderPanel(
      { status: 'ready', data: [notification({ id: UNREAD_ID })] },
      { flow },
    );

    expect(html).toContain('已标记为已读');
    expect(html).toContain('不可标记已读（已读）');
    expect(markButtonCount(html)).toBe(0);
    expect(html).not.toContain('正在标记…');
  });

  it('失败：显示统一安全拒绝文案（不区分原因），该条仍是未读且入口可重试', () => {
    const started = startMarkRead(INITIAL_NOTIFICATION_FLOW, {
      id: UNREAD_ID,
      status: 'unread',
    });
    const flow = markReadFailed(
      started.state,
      new ApiClientError('NOT_FOUND', '目标通知不存在或不可见', { status: 404 }),
    );
    const html = renderPanel(
      { status: 'ready', data: [notification({ id: UNREAD_ID })] },
      { flow },
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain(NOTIFICATION_UNAVAILABLE_CODE);
    expect(html).toContain(NOTIFICATION_READ_UNAVAILABLE_MESSAGE);
    // 失败不当成成功：该条仍是未读，入口还在（可重试）
    expect(html).toContain('未读');
    expect(markButtonCount(html)).toBe(1);
    const button = /<button[^>]*>标记已读<\/button>/.exec(html)?.[0] ?? '';
    expect(button).not.toBe('');
    expect(button).not.toContain('disabled');
  });
});

describe('我的通知：演示模式', () => {
  it('入口禁用并明确标注演示数据（写操作被拒绝，不发任何请求）', () => {
    const html = renderPanel(
      { status: 'ready', data: [notification({ id: UNREAD_ID }), readNotification(READ_ID)] },
      { mode: 'demo' },
    );
    expect(html).toContain(NOTIFICATION_DEMO_NOTE);
    expect(html).toContain('aria-describedby="notifications-demo-note"');
    expect(html).toContain('id="notifications-demo-note"');
    expect(html).toContain('tag--demo');
    // 未读条目仍然渲染入口，但是禁用态
    expect(markButtonCount(html)).toBe(1);
    expect(/<button[^>]*disabled[^>]*>标记已读<\/button>/.test(html)).toBe(true);
  });

  it('联调模式不出现演示标注，入口可用', () => {
    const html = renderPanel({ status: 'ready', data: [notification({ id: UNREAD_ID })] });
    expect(html).not.toContain(NOTIFICATION_DEMO_NOTE);
    expect(html).not.toContain('tag--demo');
    expect(markButton(html)).not.toBe('');
    expect(markButton(html)).not.toContain('disabled');
  });

  it('每一行都带可键盘操作的原生 button，列表是语义化 ul/li 结构', () => {
    const html = renderPanel({ status: 'ready', data: [notification({ id: UNREAD_ID })] });
    expect(html).toContain('<ul class="notifications">');
    expect(html).toContain('<li class="notification notification--unread">');
    expect(html).toContain('<button type="button"');
    // 不引入需要自定义焦点管理的非原生控件
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('tabindex');
  });
});
