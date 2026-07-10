import * as SecureStore from 'expo-secure-store';

/**
 * Persists the small mutable state the sharing service must keep monotonic across launches —
 * currently just the envelope `seq` counter. `seq` is the author's monotonic publish index; it
 * must never go backwards or a rejoining friend's range-reconciliation would collide keys
 * (`author/seq`). See docs/social/ARCHITECTURE.md §4–5. Not secret, but kept in the secure store
 * for durability + to sit next to the identity keys (see secure-keys.ts).
 */

const SEQ_KEY = 'sc.social.seq';

export async function loadSeq(): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(SEQ_KEY);
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    // Secure store unavailable (web / Expo Go); start from 0 (ephemeral).
    return 0;
  }
}

export async function saveSeq(seq: number): Promise<void> {
  try {
    await SecureStore.setItemAsync(SEQ_KEY, String(seq));
  } catch {
    // Best effort; seq stays in-memory only if the store is unavailable.
  }
}
