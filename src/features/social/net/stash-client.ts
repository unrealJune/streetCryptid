/**
 * Client for the trail stash control API (https://github.com/unrealJune/trail-stash). Grants the
 * stash opt-in replication of a trail namespace by presenting its read-ticket, and (optionally)
 * subscribes this device's push token so the stash can wake it when a friend posts. The stash is
 * ciphertext-blind: presenting a read-ticket only grants *replication* of already-sealed envelopes,
 * never decryption.
 *
 * All calls are best-effort — a failure only means offline delivery is degraded, never that the
 * live path or peer-only reconciliation breaks. Mirrors the pairing-mailbox client conventions.
 */

import { getStashConfig, type StashConfig } from 'iroh-location';

const DEFAULT_TIMEOUT_MS = 10_000;

export type StashPlatform = 'apns' | 'fcm';

/** A namespace grant: the trail read-ticket, plus optionally a device push token to be woken. */
export interface StashRegistration {
  readTicket: string;
  pushToken?: string | null;
  platform?: StashPlatform | null;
}

export class StashClientError extends Error {}

/** Pluggable stash transport — swap a fake in for tests. */
export interface StashClient {
  /** Whether a stash is configured (deployment provides one). */
  readonly configured: boolean;
  /** Grant replication of a namespace (`POST /v1/namespaces`); idempotent server-side. */
  registerNamespace(reg: StashRegistration): Promise<void>;
  /** Drop this device's wake subscription for a namespace (`DELETE …/subscription`). */
  unsubscribe(
    namespaceId: string,
    sub: { pushToken: string; platform: StashPlatform }
  ): Promise<void>;
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
    const body: Record<string, string> = { read_ticket: reg.readTicket };
    // push token + platform must be sent together or not at all (server rejects a partial pair).
    if (reg.pushToken && reg.platform) {
      body.push_token = reg.pushToken;
      body.platform = reg.platform;
    }
    const res = await this.request('POST', '/v1/namespaces', JSON.stringify(body));
    if (res.status === 201) return;
    throw this.failureFor('registerNamespace', res.status);
  }

  async unsubscribe(
    namespaceId: string,
    sub: { pushToken: string; platform: StashPlatform }
  ): Promise<void> {
    const res = await this.request(
      'DELETE',
      `/v1/namespaces/${namespaceId}/subscription`,
      JSON.stringify({ push_token: sub.pushToken, platform: sub.platform })
    );
    // 204 (removed) and 404-shaped idempotency are both "gone"; the server returns 204 regardless.
    if (res.status === 204 || res.status === 200) return;
    throw this.failureFor('unsubscribe', res.status);
  }

  private async request(method: 'POST' | 'DELETE', path: string, body: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.psk) headers.Authorization = `Bearer ${this.config.psk}`;
    try {
      return await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw new StashClientError('trail stash: request timed out');
      throw new StashClientError(`trail stash: request failed (${errorMessage(err)})`);
    } finally {
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
  async unsubscribe(
    _namespaceId: string,
    _sub: { pushToken: string; platform: StashPlatform }
  ): Promise<void> {}
}

/**
 * Build the default stash client from the environment: an {@link HttpStashClient} when a stash is
 * configured, otherwise a {@link NoopStashClient} so callers never need a null check.
 */
export function createDefaultStashClient(): StashClient {
  const config = getStashConfig();
  return config ? new HttpStashClient(config) : new NoopStashClient();
}
