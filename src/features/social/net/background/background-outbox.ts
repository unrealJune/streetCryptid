import { createPersistentKV } from '../persistence';
import { createFixOutbox } from './fix-outbox';

/**
 * One process-wide queue instance so enqueue/drain share the same mutex.
 *
 * Coalescing is off. It existed to stop the 5s foreground watch flooding the queue while walking
 * slowly, a job the engine's slot gate now does far better upstream. Left on, it would actively
 * break heartbeat backfill: replaying missed slots enqueues the same position several times within
 * milliseconds, which is precisely the near-duplicate pattern coalescing collapses — the uniform
 * cadence would silently become a single envelope.
 */
export const backgroundOutbox = createFixOutbox({
  kv: createPersistentKV(),
  coalesceDistanceM: 0,
});
