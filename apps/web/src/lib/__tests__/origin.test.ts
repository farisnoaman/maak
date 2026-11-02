import { describe, expect, it } from 'vitest';
import { isSameOriginRequest, resolveRequest } from '../origin';

/**
 * The CSRF check, which is the only thing standing between a cross-site form post and a signed-in session.
 *
 * Two of these cases were passing for the wrong reason and one was failing outright: an `Origin` from another site
 * was accepted whenever the server could only see a loopback `Host` — which is every request on a development server
 * and on the preview proxy. A form on `https://evil.example` could therefore create an account, or sign a visitor in
 * to the attacker's, because "every host I know is loopback" was treated as "I cannot tell".
 */
function request(headers: Record<string, string>): { headers: Headers } {
  return { headers: new Headers(headers) };
}

describe('isSameOriginRequest', () => {
  it('accepts a form post from the same host', () => {
    expect(
      isSameOriginRequest(
        request({
          host: 'maak.test',
          origin: 'https://maak.test',
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toBe(true);
  });

  it('accepts a post from a host the proxy forwards', () => {
    expect(
      isSameOriginRequest(
        request({
          host: '127.0.0.1:3000',
          'x-forwarded-host': '3000-abc.e2b.app',
          origin: 'https://3000-abc.e2b.app',
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toBe(true);
  });

  it('rejects a cross-site post even when every host it can see is loopback', () => {
    expect(
      isSameOriginRequest(
        request({
          host: '127.0.0.1:3000',
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        }),
      ),
    ).toBe(false);
  });

  it('trusts the fetch metadata when a proxy hides our own host', () => {
    // The preview proxy: `Host` is the internal address, the browser knows better, and it says so.
    expect(
      isSameOriginRequest(
        request({
          host: '0.0.0.0:3000',
          origin: 'https://3000-abc.e2b.app',
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toBe(true);
  });

  it('still allows a legacy browser with no fetch metadata under a loopback host, and warns', () => {
    // Documented residual risk, not an accident: Safari < 16.4 sends no `Sec-Fetch-Site`, and refusing here would
    // break sign-in behind any proxy that rewrites `Host`. The branch logs.
    expect(
      isSameOriginRequest(request({ host: '127.0.0.1:3000', origin: 'https://evil.example' })),
    ).toBe(true);
  });

  it('accepts a request with no origin at all — a navigation or a server-to-server call', () => {
    expect(isSameOriginRequest(request({ host: 'maak.test' }))).toBe(true);
  });
});

describe('resolveRequest', () => {
  it('takes the scheme and host from the browser, not from the internal proxy address', () => {
    const context = resolveRequest(
      request({ host: '127.0.0.1:3000', origin: 'https://3000-abc.e2b.app' }),
    );
    expect(context.origin).toBe('https://3000-abc.e2b.app');
    expect(context.evidence).toBe('origin');
  });

  it('falls back to the forwarded host when there is no origin (a bookmark, a typed URL)', () => {
    const context = resolveRequest(
      request({ host: '127.0.0.1:3000', 'x-forwarded-host': '3000-abc.e2b.app' }),
    );
    expect(context.origin).toBe('https://3000-abc.e2b.app');
    expect(context.evidence).toBe('forwarded');
  });
});
