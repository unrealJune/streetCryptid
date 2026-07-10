import type { LocationFix } from '../../core/types';
import type { FixOutbox } from './fix-outbox';

export type ActiveBackgroundFixHandler = (fix: LocationFix) => Promise<void>;

interface BackgroundFixDispatcherOptions {
  outbox: FixOutbox;
  flushHeadless(): Promise<void>;
  onActiveError?(error: unknown): void;
}

export interface BackgroundFixDispatcher {
  dispatch(fixes: readonly LocationFix[]): Promise<void>;
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
    async dispatch(fixes): Promise<void> {
      const queued: LocationFix[] = [];
      const handler = activeHandler;

      for (const fix of fixes) {
        if (!handler) {
          queued.push(fix);
          continue;
        }
        try {
          await handler(fix);
        } catch (error) {
          options.onActiveError?.(error);
          queued.push(fix);
        }
      }

      if (queued.length === 0) return;
      for (const fix of queued) {
        await options.outbox.enqueue(fix);
      }
      // A mounted runtime owns the monotonic sequence counter. If it rejected
      // a fix, leave the durable item for its next flush rather than racing a
      // second restored service against the same author/seq space.
      if (!handler) await options.flushHeadless();
    },

    registerActiveHandler(handler): () => void {
      activeHandler = handler;
      return () => {
        if (activeHandler === handler) activeHandler = null;
      };
    },
  };
}
