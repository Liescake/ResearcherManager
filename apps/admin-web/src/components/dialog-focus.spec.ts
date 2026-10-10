import { describe, expect, it } from 'vitest';
import {
  chooseFocusReturnTarget,
  closeModalDialog,
  focusDialogTarget,
  isFocusableTarget,
  openModalDialog,
  planDialogEscape,
  planDialogInitialFocus,
  restoreFocus,
} from './dialog-focus';
import type { FocusTargetLike, ModalDialogLike } from './dialog-focus';

/**
 * 模态确认框**行为核心**的单测（node 环境，无 jsdom）。
 *
 * 本项目不引入 jsdom（依赖准入未完成），组件测试只能做静态渲染，effect 不执行。
 * 因此「打开时用原生模态、初始焦点在框内、提交中焦点不落在被禁用按钮上、Escape 的两种分支、
 * 关闭后焦点回到触发按钮 / 回落到行锚点」这些**运行时语义**全部在这里用测试替身固定：
 * 断言的是「哪个元素被聚焦了几次」这种可观察行为，而不是实现细节。
 */

/** 可聚焦元素替身：记录被聚焦次数，并可随时被「禁用」或「移出文档」 */
function createFocusProbe(): {
  target: FocusTargetLike & { isConnected: boolean; disabled: boolean };
  state: { focusCount: number };
} {
  const state = { focusCount: 0 };
  const target = {
    isConnected: true,
    disabled: false,
    focus(): void {
      state.focusCount += 1;
    },
  };
  return { target, state };
}

/** 原生 `<dialog>` 替身：记录 showModal / close / focus 的调用顺序，并维护 open */
function createDialogProbe(): ModalDialogLike & { calls: string[] } {
  const probe = {
    open: false,
    calls: [] as string[],
    showModal(): void {
      probe.calls.push('showModal');
      probe.open = true;
    },
    close(): void {
      probe.calls.push('close');
      probe.open = false;
    },
    focus(): void {
      probe.calls.push('focus');
    },
  };
  return probe;
}

describe('原生模态的打开与关闭', () => {
  it('只能用 showModal 打开，且重复打开不会二次调用（原生会抛 InvalidStateError）', () => {
    const dialog = createDialogProbe();

    expect(openModalDialog(dialog)).toBe(true);
    expect(dialog.calls).toEqual(['showModal']);
    expect(dialog.open).toBe(true);

    expect(openModalDialog(dialog)).toBe(false);
    expect(dialog.calls).toEqual(['showModal']);
  });

  it('关闭只在真的打开时执行，已关闭时是空操作（不产生多余事件与焦点恢复）', () => {
    const dialog = createDialogProbe();
    closeModalDialog(dialog);
    expect(dialog.calls).toEqual([]);

    openModalDialog(dialog);
    closeModalDialog(dialog);
    expect(dialog.calls).toEqual(['showModal', 'close']);
    expect(dialog.open).toBe(false);

    closeModalDialog(dialog);
    expect(dialog.calls).toEqual(['showModal', 'close']);
  });

  it('没有 showModal 的环境退化为设置 open（内容仍可见，但不谎称拿到了焦点陷阱）', () => {
    const plain: { open: boolean; focused: number } & FocusTargetLike = {
      open: false,
      focused: 0,
      focus(): void {
        plain.focused += 1;
      },
    };

    expect(openModalDialog(plain)).toBe(true);
    expect(plain.open).toBe(true);

    closeModalDialog(plain);
    expect(plain.open).toBe(false);

    // 对 null 是安全的空操作（对话框已被卸载）
    expect(openModalDialog(null)).toBe(false);
    closeModalDialog(null);
  });
});

