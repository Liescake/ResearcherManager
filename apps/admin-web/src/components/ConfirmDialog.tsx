import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import {
  chooseFocusReturnTarget,
  closeModalDialog,
  focusDialogTarget,
  openModalDialog,
  planDialogEscape,
  planDialogInitialFocus,
  restoreFocus,
} from './dialog-focus';

/**
 * 通用**模态确认框**：用原生 `<dialog>` + `showModal()` 承担模态语义。
 *
 * 为什么是原生 `<dialog>` 而不是自定义 `div[role=alertdialog]`：
 * 焦点陷阱、背景 inert、`Escape` 关闭请求、`aria-modal` 属实性，在原生模态对话框里是浏览器
 * 保证的；用 `div` 手写等价物需要自己维护「哪些元素可聚焦、Tab 到边界时怎么办、背景要不要
 * 标 aria-hidden」，而本项目没有可用的 DOM 测试环境来固定这些手工实现。原生方案的关键语义
 * 被抽到 `dialog-focus.ts`（纯函数 + 最小接口），由 node 单测固定；本组件只做接线与渲染。
 *
 * 焦点契约（逐条对应组件里的注释）：
 * 1. 打开即 `showModal()`，并把焦点放进框内（未提交时是主操作按钮）；
 * 2. `Escape` 取消；提交中吞掉（见 `planDialogEscape`）；
 * 3. 关闭（取消 / 成功 / 失败）后焦点回到**触发它的按钮**；触发按钮已不存在时回落到调用方
 *    提供的锚点（撤销成功会让该行的撤销按钮消失）；
 * 4. 提交中两个动作都禁用，焦点离开被禁用的按钮、收到对话框容器上——否则浏览器会把焦点丢回
 *    body，模态框内不再有焦点，Tab 会从这里逃逸。
 */
export interface ConfirmDialogProps {
  /** 标题元素的 id（由调用方持有，便于每行生成互不冲突的 id） */
  readonly titleId: string;
  /** 说明元素的 id */
  readonly descriptionId: string;
  readonly title: string;
  /** 说明正文：只陈述服务端事实，不放任何可填写字段 */
  readonly description: ReactNode;
  /** 主操作文案（如「确认撤销」） */
  readonly confirmLabel: string;
  /** 提交中的主操作文案（如「正在撤销…」） */
  readonly busyLabel: string;
  /** 是否正在提交：两个动作都会禁用，防止重复提交 */
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** 触发本确认框的元素（撤销按钮）：关闭后焦点回到它 */
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  /** 触发元素已被移除时的焦点回落锚点（可选；两者都不可用时不动焦点） */
  readonly fallbackFocusRef?: RefObject<HTMLElement | null>;
}

export function ConfirmDialog({
  titleId,
  descriptionId,
  title,
  description,
  confirmLabel,
  busyLabel,
  busy,
  onConfirm,
  onCancel,
  returnFocusRef,
  fallbackFocusRef,
}: ConfirmDialogProps): ReactNode {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  /**
   * 打开那一刻的提交状态。对话框每次打开都是**全新挂载**（父组件按 `confirmingId` 条件渲染），
   * 因此这里的初值就是本次打开的真实值；不放进 effect 依赖，避免提交状态变化时重复执行
   * 「打开 + 焦点回落」这一对动作（那会在提交进行中把焦点交还给触发按钮）。
   */
  const busyAtMount = useRef(busy).current;

  useEffect(() => {
    const dialog = dialogRef.current;
    openModalDialog(dialog);
    focusDialogTarget(planDialogInitialFocus({ busy: busyAtMount }), {
      container: dialog,
      confirm: confirmRef.current,
    });
    return () => {
      // 关闭由本组件负责（而不是由原生 Escape 的默认行为负责）：React 是唯一的渲染真相，
      // DOM 不能先关、状态还开着。关闭后立刻把焦点交还给触发按钮 / 回落锚点。
      closeModalDialog(dialog);
      restoreFocus(
        chooseFocusReturnTarget({
          trigger: returnFocusRef.current,
          fallback: fallbackFocusRef?.current ?? null,
        }),
      );
    };
  }, [busyAtMount, fallbackFocusRef, returnFocusRef]);

  useEffect(() => {
    if (!busy) return;
    // 提交中：两个动作都已禁用，焦点必须离开被禁用的按钮并留在框内
    focusDialogTarget('container', {
      container: dialogRef.current,
      confirm: confirmRef.current,
    });
  }, [busy]);

  /**
   * `Escape` 与原生 `cancel` 事件共用同一条判定：无论走哪个分支都 `preventDefault()`，
   * 否则原生默认行为会直接关闭 DOM 对话框，而 React 仍认为它开着（渲染与事实脱节）。
   * 两个入口都指向幂等的 `onCancel`，重复触发不会产生第二次副作用。
   */
  const handleCloseRequest = (event: {
    preventDefault: () => void;
    stopPropagation: () => void;
  }): void => {
    event.preventDefault();
    event.stopPropagation();
    if (planDialogEscape({ busy }) === 'cancel') onCancel();
  };

  return (
    <dialog
      ref={dialogRef}
      className="confirm"
      // 原生 <dialog> 隐式角色是 dialog；这里升级为 alertdialog（要求立即确认的破坏性动作）
      role="alertdialog"
      // 模态属实性由 showModal() 保证；显式标注让语义在静态渲染与无 JS 阅读器下同样成立
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy}
      // 容器本身可被程序聚焦（tabindex=-1 不进入 Tab 顺序）：提交中的焦点落点
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') handleCloseRequest(event);
      }}
      onCancel={handleCloseRequest}
    >
      <p className="state__title" id={titleId}>
        {title}
      </p>
      <p className="muted" id={descriptionId}>
        {description}
      </p>
      <div className="confirm__actions">
        <button
          type="button"
          ref={confirmRef}
          onClick={onConfirm}
          disabled={busy}
          // 主操作排在前面：Tab 顺序与阅读顺序一致（确认 → 取消），也是打开时的初始焦点
          autoFocus
        >
          {busy ? busyLabel : confirmLabel}
        </button>
        <button type="button" className="button--secondary" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </dialog>
  );
}
