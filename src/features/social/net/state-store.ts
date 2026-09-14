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
 *
 * # What this value MEANS, since `seq_store.rs` took over issuing
 *
 * The live counter is now the native one under `state_dir`, and this is no longer a mirror of it —
 * it is a **reservation**: a number at or above every `seq` this device will issue before the next
 * launch tops it up. That distinction is the whole point, because the two stores do not die
 * together. On iOS the keychain SURVIVES app deletion while `state_dir` (Application Support) does
 * not, so a reinstall meets a live native counter of 0 and whatever this held.
 *
 * As a mirror that was a rewind. On 2026-09-12 a phone reinstalled onto a different build, the
 * native counter died at 6851, this still read 6776, and the fresh install re-issued 75 values
 * that were already on the wire — the key-reuse hazard FORWARD-SECRECY.md exists to prevent. (It
 * was harmless only because the ratchet state was wiped in the same breath.) A mirror can only
 * ever lag, and the native drain path issues `seq` on background wakes with no JS context alive to
 * update it, so no amount of write-back closes the gap.
 *
 * As a reservation it cannot rewind: {@link SEQ_RESERVATION_BLOCK} values are claimed here BEFORE
 * native issues them, so a wipe costs at most one unused block and never a reused value. Skipping
 * is explicitly safe — `SeqStore::seed` is monotone, and its own docs note a floor above the
 * current value "can only ever skip values, never re-issue them".
 */

/**
 * How far ahead of the live counter each launch reserves.
 *
 * Sized against how much the BACKGROUND path can publish while no JS context exists to reserve
 * more: measured at ~94 envelopes in 12 h on a phone that was working throughout, so this is
 * roughly fifty days of continuous background publishing. `seq` is a `u64` on the wire and gaps in
 * it mean nothing to a receiver — the only cost of being generous is numbers nobody ever uses, and
 * the only cost of being stingy is the rewind this exists to prevent.
 */
export const SEQ_RESERVATION_BLOCK = 10_000;

/**
 * How close the live counter may get to the reservation before a new block is claimed.
 *
 * Only the foreground path can notice and top up, so this exists to keep the cheap local check in
 * `nextSeq` from turning into a native round-trip on every single publish.
 */
export const SEQ_RESERVATION_LOW_WATER = 1_000;

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
