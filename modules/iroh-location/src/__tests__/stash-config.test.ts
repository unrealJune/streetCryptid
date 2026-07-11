import { getStashConfig } from '../stash-config';

const URL_KEY = 'EXPO_PUBLIC_TRAIL_STASH_URL';
const TICKET_KEY = 'EXPO_PUBLIC_TRAIL_STASH_TICKET';
const PSK_KEY = 'EXPO_PUBLIC_TRAIL_STASH_PSK';

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

describe('getStashConfig', () => {
  it('returns null when nothing is configured', () => {
    expect(getStashConfig(env({}))).toBeNull();
  });

  it('returns null when only the URL is set (ticket missing)', () => {
    expect(getStashConfig(env({ [URL_KEY]: 'https://stash.example.com' }))).toBeNull();
  });

  it('returns null when only the ticket is set (URL missing)', () => {
    expect(getStashConfig(env({ [TICKET_KEY]: 'nodeticketabc' }))).toBeNull();
  });

  it('resolves URL + ticket, trimming and stripping a trailing slash', () => {
    const cfg = getStashConfig(
      env({ [URL_KEY]: '  https://stash.example.com/  ', [TICKET_KEY]: '  nodeticketabc  ' })
    );
    expect(cfg).toEqual({
      baseUrl: 'https://stash.example.com',
      ticket: 'nodeticketabc',
      psk: null,
    });
  });

  it('includes the PSK when present', () => {
    const cfg = getStashConfig(
      env({ [URL_KEY]: 'https://stash.example.com', [TICKET_KEY]: 'tkt', [PSK_KEY]: ' s3cret ' })
    );
    expect(cfg?.psk).toBe('s3cret');
  });

  it('treats a blank PSK as none', () => {
    const cfg = getStashConfig(
      env({ [URL_KEY]: 'https://stash.example.com', [TICKET_KEY]: 'tkt', [PSK_KEY]: '   ' })
    );
    expect(cfg?.psk).toBeNull();
  });
});
