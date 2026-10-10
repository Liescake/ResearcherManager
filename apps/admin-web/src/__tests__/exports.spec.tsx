import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../api/client';
import { EXPORT_UNAVAILABLE_CODE, EXPORT_REVOKE_UNAVAILABLE_MESSAGE } from '../api/errors';
import type { ExportRequestView, MyExportPage } from '../api/types';
import {
  EXPORT_REVOKE_CONFIRM_TITLE,
  EXPORT_REVOKE_DEMO_NOTE,
  EXPORT_DOWNLOAD_ENDPOINT_REF,
  MyExportsPanel,
} from '../components/MyExportsPanel';
import { INITIAL_REVOKE_FLOW, revokeFailed, revokeSucceeded } from '../state/revoke-flow';
import type { RevokeFlowState } from '../state/revoke-flow';
import type { Loadable } from '../state/async';

/**
 * 导出记录区的**静态渲染**测试（react-dom/server，不引入 jsdom）。
 *
 * 覆盖的是「哪个状态显示什么、按钮在不在、aria 与焦点锚点是否完整」这类结构断言；
 * 交互时序（确认 / 取消 / 防重复提交 / 成功与失败的状态迁移）由
 * `state/revoke-flow.spec.ts` 的纯函数测试固定，确认框的运行时语义（showModal 打开、初始焦点、
 * Tab 不逃逸、Escape 取消、关闭后焦点回到触发按钮 / 回落到行）由
 * `components/dialog-focus.spec.ts` 的纯函数测试固定——三者合起来等价于一次完整的交互验收。
 */
const PENDING_ID = '00000000-0000-4000-8000-000000000001';
const COMPLETED_ID = '00000000-0000-4000-8000-000000000002';
const FAILED_ID = '00000000-0000-4000-8000-000000000003';
const EXPIRED_ID = '00000000-0000-4000-8000-000000000004';
const REVOKED_ID = '00000000-0000-4000-8000-000000000005';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000006';

function exportView(id: string, status: string): ExportRequestView {
  return {
    id,
    resource: 'profile',
    fields: ['name', 'grade'],
    status,
    createdAt: '2026-10-10T01:00:00.000Z',
    updatedAt: '2026-10-10T02:00:00.000Z',
  };
}

function page(items: ExportRequestView[], hasNext = false): MyExportPage {
  return { items, limit: 20, hasNext, nextCursor: hasNext ? 'cursor' : null };
}

function renderPanel(
  data: Loadable<MyExportPage>,
  options: { flow?: RevokeFlowState; mode?: 'live' | 'demo' } = {},
): string {
  return renderToStaticMarkup(
    <MyExportsPanel
      state={data}
      mode={options.mode ?? 'live'}
      flow={options.flow ?? INITIAL_REVOKE_FLOW}
      onRequestRevoke={() => undefined}
      onCancelRevoke={() => undefined}
      onConfirmRevoke={() => undefined}
      onDismissNotice={() => undefined}
      onRetry={() => undefined}
    />,
  );
}

function allStatuses(): ExportRequestView[] {
  return [
    exportView(PENDING_ID, 'pending'),
    exportView(COMPLETED_ID, 'completed'),
    exportView(FAILED_ID, 'failed'),
    exportView(EXPIRED_ID, 'expired'),
    exportView(REVOKED_ID, 'revoked'),
    exportView(UNKNOWN_ID, 'cancelled'),
  ];
}

/** 统计渲染结果里出现的「撤销」按钮个数（确认弹窗里的按钮文案不同，不会误计） */
function revokeButtonCount(html: string): number {
  return html.split('>撤销</button>').length - 1;
}

describe('导出记录区的状态展示', () => {
  it('pending / completed 显示撤销入口；failed / expired / revoked / 未知状态都没有入口', () => {
    const html = renderPanel({ status: 'ready', data: page(allStatuses()) });
    // 恰好两个可撤销状态各有一个「撤销」按钮
    expect(revokeButtonCount(html)).toBe(2);
    expect(html).toContain('处理中');
    expect(html).toContain('已完成');
    expect(html).toContain('生成失败');
    expect(html).toContain('已过期');
    // 不可撤销的状态给出明确说明，而不是一个点了就被拒绝的按钮
    expect(html).toContain('不可撤销（生成失败）');
    expect(html).toContain('不可撤销（已过期）');
    expect(html).toContain('未知状态（cancelled）');
    expect(html).toContain('不可撤销（未知状态（cancelled））');
  });

  it('revoked 显示「已撤销」且没有任何下载或撤销入口', () => {
    const html = renderPanel({ status: 'ready', data: page([exportView(REVOKED_ID, 'revoked')]) });
    expect(html).toContain('已撤销');
    expect(html).toContain('下载入口已失效');
    expect(html).toContain('不提供下载');
    expect(revokeButtonCount(html)).toBe(0);
    // 整页都不存在下载链接/按钮
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('下载</button>');
  });

  it('本区任何状态都不提供下载入口（下载端点不在本轮范围，仅作为文字说明出现）', () => {
    const html = renderPanel({ status: 'ready', data: page(allStatuses()) });
    expect(html).toContain(EXPORT_DOWNLOAD_ENDPOINT_REF);
    expect(html).not.toContain('<a ');
  });

  it('空集显示合法空态（不是错误、也不是演示数据）', () => {
    const html = renderPanel({ status: 'ready', data: page([]) });
    expect(html).toContain('当前没有导出记录');
    expect(html).toContain('合法的空集');
  });

  it('服务端提示还有更多记录时如实说明只展示第一页，不宣称「全部」', () => {
    const html = renderPanel({ status: 'ready', data: page(allStatuses(), true) });
    expect(html).toContain('服务端提示还有更多记录');
    expect(html).toContain('服务端页大小 20');
  });

  it('加载中与 403 沿用既有状态面板语义', () => {
    expect(renderPanel({ status: 'loading' })).toContain('正在加载导出记录');

    const forbidden = renderPanel({
      status: 'error',
      error: { kind: 'forbidden', code: 'FORBIDDEN', message: '没有权限' },
    });
    expect(forbidden).toContain('没有访问权限');
    expect(forbidden).toContain('profile:self:read');
  });
});

