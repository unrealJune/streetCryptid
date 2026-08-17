import * as SecureStore from 'expo-secure-store';

/**
 * Persist the node's key material in the OS secure store (iOS Keychain / Android
 * EncryptedSharedPreferences) so the EndpointId + receiving key stay stable across
 * launches. See docs/social/ARCHITECTURE.md §3.
 */

const ID_KEY = 'sc.iroh.identitySecret.v2';
const RECV_KEY = 'sc.iroh.recvSecret.v2';
const LEGACY_ID_KEY = 'sc.iroh.identitySecret';
const LEGACY_RECV_KEY = 'sc.iroh.recvSecret';

/**
 * Keychain semantics for everything this app puts in the secure store (FORWARD-SECRECY.md §6):
 *
 * - `AFTER_FIRST_UNLOCK` (not `WHEN_UNLOCKED`): the background location task publishes while the
 *   phone is locked in a pocket; a `WHEN_UNLOCKED` item is unreadable exactly then and would
 *   silently break background sharing on iOS.
 * - `THIS_DEVICE_ONLY`: keys must never travel in an iCloud keychain/device backup. Once key
 *   state becomes sequential (the ratchet), a restored-from-backup copy would rewind the chain
 *   and reuse message keys; even today, restoring identity keys to a second device would fork
 *   the EndpointId.
 */
export const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export interface PersistedKeys {
  identitySecret: string | null;
  recvSecret: string | null;
}

async function loadAndMigrate(key: string, legacyKey: string): Promise<string | null> {
  const current = await SecureStore.getItemAsync(key, SECURE_STORE_OPTIONS);
  if (current !== null) return current;

  const legacy = await SecureStore.getItemAsync(legacyKey);
  if (legacy === null) return null;

  // Expo SecureStore updates only the value of an existing keychain item, not kSecAttrAccessible.
  // Writing under a new key is therefore required to migrate old WHEN_UNLOCKED entries.
  await SecureStore.setItemAsync(key, legacy, SECURE_STORE_OPTIONS);
  return legacy;
}

export async function loadKeys(): Promise<PersistedKeys> {
  const identitySecret = await loadAndMigrate(ID_KEY, LEGACY_ID_KEY);
  const recvSecret = await loadAndMigrate(RECV_KEY, LEGACY_RECV_KEY);
  return { identitySecret, recvSecret };
}

export async function saveKeys(keys: {
  identitySecret: string;
  recvSecret: string;
}): Promise<void> {
  try {
    await SecureStore.setItemAsync(ID_KEY, keys.identitySecret, SECURE_STORE_OPTIONS);
    await SecureStore.setItemAsync(RECV_KEY, keys.recvSecret, SECURE_STORE_OPTIONS);
  } catch {
    // Best effort; keys remain ephemeral if the secure store is unavailable.
  }
}
