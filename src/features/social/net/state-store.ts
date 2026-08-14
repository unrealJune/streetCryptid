import * as SecureStore from 'expo-secure-store';

import { SECURE_STORE_OPTIONS } from './secure-keys';

/**
 * Persists the small mutable state the sharing service must keep monotonic across launches —
 * currently just the envelope `seq` counter. `seq` is the author's monotonic publish index; it
 * must never go backwards or receivers would treat the next publish as a replay. Not secret, but
 * kept in the secure store for durability + to sit next to the identity keys (see secure-keys.ts).
 *
 * Unlike the static identity keys, `seq` is SEQUENTIAL state, so persistence is fail-stop
 * (FORWARD-SECRECY.md §4.2): a silent persist no-op would let a later launch reuse an
 * already-published counter value. `saveSeq` therefore propagates failure — the caller
 * (`nextSeq` in location-sharing.ts) persists before the value goes on the wire, so a persist
 * failure aborts the publish instead of risking reuse.
 */

const SEQ_KEY = 'sc.social.seq.v2';
const LEGACY_SEQ_KEY = 'sc.social.seq';

export async function loadSeq(): Promise<number> {
  let raw = await SecureStore.getItemAsync(SEQ_KEY, SECURE_STORE_OPTIONS);
  if (raw === null) {
    raw = await SecureStore.getItemAsync(LEGACY_SEQ_KEY);
    if (raw !== null) {
      // A new key is intentional: SecureStore's update path does not change kSecAttrAccessible.
      await SecureStore.setItemAsync(SEQ_KEY, raw, SECURE_STORE_OPTIONS);
    }
  }
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Persist the seq counter. Fail-stop by design: no catch. If the secure store cannot durably
 * record the counter, the error propagates and the publish that needed it aborts.
 */
export async function saveSeq(seq: number): Promise<void> {
  await SecureStore.setItemAsync(SEQ_KEY, String(seq), SECURE_STORE_OPTIONS);
}