describe('撤销确认弹窗', () => {
  it('点击撤销后必须确认：原生模态 dialog 带 alertdialog 语义与完整 aria 关联', () => {
    const html = renderPanel(
      { status: 'ready', data: page([exportView(PENDING_ID, 'pending')]) },
      { flow: { ...INITIAL_REVOKE_FLOW, confirmingId: PENDING_ID } },
    );
    // 原生 <dialog>：模态语义（背景 inert、Tab 不逃逸、Escape 触发取消）由 showModal() 提供
    expect(html).toContain('<dialog');
    expect(html).toContain('</dialog>');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain(EXPORT_REVOKE_CONFIRM_TITLE);
    expect(html).toContain(`aria-labelledby="revoke-title-${PENDING_ID}"`);
    expect(html).toContain(`aria-describedby="revoke-desc-${PENDING_ID}"`);
    expect(html).toContain(`id="revoke-title-${PENDING_ID}"`);
    expect(html).toContain(`id="revoke-desc-${PENDING_ID}"`);
    // 不用 open 属性打开（那是非模态打开：既无焦点陷阱，也会让 showModal() 抛错）
    expect(/<dialog[^>]*\bopen\b/.test(html)).toBe(false);
  });

  it('打开时焦点目标在框内：主操作在先，容器可被程序聚焦，框内没有别的可聚焦控件', () => {
    const html = renderPanel(
      { status: 'ready', data: page([exportView(PENDING_ID, 'pending')]) },
      { flow: { ...INITIAL_REVOKE_FLOW, confirmingId: PENDING_ID } },
    );
    // 容器 tabindex=-1：提交中焦点收到这里（不进入 Tab 顺序）
    expect(html).toContain('tabindex="-1"');
    const confirmIndex = html.indexOf('>确认撤销</button>');
    const cancelIndex = html.indexOf('>取消</button>');
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(cancelIndex).toBeGreaterThan(confirmIndex);
    // 框内没有输入控件或链接：Tab 只能在「确认 / 取消 / 容器」之间循环
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<a ');
  });

  it('每一行都备好两个焦点回落的锚点：触发按钮与常驻 tabindex=-1 的行', () => {
    const html = renderPanel(
      { status: 'ready', data: page([exportView(PENDING_ID, 'pending')]) },
      { flow: { ...INITIAL_REVOKE_FLOW, confirmingId: PENDING_ID } },
    );
    // 取消 / 失败后焦点回到触发撤销的按钮；成功撤销后该按钮随状态更新消失，焦点落到行本身，
    // 因此行的 tabindex=-1 必须常驻（否则回落目标在成功那一刻也不存在了）
    expect(html).toContain('<tr tabindex="-1">');
    expect(revokeButtonCount(html)).toBe(1);
  });

  it('弹窗只提供「确认撤销 / 取消」两个动作，没有任何可填字段', () => {
    const html = renderPanel(
      { status: 'ready', data: page([exportView(PENDING_ID, 'pending')]) },
      { flow: { ...INITIAL_REVOKE_FLOW, confirmingId: PENDING_ID } },
    );
    expect(html).toContain('确认撤销');
    expect(html).toContain('取消');
    // 不接受客户端提交归属 / 产物 / 路径：弹窗里没有任何输入控件
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<select');
    expect(html).toContain('请求只包含导出 ID');
  });

  it('确认弹窗只出现在被确认的那一条上', () => {
    const html = renderPanel(
      { status: 'ready', data: page(allStatuses()) },
      { flow: { ...INITIAL_REVOKE_FLOW, confirmingId: COMPLETED_ID } },
    );
    expect(html).toContain(`revoke-title-${COMPLETED_ID}`);
    expect(html).not.toContain(`revoke-title-${PENDING_ID}`);
  });

  it('未确认时不渲染弹窗（点击前的默认状态）', () => {
    const html = renderPanel({ status: 'ready', data: page(allStatuses()) });
    expect(html).not.toContain('role="alertdialog"');
    expect(html).not.toContain('确认撤销');
  });
});

