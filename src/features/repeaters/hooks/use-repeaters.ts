import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { NativeRepeaterRoster } from 'iroh-location';

import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import { repeaterErrorCopy, rosterSections, type RosterSections } from '../core/repeaters';
import { getRepeaterClient } from '../net/repeater-client';

export type RepeatersStatus = 'loading' | 'ready' | 'unsupported' | 'error';

export interface UseRepeaters {
  readonly status: RepeatersStatus;
  readonly sections: RosterSections;
  /** Why the last read failed, in words. */
  readonly error: string | null;
  /** The roster whose carry switch is being changed, if any. */
  readonly busyRoster: string | null;
  refresh(): Promise<void>;
  /** Resolves `null` on success, or the words for why the claim failed. */
  claim(link: string, open: boolean, carryMe: boolean): Promise<string | null>;
  /** Resolves `null` on success, or the words for why it failed. */
  setCarried(rosterId: string, carry: boolean): Promise<string | null>;
}

/**
 * The rosters this phone knows, re-read whenever the screen holding it comes into focus. Reading
 * is a local file in the core (`repeaters.bin`), so it is cheap enough for the Settings menu too;
 * only `claim` and `setCarried` dial anything.
 */
export function useRepeaters(): UseRepeaters {
  const { snapshot } = useLocationSharing();
  const client = useMemo(() => getRepeaterClient(), []);
  const [rosters, setRosters] = useState<NativeRepeaterRoster[]>([]);
  const [status, setStatus] = useState<RepeatersStatus>(client ? 'loading' : 'unsupported');
  const [error, setError] = useState<string | null>(null);
  const [busyRoster, setBusyRoster] = useState<string | null>(null);
  const reads = useRef(0);

  const refresh = useCallback(async () => {
    if (!client) return;
    const read = ++reads.current;
    try {
      const next = await client.rosters();
      if (read !== reads.current) return;
      setRosters(next);
      setError(null);
      setStatus('ready');
    } catch (e) {
      if (read !== reads.current) return;
      setError(repeaterErrorCopy(e));
      setStatus('error');
    }
  }, [client]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );

  const claim = useCallback(
    async (link: string, open: boolean, carryMe: boolean) => {
      if (!client) return 'Repeaters need the installed app.';
      try {
        await client.claim(link, open, carryMe);
        await refresh();
        return null;
      } catch (e) {
        return repeaterErrorCopy(e);
      }
    },
    [client, refresh]
  );

  const setCarried = useCallback(
    async (rosterId: string, carry: boolean) => {
      if (!client) return 'Repeaters need the installed app.';
      setBusyRoster(rosterId);
      try {
        await client.setCarried(rosterId, carry);
        await refresh();
        return null;
      } catch (e) {
        return repeaterErrorCopy(e);
      } finally {
        setBusyRoster(null);
      }
    },
    [client, refresh]
  );

  const friends = snapshot?.friends;
  const sections = useMemo(
    () =>
      rosterSections(
        rosters,
        (friends ?? []).map((f) => ({ endpointId: f.endpointId, handle: f.handle }))
      ),
    [rosters, friends]
  );

  return { status, sections, error, busyRoster, refresh, claim, setCarried };
}
