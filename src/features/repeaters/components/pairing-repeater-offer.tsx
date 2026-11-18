import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Spacing, type CryptidChrome } from '@/constants/theme';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import {
  enrollFacts,
  ownerName,
  pairingOffers,
  rosterLine,
  rosterSections,
  type PairingOffers,
  type RosterView,
} from '../core/repeaters';
import { getRepeaterClient } from '../net/repeater-client';

import { FactList, IslandPanel, PanelActions, PanelButton, ToggleRow } from './repeater-chrome';

/**
 * How often the offer is read again while a friend is on the pairing screen. Their offer arrives
 * by replication a moment after the pair completes (our key is wrapped for them then,
 * `pending_peers` in the core); one read at mount would miss it. A local read, never a dial.
 */
const OFFER_REFRESH_MS = 1500;

const NONE: PairingOffers = { mine: [], theirs: [] };

export interface PairingRepeaterOffer {
  readonly offers: PairingOffers;
  /** Of `offers.mine`, what goes to whoever this phone pairs with. All of it until switched off. */
  readonly offering: ReadonlySet<string>;
  setOffering(rosterId: string, on: boolean): void;
  /** Of `offers.theirs`, what I say yes to. All of it until switched off. */
  readonly accepting: ReadonlySet<string>;
  setAccepting(rosterId: string, on: boolean): void;
  /**
   * At ACKNOWLEDGE: invite the friend to what I offered, and say yes to what I accepted (enrolled
   * at once, or the moment their invite arrives). Never awaited: nothing a repeater does may stand
   * between someone keeping a friend and the app having kept them (REPEATERS.md §4.4).
   */
  apply(): void;
}

/**
 * The repeater choices at pairing (REPEATERS.md §4.4). Friending goes both ways, so both phones
 * do both halves:
 *
 * - **Mine**, chosen before the shake: every roster this phone may invite to, all on until
 *   switched off. The selection goes to the core (`setPairingRepeaterOffer`), which writes it into
 *   our sealed profile for the peer the moment the pair completes, so their reveal can show it.
 * - **Theirs**, answered on the reveal: what the friend chose to offer, all on until switched off.
 *
 * ACKNOWLEDGE does the rest ({@link PairingRepeaterOffer.apply}); there is no question after it.
 * Whatever the reveal did not settle stays under Settings → Repeaters → Offered.
 */