describe('初始焦点与提交中的焦点', () => {
  it('未提交时初始焦点落在主操作按钮上', () => {
    const dialog = createDialogProbe();
    const confirm = createFocusProbe();

    expect(planDialogInitialFocus({ busy: false })).toBe('confirm');
    expect(
      focusDialogTarget(planDialogInitialFocus({ busy: false }), {
        container: dialog,
        confirm: confirm.target,
      }),
    ).toBe('confirm');
    expect(confirm.state.focusCount).toBe(1);
    expect(dialog.calls).toEqual([]);
  });

  it('提交中两个动作都禁用：焦点收到对话框容器，绝不落在被禁用的按钮上', () => {
    const dialog = createDialogProbe();
    const confirm = createFocusProbe();
    confirm.target.disabled = true;

    expect(planDialogInitialFocus({ busy: true })).toBe('container');
    expect(
      focusDialogTarget(planDialogInitialFocus({ busy: true }), {
        container: dialog,
        confirm: confirm.target,
      }),
    ).toBe('container');
    expect(confirm.state.focusCount).toBe(0);
    expect(dialog.calls).toEqual(['focus']);
  });

  it('计划目标是确认按钮但它此刻已禁用（刚刚进入提交中）时退到容器——防焦点被浏览器丢回 body', () => {
    const dialog = createDialogProbe();
    const confirm = createFocusProbe();
    confirm.target.disabled = true;

    expect(focusDialogTarget('confirm', { container: dialog, confirm: confirm.target })).toBe(
      'container',
    );
    expect(confirm.state.focusCount).toBe(0);
    expect(dialog.calls).toEqual(['focus']);
  });

  it('两个目标都不可聚焦时什么都不做（不抛错、不假装成功）', () => {
    const gone = createFocusProbe();
    gone.target.isConnected = false;

    expect(focusDialogTarget('confirm', { container: null, confirm: null })).toBeNull();
    expect(focusDialogTarget('container', { container: gone.target, confirm: null })).toBeNull();
  });
});

describe('Escape 的语义', () => {
  it('未提交时 Escape 等价于点「取消」', () => {
    expect(planDialogEscape({ busy: false })).toBe('cancel');
  });

  it('提交中 Escape 被吞掉：请求已在飞，关掉确认框会让界面与服务端事实脱节', () => {
    expect(planDialogEscape({ busy: true })).toBe('ignore');
  });
});

describe('关闭后的焦点回落', () => {
  it('取消 / 失败：触发撤销的按钮仍在，焦点回到它', () => {
    const trigger = createFocusProbe();
    const row = createFocusProbe();

    const target = chooseFocusReturnTarget({ trigger: trigger.target, fallback: row.target });
    expect(target).toBe(trigger.target);
    expect(restoreFocus(target)).toBe(true);
    expect(trigger.state.focusCount).toBe(1);
    expect(row.state.focusCount).toBe(0);
  });

  it('成功撤销：触发按钮随状态更新消失，焦点回落到仍然存在的行锚点', () => {
    const trigger = createFocusProbe();
    const row = createFocusProbe();

    // 撤销成功 → 该行由本地视图更新为「已撤销」，撤销按钮被移除
    trigger.target.isConnected = false;

    const target = chooseFocusReturnTarget({ trigger: trigger.target, fallback: row.target });
    expect(target).toBe(row.target);
    expect(restoreFocus(target)).toBe(true);
    expect(trigger.state.focusCount).toBe(0);
    expect(row.state.focusCount).toBe(1);
  });

  it('触发按钮被禁用（例如仍处于提交中）时也不聚焦它，改回落行锚点', () => {
    const trigger = createFocusProbe();
    const row = createFocusProbe();
    trigger.target.disabled = true;

    expect(chooseFocusReturnTarget({ trigger: trigger.target, fallback: row.target })).toBe(
      row.target,
    );
  });

  it('两个目标都已随区块卸载时返回 null：不把焦点抢到页面上', () => {
    expect(chooseFocusReturnTarget({ trigger: null, fallback: null })).toBeNull();
    expect(restoreFocus(null)).toBe(false);
  });
});

