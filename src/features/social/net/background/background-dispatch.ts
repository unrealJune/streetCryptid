import { getTelemetry, type SpanContext } from '@/features/dev/telemetry';
import type { LocationFix } from '../../core/types';
import type { FixOutbox } from './fix-outbox';

export type ActiveBackgroundFixHandler = (fix: LocationFix, parent?: SpanContext) => Promise<void>;

interface BackgroundFixDispatcherOptions {
  outbox: FixOutbox;
  flushHeadless(parent?: SpanContext): Promise<void>;
  onActiveError?(error: unknown): void;
}

export interface BackgroundFixDispatcher {
  dispatch(fixes: readonly LocationFix[], parent?: SpanContext): Promise<void>;
  registerActiveHandler(handler: ActiveBackgroundFixHandler): () => void;
}

/**
 * Routes an OS-delivered batch to the already-running app service when possible.
 * If no live runtime exists (or it rejects a fix), the batch is persisted first
 * and then drained by a short-lived headless iroh runtime.
 */
export function createBackgroundFixDispatcher(
  options: BackgroundFixDispatcherOptions
): BackgroundFixDispatcher {
  let activeHandler: ActiveBackgroundFixHandler | null = null;

  return {
    async dispatch(fixes, parent): Promise<void> {
      const queued: LocationFix[] = [];
      const handler = activeHandler;
      let activeFailures = 0;

      for (const fix of fixes) {
        if (!handler) {
          queued.push(fix);
          continue;
        }
        try {
          await handler(fix, parent);
        } catch (error) {
          activeFailures += 1;
          options.onActiveError?.(error);
          queued.push(fix);
        }
      }

      // Which branch a wake took decides everything after it — whether the mounted node published
      // directly or a short-lived headless node had to be built — and it was previously
      // reconstructible only by inferring it from which spans happened to follow. Recording it
      // makes "the mounted runtime silently stopped accepting fixes" a single query.
      getTelemetry()
        .startSpan('bg.dispatch', {
          parent,
          attributes: {
            branch: handler ? 'mounted' : 'headless',
            fixes: fixes.length,
            queued: queued.length,
            active_failures: activeFailures,
          },
        })
        .end();

      if (queued.length === 0) return;
      for (const fix of queued) {
        await options.outbox.enqueue(fix, parent);
      }
      // A mounted runtime owns the monotonic sequence counter. If it rejected
      // a fix, leave the durable item for its next flush rather than racing a
      // second restored service against the same author/seq space.
      if (!handler) await options.flushHeadless(parent);
    },

    registerActiveHandler(handler): () => void {
      activeHandler = handler;
      return () => {
        if (activeHandler === handler) activeHandler = null;
      };
    },
  };
}
