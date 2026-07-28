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
