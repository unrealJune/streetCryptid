import { InMemoryKV } from '../background/fix-outbox';
import {
  DEFAULT_TRANSPORT_PREFERENCES,
  loadTransportPreferences,
  saveRelayOnly,
  saveTransportPreferences,
} from '../persistence';

describe('transport preferences', () => {
  it('defaults to the full transport stack', async () => {
    expect(await loadTransportPreferences(new InMemoryKV())).toEqual(DEFAULT_TRANSPORT_PREFERENCES);
  });

  it('round-trips a restricted transport set', async () => {
    const kv = new InMemoryKV();
    const restricted = { relay: false, ip: true, ble: false };
    await saveTransportPreferences(kv, restricted);

    expect(await loadTransportPreferences(kv)).toEqual(restricted);
  });

  it('migrates the legacy relay-only setting', async () => {
    const kv = new InMemoryKV();
    await saveRelayOnly(kv, true);

    expect(await loadTransportPreferences(kv)).toEqual({
      relay: true,
      ip: false,
      ble: false,
    });
  });
});
