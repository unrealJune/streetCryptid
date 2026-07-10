import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';

import type { CryptidProfile, CryptidProfileDraft } from '../core/profile';
import { createCryptidProfileStore } from '../storage/profile-store';

type ProfileStatus = 'loading' | 'ready';

interface CryptidProfileContextValue {
  status: ProfileStatus;
  profile: CryptidProfile | null;
  error: string | null;
  saveProfile(profile: CryptidProfileDraft): Promise<CryptidProfile>;
}

const CryptidProfileContext = createContext<CryptidProfileContextValue | null>(null);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CryptidProfileProvider({ children }: PropsWithChildren) {
  const [store] = useState(() => createCryptidProfileStore());
  const [status, setStatus] = useState<ProfileStatus>('loading');
  const [profile, setProfile] = useState<CryptidProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void store
      .load()
      .then((saved) => {
        if (active) setProfile(saved);
      })
      .catch((loadError: unknown) => {
        if (active) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (active) setStatus('ready');
      });
    return () => {
      active = false;
    };
  }, [store]);

  const saveProfile = useCallback(
    async (draft: CryptidProfileDraft): Promise<CryptidProfile> => {
      try {
        const saved = await store.save(draft);
        setProfile(saved);
        setError(null);
        return saved;
      } catch (saveError: unknown) {
        setError(errorMessage(saveError));
        throw saveError;
      }
    },
    [store]
  );

  const value = useMemo(
    () => ({ status, profile, error, saveProfile }),
    [status, profile, error, saveProfile]
  );

  return <CryptidProfileContext.Provider value={value}>{children}</CryptidProfileContext.Provider>;
}

export function useCryptidProfile(): CryptidProfileContextValue {
  const context = useContext(CryptidProfileContext);
  if (!context) {
    throw new Error('useCryptidProfile must be used inside CryptidProfileProvider.');
  }
  return context;
}
