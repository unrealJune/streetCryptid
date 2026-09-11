import { redirectSystemPath } from '@/app/+native-intent';

const TOKEN = 'scpair2:deadbeef';

describe('native pair intent rewriting', () => {
  it('routes the https App Link to active pairing, reading the token out of the fragment', () => {
    expect(
      redirectSystemPath({
        path: `https://streetcrypt.id/pair#token=${encodeURIComponent(TOKEN)}`,
        initial: true,
      })
    ).toBe(`/pairing?token=${encodeURIComponent(TOKEN)}`);
  });

  it('accepts the https App Link with the token in the query too', () => {
    expect(
      redirectSystemPath({
        path: `https://streetcrypt.id/pair?token=${encodeURIComponent(TOKEN)}`,
        initial: false,
      })
    ).toBe(`/pairing?token=${encodeURIComponent(TOKEN)}`);
  });

  it('opens the map when a claimed URL carries no usable token', () => {
    expect(redirectSystemPath({ path: 'https://streetcrypt.id/pair', initial: true })).toBe('/');
  });

  it('leaves an unrelated https URL alone', () => {
    // Only /pair is claimed; anything else on the host must reach the browser.
    expect(redirectSystemPath({ path: 'https://streetcrypt.id/privacy', initial: true })).toBe(
      'https://streetcrypt.id/privacy'
    );
  });

  it('routes Android-style host links to active pairing', () => {
    expect(
      redirectSystemPath({
        path: `streetcryptid://social?token=${encodeURIComponent(TOKEN)}`,
        initial: true,
      })
    ).toBe(`/pairing?token=${encodeURIComponent(TOKEN)}`);
  });

  it('routes triple-slash links to active pairing', () => {
    expect(
      redirectSystemPath({
        path: `streetcryptid:///social?token=${encodeURIComponent(TOKEN)}`,
        initial: true,
      })
    ).toBe(`/pairing?token=${encodeURIComponent(TOKEN)}`);
  });

  it('routes the pair alias to active pairing too', () => {
    expect(
      redirectSystemPath({
        path: `streetcryptid://pair?token=${encodeURIComponent(TOKEN)}`,
        initial: true,
      })
    ).toBe(`/pairing?token=${encodeURIComponent(TOKEN)}`);
  });

  it('sends a tokenless invite to the active pairing screen', () => {
    expect(redirectSystemPath({ path: 'streetcryptid://social', initial: true })).toBe('/pairing');
  });

  it('keeps unrelated native paths unchanged', () => {
    expect(redirectSystemPath({ path: '/settings', initial: false })).toBe('/settings');
  });
});

/**
 * The e2e command channel (`device_dev_command`). It exists because Maestro's `launchApp`
 * force-terminates and relaunches on iOS, which tears the iroh node down; opening a URL
 * foregrounds a running app instead.
 */
describe('native dev-command intent rewriting', () => {
  it('routes a dev command to the map with its nonce', () => {
    expect(
      redirectSystemPath({ path: 'streetcryptid://dev?cmd=sync-trail&id=abc123', initial: false })
    ).toBe('/?dev=sync-trail&devId=abc123');
  });

  it('routes triple-slash dev links too', () => {
    expect(
      redirectSystemPath({
        path: 'streetcryptid:///dev?cmd=replica-status&id=n7',
        initial: false,
      })
    ).toBe('/?dev=replica-status&devId=n7');
  });

  // A command with no nonce cannot be observed by the harness, and a nonce with no command
  // names nothing to run. Either half alone is a malformed link, not a command.
  it('sends a half-formed dev link to the map without a command', () => {
    expect(redirectSystemPath({ path: 'streetcryptid://dev?cmd=sync-trail', initial: false })).toBe(
      '/'
    );
    expect(redirectSystemPath({ path: 'streetcryptid://dev?id=abc123', initial: false })).toBe('/');
  });

  // Validation is the handler's job — the mapper is a pure path rewrite, so an unknown name
  // has to reach the app to be reported as a typed error rather than silently ignored here.
  it('passes an unknown command name through for the handler to reject', () => {
    expect(
      redirectSystemPath({ path: 'streetcryptid://dev?cmd=not-a-command&id=z', initial: false })
    ).toBe('/?dev=not-a-command&devId=z');
  });
});
