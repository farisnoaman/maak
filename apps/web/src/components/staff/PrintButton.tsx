'use client';

/** Printing is the deliverable, so it gets a real button instead of "use your browser menu". */
export function PrintButton({ label }: { readonly label: string }) {
  return (
    <button type="button" className="btn btn--primary" onClick={() => window.print()}>
      {label}
    </button>
  );
}
