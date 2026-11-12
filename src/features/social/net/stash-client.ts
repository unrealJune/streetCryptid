/**
 * Client for the trail stash control API (https://github.com/unrealJune/trail-stash). Grants the
 * stash opt-in replication of a trail namespace by presenting its read-ticket. The stash is
 * ciphertext-blind: presenting a read-ticket only grants *replication* of already-sealed envelopes,
 * never decryption.
 *
 * **Device push tokens are deliberately never sent** (ARCHITECTURE.md §10). The stash's wake API
 * still exists server-side, but registering a token against namespaces let the operator identify
 * which namespace was ours — under bilateral pairing your token appeared against every friend's
 * namespace and never your own, so the gap named you. Registration is now a read-ticket and
 * nothing else.
 *
 * All calls are best-effort — a failure only means offline delivery is degraded, never that live
 * sync or peer-only reconciliation breaks. Mirrors the pairing-mailbox client conventions.
 */

import { getStashConfig, type StashConfig } from 'iroh-location';

import { getTelemetry, traceparentFor } from '@/features/dev/telemetry';

const DEFAULT_TIMEOUT_MS = 10_000;

/** A namespace grant: the trail read-ticket, and nothing that identifies this device. */
export interface StashRegistration {
  readTicket: string;
}

export class StashClientError extends Error {}

/** Pluggable stash transport — swap a fake in for tests. */
export interface StashClient {
  /** Whether a stash is configured (deployment provides one). */
  readonly configured: boolean;
  /** Grant replication of a namespace (`POST /v1/namespaces`); idempotent server-side. */
  registerNamespace(reg: StashRegistration): Promise<void>;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** HTTP implementation targeting a configured stash. */
export class HttpStashClient implements StashClient {
  private readonly config: StashConfig;
  private readonly timeoutMs: number;

  constructor(config: StashConfig, options: { timeoutMs?: number } = {}) {
    this.config = config;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get configured(): boolean {
    return true;
  }

  async registerNamespace(reg: StashRegistration): Promise<void> {
    // Read ticket only — the `push_token` / `platform` fields the server still accepts are
    // deliberately never populated. See the module header.
    const body: Record<string, string> = { read_ticket: reg.readTicket };
    const res = await this.request('POST', '/v1/namespaces', JSON.stringify(body));
    if (res.status === 201) return;
    throw this.failureFor('registerNamespace', res.status);
  }

  private async request(method: 'POST', path: string, body: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.psk) headers.Authorization = `Bearer ${this.config.psk}`;
    // Dev telemetry: send our span as `traceparent` so the stash's http.request span parents on
    // it and the whole control-API exchange reads as one trace in Tempo.
    const telemetry = getTelemetry();
    const span = telemetry.startSpan('stash.request', {
      attributes: { 'http.request.method': method, 'url.path': path },
    });
    if (telemetry.enabled) headers.traceparent = traceparentFor(span.context);
    try {
      const res = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      span.setAttribute('http.response.status_code', res.status);
      span.setStatus(res.status < 400 ? 'ok' : 'error');
      return res;
    } catch (err) {
      span.recordError(err);
      if (isAbortError(err)) throw new StashClientError('trail stash: request timed out');
      throw new StashClientError(`trail stash: request failed (${errorMessage(err)})`);
    } finally {
      span.end();
      clearTimeout(timer);
    }
  }

  private failureFor(op: string, status: number): StashClientError {
    if (status === 401) return new StashClientError(`trail stash: ${op} unauthorized (bad PSK)`);
    return new StashClientError(`trail stash: ${op} failed (${status})`);
  }
}

/** A stash client for a deployment without a stash — every call is a no-op. */
export class NoopStashClient implements StashClient {
  readonly configured = false;
  async registerNamespace(_reg: StashRegistration): Promise<void> {}
}

/**
 * Build the default stash client from the environment: an {@link HttpStashClient} when a stash is
 * configured, otherwise a {@link NoopStashClient} so callers never need a null check.
 */
export function createDefaultStashClient(): StashClient {
  const config = getStashConfig();
  return config ? new HttpStashClient(config) : new NoopStashClient();
}
