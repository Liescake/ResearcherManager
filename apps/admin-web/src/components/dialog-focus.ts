/**
 * 模态确认框的**行为核心**（纯函数 + 最小接口，无 React、无 DOM 依赖，可在 node 环境直接单测）。
 *
 * 为什么把它从组件里拿出来：本项目的组件测试用 `react-dom/server` 静态渲染，**不引入 jsdom**
 * （依赖准入与许可证评估完成前不扩依赖，见 `vitest.config.ts`）。静态渲染不执行 effect，
 * 因此「打开、初始焦点、Escape、关闭、焦点回落」这些**运行时语义**在静态渲染里无法被验证。
 *
 * 把这些语义收敛成一组只依赖最小接口的纯函数后：
 * - 组件只负责在 effect 里调用它们（没有第二份逻辑）；
 * - 单测用测试替身逐条固定语义——焦点落在哪、被禁用时落到哪、Escape 在提交中是否被吞掉、
 *   关闭后焦点回到哪个元素、触发元素已消失时回落到哪。
 *
 * 无障碍契约（被单测固定，与 `ConfirmDialog.tsx` 的静态渲染测试互补）：
 * 1. **原生模态**：只能用 `<dialog>.showModal()` 打开；不用 `open` 属性，因为非模态打开
 *    既不产生焦点陷阱（Tab 可逃逸），也会让后续 `showModal()` 抛 `InvalidStateError`；
 * 2. **初始焦点在框内**：未提交时落在主操作按钮上；已提交（两个按钮都禁用）时落在对话框容器上，
 *    否则焦点会停在禁用按钮上并被浏览器丢回 body——这正是「模态框里没有焦点」的逃逸入口；
 * 3. **Escape 取消**：由本模块判定；提交中一律吞掉（否会让界面与服务端事实脱节）；
 * 4. **焦点回落**：关闭后焦点回到**触发撤销的那个按钮**；触发按钮已不存在（撤销成功，
 *    该行按钮随状态更新消失）时回落到仍然存在的行锚点，绝不把焦点留在 body。
 */

/** 可接收焦点的最小抽象：原生 DOM 元素与测试替身都能满足（`HTMLElement` 结构上兼容） */
export interface FocusTargetLike {
  focus(): void;
  /** 是否仍在文档中（原生元素：`isConnected`；替身省略即视为仍在文档中） */
  readonly isConnected?: boolean;
  /** 是否处于禁用态（原生按钮：`disabled`；替身省略即视为可用） */
  readonly disabled?: boolean;
}

/** 原生 `<dialog>` 的最小抽象：只用到 open / showModal / close（`HTMLDialogElement` 结构上兼容） */
export interface ModalDialogLike extends FocusTargetLike {
  open: boolean;
  showModal?: () => void;
  close?: () => void;
}

/** 一个元素此刻是否真的可以被聚焦 */
export function isFocusableTarget(target: FocusTargetLike | null | undefined): boolean {
  if (target === null || target === undefined) return false;
  if (target.isConnected === false) return false;
  if (target.disabled === true) return false;
  return true;
}

/**
 * 用**原生模态**打开：只有 `showModal()` 能建立模态语义（背景 inert、Tab 不逃逸、
 * Escape 触发 `cancel`、`aria-modal` 属实）。
 *
 * - 已经打开时是空操作（重复 `showModal()` 会抛 `InvalidStateError`）；
 * - 没有 `showModal` 的实现（老浏览器 / 测试替身）退化为设置 `open`，保证内容可见，
 *   但**不假装**拿到了焦点陷阱——这一点由调用方的注释与 README 明示。
 *
 * @returns 本次调用是否真的打开了对话框
 */
export function openModalDialog(dialog: ModalDialogLike | null): boolean {
  if (dialog === null || dialog.open) return false;
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
    return true;
  }
  dialog.open = true;
  return true;
}

/** 关闭：只在真的打开时调用 `close()`，避免无谓的关闭事件与重复的焦点恢复 */
export function closeModalDialog(dialog: ModalDialogLike | null): void {
  if (dialog === null || !dialog.open) return;
  if (typeof dialog.close === 'function') {
    dialog.close();
    return;
  }
  dialog.open = false;
}

/** 打开后初始焦点落在哪：主操作按钮（`confirm`）还是对话框容器（`container`） */
export type DialogFocusPlan = 'confirm' | 'container';

/**
 * 打开时的初始焦点：
 * - 未提交：主操作按钮——键盘使用者不必先 Tab 寻找，也保证 Tab 循环从框内开始；
 * - 已提交：容器（`tabindex=-1`）——两个动作都已禁用，聚焦禁用按钮只会立刻失去焦点。
 */
export function planDialogInitialFocus(options: { readonly busy: boolean }): DialogFocusPlan {
  return options.busy ? 'container' : 'confirm';
}

/**
 * 应用初始 / 提交中的焦点计划。按计划优先，计划目标此刻不可聚焦（禁用 / 已移除）时
 * 退到另一个目标——保证「只要框里有可聚焦的东西，焦点就在框里」。
 *
 * @returns 实际被聚焦的目标；`null` 表示两个目标都不可聚焦（什么都没做）
 */
export function focusDialogTarget(
  plan: DialogFocusPlan,
  targets: {
    readonly container: FocusTargetLike | null;
    readonly confirm: FocusTargetLike | null;
  },
): DialogFocusPlan | null {
  const order: readonly DialogFocusPlan[] =
    plan === 'confirm' ? ['confirm', 'container'] : ['container', 'confirm'];
  for (const candidate of order) {
    const target = candidate === 'confirm' ? targets.confirm : targets.container;
    if (target === null || !isFocusableTarget(target)) continue;
    target.focus();
    return candidate;
  }
  return null;
}

/** Escape 的处理判定 */
export type DialogEscapePlan = 'cancel' | 'ignore';

/**
 * Escape（以及原生 `cancel` 事件）的语义：
 * - 未提交：取消（等价于点「取消」）；
 * - 提交中：吞掉——请求已经在飞，关闭确认框会让界面与服务端事实脱节
 *   （状态机 `cancelRevoke` 在 `pendingId !== null` 时同样是空操作）。
 *
 * 无论哪种分支，调用方都必须 `preventDefault()`：原生默认行为会直接把 DOM 对话框关掉，
 * 而 React 仍认为它开着，两者随即脱节（渲染与事实不一致，焦点也会被浏览器丢到 body）。
 */
export function planDialogEscape(options: { readonly busy: boolean }): DialogEscapePlan {
  return options.busy ? 'ignore' : 'cancel';
}

/**
 * 关闭后焦点回落到哪：优先**触发撤销的按钮**；它已被移除或不可用时用仍然存在的回退锚点。
 * 两者都不可用（整个区块已随页面离开而卸载）时返回 `null`——此时不该去抢焦点。
 */
export function chooseFocusReturnTarget(candidates: {
  readonly trigger: FocusTargetLike | null;
  readonly fallback: FocusTargetLike | null;
}): FocusTargetLike | null {
  if (isFocusableTarget(candidates.trigger)) return candidates.trigger;
  if (isFocusableTarget(candidates.fallback)) return candidates.fallback;
  return null;
}

/** 执行一次焦点回填；对 `null` 是安全的空操作 */
export function restoreFocus(target: FocusTargetLike | null): boolean {
  if (target === null || !isFocusableTarget(target)) return false;
  target.focus();
  return true;
}
