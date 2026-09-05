/**
 * The key/value port the background modules persist through, and the in-memory stand-in.
 *
 * Extracted from `fix-outbox.ts` when the outbox itself moved to Rust (`outbox.rs`). It had always
 * been the odd thing in that file: half the app persists through this port — the friend pool,
 * watermarks, the profile store, transport preferences — and none of that has anything to do with
 * a queue of pending fixes. Its old home is why deleting the queue would otherwise have taken the
 * port with it.
 */

/** Minimal persistence port. Real impl: expo-sqlite / AsyncStorage. Tests use {@link InMemoryKV}. */
export interface PersistentKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** In-memory {@link PersistentKV} for unit tests (and the web/no-native fallback). */
export class InMemoryKV implements PersistentKV {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}
