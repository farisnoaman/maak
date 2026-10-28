/**
 * Typed i18n with compile-time key safety.
 *
 * - `ar` and `en` are the sources of truth; both must define the same keys (a test asserts this).
 * - Keys are dotted paths into a flat dictionary so a missing key is a type error, not a blank screen.
 * - Arabic is the default locale; every string exists in both (specs.md BR-43).
 */

export type Locale = 'ar' | 'en';

export const LOCALES: readonly Locale[] = ['ar', 'en'] as const;
export const DEFAULT_LOCALE: Locale = 'ar';

export const DIRECTION: Record<Locale, 'rtl' | 'ltr'> = { ar: 'rtl', en: 'ltr' };

export const LOCALE_LABEL: Record<Locale, string> = { ar: 'العربية', en: 'English' };

export function dir(locale: Locale): 'rtl' | 'ltr' {
  return DIRECTION[locale];
}

export function isLocale(value: unknown): value is Locale {
  return value === 'ar' || value === 'en';
}

/** Resolves the best locale from an Accept-Language header or an explicit hint. */
export function negotiateLocale(
  acceptLanguage: string | null | undefined,
  preferred?: string | null,
): Locale {
  if (isLocale(preferred)) return preferred;
  if (!acceptLanguage) return DEFAULT_LOCALE;
  for (const part of acceptLanguage.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase();
    if (!tag) continue;
    if (tag.startsWith('ar')) return 'ar';
    if (tag.startsWith('en')) return 'en';
  }
  return DEFAULT_LOCALE;
}

export type Vars = Record<string, string | number>;

/**
 * Interpolates `{name}` placeholders. Missing variables are left untouched
 * (visible in QA) rather than silently rendering `undefined`.
 */
export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : match,
  );
}
