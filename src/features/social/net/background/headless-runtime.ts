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
