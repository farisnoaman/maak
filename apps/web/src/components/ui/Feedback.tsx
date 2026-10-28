import type { ReactNode } from 'react';

/** Loading placeholder with a fixed aspect so content does not jump (CLS). */
export function Skeleton({
  width = '100%',
  height = 16,
  radius = 'var(--radius-sm)',
  label,
}: {
  readonly width?: number | string;
  readonly height?: number | string;
  readonly radius?: string;
  readonly label?: string;
}) {
  return (
    <div
      className="ui-skeleton"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ inlineSize: width, blockSize: height, borderRadius: radius }}
    />
  );
}

/** Empty states always carry a next action; a dead end is a product bug. */
export function EmptyState({
  title,
  description,
  action,
  icon = '◇',
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly icon?: string;
}) {
  return (
    <div className="ui-empty">
      <div className="ui-empty__icon" aria-hidden="true">
        {icon}
      </div>
      <h3 className="ui-empty__title">{title}</h3>
      {description ? <p className="ui-empty__desc">{description}</p> : null}
      {action ? <div className="ui-empty__action">{action}</div> : null}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`ui-badge ui-badge--${tone}`}>{children}</span>;
}
