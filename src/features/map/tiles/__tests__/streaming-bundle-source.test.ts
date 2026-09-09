import { randomBytes } from 'node:crypto';

import { StreamingBundleSource } from '../streaming-bundle-source';
import { MemoryBundleResumeStore } from '../bundle-resume-store';
import { TILE_STREAM_MEDIA_TYPE } from '../bundle-stream';
import { TILE_BUNDLE_MEDIA_TYPE } from '../tile-bundle';
import { hashBytes, scb1, streamFixture, streamRequest } from '../__fixtures__/stream-fixture';

const url = 'https://tiles.test/planet/bundle/v2/164/357/11';
const etag = '"dataset:v2:164:357:11"';
const original = global.fetch;

function response(
  bytes: Uint8Array,
  extra: Record<string, string> = {},
  status = 200,
  fail = false
): Response {
  const headers = {
    'content-type': TILE_STREAM_MEDIA_TYPE,
    etag,
    ...extra,
  };
  let sent = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name as keyof typeof headers] ?? null },
    body: {
      getReader: () => ({
        read: async () => {
          if (!sent) {
            sent = true;
            return { done: false, value: bytes };
          }
          if (fail) throw new Error('connection lost');
          return { done: true };
        },
        cancel: jest.fn(async () => {}),
      }),
    },
  } as unknown as Response;
}

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => {
  global.fetch = original;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('resumes a dropped response after a new source instance from the durable prefix, not zero', async () => {
  const store = new MemoryBundleResumeStore();
  const { all } = streamFixture(streamRequest, new Uint8Array(randomBytes(100_000)));
  expect(all.length).toBeGreaterThan(262144);
  const fetchMock = jest
    .fn()
    .mockResolvedValueOnce(response(all.slice(0, 280_000), {}, 200, true))
    .mockImplementationOnce(async (_url, init) => {
      expect(init.headers.Range).toBe('bytes=262144-');
      expect(init.headers['If-Range']).toBe(etag);
      return response(
        all.slice(262144),
        { 'content-range': `bytes 262144-${all.length - 1}/${all.length}` },
        206
      );
    });
  global.fetch = fetchMock;
  await expect(
    new StreamingBundleSource('https://tiles.test/planet', async () => store, hashBytes).getBundle(
      streamRequest
    )
  ).rejects.toThrow('connection lost');
  expect((await store.state(url))?.size).toBe(262144);
  const entries = await new StreamingBundleSource(
    'https://tiles.test/planet',
    async () => store,
    hashBytes
  ).getBundle(streamRequest);
  expect(entries).toHaveLength(4);
  expect(await store.state(url)).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('starts fresh if If-Range produces 200 for a changed representation', async () => {
  const store = new MemoryBundleResumeStore();
  await store.append(url, '"old"', 0, new Uint8Array([1, 2, 3]));
  global.fetch = jest.fn(async () => response(streamFixture().all));
  const result = await new StreamingBundleSource(
    'https://tiles.test/planet',
    async () => store,
    hashBytes
  ).getBundle(streamRequest);
  expect(result).toHaveLength(4);
  expect(await store.state(url)).toBeNull();
});

it('rejects inconsistent resumed ranges and discards the poisoned journal', async () => {
  const store = new MemoryBundleResumeStore();
  await store.append(url, etag, 0, new Uint8Array([1, 2, 3]));
  global.fetch = jest.fn(async () =>
    response(streamFixture().all, { 'content-range': 'bytes 4-10/11' }, 206)
  );
  await expect(
    new StreamingBundleSource('https://tiles.test/planet', async () => store, hashBytes).getBundle(
      streamRequest
    )
  ).rejects.toThrow('resume response');
  expect(await store.state(url)).toBeNull();
});

it('recognizes a journal completed before process shutdown with a validated 416', async () => {
  const store = new MemoryBundleResumeStore();
  const { all } = streamFixture();
  await store.append(url, etag, 0, all);
  global.fetch = jest.fn(async () =>
    response(new Uint8Array(), { 'content-range': `bytes */${all.length}` }, 416)
  );
  expect(
    await new StreamingBundleSource(
      'https://tiles.test/planet',
      async () => store,
      hashBytes
    ).getBundle(streamRequest)
  ).toHaveLength(4);
  expect(await store.state(url)).toBeNull();
});

it('falls back to v1 only when the v2 endpoint is unsupported', async () => {
  const store = new MemoryBundleResumeStore();
  const legacy = scb1(streamRequest);
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(response(new Uint8Array(), {}, 404))
    .mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h === 'content-type' ? TILE_BUNDLE_MEDIA_TYPE : null) },
      arrayBuffer: async () => legacy.buffer,
    });
  const source = new StreamingBundleSource(
    'https://tiles.test/planet',
    async () => store,
    hashBytes
  );
  await source.getBundle(streamRequest);
  await source.getBundle(streamRequest);
  expect(jest.mocked(fetch).mock.calls.map((call) => String(call[0]))).toEqual([
    url,
    url.replace('/v2/', '/v1/'),
    url.replace('/v2/', '/v1/'),
  ]);
});

