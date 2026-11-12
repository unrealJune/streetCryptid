import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { CryptidChrome } from '@/constants/theme';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import {
  enrollFacts,
  ownerName,
  pairingOffers,
  rosterLine,
  rosterSections,
  vouchLine,
  type PairingOffers,
  type RosterView,
} from '../core/repeaters';
import { getRepeaterClient } from '../net/repeater-client';

import { FactList, ToggleRow } from './repeater-chrome';

export interface PairingRepeaterOffer {
  readonly offers: PairingOffers;
  /** Rosters the person chose to invite the new friend to. */
  readonly invite: ReadonlySet<string>;
  toggleInvite(rosterId: string, on: boolean): void;
  /**
   * Sign the chosen invites. Called once the pair is acknowledged, and never awaited: like
   * everything else at ACKNOWLEDGE (`connectNewFriend`), nothing a repeater does may stand between
   * someone keeping a friend and the app having kept them (REPEATERS.md §4.4). The ops are queued
   * durably in the core and offered to the roster's repeaters until one answers.
   */
  apply(): void;
  /** Enroll in the friend's rosters the person said yes to, after ACKNOWLEDGE. Never awaited. */
  enroll(rosterIds: Iterable<string>): void;
}

const NONE: PairingOffers = { enroll: [], invite: [] };

/**
 * The repeater questions at pairing (REPEATERS.md §4.4), read from the rosters this phone already
 * knows, including the friend's card if it arrived with the pair; when it has not, there is
 * nothing to ask here and the roster shows up later under Settings → Repeaters → Available
 * through friends, with a badge on the Settings menu.
 *
 * Two questions, asked at two moments. "Also invite them to my repeaters" sits above ACKNOWLEDGE,
 * one switch per invite-only roster this phone may invite to, pre-checked when auto-invite is on:
 * it is part of deciding about the friend. "Replicate your location on their repeaters?" comes
 * after ACKNOWLEDGE, on its own, because it is a decision about your location, not about them.
 */
export function usePairingRepeaterOffer(
  friend: { readonly endpointId: string; readonly handle: string } | null
): PairingRepeaterOffer {
  const { snapshot } = useLocationSharing();
  const client = useMemo(() => getRepeaterClient(), []);
  const self = snapshot?.self?.endpointId ?? null;
  const friendId = friend?.endpointId ?? null;
  const friendHandle = friend?.handle ?? '';
  // Everything below is kept per friend, so a second pair on the same screen starts clean
  // without resetting state from inside an effect.
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [picked, setPicked] = useState<Picked>(UNPICKED);

  useEffect(() => {
    if (!client || !friendId) return;
    let live = true;
    void (async () => {
      try {
        const rosters = await client.rosters();
        const auto = client.invites ? await client.invites.autoInvite() : false;
        if (!live) return;
        const sections = rosterSections(
          rosters,
          [{ endpointId: friendId, handle: friendHandle }],
          self
        );
        const next = pairingOffers(sections, friendId);
        setLoaded({
          friendId,
          offers: { ...next, invite: client.invites ? next.invite : [] },
          auto,
        });
      } catch {
        // Nothing to offer is the honest answer when the core cannot say.
      }
    })();
    return () => {
      live = false;
    };
  }, [client, friendId, friendHandle, self]);

  const current = loaded && loaded.friendId === friendId ? loaded : null;
  const offers = current?.offers ?? NONE;
  const mine = picked.friendId === friendId ? picked : UNPICKED;
  // Pre-checked when auto-invite is on, until the person says otherwise.
  const invite = useMemo(() => {
    if (mine.invite) return mine.invite;
    return new Set(current?.auto ? offers.invite.map((r) => r.rosterId) : []);
  }, [mine.invite, current?.auto, offers.invite]);

  const toggleInvite = useCallback(
    (rosterId: string, on: boolean) => {
      setPicked((was) => {
        const base = was.friendId === friendId ? was : { ...UNPICKED, friendId };
        const next = new Set(base.invite ?? invite);
        if (on) next.add(rosterId);
        else next.delete(rosterId);
        return { ...base, invite: next };
      });
    },
    [friendId, invite]
  );

  const apply = useCallback(() => {
    if (!client?.invites || !friendId) return;
    const offered = new Set(offers.invite.map((r) => r.rosterId));
    for (const rosterId of invite) {
      if (offered.has(rosterId)) {
        void client.invites.invite(rosterId, friendId).catch(() => undefined);
      }
    }
  }, [client, friendId, invite, offers.invite]);

  const enroll = useCallback(
    (rosterIds: Iterable<string>) => {
      if (!client) return;
      for (const rosterId of rosterIds) {
        void client.setCarried(rosterId, true).catch(() => undefined);
      }
    },
    [client]
  );

  return { offers, invite, toggleInvite, apply, enroll };
}

