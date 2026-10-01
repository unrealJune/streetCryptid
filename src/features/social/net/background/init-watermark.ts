import { Platform } from 'react-native';

import { getTelemetry, type SpanContext } from '@/features/dev/telemetry';
import { clearInitWatermark, loadInitWatermark } from '../persistence';
import type { PersistentKV } from './persistent-kv';

/**
 * Reporting for an `init()` that never finished.
 *
 * The mirror image of `teardown-watermark.ts`, and it exists because the same blind spot sits at
 * the other end of the lifecycle. A service that wedges inside `init` never reaches
 * `setStatus('ready')`, never starts the pairing poll or the heartbeat, and never ends the spans
 * that would have described it — so the device stops emitting mid-sentence and the only thing left
 * on the wire is whatever completed before the stall.
 *
 * On 2026-09-18 that cost an iPhone nine hours. A background launch at 00:36:31 got as far as
 * `node.create` and stopped 128 ms in; the OS froze the process rather than killing it (no
 * `cpu_resource`, no `JetsamEvent`, and the container's newest write stayed at 00:36 all night), so
 * there was no crash report either. When the phone was picked up at 09:57 the SAME JS context
 * resumed into a `sharedServiceInit` promise that could never settle, and the app drew its chrome
 * from `hydrateFromStore()` while the map never mounted. Nothing in the data said which step had
 * been in flight — this span is what answers that next time.
 *
 * A leaf module for the usual reason: both `location-sharing.ts` and the hook need it, and those
 * already import each other in one direction. Same rationale as `native-runtime-owner.ts`.
 */

/**
 * Report an init that never completed, then clear it so one stall is reported exactly once.
 *
 * Call from anywhere that runs early in a fresh context. This only fires for a NEW JS context — a
 * suspension that resumes the same context is invisible to it by construction (`sc.run_id` is
 * unchanged), which is precisely why the hook's own watchdog emits `app.init.timeout` as well.
 * The two are not redundant: this one survives a force-quit and names the phase from disk, the
 * other fires while the process is still alive.
 *
 * @returns how long the init had been stranded, or null when there was nothing to report.
 */
export async function reportStrandedInit(
  kv: PersistentKV,
  context: 'headless' | 'mounted',
  parent?: SpanContext
): Promise<number | null> {
  const stranded = await loadInitWatermark(kv).catch(() => null);
  if (!stranded) return null;
  await clearInitWatermark(kv).catch(() => undefined);
  const strandedMs = Math.max(0, Date.now() - stranded.startedAt);
  getTelemetry()
    .startSpan('app.init.stranded', {
      parent,
      attributes: {
        'init.phase': stranded.phase,
        'init.interactive': stranded.interactive,
        stranded_ms: strandedMs,
        reported_from: context,
        platform: Platform.OS,
        'sc.drop_reason': 'init-stranded',
      },
    })
    .end();
  return strandedMs;
}
