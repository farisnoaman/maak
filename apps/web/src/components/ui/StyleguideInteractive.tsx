'use client';

import { useState } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { useToast } from './Toast';

/**
 * Client-side half of the styleguide: dialog + toast need interaction to review.
 * Copy is passed in, so this component stays free of hardcoded strings (BR-43).
 */
export function StyleguideInteractive({
  dialogTitle,
  dialogBody,
  openLabel,
  closeLabel,
  toastLabel,
  toastTitle,
  toastDescription,
}: {
  readonly dialogTitle: string;
  readonly dialogBody: string;
  readonly openLabel: string;
  readonly closeLabel: string;
  readonly toastLabel: string;
  readonly toastTitle: string;
  readonly toastDescription: string;
}) {
  const [open, setOpen] = useState(false);
  const { push } = useToast();

  return (
    <section aria-labelledby="sg-dialog" className="section">
      <h2 id="sg-dialog">{dialogTitle}</h2>
      <div className="sg-row">
        <Button onClick={() => setOpen(true)}>{openLabel}</Button>
        <Button
          variant="ghost"
          onClick={() =>
            push({ title: toastTitle, description: toastDescription, tone: 'success' })
          }
        >
          {toastLabel}
        </Button>
      </div>

      <Dialog
        open={open}
        title={dialogTitle}
        onClose={() => setOpen(false)}
        closeLabel={closeLabel}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {closeLabel}
            </Button>
            <Button onClick={() => setOpen(false)}>{closeLabel}</Button>
          </>
        }
      >
        <p>{dialogBody}</p>
      </Dialog>
    </section>
  );
}
