import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import { pairingOffers, rosterSections, type PairingOffers } from '../core/repeaters';
import { getRepeaterClient } from '../net/repeater-client';

export interface PairingRepeaterOffer {
  readonly offers: PairingOffers;
  /** Rosters the person chose to enrol in. */
  readonly enrol: ReadonlySet<string>;
  readonly invite: boolean;
  toggleEnrol(rosterId: string, on: boolean): void;
  setInvite(on: boolean): void;
  /**
   * Carry out the choices. Called once the pair is acknowledged, and never awaited: like
   * everything else at ACKNOWLEDGE (`connectNewFriend`), nothing a repeater does may stand between
   * someone keeping a friend and the app having kept them (REPEATERS.md §4.4).
   */
  apply(): void;
}

const NONE: PairingOffers = { enrol: [], canInvite: false };

/**
 * The repeater question at pairing (REPEATERS.md §4.4): enrol in the new friend's rosters, and
 * invite them to mine. Read from the rosters this phone already knows, including the friend's
 * card if it arrived with the pair; when it has not, there is nothing to ask here and the roster
 * shows up later under Settings → Repeaters → Available through friends.
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
          offers: { ...next, canInvite: next.canInvite && client.invites !== null },
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
  const enrol = mine.enrol;
  // Pre-checked when auto-invite is on, until the person says otherwise.
  const invite = offers.canInvite && (mine.invite ?? current?.auto ?? false);

  const toggleEnrol = useCallback(
    (rosterId: string, on: boolean) => {
      setPicked((was) => {
        const base = was.friendId === friendId ? was : { ...UNPICKED, friendId };
        const next = new Set(base.enrol);
        if (on) next.add(rosterId);
        else next.delete(rosterId);
        return { ...base, enrol: next };
      });
    },
    [friendId]
  );

  const setInvite = useCallback(
    (on: boolean) => {
      setPicked((was) => ({
        ...(was.friendId === friendId ? was : { ...UNPICKED, friendId }),
        invite: on,
      }));
    },
    [friendId]
  );

  const apply = useCallback(() => {
    if (!client || !friendId) return;
    for (const rosterId of enrol) {
      void client.setCarried(rosterId, true).catch(() => undefined);
    }
    if (invite && client.invites) {
      void client.invites.inviteFriend(friendId).catch(() => undefined);
    }
  }, [client, friendId, enrol, invite]);

  return { offers, enrol, invite, toggleEnrol, setInvite, apply };
}

interface Loaded {
  readonly friendId: string;
  readonly offers: PairingOffers;
  /** The auto-invite preference, which pre-checks the invite. */
  readonly auto: boolean;
}

interface Picked {
  readonly friendId: string | null;
  readonly enrol: ReadonlySet<string>;
  /** `null` until the person touches the switch. */
  readonly invite: boolean | null;
}

const UNPICKED: Picked = { friendId: null, enrol: new Set(), invite: null };

/** The switches for {@link usePairingRepeaterOffer}; renders nothing when there is nothing to ask. */
export function PairingRepeaterOfferView({
  offer,
  friendHandle,
  accent,
  disabled,
}: {
  readonly offer: PairingRepeaterOffer;
  readonly friendHandle: string;
  readonly accent: string;
  readonly disabled: boolean;
}) {
  const theme = useTheme();
  const { offers, enrol, invite } = offer;
  if (offers.enrol.length === 0 && !offers.canInvite) return null;
  return (
    <View style={[styles.box, { borderColor: theme.backgroundSelected }]}>
      {offers.enrol.map((roster) => (
        <View key={roster.rosterId} style={styles.option}>
          <View style={styles.copy}>
            <ThemedText type="small">{`Replicate your trail on ${roster.ownerLabel}?`}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Kept sealed on their machines while your phone sleeps. You can stop any time.
            </ThemedText>
          </View>
          <Switch
            accessibilityRole="switch"
            accessibilityLabel={`Carry my trail on ${roster.ownerLabel}`}
            disabled={disabled}
            value={enrol.has(roster.rosterId)}
            onValueChange={(on) => offer.toggleEnrol(roster.rosterId, on)}
            trackColor={{ true: accent, false: theme.backgroundSelected }}
          />
        </View>
      ))}
      {offers.canInvite ? (
        <View style={styles.option}>
          <View style={styles.copy}>
            <ThemedText type="small">Also invite them to my repeaters</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {`${friendHandle} can then choose to have their trail carried there.`}
            </ThemedText>
          </View>
          <Switch
            accessibilityRole="switch"
            accessibilityLabel={`Invite ${friendHandle} to my repeaters`}
            disabled={disabled}
            value={invite}
            onValueChange={offer.setInvite}
            trackColor={{ true: accent, false: theme.backgroundSelected }}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignSelf: 'stretch',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.three,
    padding: Spacing.three,
  },
  option: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
});
