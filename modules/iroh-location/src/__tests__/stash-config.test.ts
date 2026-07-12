import { getStashConfig } from '../stash-config';

const URL_KEY = 'EXPO_PUBLIC_TRAIL_STASH_URL';
const TICKET_KEY = 'EXPO_PUBLIC_TRAIL_STASH_TICKET';
const PSK_KEY = 'EXPO_PUBLIC_TRAIL_STASH_PSK';

const originals: Record<string, string | undefined> = {
  [URL_KEY]: process.env[URL_KEY],
  [TICKET_KEY]: process.env[TICKET_KEY],
  [PSK_KEY]: process.env[PSK_KEY],
};

/**
 * Set the stash env for one test. Reads must go through the real `process.env` (not an injected
 * object) so the runtime path matches the release build, where `babel-preset-expo` inlines
 * `process.env.EXPO_PUBLIC_*` statically. See `relay-config.test.ts` for the same pattern.
 */
function setEnv(overrides: Record<string, string | undefined>): void {
  for (const key of [URL_KEY, TICKET_KEY, PSK_KEY]) {
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  setEnv(originals);
});

describe('getStashConfig', () => {
  it('returns null when nothing is configured', () => {
    setEnv({});
    expect(getStashConfig()).toBeNull();
  });

  it('returns null when only the URL is set (ticket missing)', () => {
    setEnv({ [URL_KEY]: 'https://stash.example.com' });
    expect(getStashConfig()).toBeNull();
  });

  it('returns null when only the ticket is set (URL missing)', () => {
    setEnv({ [TICKET_KEY]: 'nodeticketabc' });
    expect(getStashConfig()).toBeNull();
  });

  it('resolves URL + ticket, trimming and stripping a trailing slash', () => {
    setEnv({ [URL_KEY]: '  https://stash.example.com/  ', [TICKET_KEY]: '  nodeticketabc  ' });
    expect(getStashConfig()).toEqual({
      baseUrl: 'https://stash.example.com',
      ticket: 'nodeticketabc',
      psk: null,
    });
  });

  it('includes the PSK when present', () => {
    setEnv({ [URL_KEY]: 'https://stash.example.com', [TICKET_KEY]: 'tkt', [PSK_KEY]: ' s3cret ' });
    expect(getStashConfig()?.psk).toBe('s3cret');
  });

  it('treats a blank PSK as none', () => {
    setEnv({ [URL_KEY]: 'https://stash.example.com', [TICKET_KEY]: 'tkt', [PSK_KEY]: '   ' });
    expect(getStashConfig()?.psk).toBeNull();
  });
});
