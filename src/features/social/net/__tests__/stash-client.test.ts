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

  it('includes push token + platform together when both given', async () => {
    const fetchMock = mockFetch(201);
    await new HttpStashClient(CONFIG).registerNamespace({
      readTicket: 'doc-ticket-xyz',
      pushToken: 'tok',
      platform: 'fcm',
    });
    expect(JSON.parse(lastCall(fetchMock).init.body as string)).toEqual({
      read_ticket: 'doc-ticket-xyz',
      push_token: 'tok',
      platform: 'fcm',
    });
  });

  it('omits a lone push token (server rejects partial pairs)', async () => {
    const fetchMock = mockFetch(201);
    await new HttpStashClient(CONFIG).registerNamespace({
      readTicket: 'doc-ticket-xyz',
      pushToken: 'tok',
    });
    expect(JSON.parse(lastCall(fetchMock).init.body as string)).toEqual({
      read_ticket: 'doc-ticket-xyz',
    });
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

describe('HttpStashClient.unsubscribe', () => {
  it('DELETEs the subscription and resolves on 204', async () => {
    const fetchMock = mockFetch(204);
    await new HttpStashClient(CONFIG).unsubscribe('abcd', { pushToken: 'tok', platform: 'apns' });
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe('https://stash.example.com/v1/namespaces/abcd/subscription');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({ push_token: 'tok', platform: 'apns' });
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
