import { randomBytes } from 'node:crypto';

import { StreamingBundleSource } from '../streaming-bundle-source';
import { MemoryBundleResumeStore } from '../bundle-resume-store';
import { TILE_STREAM3_MEDIA_TYPE, TILE_STREAM_MEDIA_TYPE } from '../bundle-stream';
import { TILE_BUNDLE_MEDIA_TYPE } from '../tile-bundle';
import {
  hashBytes,
  scb1,
  stream3Fixture,
  streamFixture,
  streamRequest,
} from '../__fixtures__/stream-fixture';

const url = 'https://tiles.test/planet/bundle/v3/164/357/11';
const etag = '"dataset:v3:164:357:11"';
const original = global.fetch;

function response(
  bytes: Uint8Array,
  extra: Record<string, string> = {},
  status = 200,
  fail = false
): Response {
  const headers = {
    'content-type': TILE_STREAM3_MEDIA_TYPE,
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
  const { all } = stream3Fixture(streamRequest, new Uint8Array(randomBytes(100_000)));
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
  global.fetch = jest.fn(async () => response(stream3Fixture().all));
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
    response(stream3Fixture().all, { 'content-range': 'bytes 4-10/11' }, 206)
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
  const { all } = stream3Fixture();
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

it('falls back to v2, then v1, only when each endpoint is unsupported', async () => {
  const store = new MemoryBundleResumeStore();
  const legacy = scb1(streamRequest);
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(response(new Uint8Array(), {}, 404))
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
    url.replace('/v3/', '/v2/'),
    url.replace('/v3/', '/v1/'),
    url.replace('/v3/', '/v1/'),
  ]);
});

it('uses the v2 stream once a server has answered v3 with 404', async () => {
  const store = new MemoryBundleResumeStore();
  const v2 = streamFixture(streamRequest, new Uint8Array([0x1a, 0]));
  const v2Response = () => {
    const r = response(v2.all, { 'content-type': TILE_STREAM_MEDIA_TYPE, etag: '"v2"' });
    return r;
  };
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(response(new Uint8Array(), {}, 405))
    .mockImplementation(async (_url, init) => {
      expect(init.headers.Accept).toBe(TILE_STREAM_MEDIA_TYPE);
      return v2Response();
    });
  const source = new StreamingBundleSource(
    'https://tiles.test/planet',
    async () => store,
    hashBytes
  );
  const stages: string[] = [];
  const entries = await source.getBundle(streamRequest, async (_r, _e, stage) => {
    stages.push(`${stage.tileZoom}:${stage.part}`);
  });
  // v2 entries are raw MVT; nothing downstream needs to know which format delivered them.
  expect(entries.map((e) => [...(e.bytes ?? [])])).toEqual(Array(4).fill([0x1a, 0]));
  expect(stages).toEqual(['11:full']);
  await source.getBundle(streamRequest);
  expect(jest.mocked(fetch).mock.calls.map((call) => String(call[0]))).toEqual([
    url,
    url.replace('/v3/', '/v2/'),
    url.replace('/v3/', '/v2/'),
  ]);
});

it('delivers a z14 stream as overview, structure, then labels, resolving with the labels', async () => {
  const request = { ...streamRequest, tileZoom: 14 };
  const { all } = stream3Fixture(request, new Uint8Array([0x1a, 0]));
  global.fetch = jest.fn(async () => response(all));
  const stages: string[] = [];
  const entries = await new StreamingBundleSource(
    'https://tiles.test/planet',
    async () => new MemoryBundleResumeStore(),
    hashBytes
  ).getBundle(request, async (_r, e, stage) => {
    stages.push(`${stage.tileZoom}:${stage.part}:${e.length}`);
  });
  expect(stages).toEqual(['13:full:64', '14:structure:256', '14:labels:256']);
  expect(entries).toHaveLength(256);
  expect([...entries[0].bytes!.subarray(0, 3)]).toEqual([0x1f, 0x8b, 0x08]);
  expect(jest.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({
    Accept: TILE_STREAM3_MEDIA_TYPE,
  });
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
  const { all } = stream3Fixture();
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
        releases.push(() => resolve(response(stream3Fixture({ ...streamRequest, anchorX }).all)));
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