it('does not downgrade on server failures', async () => {
  const store = new MemoryBundleResumeStore();
  global.fetch = jest.fn(async () => response(new Uint8Array(), {}, 503));
  await expect(
    new StreamingBundleSource('https://tiles.test/planet', async () => store, hashBytes).getBundle(
      streamRequest
    )
  ).rejects.toThrow('503');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('allows transfers longer than sixty seconds while bytes keep arriving', async () => {
  jest.useFakeTimers();
  const { all } = streamFixture();
  const base = response(all);
  let read = 0;
  const reader = {
    read: () =>
      new Promise((resolve) =>
        setTimeout(() => {
          read++;
          resolve(
            read === 1
              ? { done: false, value: all.slice(0, 25) }
              : read === 2
                ? { done: false, value: all.slice(25) }
                : { done: true }
          );
        }, 40_000)
      ),
    cancel: jest.fn(async () => {}),
  };
  global.fetch = jest.fn(
    async () =>
      ({
        ...base,
        body: { getReader: () => reader },
      }) as unknown as Response
  );
  const store = new MemoryBundleResumeStore();
  const pending = new StreamingBundleSource(
    'https://tiles.test/planet',
    async () => store,
    hashBytes
  ).getBundle(streamRequest);
  const assertion = expect(pending).resolves.toHaveLength(4);
  await jest.advanceTimersByTimeAsync(120_000);
  await assertion;
});

it('releases a stalled reader at the no-progress deadline even if cancellation never settles', async () => {
  jest.useFakeTimers();
  const base = response(new Uint8Array());
  global.fetch = jest.fn(
    async () =>
      ({
        ...base,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
            cancel: () => new Promise(() => {}),
          }),
        },
      }) as unknown as Response
  );
  const pending = new StreamingBundleSource(
    'https://tiles.test/planet',
    async () => new MemoryBundleResumeStore(),
    hashBytes
  ).getBundle(streamRequest);
  const assertion = expect(pending).rejects.toThrow('45000ms');
  await jest.advanceTimersByTimeAsync(45_000);
  await assertion;
});

it('admits at most two active streams across source instances', async () => {
  const releases: (() => void)[] = [];
  global.fetch = jest.fn(
    (input) =>
      new Promise<Response>((resolve) => {
        const anchorX = Number(String(input).split('/').at(-3));
        releases.push(() => resolve(response(streamFixture({ ...streamRequest, anchorX }).all)));
      })
  );
  const pending = [164, 165, 166].map((anchorX) =>
    new StreamingBundleSource(
      'https://tiles.test/planet',
      async () => new MemoryBundleResumeStore(),
      hashBytes
    ).getBundle({ ...streamRequest, anchorX })
  );
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(2);
  releases[0]();
  await pending[0];
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(3);
  releases[1]();
  releases[2]();
  await Promise.all(pending);
});
