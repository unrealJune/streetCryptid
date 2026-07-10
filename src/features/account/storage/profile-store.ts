import {
  createCryptidProfile,
  parseCryptidProfile,
  type CryptidProfile,
  type CryptidProfileDraft,
} from '../core/profile';
import type { PersistentKV } from '@/features/social/net/background/fix-outbox';
import { createPersistentKV } from '@/features/social/net/persistence';

const PROFILE_KEY = 'sc.account.profile.v1';

export interface CryptidProfileStore {
  load(): Promise<CryptidProfile | null>;
  save(profile: CryptidProfileDraft): Promise<CryptidProfile>;
}

export function createCryptidProfileStore(
  kv: PersistentKV = createPersistentKV()
): CryptidProfileStore {
  return {
    async load(): Promise<CryptidProfile | null> {
      const raw = await kv.get(PROFILE_KEY);
      if (raw === null) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('Saved cryptid profile could not be read.');
      }
      return parseCryptidProfile(parsed);
    },

    async save(draft: CryptidProfileDraft): Promise<CryptidProfile> {
      const profile = createCryptidProfile(draft);
      await kv.set(PROFILE_KEY, JSON.stringify(profile));
      return profile;
    },
  };
}
