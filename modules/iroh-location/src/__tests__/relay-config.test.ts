import { requireIrohRelayRuntimeConfig } from '../relay-config';

const originalRelayUrls = process.env.EXPO_PUBLIC_IROH_RELAY_URLS;
const originalRelayToken = process.env.EXPO_PUBLIC_IROH_RELAY_TOKEN;

afterEach(() => {
  if (originalRelayUrls === undefined) {
    delete process.env.EXPO_PUBLIC_IROH_RELAY_URLS;
  } else {
    process.env.EXPO_PUBLIC_IROH_RELAY_URLS = originalRelayUrls;
  }

  if (originalRelayToken === undefined) {
    delete process.env.EXPO_PUBLIC_IROH_RELAY_TOKEN;
  } else {
    process.env.EXPO_PUBLIC_IROH_RELAY_TOKEN = originalRelayToken;
  }
});

describe('requireIrohRelayRuntimeConfig', () => {
  it('reads and normalizes public relay configuration', () => {
    process.env.EXPO_PUBLIC_IROH_RELAY_URLS =
      ' https://relay-us.example.com, ,https://relay-eu.example.com ';
    process.env.EXPO_PUBLIC_IROH_RELAY_TOKEN = ' client-token ';

    expect(requireIrohRelayRuntimeConfig()).toEqual({
      relayUrls: ['https://relay-us.example.com', 'https://relay-eu.example.com'],
      authToken: 'client-token',
    });
  });

  it('rejects missing relay URLs', () => {
    delete process.env.EXPO_PUBLIC_IROH_RELAY_URLS;
    process.env.EXPO_PUBLIC_IROH_RELAY_TOKEN = 'client-token';

    expect(() => requireIrohRelayRuntimeConfig()).toThrow('Iroh relay URLs are not configured');
  });

  it('rejects a missing relay token', () => {
    process.env.EXPO_PUBLIC_IROH_RELAY_URLS = 'https://relay.example.com';
    delete process.env.EXPO_PUBLIC_IROH_RELAY_TOKEN;

    expect(() => requireIrohRelayRuntimeConfig()).toThrow('Iroh relay auth is not configured');
  });
});
