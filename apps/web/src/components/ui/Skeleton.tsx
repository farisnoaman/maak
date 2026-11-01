/**
 * A loading placeholder.
 *
 * The inbox and the template preview are server-rendered against a database that can take a moment, so the
 * route segment streams a skeleton rather than a blank panel. It is deliberately dumb: three grey bars with
 * no text, `aria-busy`, and nothing announced — a screen reader should hear the content once, not the wait.
 */
export function Skeleton({ rows = 3, label }: { readonly rows?: number; readonly label: string }) {
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton__row">
          <span className="skeleton__bar skeleton__bar--wide" />
          <span className="skeleton__bar skeleton__bar--narrow" />
        </div>
      ))}
    </div>
  );
}