describe('提交中与结果展示', () => {
  it('提交中：弹窗显示「正在撤销…」并禁用确认与取消（防重复提交）', () => {
    const html = renderPanel(
      { status: 'ready', data: page([exportView(PENDING_ID, 'pending')]) },
      {
        flow: {
          ...INITIAL_REVOKE_FLOW,
          confirmingId: PENDING_ID,
          pendingId: PENDING_ID,
        },
      },
    );
    expect(html).toContain('正在撤销…');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled');
    // 提交中不存在可再次点击的「确认撤销」按钮（不会重复提交）
    expect(html.split('>确认撤销</button>').length - 1).toBe(0);
    expect(revokeButtonCount(html)).toBe(1);
    // 提交中确认与取消都是禁用按钮：焦点必须落在对话框容器（tabindex=-1）上，
    // 否则浏览器会把它丢回 body ——「正在撤销…」期间框内就没有焦点了
    expect(/<button[^>]*disabled[^>]*>正在撤销…<\/button>/.test(html)).toBe(true);
    expect(/<button[^>]*disabled[^>]*>取消<\/button>/.test(html)).toBe(true);
    expect(html).toContain('<dialog');
    expect(html).toContain('tabindex="-1"');
  });

  it('成功：提示下载失效，且该条由本地视图更新为「已撤销」并移除撤销入口', () => {
    const flow = revokeSucceeded(
      { ...INITIAL_REVOKE_FLOW, confirmingId: PENDING_ID, pendingId: PENDING_ID },
      exportView(PENDING_ID, 'revoked'),
    );
    const html = renderPanel(
      { status: 'ready', data: page([exportView(PENDING_ID, 'pending')]) },
      { flow },
    );
    expect(html).toContain('已撤销：下载入口立即失效');
    expect(html).toContain('下载入口已失效');
    expect(revokeButtonCount(html)).toBe(0);
    // 成功撤销后该行的撤销按钮已消失（焦点回落目标只剩行锚点），确认框也已关闭
    expect(html).not.toContain('<dialog');
    expect(html).toContain('<tr tabindex="-1">');
  });

  it('失败：显示统一安全拒绝文案（不区分原因、不泄露存在性），本地视图保持不变', () => {
    const flow = revokeFailed(
      { ...INITIAL_REVOKE_FLOW, confirmingId: PENDING_ID, pendingId: PENDING_ID },
      new ApiClientError('NOT_FOUND', '导出请求不存在或不可撤销', { status: 404 }),
    );
    const html = renderPanel(
      { status: 'ready', data: page([exportView(PENDING_ID, 'pending')]) },
      { flow },
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(EXPORT_UNAVAILABLE_CODE);
    expect(html).toContain(EXPORT_REVOKE_UNAVAILABLE_MESSAGE);
    // 失败不当成成功：该条仍是处理中，撤销入口还在（可重试）
    expect(html).toContain('处理中');
    expect(revokeButtonCount(html)).toBe(1);
    // 失败后确认框关闭，触发撤销的按钮重新可用：它是关闭后焦点回填的目标
    expect(html).not.toContain('<dialog');
    const revokeButton = /<button[^>]*>撤销<\/button>/.exec(html)?.[0] ?? '';
    expect(revokeButton).not.toBe('');
    expect(revokeButton).not.toContain('disabled');
    expect(html).toContain('<tr tabindex="-1">');
  });

  it('失败：503 沿用「服务暂时不可用」，而不是笼统的服务端异常', () => {
    const flow = revokeFailed(
      INITIAL_REVOKE_FLOW,
      new ApiClientError('HTTP_503', '服务暂不可用', { status: 503 }),
    );
    const html = renderPanel(
      { status: 'ready', data: page([exportView(PENDING_ID, 'pending')]) },
      {
        flow,
      },
    );
    expect(html).toContain('服务暂时不可用');
    expect(html).not.toContain('导出请求不存在或不可撤销');
  });
});

describe('演示模式', () => {
  it('撤销入口禁用并明确标注演示数据（写操作被拒绝，不发任何请求）', () => {
    const html = renderPanel({ status: 'ready', data: page(allStatuses()) }, { mode: 'demo' });
    expect(html).toContain(EXPORT_REVOKE_DEMO_NOTE);
    expect(html).toContain('aria-describedby="exports-revoke-demo-note"');
    expect(html).toContain('id="exports-revoke-demo-note"');
    expect(html).toContain('演示');
    // 两个可撤销状态仍然渲染入口，但都是禁用态
    expect(revokeButtonCount(html)).toBe(2);
    expect(html).toContain('disabled');
    expect(html).not.toContain('真实请求');
  });

  it('联调模式不出现演示标注，入口可用', () => {
    const html = renderPanel(
      { status: 'ready', data: page([exportView(PENDING_ID, 'pending')]) },
      {
        mode: 'live',
      },
    );
    expect(html).not.toContain(EXPORT_REVOKE_DEMO_NOTE);
    expect(html).not.toContain('tag--demo');
    expect(revokeButtonCount(html)).toBe(1);
    expect(html).toContain('>撤销</button>');
  });
});
