export interface IrohRelayRuntimeConfig {
  relayUrls: string[];
  authToken: string;
}

export function requireIrohRelayRuntimeConfig(): IrohRelayRuntimeConfig {
  const relayUrls = (process.env.EXPO_PUBLIC_IROH_RELAY_URLS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  if (relayUrls.length === 0) {
    throw new Error(
      'Iroh relay URLs are not configured. Set EXPO_PUBLIC_IROH_RELAY_URLS in an ignored .env.local file.'
    );
  }

  const authToken = process.env.EXPO_PUBLIC_IROH_RELAY_TOKEN?.trim();
  if (!authToken) {
    throw new Error(
      'Iroh relay auth is not configured. Set EXPO_PUBLIC_IROH_RELAY_TOKEN in an ignored .env.local file.'
    );
  }

  return {
    relayUrls,
    authToken,
  };
}
