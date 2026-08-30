import { getTelemetry, type SpanContext } from '@/features/dev/telemetry';
import type { LocationFix } from '../../core/types';

export type ActiveBackgroundFixHandler = (fix: LocationFix, parent?: SpanContext) => Promise<void>;

interface BackgroundFixDispatcherOptions {
  /**
   * Run fixes the mounted runtime did not take through a short-lived headless one.
   *
   * There is no JS queue in front of this any more: the durable outbox lives in Rust
   * (`outbox.rs`), so a fix is handed straight down and the native side decides whether it is
   * gated, queued or sent. The old two-step — persist here, drain there — existed because the
   * queue was on this side of the boundary.
   */
  ingestHeadless(fixes: readonly LocationFix[], parent?: SpanContext): Promise<void>;
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
      // A mounted runtime owns the process-wide native stores. If it rejected a fix, leave it for
      // its next heartbeat rather than racing a second restored service against the same author/seq
      // space — the directory claim in `durable.rs` would refuse the second one anyway.
      if (!handler) await options.ingestHeadless(queued, parent);
    },

    registerActiveHandler(handler): () => void {
      activeHandler = handler;
      return () => {
        if (activeHandler === handler) activeHandler = null;
      };
    },
  };
}
