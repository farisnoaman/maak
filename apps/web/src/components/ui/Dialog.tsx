'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export interface DialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly closeLabel: string;
}

/**
 * Built on the native `<dialog>` element: focus trapping, Escape handling, inert background
 * and screen-reader semantics come from the browser instead of a 40 KB dependency.
 */
export function Dialog({ open, title, onClose, children, footer, closeLabel }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const handleClose = () => onClose();
    element.addEventListener('close', handleClose);
    return () => element.removeEventListener('close', handleClose);
  }, [onClose]);

  return (
    <dialog ref={ref} className="ui-dialog" aria-labelledby="ui-dialog-title">
      <div className="ui-dialog__head">
        <h2 className="ui-dialog__title" id="ui-dialog-title">
          {title}
        </h2>
        <button
          type="button"
          className="ui-dialog__close"
          onClick={onClose}
          aria-label={closeLabel}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className="ui-dialog__body">{children}</div>
      {footer ? <div className="ui-dialog__footer">{footer}</div> : null}
    </dialog>
  );
}
