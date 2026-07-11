import {
  isTrailSyncNotification,
  mapDeviceTokenType,
  NoopPushTokenProvider,
} from '../push-token-provider';

describe('mapDeviceTokenType', () => {
  it('maps iOS to apns and Android to fcm', () => {
    expect(mapDeviceTokenType('ios')).toBe('apns');
    expect(mapDeviceTokenType('android')).toBe('fcm');
  });

  it('returns null for unknown types', () => {
    expect(mapDeviceTokenType('web')).toBeNull();
    expect(mapDeviceTokenType('')).toBeNull();
  });
});

describe('isTrailSyncNotification', () => {
  it('detects the trail-sync data payload', () => {
    expect(
      isTrailSyncNotification({ request: { content: { data: { type: 'trail-sync', ns: 'ab' } } } })
    ).toBe(true);
  });

  it('ignores unrelated or malformed notifications', () => {
    expect(isTrailSyncNotification({ request: { content: { data: { type: 'other' } } } })).toBe(
      false
    );
    expect(isTrailSyncNotification({})).toBe(false);
    expect(isTrailSyncNotification(null)).toBe(false);
  });
});

describe('NoopPushTokenProvider', () => {
  it('acquires nothing and no-ops the background handler', async () => {
    const provider = new NoopPushTokenProvider();
    await expect(provider.acquire()).resolves.toBeNull();
    expect(() => provider.registerBackgroundSync(() => {})).not.toThrow();
  });
});
