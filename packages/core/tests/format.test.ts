import { describe, expect, it } from 'vitest';
import { money } from '../src/domain/money';
import {
  APP_TIMEZONE,
  bidiIsolate,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPhone,
  formatRelative,
} from '../src/format';

const arOpts = { locale: 'ar' as const };
const enOpts = { locale: 'en' as const };

describe('numbers', () => {
  it('formats with western digits by default in both locales', () => {
    expect(formatNumber(1500, arOpts)).toContain('1');
    expect(formatNumber(1500, enOpts)).toContain('1,500');
  });

  it('supports Arabic-Indic numerals as an opt-in preference', () => {
    const arabic = formatNumber(1500, { locale: 'ar', numerals: 'arabic_indic' });
    expect(arabic).not.toBe(formatNumber(1500, arOpts));
  });
});

describe('money', () => {
  it('places the currency per locale', () => {
    expect(formatMoney(money(1500), arOpts)).toBe('1,500 ر.ي');
    expect(formatMoney(money(1500), enOpts)).toBe('YER 1,500');
  });

  it('handles two-decimal currencies', () => {
    expect(formatMoney(money(1001, 'USD'), enOpts)).toBe('USD 10.01');
  });

  it('always pairs an amount with a currency', () => {
    expect(formatMoney(money(0), arOpts)).toMatch(/ر\.ي/);
  });
});

describe('dates', () => {
  const iso = '2026-11-05T06:30:00.000Z';

  it('formats in Asia/Aden, not the server timezone', () => {
    expect(APP_TIMEZONE).toBe('Asia/Aden');
    const formatted = formatDateTime(iso, arOpts);
    // 06:30 UTC is 09:30 in Aden (UTC+3)
    expect(formatted).toMatch(/9:30|٠٩:٣٠|09:30/);
  });

  it('returns an em dash for invalid input instead of "Invalid Date"', () => {
    expect(formatDateTime('not-a-date', enOpts)).toBe('—');
    expect(formatDate('not-a-date', arOpts)).toBe('—');
  });
});

describe('phone and bidi', () => {
  it('formats Yemeni mobiles consistently', () => {
    expect(formatPhone('+967771234567')).toBe('+967 771 234 567');
    expect(formatPhone('771234567')).toBe('+967 771 234 567');
  });

  it('leaves unrecognised numbers untouched rather than mangling them', () => {
    expect(formatPhone('+1 555 0100')).toBe('+1 555 0100');
  });

  it('wraps mixed-direction strings in isolates', () => {
    expect(bidiIsolate('MK-2026-000123')).toBe('\u2068MK-2026-000123\u2069');
  });
});

describe('relative time', () => {
  const now = new Date('2026-11-05T09:00:00.000Z');

  it('speaks the viewer language', () => {
    expect(formatRelative('2026-11-05T09:20:00.000Z', now, enOpts)).toMatch(/20 minutes/);
    expect(formatRelative('2026-11-05T09:20:00.000Z', now, arOpts)).not.toMatch(/minutes/);
  });

  it('switches to hours and days', () => {
    expect(formatRelative('2026-11-05T12:00:00.000Z', now, enOpts)).toMatch(/3 hours/);
    expect(formatRelative('2026-11-07T09:00:00.000Z', now, enOpts)).toMatch(/2 days/);
  });
});
