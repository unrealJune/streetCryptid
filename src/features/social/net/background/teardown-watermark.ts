import { Platform } from 'react-native';

import { getTelemetry, type SpanContext } from '@/features/dev/telemetry';
import { clearTeardownWatermark, loadTeardownWatermark } from '../persistence';
import type { PersistentKV } from './fix-outbox';

/**
 * Reporting for a headless teardown that never came back.
 *
 * A session that wedges inside the native `shutdown` is structurally unable to describe itself: its
 * span never ends, its telemetry batch never flushes, and every trace from that device simply stops
 * mid-sentence. The durable watermark written before the risky await (see `persistence.ts`) is the
 * only evidence it can leave, and this is where a *later* context turns that evidence into a span.
 *
 * A leaf module for the usual reason — both `headless-runtime.ts` and `location-sharing.ts` need
 * it, and those two already import each other in one direction. Keeping the reporter here is what
 * stops that becoming a cycle (same rationale as `native-runtime-owner.ts`).
 */

/**
 * Report a stranded teardown, then clear it so one outage is reported exactly once.
 *
 * Call from anywhere that runs early in a fresh context. Both callers matter and neither is
 * redundant: a headless wake is the common case on iOS, while a foreground launch is what happens
 * immediately after the user force-quits an app the hang had frozen — which is exactly the moment
 * we most want the previous outage on record.
 *
 * @returns how long the teardown had been stranded, or null when there was nothing to report.
 */
export async function reportStrandedTeardown(
  kv: PersistentKV,
  context: 'headless' | 'mounted',
  parent?: SpanContext
): Promise<number | null> {
  const stranded = await loadTeardownWatermark(kv).catch(() => null);
  if (!stranded) return null;
  await clearTeardownWatermark(kv).catch(() => undefined);
  const strandedMs = Math.max(0, Date.now() - stranded.startedAt);
  getTelemetry()
    .startSpan('bg.session.stranded', {
      parent,
      attributes: {
        trigger: stranded.trigger,
        stranded_ms: strandedMs,
        reported_from: context,
        platform: Platform.OS,
        'sc.drop_reason': 'teardown-stranded',
      },
    })
    .end();
  return strandedMs;
}