export function usePairingRepeaterOffer(
  friend: { readonly endpointId: string; readonly handle: string } | null
): PairingRepeaterOffer {
  const { snapshot } = useLocationSharing();
  const client = useMemo(() => getRepeaterClient(), []);
  const self = snapshot?.self?.endpointId ?? null;
  const friendId = friend?.endpointId ?? null;
  const friendHandle = friend?.handle ?? '';
  const [offers, setOffers] = useState<PairingOffers>(NONE);
  const [tick, setTick] = useState(0);
  // What was switched OFF, so a roster that turns up later starts switched on like the rest.
  const [declinedMine, setDeclinedMine] = useState<ReadonlySet<string>>(() => new Set());
  const [declinedTheirs, setDeclinedTheirs] = useState<{
    readonly friendId: string | null;
    readonly ids: ReadonlySet<string>;
  }>({ friendId: null, ids: new Set() });

  useEffect(() => {
    if (!client || !friendId) return;
    const timer = setInterval(() => setTick((n) => n + 1), OFFER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [client, friendId]);

  useEffect(() => {
    if (!client) return;
    let live = true;
    void (async () => {
      try {
        const rosters = await client.rosters();
        if (!live) return;
        const friends = friendId ? [{ endpointId: friendId, handle: friendHandle }] : [];
        const next = pairingOffers(rosterSections(rosters, friends, self), friendId);
        setOffers(client.invites ? next : { ...next, mine: [] });
      } catch {
        // Nothing to offer is the honest answer when the core cannot say.
      }
    })();
    return () => {
      live = false;
    };
  }, [client, friendId, friendHandle, self, tick]);

  const offering = useMemo(
    () => new Set(offers.mine.map((r) => r.rosterId).filter((id) => !declinedMine.has(id))),
    [offers.mine, declinedMine]
  );
  const theirsDeclined = declinedTheirs.friendId === friendId ? declinedTheirs.ids : null;
  const accepting = useMemo(
    () => new Set(offers.theirs.map((r) => r.rosterId).filter((id) => !theirsDeclined?.has(id))),
    [offers.theirs, theirsDeclined]
  );

  // The core offers this to whoever we pair with next, and to anyone already waiting on our
  // ACKNOWLEDGE. A string key, so an unchanged selection is not sent again on every read.
  const offeringKey = [...offering].sort().join(',');
  useEffect(() => {
    const pairing = client?.pairing;
    if (!pairing) return;
    void pairing.setOffer(offeringKey ? offeringKey.split(',') : []).catch(() => undefined);
  }, [client, offeringKey]);

  const setOffering = useCallback((rosterId: string, on: boolean) => {
    setDeclinedMine((was) => {
      const next = new Set(was);
      if (on) next.delete(rosterId);
      else next.add(rosterId);
      return next;
    });
  }, []);

  const setAccepting = useCallback(
    (rosterId: string, on: boolean) => {
      setDeclinedTheirs((was) => {
        const next = new Set(was.friendId === friendId ? was.ids : []);
        if (on) next.delete(rosterId);
        else next.add(rosterId);
        return { friendId, ids: next };
      });
    },
    [friendId]
  );

  const apply = useCallback(() => {
    if (!client || !friendId) return;
    const invites = client.invites;
    if (invites) {
      for (const roster of offers.mine) {
        if (offering.has(roster.rosterId)) {
          void invites.invite(roster.rosterId, friendId).catch(() => undefined);
        }
      }
    }
    const pairing = client.pairing;
    if (pairing) {
      for (const roster of offers.theirs) {
        if (accepting.has(roster.rosterId)) {
          void pairing.want(roster.rosterId, true).catch(() => undefined);
        }
      }
    }
  }, [accepting, client, friendId, offering, offers.mine, offers.theirs]);

  return { offers, offering, setOffering, accepting, setAccepting, apply };
}

/**
 * The repeater cards on the pairing screen: MY REPEATERS from before the shake, THEIR REPEATERS
 * once a friend's offer has arrived. Each opens {@link RosterPickSheet}. Nothing when there is
 * nothing on either side.
 */
export function PairingRepeaterCards({
  offer,
  chrome,
  friendLabel,
  disabled,
}: {
  readonly offer: PairingRepeaterOffer;
  readonly chrome: CryptidChrome;
  /** The friend on the reveal, or `null` before a pair. */
  readonly friendLabel: string | null;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = useState<'mine' | 'theirs' | null>(null);
  const { mine, theirs } = offer.offers;
  if (mine.length === 0 && theirs.length === 0) return null;
  const from = friendLabel ?? 'They';
  return (
    <View style={styles.cards}>
      {friendLabel && theirs.length > 0 ? (
        <OfferCard
          chrome={chrome}
          label="THEIR REPEATERS"
          text={`${from} is sharing ${count(theirs.length)}. You’re joining ${offer.accepting.size}.`}
          accent
          disabled={disabled}
          onPress={() => setOpen('theirs')}
        />
      ) : null}
      {mine.length > 0 ? (
        <OfferCard
          chrome={chrome}
          label="SHARE REPEATERS"
          text={
            offer.offering.size === 0
              ? 'Sharing none'
              : `Sharing ${offer.offering.size} of ${count(mine.length)}`
          }
          disabled={disabled}
          onPress={() => setOpen('mine')}
        />
      ) : null}
      <RosterPickSheet
        visible={open === 'mine'}
        chrome={chrome}
        title={
          friendLabel ? `SHARE REPEATERS WITH ${friendLabel.toUpperCase()}` : 'SHARE REPEATERS'
        }
        detail={`Invite ${friendLabel ?? 'whoever you pair with'} to repeaters you use. They choose whether to join, once you acknowledge.`}
        rosters={mine}
        chosen={offer.offering}
        onToggle={offer.setOffering}
        onDone={() => setOpen(null)}
        rowText={(roster) => rosterLine(roster)}
      />
      <RosterPickSheet
        visible={open === 'theirs'}
        chrome={chrome}
        title={`CARRY YOUR LOCATION ON ${from.toUpperCase()}’S REPEATERS?`}
        detail="Starts when you acknowledge. Invite-only ones start once their invite arrives."
        rosters={theirs}
        chosen={offer.accepting}
        onToggle={offer.setAccepting}
        onDone={() => setOpen(null)}
        rowText={(roster) => rosterLine(roster)}
        facts={theirs[0]}
      />
    </View>
  );
}

function count(n: number): string {
  return `${n} ${n === 1 ? 'repeater group' : 'repeater groups'}`;
}

function OfferCard({
  chrome,
  label,
  text,
  accent = false,
  disabled,
  onPress,
}: {
  readonly chrome: CryptidChrome;
  readonly label: string;
  readonly text: string;
  readonly accent?: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${text}. Choose`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          borderColor: accent ? chrome.green : chrome.hairline,
          opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <View style={styles.cardCopy}>
        <Text style={[styles.label, { color: accent ? chrome.green : chrome.steel }]}>{label}</Text>
        <Text style={[styles.cardText, { color: chrome.ink }]}>{text}</Text>
      </View>
      <Text style={[styles.chevron, { color: chrome.steel }]}>{'›'}</Text>
    </Pressable>
  );
}

/**
 * A drawer of repeater groups with a switch each: what to offer before pairing, and what to
 * accept of someone's offer on the reveal. The same list on both phones, so each person sees
 * exactly what the other chose from.
 */
export function RosterPickSheet({
  visible,
  chrome,
  title,
  detail,
  rosters,
  chosen,
  onToggle,
  onDone,
  rowText,
  facts,
}: {
  readonly visible: boolean;
  readonly chrome: CryptidChrome;
  readonly title: string;
  readonly detail: string;
  readonly rosters: readonly RosterView[];
  readonly chosen: ReadonlySet<string>;
  readonly onToggle: (rosterId: string, on: boolean) => void;
  readonly onDone: () => void;
  readonly rowText: (roster: RosterView) => string;
  /** What carrying means, said once: shown when the drawer is about enrolling. */
  readonly facts?: RosterView;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      animationType="slide"
      onRequestClose={onDone}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={[styles.scrim, { backgroundColor: chrome.scrim }]}>
        <Pressable
          accessibilityLabel="Done"
          accessibilityRole="button"
          onPress={onDone}
          style={StyleSheet.absoluteFill}
        />
        <IslandPanel
          chrome={chrome}
          status={title}
          statusColor={chrome.ink}
          detail={detail}
          marginBottom={Math.max(insets.bottom, Spacing.two)}
        >
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {facts ? <FactList chrome={chrome} facts={enrollFacts(facts)} /> : null}
            {rosters.map((roster) => (
              <ToggleRow
                key={roster.rosterId}
                chrome={chrome}
                title={roster.mine ? 'Your repeaters' : `${ownerName(roster)}’s repeaters`}
                text={rowText(roster)}
                accessibilityLabel={roster.ownerLabel}
                value={chosen.has(roster.rosterId)}
                onChange={(on) => onToggle(roster.rosterId, on)}
              />
            ))}
          </ScrollView>
          <PanelActions>
            <PanelButton chrome={chrome} label="DONE" onPress={onDone} />
          </PanelActions>
        </IslandPanel>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  cards: { gap: 8, paddingHorizontal: 18, paddingTop: 14 },
  card: {
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  cardCopy: { flex: 1, gap: 2 },
  label: { fontFamily: 'IBMPlexMono_600SemiBold', fontSize: 10, letterSpacing: 1.2 },
  cardText: { fontFamily: 'IBMPlexMono_400Regular', fontSize: 12, lineHeight: 16 },
  chevron: { fontSize: 22, lineHeight: 24 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  list: { maxHeight: 360 },
  listContent: { gap: 6 },
});