interface Loaded {
  readonly friendId: string;
  readonly offers: PairingOffers;
  /** The auto-invite preference, which pre-checks the invites. */
  readonly auto: boolean;
}

interface Picked {
  readonly friendId: string | null;
  /** `null` until the person touches a switch. */
  readonly invite: ReadonlySet<string> | null;
}

const UNPICKED: Picked = { friendId: null, invite: null };

/** "Also invite them to my repeaters", one row per roster; nothing when there is nothing to ask. */
export function PairingInviteOfferView({
  offer,
  chrome,
  disabled,
}: {
  readonly offer: PairingRepeaterOffer;
  readonly chrome: CryptidChrome;
  readonly disabled: boolean;
}) {
  const rosters = offer.offers.invite;
  if (rosters.length === 0) return null;
  return (
    <View style={styles.box}>
      <Text style={[styles.label, { color: chrome.green }]}>
        ALSO INVITE THEM TO {rosters.length === 1 && rosters[0].mine ? 'MY' : 'THESE'} REPEATERS
      </Text>
      {rosters.map((roster) => (
        <ToggleRow
          key={roster.rosterId}
          chrome={chrome}
          title={roster.ownerLabel}
          text={`${rosterLine(roster)}${roster.mine ? '' : ' · you can invite'}`}
          accessibilityLabel={`Invite them to ${roster.ownerLabel}`}
          disabled={disabled}
          value={offer.invite.has(roster.rosterId)}
          onChange={(on) => offer.toggleInvite(roster.rosterId, on)}
        />
      ))}
    </View>
  );
}

/** The question after ACKNOWLEDGE: what enrolling in their repeaters means, said first. */
export function PairingEnrollQuestion({
  rosters,
  chosen,
  onToggle,
  chrome,
}: {
  readonly rosters: readonly RosterView[];
  readonly chosen: ReadonlySet<string>;
  readonly onToggle: (rosterId: string, on: boolean) => void;
  readonly chrome: CryptidChrome;
}) {
  const only = rosters.length === 1 ? rosters[0] : null;
  return (
    <View style={styles.question}>
      <Text style={[styles.questionTitle, { color: chrome.ink }]}>
        {only
          ? `REPLICATE YOUR LOCATION ON ${ownerName(only).toUpperCase()}’S REPEATERS?`
          : 'REPLICATE YOUR LOCATION ON THEIR REPEATERS?'}
      </Text>
      {only ? (
        <Text style={[styles.detail, { color: chrome.steel }]}>
          {[rosterLine(only), vouchLine(only)].filter(Boolean).join(' · ')}
        </Text>
      ) : null}
      <FactList chrome={chrome} facts={enrollFacts(only ?? rosters[0])} />
      {only
        ? null
        : rosters.map((roster) => (
            <ToggleRow
              key={roster.rosterId}
              chrome={chrome}
              title={roster.ownerLabel}
              text={rosterLine(roster)}
              accessibilityLabel={`Carry my location on ${roster.ownerLabel}`}
              value={chosen.has(roster.rosterId)}
              onChange={(on) => onToggle(roster.rosterId, on)}
            />
          ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6, paddingHorizontal: 18, paddingTop: 14 },
  label: { fontFamily: 'IBMPlexMono_600SemiBold', fontSize: 10, letterSpacing: 1.2 },
  question: { gap: 8, paddingHorizontal: 18, paddingTop: 14 },
  questionTitle: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 11,
    letterSpacing: 1.1,
    lineHeight: 16,
  },
  detail: { fontFamily: 'IBMPlexMono_400Regular', fontSize: 11, lineHeight: 15 },
});
