import { getTelemetry } from '@/features/dev/telemetry';
import type { LocationFix } from '../../core/types';

/**
 * Durable outbox decoupling "GPS fix captured" from "fix published on the wire". Captures made
 * while the iroh node is unbound (app killed / backgrounded / offline) survive in a persistent
 * KV and are flushed when the node is ready again. See docs/social/ARCHITECTURE.md §9.
 *
 * The background TaskManager handler appends into this outbox when no mounted
 * runtime exists, then a restored headless iroh publisher drains it immediately.
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

export interface FixOutbox {
  /** Append a captured fix. Enforces the bound (drops oldest) and coalescing. */
  enqueue(fix: LocationFix): Promise<void>;
  /**
   * Publish queued fixes in capture order. Each successful `publish` removes that item; if
   * `publish` rejects, draining stops and the remaining items are kept for the next call.
   * Returns the number of fixes successfully published.
   */
  drain(publish: (fix: LocationFix) => Promise<void>): Promise<number>;
  /** How many fixes are currently queued. */
  pending(): Promise<number>;
  /** Drop everything (e.g. on sign-out). */
  clear(): Promise<void>;
}

export interface OutboxOptions {
  kv: PersistentKV;
  /** KV key under which the queue is serialized. Default `sc.social.outbox`. */
  storageKey?: string;
  /** Bounded ring size; oldest fixes are dropped past this. Default 500. */
  maxItems?: number;
  /**
   * Coalescing: when the newest queued fix is within `coalesceDistanceM` and `coalesceWindowMs`
   * of the incoming one, replace it instead of appending (avoids flooding while walking slowly).
   * Set distance to 0 to disable coalescing. Defaults: 5 m / 3000 ms.
   */
  coalesceDistanceM?: number;
  coalesceWindowMs?: number;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
}

interface OutboxItem {
  fix: LocationFix;
  enqueuedAt: number;
}

/** Great-circle distance between two fixes in metres. Private. */
function haversineMetres(a: LocationFix, b: LocationFix): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function createFixOutbox(opts: OutboxOptions): FixOutbox {
  const storageKey = opts.storageKey ?? 'sc.social.outbox';
  const maxItems = opts.maxItems ?? 500;
  const coalesceDistanceM = opts.coalesceDistanceM ?? 5;
  const coalesceWindowMs = opts.coalesceWindowMs ?? 3000;
  const now = opts.now ?? Date.now;
  let operation = Promise.resolve();

  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = operation.then(work, work);
    operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function load(): Promise<OutboxItem[]> {
    const raw = await opts.kv.get(storageKey);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw) as OutboxItem[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async function save(items: OutboxItem[]): Promise<void> {
    await opts.kv.set(storageKey, JSON.stringify(items));
  }

  return {
    enqueue(fix: LocationFix): Promise<void> {
      return exclusive(async () => {
        const items = await load();
        const last = items[items.length - 1];
        const ts = now();

        const coalesced =
          coalesceDistanceM > 0 &&
          last !== undefined &&
          haversineMetres(last.fix, fix) <= coalesceDistanceM &&
          ts - last.enqueuedAt <= coalesceWindowMs;
        if (coalesced) {
          items[items.length - 1] = { fix, enqueuedAt: ts };
        } else {
          items.push({ fix, enqueuedAt: ts });
        }

        let overflowDropped = 0;
        while (items.length > maxItems) {
          items.shift();
          overflowDropped += 1;
        }

        await save(items);

        // Both branches are legitimate "a captured fix will never hit the wire" outcomes — the
        // exact thing a dropped-ping investigation needs to see (searchable via sc.drop_reason).
        const telemetry = getTelemetry();
        if (telemetry.enabled && (coalesced || overflowDropped > 0)) {
          const span = telemetry.startSpan('outbox.enqueue', {
            attributes: {
              coalesced,
              overflow_dropped: overflowDropped,
              pending: items.length,
              'sc.drop_reason': overflowDropped > 0 ? 'outbox-overflow' : 'coalesced',
            },
          });
          span.end();
        }
      });
    },

    drain(publish: (fix: LocationFix) => Promise<void>): Promise<number> {
      return exclusive(async () => {
        const items = await load();
        if (items.length === 0) return 0;
        const telemetry = getTelemetry();
        const span = telemetry.startSpan('outbox.drain', {
          attributes: { queued: items.length },
        });
        let published = 0;
        while (items.length > 0) {
          const item = items[0];
          try {
            await publish(item.fix);
          } catch (err) {
            // Not a drop — the fix is retained for the next drain — but it IS why nothing went
            // out on this wake, so record the reason.
            span.addEvent('publish.failed', {
              reason: err instanceof Error ? err.message : String(err),
            });
            break;
          }
          items.shift();
          published += 1;
          await save(items);
        }
        span.setAttributes({ published, retained: items.length });
        span.setStatus(published > 0 || items.length === 0 ? 'ok' : 'error');
        span.end();
        return published;
      });
    },

    async pending(): Promise<number> {
      await operation;
      return (await load()).length;
    },

    clear(): Promise<void> {
      return exclusive(async () => {
        await opts.kv.remove(storageKey);
      });
    },
  };
}
