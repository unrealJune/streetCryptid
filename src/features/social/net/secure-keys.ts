import * as SecureStore from 'expo-secure-store';

/**
 * Persist the node's key material in the OS secure store (iOS Keychain / Android
 * EncryptedSharedPreferences) so the EndpointId + receiving key stay stable across
 * launches. See docs/social/ARCHITECTURE.md §3.
 */

const ID_KEY = 'sc.iroh.identitySecret';
const RECV_KEY = 'sc.iroh.recvSecret';

export interface PersistedKeys {
  identitySecret: string | null;
  recvSecret: string | null;
}

export async function loadKeys(): Promise<PersistedKeys> {
  try {
    const identitySecret = await SecureStore.getItemAsync(ID_KEY);
    const recvSecret = await SecureStore.getItemAsync(RECV_KEY);
    return { identitySecret, recvSecret };
  } catch {
    // Secure store is unavailable (web / Expo Go); fall back to ephemeral keys.
    return { identitySecret: null, recvSecret: null };
  }
}

export async function saveKeys(keys: {
  identitySecret: string;
  recvSecret: string;
}): Promise<void> {
  try {
    await SecureStore.setItemAsync(ID_KEY, keys.identitySecret);
    await SecureStore.setItemAsync(RECV_KEY, keys.recvSecret);
  } catch {
    // Best effort; keys remain ephemeral if the secure store is unavailable.
  }
}
