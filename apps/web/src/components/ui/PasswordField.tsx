'use client';

import { useState } from 'react';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import { Field, type FieldProps } from './Field';

/**
 * A password input with a way to read what you typed.
 *
 * Typing a long password on a phone keyboard, blind, is the single most common reason a sign-in fails on the first
 * attempt — and the recovery is "type it again, slower". The whole feature is one attribute, so it is worth having on
 * every password field in the app.
 *
 * Progressive enhancement, not a requirement: the input works and submits without JavaScript; only the toggle needs
 * the client. `aria-pressed` tells a screen reader the state, and the label changes with it, so the button never
 * announces itself as "Show" while it is showing.
 */
export function PasswordField({
  locale,
  ...rest
}: Omit<FieldProps, 'type' | 'trailing'> & { readonly locale: Locale }) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [shown, setShown] = useState(false);

  return (
    <Field
      {...rest}
      type={shown ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          className="ui-field__reveal"
          aria-pressed={shown}
          onClick={() => setShown((value) => !value)}
        >
          {shown ? t('auth.hidePassword') : t('auth.showPassword')}
        </button>
      }
    />
  );
}
