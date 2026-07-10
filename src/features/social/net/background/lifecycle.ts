/**
 * Reconnect-on-resume controller (ARCHITECTURE §9). Watches RN `AppState` and fires handlers so
 * the service can: on foreground → rebind the iroh node, drain the outbox, trigger a trail sync;
 * on background → persist state and rely on the OS keep-alive (Android foreground service / iOS
 * background-location mode). Kept as a tiny, injectable controller so its wiring is testable.
 *
 * Requires `react-native` `AppState` (no extra dep).
 */

import { AppState, type AppStateStatus } from 'react-native';

export interface LifecycleHandlers {
  /** App entered foreground / became active. */
  onForeground(): void | Promise<void>;
  /** App went to background / inactive. */
  onBackground(): void | Promise<void>;
}

export interface AppLifecycleController {
  /** Begin listening; returns an unsubscribe fn. Fires `onForeground` immediately if active. */
  start(): () => void;
}

function runGuarded(fn: () => void | Promise<void>): void {
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') {
      result.catch((err) => console.warn('[lifecycle] handler rejected', err));
    }
  } catch (err) {
    console.warn('[lifecycle] handler threw', err);
  }
}

export function createAppLifecycleController(handlers: LifecycleHandlers): AppLifecycleController {
  return {
    start(): () => void {
      let previous: AppStateStatus = AppState.currentState;

      const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
        if (next === previous) {
          return;
        }
        if (next === 'active') {
          runGuarded(handlers.onForeground);
        } else if (next === 'background' || next === 'inactive') {
          runGuarded(handlers.onBackground);
        }
        previous = next;
      });

      if (AppState.currentState === 'active') {
        runGuarded(handlers.onForeground);
      }

      return () => sub.remove();
    },
  };
}
