import { getTelemetry } from '@/features/dev/telemetry';

/**
 * Reports when on-device persistence has silently degraded to an in-memory store.
 *
 * `persistence.ts` is deliberately forgiving: every SQLite access falls back to an in-memory
 * object so a build without the native module (web, Expo Go, an old dev client) degrades instead
 * of crashing. The cost is that the most consequential failure in the whole feature is also its
 * quietest one — an install running on the fallback loses the outbox, the friend pool, and the
 * sharing intent on every process death, and looks from the outside exactly like a phone that
 * simply never woke.
 *
 * Two grades, because they need different responses:
 *  - **fatal** — the database could not be opened at all (missing module, migration failure). The
 *    whole install is on the fallback for the rest of the process, so this stamps
 *    `storage.backend='memory'` onto the telemetry resource and every subsequent span from this
 *    device carries it. That is the attribute worth filtering a dashboard on.
 *  - **transient** — one statement threw against an otherwise healthy database. Worth counting,
 *    not worth alarming on.
 *
 * Reports are deduplicated per `scope:reason`: a wedged database fails on every access, and the
 * point is to learn that it is wedged, not to spend the export budget saying so thousands of
 * times. The occurrence count rides along on the span so the volume is still visible.
 */

export type StorageBackend = 'sqlite' | 'memory';

export interface StorageDegradation {
  /** Which access degraded — `'open'`, `'kv.get'`, `'trail.putSelf'`, … */
  scope: string;
  /** Why, as a low-cardinality slug. */
  reason: string;
  /** The database is unusable for this whole process, not just this statement. */
  fatal?: boolean;
  error?: unknown;
}

let backend: StorageBackend = 'sqlite';
const seen = new Map<string, number>();

function messageOf(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Record a degradation. Safe to call from any context, including a headless background task and
 * a module-scope initialiser — it never throws and never awaits.
 */
export function reportStorageDegraded(degradation: StorageDegradation): void {
  const { scope, reason, fatal = false, error } = degradation;
  const key = `${scope}:${reason}`;
  const count = (seen.get(key) ?? 0) + 1;
  seen.set(key, count);

  if (fatal && backend !== 'memory') {
    backend = 'memory';
    // Sticky: every span exported after this point is tagged, so the degraded window is visible
    // on the dashboard without having to find this one span first.
    getTelemetry().setResourceAttributes({ 'storage.backend': 'memory' });
  }

  // Only the first occurrence of each distinct failure gets a span. Later ones are counted and
  // ride along on the next first-of-its-kind, and on `device.health`.
  if (count > 1) return;

  getTelemetry()
    .startSpan('storage.degraded', {
      attributes: {
        scope,
        fatal,
        'storage.backend': backend,
        'sc.drop_reason': `storage-${reason}`,
        ...(messageOf(error) ? { 'exception.message': messageOf(error) } : {}),
      },
    })
    .end();
}

/** The backend persistence is actually running on. `'memory'` means nothing survives a restart. */
export function getStorageBackend(): StorageBackend {
  return backend;
}

/** Total degradation events recorded this process, for the `device.health` record. */
export function getStorageDegradationCount(): number {
  let total = 0;
  seen.forEach((count) => {
    total += count;
  });
  return total;
}

/** Test seam. */
export function resetStorageHealthForTesting(): void {
  backend = 'sqlite';
  seen.clear();
}
