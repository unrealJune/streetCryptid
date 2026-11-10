import { Linking, Platform } from 'react-native';

import { isNavigationDestination, openNavigation } from '../open-navigation';

describe('openNavigation', () => {
  const originalOS = Platform.OS;
  const destination = { lat: 47.6308, lon: -122.32 };
  let openURL: jest.SpiedFunction<typeof Linking.openURL>;

  beforeEach(() => {
    openURL = jest.spyOn(Linking, 'openURL').mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    Platform.OS = originalOS;
    jest.restoreAllMocks();
  });

  it('asks iOS for its default navigation handler before Apple Maps', async () => {
    Platform.OS = 'ios';
    await openNavigation(destination);

    expect(openURL.mock.calls).toEqual([
      ['geo-navigation:///directions?destination=47.6308%2C-122.32'],
    ]);
    const url = new URL(openURL.mock.calls[0][0]);
    expect(url.host).toBe('');
    expect(url.pathname).toBe('/directions');
    expect(url.searchParams.get('destination')).toBe('47.6308,-122.32');
  });

  it('falls back to Apple Maps directions when iOS cannot open the navigation scheme', async () => {
    Platform.OS = 'ios';
    openURL.mockRejectedValueOnce(new Error('No navigation handler'));

    await openNavigation(destination);

    expect(openURL.mock.calls).toEqual([
      ['geo-navigation:///directions?destination=47.6308%2C-122.32'],
      ['https://maps.apple.com/?daddr=47.6308%2C-122.32'],
    ]);
  });

  it('lets Android resolve a standard geo intent without forcing a maps vendor', async () => {
    Platform.OS = 'android';
    await openNavigation(destination);

    expect(openURL.mock.calls).toEqual([['geo:0,0?q=47.6308%2C-122.32']]);
  });

  it('falls back to web directions when Android has no maps handler', async () => {
    Platform.OS = 'android';
    openURL.mockRejectedValueOnce(new Error('No geo handler'));

    await openNavigation(destination);

    expect(openURL.mock.calls).toEqual([
      ['geo:0,0?q=47.6308%2C-122.32'],
      ['https://www.google.com/maps/dir/?api=1&destination=47.6308%2C-122.32'],
    ]);
  });

  it('opens HTTPS directions on web immediately, without probing native schemes', async () => {
    Platform.OS = 'web';
    const opening = openNavigation(destination);

    // Keep window.open in the user's click stack, before any async capability checks.
    expect(openURL.mock.calls).toEqual([
      ['https://www.google.com/maps/dir/?api=1&destination=47.6308%2C-122.32'],
    ]);
    await opening;
  });

  it.each(['ios', 'android', 'web'] as const)(
    'reports a failed final handoff on %s instead of resolving as success',
    async (os) => {
      Platform.OS = os;
      const failure = new Error('Cannot open maps');
      openURL.mockRejectedValue(failure);

      await expect(openNavigation(destination)).rejects.toBe(failure);
    }
  );

  it.each([
    { lat: 0, lon: 0 },
    { lat: -90, lon: -180 },
    { lat: 90, lon: 180 },
  ])('accepts valid boundary coordinates %j', async (point) => {
    Platform.OS = 'android';
    expect(isNavigationDestination(point)).toBe(true);

    await openNavigation(point);

    expect(openURL).toHaveBeenCalledWith(
      `geo:0,0?q=${encodeURIComponent(`${point.lat},${point.lon}`)}`
    );
  });

  it('does not navigate without a location', () => {
    expect(isNavigationDestination(null)).toBe(false);
    expect(openURL).not.toHaveBeenCalled();
  });

  it.each([
    { lat: NaN, lon: 0 },
    { lat: 0, lon: Infinity },
    { lat: -Infinity, lon: 0 },
    { lat: -90.01, lon: 0 },
    { lat: 90.01, lon: 0 },
    { lat: 0, lon: -180.01 },
    { lat: 0, lon: 180.01 },
  ])('refuses invalid coordinates %j before any external handoff', async (point) => {
    expect(isNavigationDestination(point)).toBe(false);
    await expect(openNavigation(point)).rejects.toThrow('This location cannot be opened in maps.');
    expect(openURL).not.toHaveBeenCalled();
  });
});
