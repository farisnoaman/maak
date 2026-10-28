/**
 * Locale-aware formatting. Every number, price and date shown to a user goes through here,
 * so Arabic-Indic digits, currency placement and timezone handling are decided in one place
 * (specs.md BR-45).
 */

import { CURRENCIES, type CurrencyCode, type Money, toMajor } from './domain/money';
import type { Locale } from './i18n/locale';

export const APP_TIMEZONE = 'Asia/Aden';

/** Input mask for Yemeni mobiles — a format, not translatable copy. */
export const PHONE_PLACEHOLDER = '+967 7XX XXX XXX';

export type Numerals = 'western' | 'arabic_indic';

export interface FormatOptions {
  readonly locale: Locale;
  readonly numerals?: Numerals;
  readonly timezone?: string;
}

function intlLocale(locale: Locale, numerals: Numerals): string {
  // `ar-YE-u-nu-latn` keeps Latin digits; plain `ar-YE` gives Arabic-Indic.
  if (locale === 'ar') return numerals === 'arabic_indic' ? 'ar-YE' : 'ar-YE-u-nu-latn';
  return 'en-US';
}

export function formatNumber(value: number, opts: FormatOptions): string {
  return new Intl.NumberFormat(intlLocale(opts.locale, opts.numerals ?? 'western'), {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

/** `1,500 ر.ي` in Arabic, `YER 1,500` in English. Always currency-annotated. */
export function formatMoney(amount: Money, opts: FormatOptions): string {
  const n = formatNumber(toMajor(amount), opts);
  const { symbolAr, symbolEn } = CURRENCIES[amount.currency];
  return opts.locale === 'ar' ? `${n} ${symbolAr}` : `${symbolEn} ${n}`;
}

export function formatMinor(
  amountMinor: number,
  currency: CurrencyCode,
  opts: FormatOptions,
): string {
  return formatMoney({ amountMinor, currency }, opts);
}

const DATE_TIME: Intl.DateTimeFormatOptions = {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: APP_TIMEZONE,
};

export function formatDateTime(iso: string | Date, opts: FormatOptions): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(opts.locale, opts.numerals ?? 'western'), {
    ...DATE_TIME,
    timeZone: opts.timezone ?? APP_TIMEZONE,
  }).format(date);
}

export function formatDate(iso: string | Date, opts: FormatOptions): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(opts.locale, opts.numerals ?? 'western'), {
    dateStyle: 'medium',
    timeZone: opts.timezone ?? APP_TIMEZONE,
  }).format(date);
}

/** Yemeni mobile numbers: `+967 7XX XXX XXX`. */
export function formatPhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  const local = digits.startsWith('+967') ? digits.slice(4) : digits.replace(/^967/, '');
  if (!/^7\d{8}$/.test(local)) return raw;
  return `+967 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
}

/**
 * Wraps mixed-direction strings (plates, codes, phone numbers) so they render
 * correctly inside Arabic text. Components use this, never raw interpolation.
 */
export function bidiIsolate(value: string): string {
  return `\u2068${value}\u2069`;
}

/** Relative time in the viewer's language, for "last updated" style labels. */
export function formatRelative(then: string | Date, now: Date, opts: FormatOptions): string {
  const target = typeof then === 'string' ? new Date(then) : then;
  const diffMs = target.getTime() - now.getTime();
  const minutes = Math.round(diffMs / 60_000);
  const rtf = new Intl.RelativeTimeFormat(intlLocale(opts.locale, opts.numerals ?? 'western'), {
    numeric: 'auto',
  });
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}
