import { redirectSystemPath } from '@/app/+native-intent';

const TOKEN = 'scpair1:deadbeef';

describe('native pair intent rewriting', () => {
  it('routes Android-style host links to the social route', () => {
    expect(
      redirectSystemPath({
        path: `streetcryptid://social?token=${encodeURIComponent(TOKEN)}`,
        initial: true,
      })
    ).toBe(`/social?token=${encodeURIComponent(TOKEN)}`);
  });

  it('routes triple-slash links to the social route', () => {
    expect(
      redirectSystemPath({
        path: `streetcryptid:///social?token=${encodeURIComponent(TOKEN)}`,
        initial: true,
      })
    ).toBe(`/social?token=${encodeURIComponent(TOKEN)}`);
  });

  it('keeps unrelated native paths unchanged', () => {
    expect(redirectSystemPath({ path: '/settings', initial: false })).toBe('/settings');
  });
});
