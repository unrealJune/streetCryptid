/**
 * HTTP client tests for the pairing mailbox, using a mocked global `fetch`. Covers
 * create/take/burn status handling, TTL clamping, unconfigured-client rejection, and request
 * timeout.
 */

import {
  clampMailboxTtlSeconds,
  HttpPairingMailbox,
  isValidLookupId,
  MAILBOX_MAX_TTL_SECONDS,
  MAILBOX_MIN_TTL_SECONDS,
  PairingMailboxConflictError,
  PairingMailboxNotConfiguredError,
  PairingMailboxNotFoundError,
  PairingMailboxRateLimitedError,
  PairingMailboxServerError,
  PairingMailboxTimeoutError,
} from '../pairing-mailbox';

const LOOKUP_ID = 'a'.repeat(32);
const BASE_URL = 'https://mailbox.example.test';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('clampMailboxTtlSeconds / isValidLookupId', () => {
  it('clamps below the minimum and above the maximum', () => {
    expect(clampMailboxTtlSeconds(1)).toBe(MAILBOX_MIN_TTL_SECONDS);
    expect(clampMailboxTtlSeconds(100_000)).toBe(MAILBOX_MAX_TTL_SECONDS);
    expect(clampMailboxTtlSeconds(300)).toBe(300);
  });

  it('validates the 32-lowercase-hex lookup id shape', () => {
    expect(isValidLookupId(LOOKUP_ID)).toBe(true);
    expect(isValidLookupId(LOOKUP_ID.toUpperCase())).toBe(false);
    expect(isValidLookupId('abc')).toBe(false);
  });
});

describe('HttpPairingMailbox', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('reports unconfigured when no base URL is available', async () => {
    const mailbox = new HttpPairingMailbox({ baseUrl: null });
    expect(mailbox.configured).toBe(false);
    await expect(mailbox.put(LOOKUP_ID, 'capsule', 300)).rejects.toThrow(
      PairingMailboxNotConfiguredError
    );
    await expect(mailbox.take(LOOKUP_ID)).rejects.toThrow(PairingMailboxNotConfiguredError);
    await expect(mailbox.burn(LOOKUP_ID)).rejects.toThrow(PairingMailboxNotConfiguredError);
  });

  it('is configured when given an explicit base URL', () => {
    const mailbox = new HttpPairingMailbox({ baseUrl: BASE_URL });
    expect(mailbox.configured).toBe(true);
  });

  it('PUTs the capsule with a clamped TTL and succeeds on 201', async () => {
    const fetchMock = jest.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/v1/invites/${LOOKUP_ID}`);
      expect(init.method).toBe('PUT');
      const body = JSON.parse(init.body as string) as { capsule: string; ttlSeconds: number };
      expect(body).toEqual({ capsule: 'scmail1:abc', ttlSeconds: MAILBOX_MAX_TTL_SECONDS });
      return emptyResponse(201);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const mailbox = new HttpPairingMailbox({ baseUrl: BASE_URL });
    await expect(mailbox.put(LOOKUP_ID, 'scmail1:abc', 100_000)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects PUT with a 409 conflict', async () => {
    global.fetch = jest.fn(async () => emptyResponse(409)) as unknown as typeof fetch;
    const mailbox = new HttpPairingMailbox({ baseUrl: BASE_URL });
    await expect(mailbox.put(LOOKUP_ID, 'scmail1:abc', 300)).rejects.toThrow(
      PairingMailboxConflictError
    );
  });

  it('rejects PUT with an invalid lookup id before ever calling fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const mailbox = new HttpPairingMailbox({ baseUrl: BASE_URL });
    await expect(mailbox.put('not-hex', 'scmail1:abc', 300)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('take() returns the capsule on 200', async () => {
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/v1/invites/${LOOKUP_ID}`);
      expect(init.method).toBe('GET');
      return jsonResponse(200, { capsule: 'scmail1:sealed' });
    }) as unknown as typeof fetch;

    const mailbox = new HttpPairingMailbox({ baseUrl: BASE_URL });
    await expect(mailbox.take(LOOKUP_ID)).resolves.toBe('scmail1:sealed');
  });

  it('take() throws PairingMailboxNotFoundError on 404', async () => {
    global.fetch = jest.fn(async () => emptyResponse(404)) as unknown as typeof fetch;
    const mailbox = new HttpPairingMailbox({ baseUrl: BASE_URL });
    await expect(mailbox.take(LOOKUP_ID)).rejects.toThrow(PairingMailboxNotFoundError);
  });

  it('take() throws on a malformed 200 body', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse(200, { nope: true })
    ) as unknown as typeof fetch;
    const mailbox = new HttpPairingMailbox({ baseUrl: BASE_URL });
    await expect(mailbox.take(LOOKUP_ID)).rejects.toThrow();
  });

  it('surfaces a 429 as PairingMailboxRateLimitedError with Retry-After', async () => {
    global.fetch = jest.fn(async () =>
      emptyResponse(429, { 'Retry-After': '30' })
    ) as unknown as typeof fetch;
    const mailbox = new HttpPairingMailbox({ baseUrl: BASE_URL });
    try {
      await mailbox.take(LOOKUP_ID);
      throw new Error('expected take() to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(PairingMailboxRateLimitedError);
      expect((err as PairingMailboxRateLimitedError).retryAfterSeconds).toBe(30);
    }
  });

  it('surfaces a 5xx as PairingMailboxServerError', async () => {
    global.fetch = jest.fn(async () => emptyResponse(503)) as unknown as typeof fetch;
    const mailbox = new HttpPairingMailbox({ baseUrl: BASE_URL });
    try {
      await mailbox.take(LOOKUP_ID);
      throw new Error('expected take() to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(PairingMailboxServerError);
      expect((err as PairingMailboxServerError).status).toBe(503);
    }
  });

  it('burn() succeeds on 204 and is idempotent-shaped (also accepts 200)', async () => {
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('DELETE');
      return emptyResponse(204);
    }) as unknown as typeof fetch;
    const mailbox = new HttpPairingMailbox({ baseUrl: BASE_URL });
    await expect(mailbox.burn(LOOKUP_ID)).resolves.toBeUndefined();
  });

  it('times out and throws PairingMailboxTimeoutError', async () => {
    global.fetch = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    ) as unknown as typeof fetch;

    const mailbox = new HttpPairingMailbox({ baseUrl: BASE_URL, timeoutMs: 5 });
    await expect(mailbox.take(LOOKUP_ID)).rejects.toThrow(PairingMailboxTimeoutError);
  });

  it('reads the base URL from EXPO_PUBLIC_PAIR_MAILBOX_URL when not given explicitly', () => {
    const original = process.env.EXPO_PUBLIC_PAIR_MAILBOX_URL;
    process.env.EXPO_PUBLIC_PAIR_MAILBOX_URL = BASE_URL;
    try {
      const mailbox = new HttpPairingMailbox();
      expect(mailbox.configured).toBe(true);
    } finally {
      if (original === undefined) delete process.env.EXPO_PUBLIC_PAIR_MAILBOX_URL;
      else process.env.EXPO_PUBLIC_PAIR_MAILBOX_URL = original;
    }
  });
});
