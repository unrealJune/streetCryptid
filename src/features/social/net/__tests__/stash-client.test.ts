import {
  createDefaultStashClient,
  HttpStashClient,
  NoopStashClient,
  StashClientError,
} from '../stash-client';
import type { StashConfig } from 'iroh-location';

const CONFIG: StashConfig = {
  baseUrl: 'https://stash.example.com',
  ticket: 'nodeticket',
  psk: null,
};

function mockFetch(status: number): jest.Mock {
  const fn = jest.fn(async () => ({ status }) as Response);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function lastCall(fn: jest.Mock): { url: string; init: RequestInit } {
  const [url, init] = fn.mock.calls[fn.mock.calls.length - 1];
  return { url, init };
}

describe('HttpStashClient.registerNamespace', () => {
  it('POSTs the read ticket and resolves on 201', async () => {
    const fetchMock = mockFetch(201);
    await new HttpStashClient(CONFIG).registerNamespace({ readTicket: 'doc-ticket-xyz' });
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe('https://stash.example.com/v1/namespaces');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ read_ticket: 'doc-ticket-xyz' });
  });

  // The privacy property the stash registration rests on (ARCHITECTURE.md §10): a device
  // push token is the one identifier here resolvable to a real person, and pairing it with a
  // namespace let the stash operator work out which namespace was ours. Nothing may reintroduce
  // it — not even as an optional field a caller could set.
  it('never sends anything that identifies this device', async () => {
    const fetchMock = mockFetch(201);
    await new HttpStashClient(CONFIG).registerNamespace({ readTicket: 'doc-ticket-xyz' });
    const body = JSON.parse(lastCall(fetchMock).init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ read_ticket: 'doc-ticket-xyz' });
    expect(Object.keys(body)).toEqual(['read_ticket']);
  });

  it('sends the PSK as a bearer when configured', async () => {
    const fetchMock = mockFetch(201);
    await new HttpStashClient({ ...CONFIG, psk: 's3cret' }).registerNamespace({
      readTicket: 'doc-ticket-xyz',
    });
    const headers = lastCall(fetchMock).init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer s3cret');
  });

  it('omits the auth header when no PSK is configured', async () => {
    const fetchMock = mockFetch(201);
    await new HttpStashClient(CONFIG).registerNamespace({ readTicket: 'doc-ticket-xyz' });
    const headers = lastCall(fetchMock).init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws on 401 (bad PSK)', async () => {
    mockFetch(401);
    await expect(
      new HttpStashClient(CONFIG).registerNamespace({ readTicket: 'x' })
    ).rejects.toThrow(StashClientError);
  });

  it('throws on unexpected status', async () => {
    mockFetch(502);
    await expect(
      new HttpStashClient(CONFIG).registerNamespace({ readTicket: 'x' })
    ).rejects.toThrow(/502/);
  });
});

describe('NoopStashClient', () => {
  it('reports not configured and no-ops', async () => {
    const client = new NoopStashClient();
    expect(client.configured).toBe(false);
    await expect(client.registerNamespace({ readTicket: 'x' })).resolves.toBeUndefined();
  });
});

describe('createDefaultStashClient', () => {
  const saved = {
    url: process.env.EXPO_PUBLIC_TRAIL_STASH_URL,
    ticket: process.env.EXPO_PUBLIC_TRAIL_STASH_TICKET,
  };
  afterEach(() => {
    process.env.EXPO_PUBLIC_TRAIL_STASH_URL = saved.url;
    process.env.EXPO_PUBLIC_TRAIL_STASH_TICKET = saved.ticket;
  });

  it('returns a Noop client when unconfigured', () => {
    delete process.env.EXPO_PUBLIC_TRAIL_STASH_URL;
    delete process.env.EXPO_PUBLIC_TRAIL_STASH_TICKET;
    expect(createDefaultStashClient().configured).toBe(false);
  });

  it('returns an HTTP client when configured', () => {
    process.env.EXPO_PUBLIC_TRAIL_STASH_URL = 'https://stash.example.com';
    process.env.EXPO_PUBLIC_TRAIL_STASH_TICKET = 'tkt';
    expect(createDefaultStashClient().configured).toBe(true);
  });
});
