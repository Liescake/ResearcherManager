import type { ReactNode } from 'react';

/**
 * 页面级与区块级的**版式骨架**（纯结构、无状态）。
 *
 * 为什么单独抽出来：此前每个页面各写一份 `page__header` / `card` + `h2` + 说明，
 * 标题层级、说明文字的位置与「区块右上角的操作」在不同页面里各不相同。
 * 统一成两个组件后：
 * - 标题层级固定：页面只有一个 `h1`（`PageHeader`），区块一律 `h2`（`SectionCard`）；
 * - 区块必有可访问名称：`section[aria-labelledby]` 指向自己的 `h2`；
 * - 操作位固定在标题右侧（窄屏下换行到标题下方），使用者不必在每页重新寻找「刷新」在哪里。
 *
 * 视觉完全由 `app.css` 决定；替换视觉设计不需要改动这里的结构。
 */
export interface PageHeaderProps {
  readonly title: string;
  /** 一句话说明本页的数据来源与边界（可含行内 `code`） */
  readonly description?: ReactNode;
  /** 标题右侧的页面级操作（如刷新） */
  readonly actions?: ReactNode;
  /** 标题下方的补充信息（如标签） */
  readonly meta?: ReactNode;
}

export function PageHeader({ title, description, actions, meta }: PageHeaderProps): ReactNode {
  return (
    <header className="page__header">
      <div className="page__heading">
        <h1>{title}</h1>
        {description !== undefined && <p className="page__lead">{description}</p>}
        {meta !== undefined && <div className="page__meta">{meta}</div>}
      </div>
      {actions !== undefined && <div className="page__actions">{actions}</div>}
    </header>
  );
}

export interface SectionCardProps {
  /** 区块 id 前缀：标题元素的 id 为 `${id}-title` */
  readonly id: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  /** 追加的修饰类（如 `card--muted`） */
  readonly className?: string;
  readonly children?: ReactNode;
}

export function SectionCard({
  id,
  title,
  description,
  actions,
  className,
  children,
}: SectionCardProps): ReactNode {
  const titleId = `${id}-title`;
  return (
    <section
      className={className === undefined ? 'card' : `card ${className}`}
      aria-labelledby={titleId}
    >
      <div className="card__header">
        <div className="card__heading">
          <h2 id={titleId}>{title}</h2>
          {description !== undefined && <p className="card__desc">{description}</p>}
        </div>
        {actions !== undefined && <div className="card__actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