describe('可聚焦性判定', () => {
  it('null / 已移出文档 / 已禁用 一律不可聚焦', () => {
    const probe = createFocusProbe();
    expect(isFocusableTarget(null)).toBe(false);
    expect(isFocusableTarget(undefined)).toBe(false);
    expect(isFocusableTarget(probe.target)).toBe(true);

    probe.target.disabled = true;
    expect(isFocusableTarget(probe.target)).toBe(false);

    probe.target.disabled = false;
    probe.target.isConnected = false;
    expect(isFocusableTarget(probe.target)).toBe(false);

    // 替身省略 isConnected / disabled 时视为可用（最小接口）
    expect(isFocusableTarget({ focus: () => undefined })).toBe(true);
  });
});

describe('一次完整的确认往返（取消）', () => {
  it('点击撤销 → 打开模态并聚焦确认按钮 → Escape → 关闭 → 焦点回到触发按钮', () => {
    const dialog = createDialogProbe();
    const confirm = createFocusProbe();
    const trigger = createFocusProbe();
    const row = createFocusProbe();

    // 1) 用户点击「撤销」：打开确认框，初始焦点在框内
    openModalDialog(dialog);
    focusDialogTarget(planDialogInitialFocus({ busy: false }), {
      container: dialog,
      confirm: confirm.target,
    });
    expect(dialog.open).toBe(true);
    expect(confirm.state.focusCount).toBe(1);

    // 2) 按 Escape：未提交 → 取消
    expect(planDialogEscape({ busy: false })).toBe('cancel');

    // 3) 状态机把 confirmingId 置空 → 确认框卸载 → 关闭并回收焦点
    closeModalDialog(dialog);
    restoreFocus(chooseFocusReturnTarget({ trigger: trigger.target, fallback: row.target }));

    expect(dialog.open).toBe(false);
    // 初始焦点落在确认按钮上（而不是容器），因此对话框自身只经历「打开 → 关闭」
    expect(dialog.calls).toEqual(['showModal', 'close']);
    expect(trigger.state.focusCount).toBe(1);
    expect(row.state.focusCount).toBe(0);
  });
});

describe('一次完整的确认往返（提交中与成功）', () => {
  it('点击确认 → 两个动作禁用、焦点收到容器 → 成功 → 焦点回落到行锚点', () => {
    const dialog = createDialogProbe();
    const confirm = createFocusProbe();
    const trigger = createFocusProbe();
    const row = createFocusProbe();

    openModalDialog(dialog);
    focusDialogTarget(planDialogInitialFocus({ busy: false }), {
      container: dialog,
      confirm: confirm.target,
    });

    // 1) 点击「确认撤销」→ busy：两个动作都被禁用
    confirm.target.disabled = true;
    expect(planDialogEscape({ busy: true })).toBe('ignore');
    // 焦点不能留在刚被禁用的按钮上（浏览器会把它丢回 body）
    expect(focusDialogTarget('container', { container: dialog, confirm: confirm.target })).toBe(
      'container',
    );
    expect(confirm.state.focusCount).toBe(1);

    // 2) 服务端确认撤销：该行变成「已撤销」，撤销按钮消失
    trigger.target.isConnected = false;
    closeModalDialog(dialog);
    restoreFocus(chooseFocusReturnTarget({ trigger: trigger.target, fallback: row.target }));

    expect(dialog.open).toBe(false);
    expect(trigger.state.focusCount).toBe(0);
    expect(row.state.focusCount).toBe(1);
  });
});

describe('与原生元素的类型兼容', () => {
  it('HTMLButtonElement / HTMLDialogElement 结构上满足最小接口，组件不需要强制转换', () => {
    const asFocusTarget = (element: HTMLButtonElement): FocusTargetLike => element;
    const asModalDialog = (element: HTMLDialogElement): ModalDialogLike => element;
    expect(typeof asFocusTarget).toBe('function');
    expect(typeof asModalDialog).toBe('function');
  });
});
