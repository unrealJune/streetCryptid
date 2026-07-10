import { AppState } from 'react-native';

import { createCryptidProfileStore } from '@/features/account/storage/profile-store';
import { LocationSharingService } from '../location-sharing';
import { backgroundOutbox } from './background-outbox';

let flushInFlight: Promise<number> | null = null;

/**
 * Restores the minimum persisted state needed to publish queued fixes when
 * TaskManager launches a fresh JS runtime with no mounted React tree.
 */
export function flushBackgroundOutboxHeadless(): Promise<number> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = doFlush().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

async function doFlush(): Promise<number> {
  // expo-task-manager delivers each OS location batch to a fresh, short-lived headless JS context —
  // even while the app is foreground — and that context can't see the mounted service's registered
  // handler, so the dispatcher here always takes the headless path. Spinning up a second iroh node
  // would call createNode → clearRuntime and tear down the FOREGROUND node mid-flight (breaking its
  // gossip subscription and pairing poll). While the app is active, the mounted runtime owns the
  // shared native node and drains the outbox itself, so defer to it: the batch is already persisted
  // (the dispatcher enqueues before calling us), so nothing is lost — it flushes on the foreground
  // engine's next cycle. Only a truly backgrounded/killed process (no active UI) publishes headless.
  if (AppState.currentState === 'active') return 0;
  if ((await backgroundOutbox.pending()) === 0) return 0;

  const profile = await createCryptidProfileStore().load();
  if (!profile) {
    throw new Error('Cannot publish background locations before a cryptid profile is configured.');
  }

  const service = new LocationSharingService();
  try {
    await service.init(profile.handle, profile.sigil, profile.cryptidName, profile.color, {
      mode: 'headless',
    });
    return await backgroundOutbox.drain(async (fix) => {
      await service.publishFix(fix);
    });
  } finally {
    await service.shutdownAsync();
  }
}
