import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  dir,
  interpolate,
  isLocale,
  negotiateLocale,
  type Locale,
} from '../src/i18n/locale';
import { ar, dictionaries, en, keyParity, translate } from '../src/i18n/dictionaries';

describe('locale handling', () => {
  it('defaults to Arabic and knows both directions', () => {
    expect(DEFAULT_LOCALE).toBe('ar');
    expect(dir('ar')).toBe('rtl');
    expect(dir('en')).toBe('ltr');
  });

  it('validates locale tags', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it('prefers an explicit profile preference', () => {
    expect(negotiateLocale('en-US,en;q=0.9', 'ar')).toBe('ar');
    expect(negotiateLocale('ar-YE,ar;q=0.9', 'en')).toBe('en');
  });

  it('falls back to the Accept-Language header', () => {
    expect(negotiateLocale('ar-YE,ar;q=0.9,en;q=0.8')).toBe('ar');
    expect(negotiateLocale('en-GB,en;q=0.9')).toBe('en');
    expect(negotiateLocale(null)).toBe('ar');
    expect(negotiateLocale('fr-FR')).toBe('ar');
  });
});

describe('interpolation', () => {
  it('replaces named variables', () => {
    expect(interpolate('{count} seats left', { count: 3 })).toBe('3 seats left');
  });

  it('leaves unknown placeholders visible instead of printing undefined', () => {
    expect(interpolate('{count} seats', {})).toBe('{count} seats');
  });

  it('does not treat inherited prototype keys as variables', () => {
    expect(interpolate('{constructor}', {})).toBe('{constructor}');
  });
});

describe('dictionary parity (BR-43)', () => {
  it('has the same keys in both locales', () => {
    expect(keyParity()).toEqual({ missingInEn: [], missingInAr: [] });
  });

  it('has no empty translations', () => {
    for (const locale of ['ar', 'en'] as Locale[]) {
      for (const [key, value] of Object.entries(dictionaries[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('translates the same key differently per locale where it matters', () => {
    expect(translate('ar', 'common.appName')).toBe('معك');
    expect(translate('en', 'common.appName')).toBe('Maak');
    expect(translate('ar', 'calc.total')).not.toBe(translate('en', 'calc.total'));
  });

  it('interpolates through translate', () => {
    expect(translate('en', 'calc.title', {})).toBe(en['calc.title']);
    expect(ar['errors.NOT_VERIFIED']).toContain('موثّق');
  });

  it('falls back to the key when a key is somehow missing at runtime', () => {
    const key = 'not.a.real.key' as keyof typeof ar;
    expect(translate('en', key)).toBe('not.a.real.key');
  });
});
