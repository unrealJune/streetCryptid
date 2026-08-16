import { redirectSystemPath } from '@/app/+native-intent';

const TOKEN = 'scpair1:deadbeef';

describe('native pair intent rewriting', () => {
  it('routes Android-style host links to the map', () => {
    expect(
      redirectSystemPath({
        path: `streetcryptid://social?token=${encodeURIComponent(TOKEN)}`,
        initial: true,
      })
    ).toBe(`/?pair=${encodeURIComponent(TOKEN)}`);
  });

  it('routes triple-slash links to the map', () => {
    expect(
      redirectSystemPath({
        path: `streetcryptid:///social?token=${encodeURIComponent(TOKEN)}`,
        initial: true,
      })
    ).toBe(`/?pair=${encodeURIComponent(TOKEN)}`);
  });

  it('routes the pair alias to the map too', () => {
    expect(
      redirectSystemPath({
        path: `streetcryptid://pair?token=${encodeURIComponent(TOKEN)}`,
        initial: true,
      })
    ).toBe(`/?pair=${encodeURIComponent(TOKEN)}`);
  });

  // The Friends route is gone, so a tokenless invite has nowhere to go but home.
  it('sends a tokenless invite to the map', () => {
    expect(redirectSystemPath({ path: 'streetcryptid://social', initial: true })).toBe('/');
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
