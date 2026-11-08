import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { NativeRepeaterRoster } from 'iroh-location';

import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import { repeaterErrorCopy, rosterSections, type RosterSections } from '../core/repeaters';
import { getRepeaterClient } from '../net/repeater-client';

export type RepeatersStatus = 'loading' | 'ready' | 'unsupported' | 'error';

/** Resolves `null` on success, or the words for why it failed. */
type Outcome = Promise<string | null>;

export interface UseRepeaters {
  readonly status: RepeatersStatus;
  readonly sections: RosterSections;
  /** Why the last read failed, in words. */
  readonly error: string | null;
  /** The roster being changed, if any: its controls are disabled until it lands. */
  readonly busyRoster: string | null;
  /** Whether this binary has the owner's controls (policy, removing members and machines). */
  readonly ownerControls: boolean;
  refresh(): Promise<void>;
  claim(link: string, open: boolean, carryMe: boolean): Outcome;
  setCarried(rosterId: string, carry: boolean): Outcome;
  setPolicy(rosterId: string, open: boolean): Outcome;
  removeMember(rosterId: string, member: string): Outcome;
  removeMachine(rosterId: string, repeaterId: string): Outcome;
}

const UNSUPPORTED = 'Repeaters need the installed app.';

/**
 * The rosters this phone knows, re-read whenever the screen holding it comes into focus. Reading
 * is a local file in the core (`repeaters.bin`), so it is cheap enough for the Settings menu too;
 * every change dials the roster's repeaters, and is re-read once it lands.
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

  /** Run one change against a roster, then re-read; `rosterId` null for a claim. */
  const change = useCallback(
    async (rosterId: string | null, run: () => Promise<unknown>): Outcome => {
      if (rosterId) setBusyRoster(rosterId);
      try {
        await run();
        await refresh();
        return null;
      } catch (e) {
        return repeaterErrorCopy(e);
      } finally {
        if (rosterId) setBusyRoster(null);
      }
    },
    [refresh]
  );

  const owner = client?.owner ?? null;
  const actions = useMemo(
    () => ({
      claim: (link: string, open: boolean, carryMe: boolean) =>
        client
          ? change(null, () => client.claim(link, open, carryMe))
          : Promise.resolve(UNSUPPORTED),
      setCarried: (rosterId: string, carry: boolean) =>
        client
          ? change(rosterId, () => client.setCarried(rosterId, carry))
          : Promise.resolve(UNSUPPORTED),
      setPolicy: (rosterId: string, open: boolean) =>
        owner
          ? change(rosterId, () => owner.setPolicy(rosterId, open))
          : Promise.resolve(UNSUPPORTED),
      removeMember: (rosterId: string, member: string) =>
        owner
          ? change(rosterId, () => owner.removeMember(rosterId, member))
          : Promise.resolve(UNSUPPORTED),
      removeMachine: (rosterId: string, repeaterId: string) =>
        owner
          ? change(rosterId, () => owner.removeMachine(rosterId, repeaterId))
          : Promise.resolve(UNSUPPORTED),
    }),
    [client, owner, change]
  );

  const friends = snapshot?.friends;
  const self = snapshot?.self?.endpointId ?? null;
  const sections = useMemo(
    () =>
      rosterSections(
        rosters,
        (friends ?? []).map((f) => ({ endpointId: f.endpointId, handle: f.handle })),
        self
      ),
    [rosters, friends, self]
  );

  return {
    status,
    sections,
    error,
    busyRoster,
    ownerControls: owner !== null,
    refresh,
    ...actions,
  };
}
