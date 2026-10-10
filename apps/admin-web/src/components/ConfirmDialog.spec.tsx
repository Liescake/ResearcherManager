import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * 模态确认框的**静态渲染**测试（`react-dom/server`，不引入 jsdom）。
 *
 * 这里固定的是「语义与结构」：原生 `<dialog>`、`role="alertdialog"`、`aria-modal`、
 * label / description 关联、容器可被程序聚焦、提交中两个动作都禁用且没有可再次点击的确认按钮。
 * 运行时语义（showModal 打开、初始焦点、Escape 分支、焦点回落）由
 * `dialog-focus.spec.ts` 的纯函数单测固定——两者合起来等价于一次完整的交互验收。
 */
function renderDialog(options: { busy?: boolean } = {}): string {
  return renderToStaticMarkup(
    <ConfirmDialog
      titleId="revoke-title-x"
      descriptionId="revoke-desc-x"
      title="确认撤销这条导出？"
      description="撤销后该导出的下载立即失效。"
      confirmLabel="确认撤销"
      busyLabel="正在撤销…"
      busy={options.busy ?? false}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      returnFocusRef={{ current: null }}
    />,
  );
}

/** 统计渲染结果里出现「点击后仍是同一个按钮」的确认动作（提交中主操作文案会变） */
function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('原生模态与无障碍语义', () => {
  it('渲染为原生 <dialog>，带 alertdialog / aria-modal 与完整的 label / description 关联', () => {
    const html = renderDialog();

    expect(html).toContain('<dialog');
    expect(html).toContain('</dialog>');
    expect(html).toContain('role="alertdialog"');
    // 模态属实性由 showModal() 保证，这里显式标注（静态渲染下同样成立）
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="revoke-title-x"');
    expect(html).toContain('aria-describedby="revoke-desc-x"');
    expect(html).toContain('id="revoke-title-x"');
    expect(html).toContain('id="revoke-desc-x"');
    expect(html).toContain('确认撤销这条导出？');
  });

  it('不用 open 属性标记打开状态：打开只能由 showModal() 完成', () => {
    const html = renderDialog();

    // 用 open 属性会是「非模态打开」：没有焦点陷阱（Tab 可逃逸），且后续 showModal() 会抛
    // InvalidStateError，模态语义永远建立不起来
    expect(/<dialog[^>]*\bopen\b/.test(html)).toBe(false);
    // 容器可被程序聚焦（tabindex=-1，不进入 Tab 顺序）：提交中的焦点落点
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('class="confirm"');
  });

  it('框内只有「确认 / 取消」两个可聚焦控件，没有输入控件与链接', () => {
    const html = renderDialog();

    expect(count(html, '<button')).toBe(2);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<a ');
  });

  it('主操作排在取消之前（Tab 顺序与阅读顺序一致，也是打开时的初始焦点）', () => {
    const html = renderDialog();

    const confirmIndex = html.indexOf('>确认撤销</button>');
    const cancelIndex = html.indexOf('>取消</button>');
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(cancelIndex).toBeGreaterThan(confirmIndex);
  });
});

describe('提交中的状态', () => {
  it('两个动作都禁用，主操作变为提交中文案（不存在可重复点击的确认按钮）', () => {
    const html = renderDialog({ busy: true });

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('>正在撤销…</button>');
    expect(count(html, '>确认撤销</button>')).toBe(0);
    expect(count(html, '<button')).toBe(2);
    // 确认与取消都带 disabled
    expect(count(html, 'disabled')).toBe(2);
  });

  it('未提交时不带 disabled，且不是提交中文案', () => {
    const html = renderDialog();

    expect(html).toContain('aria-busy="false"');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('正在撤销…');
  });
});
