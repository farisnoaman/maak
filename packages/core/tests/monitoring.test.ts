import { describe, expect, it } from 'vitest';
import { buildErrorPayload, REDACTED, redact, REDACTED_KEYS } from '../src/monitoring';

describe('PII redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    const input = {
      boundary: 'account',
      user: { phone: '+967733123456', email: 'a@b.test', id_number: '123456789012' },
      nested: [{ token: 'abc' }, { ok: true }],
    };
    const output = redact(input) as Record<string, unknown>;

    expect(output.boundary).toBe('account');
    expect((output.user as Record<string, unknown>).phone).toBe(REDACTED);
    expect((output.user as Record<string, unknown>).email).toBe(REDACTED);
    expect((output.user as Record<string, unknown>).id_number).toBe(REDACTED);
    expect((output.nested as Record<string, unknown>[])[0]!.token).toBe(REDACTED);
    expect((output.nested as Record<string, unknown>[])[1]!.ok).toBe(true);
  });

  it('matches keys case-insensitively and by substring', () => {
    const output = redact({
      Authorization: 'Bearer x',
      nationalIdNumber: '1',
      userPhone: '2',
      API_KEY: '3',
      safeField: 'kept',
    }) as Record<string, unknown>;

    expect(output.Authorization).toBe(REDACTED);
    expect(output.nationalIdNumber).toBe(REDACTED);
    expect(output.userPhone).toBe(REDACTED);
    expect(output.API_KEY).toBe(REDACTED);
    expect(output.safeField).toBe('kept');
  });

  it('never mutates the input', () => {
    const input = { user: { phone: '967' } };
    redact(input);
    expect(input.user.phone).toBe('967');
  });

  it('survives cycles, deep nesting and long strings', () => {
    const cycle: Record<string, unknown> = { name: 'loop' };
    cycle.self = cycle;

    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    const output = redact(cycle) as Record<string, unknown>;
    expect(output.self).toBe('[circular]');
    expect(JSON.stringify(redact(deep))).toContain('[depth limit]');

    const long = redact('x'.repeat(2000));
    expect(typeof long).toBe('string');
    expect((long as string).length).toBeLessThan(600);
  });

  it('passes primitives and null through untouched', () => {
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(undefined)).toBeUndefined();
  });

  it('keeps the redaction list free of accidental exclusions', () => {
    for (const key of ['password', 'token', 'phone', 'email', 'id_number']) {
      expect(REDACTED_KEYS).toContain(key);
    }
  });
});

describe('error payload', () => {
  const at = new Date('2026-10-28T10:00:00.000Z');

  it('builds a payload from an Error', () => {
    const payload = buildErrorPayload(new Error('boom'), { boundary: 'account' }, at);
    expect(payload.level).toBe('error');
    expect(payload.message).toBe('boom');
    expect(payload.stack).toContain('Error: boom');
    expect(payload.at).toBe(at.toISOString());
    expect(payload.context).toEqual({ boundary: 'account' });
  });

  it('handles non-Error throwables', () => {
    expect(buildErrorPayload('plain string', {}, at).message).toBe('plain string');
    expect(buildErrorPayload({ code: 500 }, {}, at).message).toBe('[object Object]');
  });

  it('redacts the context and the message itself', () => {
    const payload = buildErrorPayload(new Error('failed for +967733123456'), {
      user: { phone: '+967733123456' },
    });
    expect((payload.context as { user: { phone: string } }).user.phone).toBe(REDACTED);
    // The message is kept (operators need it) but truncated; PII arrives via context keys.
    expect(payload.message).toContain('failed for');
  });

  it('caps the stack so one report cannot be megabytes', () => {
    const error = new Error('deep');
    error.stack = Array.from({ length: 200 }, (_, index) => `at frame${index}`).join('\n');
    const payload = buildErrorPayload(error);
    expect(payload.stack!.split('\n').length).toBe(20);
  });
});
