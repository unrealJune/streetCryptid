import type { Attributes } from '@/features/dev/telemetry';
import type { PersistentKV } from './fix-outbox';

/**
 * "When did this phone last manage to do X?" — the durable timestamps that make the
 * `device.health` record diagnostic on its own.
 *
 * A single health span answers "is it broken?" only if it can say how long it has been broken.
 * Without these, a phone that has published nothing for nineteen hours and a phone that published
 * a second ago produce identical records, and telling them apart means reconstructing a timeline
 * from spans that may never have been exported.
 *
 * All four live in ONE KV row, deliberately: they are stamped on the hot path (a live-mode publish
 * runs every few seconds) and four separate writes would be four SQLite statements per fix. The
 * row is small and last-write-wins — losing a stamp costs a slightly stale age, never correctness,
 * so nothing here is worth a transaction.
 *
 * Follows the same shape as `teardown-watermark.ts`: write a fact now, have a later session read
 * it back and report on it, because the context that could report on itself is exactly the one
 * that died.
 */

export const WATERMARKS_KEY = 'sc.social.watermarks';

/** What each stamp means, and the attribute it becomes on `device.health`. */
export type WatermarkKind =
  /** The OS delivered a location batch to our background task. */
  | 'wake'
  /** A fix passed the confidence gate and was accepted by the engine. */
  | 'fix'
  /** `publishFix` completed — the envelope was sealed and broadcast. */
  | 'publish'
  /** `pushTrail` completed — the envelope actually left the device. */
  | 'push'
  /** A `device.health` record was emitted. */
  | 'health';

export type Watermarks = Partial<Record<WatermarkKind, number>>;

const KINDS: WatermarkKind[] = ['wake', 'fix', 'publish', 'push', 'health'];

function parse(raw: string | null): Watermarks {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Watermarks = {};
    for (const kind of KINDS) {
      const value = parsed[kind];
      if (typeof value === 'number' && Number.isFinite(value)) out[kind] = value;
    }
    return out;
  } catch {
    // A corrupt row costs us the ages on one record, and is repaired by the next stamp.
    return {};
  }
}

/** Read every stamp. Never throws; an unreadable row reads as "nothing has ever happened". */
export async function loadWatermarks(kv: PersistentKV): Promise<Watermarks> {
  return parse(await kv.get(WATERMARKS_KEY).catch(() => null));
}

/**
 * Record that `kind` just happened. Best-effort and never throws — a missed stamp must not fail
 * the publish it was describing.
 */
export async function stampWatermark(
  kv: PersistentKV,
  kind: WatermarkKind,
  at: number = Date.now()
): Promise<void> {
  try {
    const current = await loadWatermarks(kv);
    await kv.set(WATERMARKS_KEY, JSON.stringify({ ...current, [kind]: at }));
  } catch {
    // Best-effort by design.
  }
}

/**
 * Turn stamps into `*_age_ms` span attributes.
 *
 * A kind that has *never* happened is deliberately omitted rather than sent as -1 or 0: on a
 * dashboard "no `last_publish_age_ms` at all" and "published a long time ago" are different
 * diagnoses, and a sentinel number quietly collapses them into one.
 */
export function watermarkAges(marks: Watermarks, now: number = Date.now()): Attributes {
  const attrs: Attributes = {};
  for (const kind of KINDS) {
    const at = marks[kind];
    if (at !== undefined) attrs[`last_${kind}_age_ms`] = Math.max(0, now - at);
  }
  return attrs;
}
