import { MartinByteSource } from '../martin-source';

const TILE = { z: 10, x: 164, y: 357 };

describe('MartinByteSource', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  it.each([204, 404])('treats HTTP %s as a known-empty tile', async (status) => {
    global.fetch = jest.fn().mockResolvedValue({ status });
    await expect(new MartinByteSource('http://tiles.test').getTileBytes(TILE)).resolves.toBeNull();
  });

  it('rejects an HTTP failure and allows a later request to succeed', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ status: 503, ok: false })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
    const source = new MartinByteSource('http://tiles.test');
    await expect(source.getTileBytes(TILE)).rejects.toThrow('503');
    await expect(source.getTileBytes(TILE)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it.each(['headers', 'body'])(
    'settles a stalled %s request at the deadline even if fetch ignores abort',
    async (stage) => {
      jest.useFakeTimers();
      let requestSignal: AbortSignal | undefined;
      global.fetch = jest.fn().mockImplementation((_url, opts) => {
        requestSignal = opts.signal;
        return stage === 'headers'
          ? new Promise(() => {})
          : Promise.resolve({
              status: 200,
              ok: true,
              arrayBuffer: () => new Promise(() => {}),
            });
      });
      const caller = new AbortController();
      const outcome = new MartinByteSource('http://tiles.test')
        .getTileBytes(TILE, caller.signal)
        .then(
          () => 'resolved',
          (error: Error) => error.name
        );
      let result: string | undefined;
      void outcome.then((value) => {
        result = value;
      });

      await jest.advanceTimersByTimeAsync(29_999);
      expect(result).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      expect(result).toBe('TimeoutError');
      expect(requestSignal?.aborted).toBe(true);
      expect(caller.signal.aborted).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it('settles caller cancellation without depending on fetch to reject', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn().mockImplementation(() => new Promise(() => {}));
    const caller = new AbortController();
    let result: string | undefined;
    void new MartinByteSource('http://tiles.test')
      .getTileBytes(TILE, caller.signal)
      .catch((error: Error) => {
        result = error.name;
      });
    caller.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(result).toBe('AbortError');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not fetch for an already-cancelled caller', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 204 });
    const caller = new AbortController();
    caller.abort();
    await expect(
      new MartinByteSource('http://tiles.test').getTileBytes(TILE, caller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
