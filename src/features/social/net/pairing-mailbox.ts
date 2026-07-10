/**
 * Client for the blind pairing mailbox: a one-time, short-lived KV that hands an already-sealed
 * capsule from one device to another. The mailbox is deliberately blind — it never sees
 * plaintext, keys, or the human code, only a random lookup id and opaque capsule bytes. See
 * `core/pairing-code.ts` for the seal/open logic.
 */

/** Server-enforced TTL bounds (seconds); `PUT` clamps into this range. */
export const MAILBOX_MIN_TTL_SECONDS = 60;
export const MAILBOX_MAX_TTL_SECONDS = 900;

const LOOKUP_ID_RE = /^[0-9a-f]{32}$/;
const DEFAULT_TIMEOUT_MS = 10_000;

export class PairingMailboxError extends Error {}

/** No mailbox base URL is configured (`EXPO_PUBLIC_PAIR_MAILBOX_URL` unset). */
export class PairingMailboxNotConfiguredError extends PairingMailboxError {}

/** `404` — the lookup id has no live entry (never existed, already burned, or expired). */
export class PairingMailboxNotFoundError extends PairingMailboxError {}

/** `409` — a live entry already occupies that lookup id (PUT never overwrites). */
export class PairingMailboxConflictError extends PairingMailboxError {}

/** `429` — per-IP rate limit exceeded. `retryAfterSeconds` is the server's `Retry-After`, if sent. */
export class PairingMailboxRateLimitedError extends PairingMailboxError {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null
  ) {
    super(message);
  }
}

/** An unexpected non-2xx response (e.g. `5xx`, malformed body). */
export class PairingMailboxServerError extends PairingMailboxError {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** The request didn't complete within the client timeout. */
export class PairingMailboxTimeoutError extends PairingMailboxError {}

/** Clamp a caller-supplied TTL into the mailbox's server-enforced `[60, 900]` second range. */
export function clampMailboxTtlSeconds(ttlSeconds: number): number {
  return Math.min(
    MAILBOX_MAX_TTL_SECONDS,
    Math.max(MAILBOX_MIN_TTL_SECONDS, Math.round(ttlSeconds))
  );
}

/** True when `lookupId` is exactly 32 lowercase hex characters, as the mailbox requires. */
export function isValidLookupId(lookupId: string): boolean {
  return LOOKUP_ID_RE.test(lookupId);
}

/** Typed, pluggable mailbox transport — swap in a fake for tests. */
export interface PairingMailbox {
  /** Whether this client has a usable mailbox endpoint configured. */
  readonly configured: boolean;
  /** `PUT` a capsule at `lookupId`. `ttlSeconds` is clamped server-side into `[60, 900]`. */
  put(lookupId: string, capsule: string, ttlSeconds: number): Promise<void>;
  /** One-time `GET`: atomically returns and burns the capsule. */
  take(lookupId: string): Promise<string>;
  /** Burn an entry (best-effort cleanup); idempotent — never throws for "already gone". */
  burn(lookupId: string): Promise<void>;
}

function assertLookupId(lookupId: string): void {
  if (!isValidLookupId(lookupId)) {
    throw new PairingMailboxError('pairing mailbox: lookup id must be 32 lowercase hex characters');
  }
}

function normalizeBaseUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** HTTP implementation, targeting `EXPO_PUBLIC_PAIR_MAILBOX_URL` (or an explicit `baseUrl`). */
export class HttpPairingMailbox implements PairingMailbox {
  private readonly baseUrl: string | null;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl?: string | null; timeoutMs?: number } = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl !== undefined ? options.baseUrl : process.env.EXPO_PUBLIC_PAIR_MAILBOX_URL
    );
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get configured(): boolean {
    return this.baseUrl !== null;
  }

  async put(lookupId: string, capsule: string, ttlSeconds: number): Promise<void> {
    assertLookupId(lookupId);
    const res = await this.request('PUT', lookupId, {
      body: JSON.stringify({ capsule, ttlSeconds: clampMailboxTtlSeconds(ttlSeconds) }),
    });
    if (res.status === 201) return;
    if (res.status === 409) {
      throw new PairingMailboxConflictError('pairing mailbox: that code is already in use');
    }
    throw await this.failureFor(res);
  }

  async take(lookupId: string): Promise<string> {
    assertLookupId(lookupId);
    const res = await this.request('GET', lookupId);
    if (res.status === 404) {
      throw new PairingMailboxNotFoundError('pairing mailbox: code not found or expired');
    }
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new PairingMailboxError('pairing mailbox: malformed response body');
      }
      const capsule = (body as { capsule?: unknown } | null)?.capsule;
      if (typeof capsule !== 'string' || capsule.length === 0) {
        throw new PairingMailboxError('pairing mailbox: malformed response body');
      }
      return capsule;
    }
    throw await this.failureFor(res);
  }

  async burn(lookupId: string): Promise<void> {
    assertLookupId(lookupId);
    const res = await this.request('DELETE', lookupId);
    if (res.status === 204 || res.status === 200) return;
    throw await this.failureFor(res);
  }

  private async request(
    method: 'PUT' | 'GET' | 'DELETE',
    lookupId: string,
    init: { body?: string } = {}
  ): Promise<Response> {
    if (!this.baseUrl) {
      throw new PairingMailboxNotConfiguredError(
        'pairing mailbox: EXPO_PUBLIC_PAIR_MAILBOX_URL is not configured'
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}/v1/invites/${lookupId}`, {
        method,
        ...(init.body ? { headers: { 'Content-Type': 'application/json' }, body: init.body } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new PairingMailboxTimeoutError('pairing mailbox: request timed out');
      }
      throw new PairingMailboxError(`pairing mailbox: request failed (${errorMessage(err)})`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async failureFor(res: Response): Promise<PairingMailboxError> {
    if (res.status === 429) {
      const retryAfterRaw = res.headers.get('Retry-After');
      const retryAfter = retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) : NaN;
      return new PairingMailboxRateLimitedError(
        'pairing mailbox: rate limited, try again shortly',
        Number.isFinite(retryAfter) ? retryAfter : null
      );
    }
    if (res.status >= 500) {
      return new PairingMailboxServerError(
        `pairing mailbox: server error (${res.status})`,
        res.status
      );
    }
    return new PairingMailboxServerError(
      `pairing mailbox: unexpected response (${res.status})`,
      res.status
    );
  }
}

/** Build the default mailbox client from environment config (`EXPO_PUBLIC_PAIR_MAILBOX_URL`). */
export function createDefaultPairingMailbox(): PairingMailbox {
  return new HttpPairingMailbox();
}
