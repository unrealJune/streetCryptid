import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { NativeRepeaterRoster } from 'iroh-location';

import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import {
  repeaterErrorCopy,
  rosterSections,
  type FriendName,
  type RosterSections,
} from '../core/repeaters';
import { getRepeaterClient } from '../net/repeater-client';

export type RepeatersStatus = 'loading' | 'ready' | 'unsupported' | 'error';

/** Resolves `null` on success, or the words for why it failed. */
type Outcome = Promise<string | null>;

export interface UseRepeaters {
  readonly status: RepeatersStatus;
  readonly sections: RosterSections;
  /** Friends by endpoint id, for the invite lists. */
  readonly friends: readonly FriendName[];
  /** Why the last read failed, in words. */
  readonly error: string | null;
  /** The roster being changed, if any: its controls are disabled until it lands. */
  readonly busyRoster: string | null;
  /** Whether this binary has the owner's controls (policy, removing members and machines). */
  readonly ownerControls: boolean;
  /** Whether this binary can invite, grant `inviter`, and auto-invite. */
  readonly inviteControls: boolean;
  /** Invite each new friend at pairing (REPEATERS.md §3.2); `null` until read or unsupported. */
  readonly autoInvite: boolean | null;
  refresh(): Promise<void>;
  claim(link: string, open: boolean, carryMe: boolean): Outcome;
  setCarried(rosterId: string, carry: boolean): Outcome;
  setPolicy(rosterId: string, open: boolean): Outcome;
  removeMember(rosterId: string, member: string): Outcome;
  removeMachine(rosterId: string, repeaterId: string): Outcome;
  invite(rosterId: string, member: string): Outcome;
  setInviter(rosterId: string, member: string, inviter: boolean): Outcome;
  setAutoInvite(on: boolean): Outcome;
}

const UNSUPPORTED = 'Repeaters need the installed app.';

/**
 * The rosters this phone knows, re-read whenever the screen holding it comes into focus. Reading
 * is a local file in the core (`repeaters.bin`), so it is cheap enough for the Settings menu too.
 * A change is signed into that file and resolves at once; the core takes it to the repeaters in
 * the background, since a repeater may be a computer that is asleep (REPEATERS.md §4.4).
 */
export function useRepeaters({
  refreshNames = false,
}: {
  /**
   * Also ask this phone's own machines for names given at their consoles since they were listed
   * (`refreshRepeaterNames`), once per focus. It dials each machine, so only the repeater screens
   * ask; the Settings menu reads the roster book alone.
   */
  readonly refreshNames?: boolean;
} = {}): UseRepeaters {
  const { snapshot } = useLocationSharing();
  const client = useMemo(() => getRepeaterClient(), []);
  const [rosters, setRosters] = useState<NativeRepeaterRoster[]>([]);
  const [status, setStatus] = useState<RepeatersStatus>(client ? 'loading' : 'unsupported');
  const [error, setError] = useState<string | null>(null);
  const [busyRoster, setBusyRoster] = useState<string | null>(null);
  const [autoInvite, setAutoInviteState] = useState<boolean | null>(null);
  const reads = useRef(0);
  const invites = client?.invites ?? null;

  const refresh = useCallback(async () => {
    if (!client) return;
    const read = ++reads.current;
    try {
      const next = await client.rosters();
      const auto = invites ? await invites.autoInvite().catch(() => null) : null;
      if (read !== reads.current) return;
      setRosters(next);
      setAutoInviteState(auto);
      setError(null);
      setStatus('ready');
    } catch (e) {
      if (read !== reads.current) return;
      setError(repeaterErrorCopy(e));
      setStatus('error');
    }
  }, [client, invites]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      const pickUp = refreshNames ? client?.refreshNames : null;
      if (pickUp) {
        void pickUp().then(
          (changed) => (changed > 0 ? refresh() : undefined),
          () => undefined
        );
      }
    }, [client, refresh, refreshNames])
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
  const setInviterCall = owner?.setInviter ?? null;
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
      invite: (rosterId: string, member: string) =>
        invites
          ? change(rosterId, () => invites.invite(rosterId, member))
          : Promise.resolve(UNSUPPORTED),
      setInviter: (rosterId: string, member: string, inviter: boolean) =>
        setInviterCall
          ? change(rosterId, () => setInviterCall(rosterId, member, inviter))
          : Promise.resolve(UNSUPPORTED),
      setAutoInvite: (on: boolean) =>
        invites ? change(null, () => invites.setAutoInvite(on)) : Promise.resolve(UNSUPPORTED),
    }),
    [client, owner, invites, setInviterCall, change]
  );

  const friendList = snapshot?.friends;
  const self = snapshot?.self?.endpointId ?? null;
  const friends = useMemo(
    () => (friendList ?? []).map((f) => ({ endpointId: f.endpointId, handle: f.handle })),
    [friendList]
  );
  const sections = useMemo(() => rosterSections(rosters, friends, self), [rosters, friends, self]);

  return {
    status,
    sections,
    friends,
    error,
    busyRoster,
    ownerControls: owner !== null,
    inviteControls: invites !== null && setInviterCall !== null,
    autoInvite,
    refresh,
    ...actions,
  };
}
