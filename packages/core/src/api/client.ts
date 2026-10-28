/**
 * The single client every surface uses to reach the write gateway.
 *
 * Deliberately transport-agnostic: `fetch` lives in the apps (web/mobile), so this module stays
 * framework-free and unit-testable. The client guarantees three things:
 *   1. a typed, Zod-validated request per command
 *   2. an `Idempotency-Key` on every mutating call (double-tap and retry safe)
 *   3. errors normalised into the shared contract, never thrown raw
 */

import { fail, ok, toApiFailure, type Result } from './errors';

export interface TransportRequest {
  readonly method: 'POST';
  readonly path: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export interface TransportResponse {
  readonly status: number;
  readonly body: unknown;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export type TokenProvider = () => Promise<string | null>;

export interface Validator<T> {
  parse: (input: unknown) => T;
}

export interface CommandSpec<Input, Output> {
  /** Path segment under `/functions/v1/`, e.g. `trips-create`. */
  readonly path: string;
  readonly input: Validator<Input>;
  readonly output: Validator<Output>;
  /** Mutations get an idempotency key and are never cached. */
  readonly mutating: boolean;
}

export interface ApiClientOptions {
  readonly transport: Transport;
  readonly getToken: TokenProvider;
  /** Prefix of the functions host, e.g. `https://xyz.supabase.co/functions/v1`. */
  readonly baseUrl: string;
  readonly clientVersion?: string;
  /** Injectable so tests are deterministic. */
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export class ApiClient {
  private readonly opts: ApiClientOptions;

  constructor(options: ApiClientOptions) {
    this.opts = options;
  }

  async call<Input, Output>(
    spec: CommandSpec<Input, Output>,
    input: Input,
  ): Promise<Result<Output>> {
    // Validate on the way out: a client bug surfaces as a typed validation error, not a 400 from prod.
    let parsedInput: Input;
    try {
      parsedInput = spec.input.parse(input);
    } catch (error) {
      return fail({
        code: 'VALIDATION_FAILED',
        detail: error instanceof Error ? error.message : 'invalid input',
      });
    }

    const token = await this.opts.getToken();
    if (!token && spec.mutating) return fail({ code: 'UNAUTHENTICATED' });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Maak-Client': this.opts.clientVersion ?? 'unknown',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (spec.mutating) {
      headers['Idempotency-Key'] = (this.opts.idFactory ?? defaultIdFactory)();
    }

    let response: TransportResponse;
    try {
      response = await this.opts.transport({
        method: 'POST',
        path: `${this.opts.baseUrl}/${spec.path}`,
        body: parsedInput,
        headers,
      });
    } catch (error) {
      return fail(toApiFailure(error));
    }

    if (response.status >= 200 && response.status < 300) {
      try {
        return ok(spec.output.parse(response.body));
      } catch (error) {
        // A response that fails its own schema is a server bug; never pass it to the UI.
        return fail({
          code: 'INTERNAL',
          detail: error instanceof Error ? error.message : 'invalid response',
        });
      }
    }

    const failure = toApiFailure(response.body);
    return fail({
      ...failure,
      code: failure.code === 'INTERNAL' && response.status === 429 ? 'RATE_LIMITED' : failure.code,
    });
  }
}

/** RFC 4122 v4-ish identifier; `crypto.randomUUID` when available. */
export function defaultIdFactory(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `idem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
