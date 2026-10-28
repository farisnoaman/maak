import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly iconStart?: ReactNode;
  readonly iconEnd?: ReactNode;
  readonly fullWidth?: boolean;
}

/**
 * The only button in the app. Variants are semantic, never colour-coded ad hoc,
 * so a design change happens in CSS and nowhere else.
 * `aria-busy` + disabled during loading prevents double submission of money actions.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  iconStart,
  iconEnd,
  fullWidth = false,
  className = '',
  disabled,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    'ui-btn',
    `ui-btn--${variant}`,
    `ui-btn--${size}`,
    fullWidth ? 'ui-btn--block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {iconStart ? (
        <span className="ui-btn__icon" aria-hidden="true">
          {iconStart}
        </span>
      ) : null}
      <span>{children}</span>
      {iconEnd ? (
        <span className="ui-btn__icon" aria-hidden="true">
          {iconEnd}
        </span>
      ) : null}
    </button>
  );
}
