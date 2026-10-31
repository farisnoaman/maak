import type { InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly trailing?: ReactNode;
}

/**
 * Label + input + error wiring in one component, so accessibility cannot be forgotten
 * per screen: `htmlFor`/`id` are generated, the error is announced via `aria-describedby`
 * and `aria-invalid`, and the hint is linked too.
 */
export function Field({ label, hint, error, trailing, className = '', ...rest }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={`ui-field ${className}`}>
      <label className="ui-field__label" htmlFor={id}>
        {label}
        {rest.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <div className="ui-field__control">
        <input
          id={id}
          className="ui-input"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...rest}
        />
        {trailing}
      </div>
      {hint ? (
        <p className="ui-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="ui-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
