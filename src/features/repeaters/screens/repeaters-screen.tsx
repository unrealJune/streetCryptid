import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { CryptidThemes, Spacing } from '@/constants/theme';
import { SettingsPage, SettingsSection } from '@/features/settings/components/settings-page';
import { STASH_RETENTION_MS } from '@/features/social/core/delivery-mode';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';
import { useColorScheme } from '@/hooks/use-color-scheme';

import { ClaimRepeaterForm } from '../components/claim-repeater-form';
import { RosterCard } from '../components/roster-card';
import { StashCard } from '../components/stash-card';
import {
  checkClaimLink,
  inviteCandidates,
  retentionWords,
  type RosterView,
} from '../core/repeaters';
import { useRepeaters } from '../hooks/use-repeaters';

/**
 * Settings → Repeaters (REPEATERS.md §4.4): the machines you own, whose repeaters carry your
 * trail, and the rosters this phone knows of that do not. A repeater is a computer that keeps
 * sealed trails it cannot read, so friends get yours while your phone sleeps.
 *
 * A scanned claim QR code lands here as `?claim=` (see `+native-intent.tsx`), filled into the
 * form but not claimed: the claim is where the roster's policy is chosen.
 *
 * "Available through friends" is every roster a friend's repeater card vouches for (REPEATERS.md
 * §4.2): friends publish the rosters they own or are carried by, and reading the settings reads
 * their cards. Turning carrying on there is enrolling, the same switch as everywhere else.
 *
 * The hosted stash sits at the top, as the carve-out it is: ownerless, rosterless, forgetting on a
 * clock. Its switch is the delivery mode, so this page and Settings → Delivery are one setting.
 */
export default function RepeatersScreen() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const repeaters = useRepeaters();
  const { status, sections, error, busyRoster } = repeaters;
  const [actionError, setActionError] = useState<string | null>(null);
  const { snapshot, setDeliveryMode } = useLocationSharing();
  const [stashBusy, setStashBusy] = useState(false);
  const { claim } = useLocalSearchParams<{ claim?: string }>();
  const scanned = typeof claim === 'string' ? checkClaimLink(claim) : null;
  const initialLink = scanned?.ok ? scanned.link : undefined;

  async function run(outcome: Promise<string | null>) {
    setActionError(null);
    const failure = await outcome;
    if (failure) setActionError(failure);
  }

  const stash = snapshot?.delivery.stashConfigured ? (
    <SettingsSection label="STASH">
      <StashCard
        carriesMe={snapshot.delivery.mode === 'stash'}
        retention={retentionWords(STASH_RETENTION_MS)}
        accent={chrome.green}
        busy={stashBusy}
        onCarryChange={(carry) => {
          setStashBusy(true);
          void run(
            setDeliveryMode(carry ? 'stash' : 'mutual').then(
              () => null,
              () => 'Could not change the stash setting. Try again.'
            )
          ).finally(() => setStashBusy(false));
        }}
      />
    </SettingsSection>
  ) : null;

  const card = (roster: RosterView) => (
    <RosterCard
      key={roster.rosterId}
      roster={roster}
      accent={chrome.green}
      warning={chrome.amber}
      busy={busyRoster === roster.rosterId}
      onCarryChange={(carry) => void run(repeaters.setCarried(roster.rosterId, carry))}
      owner={
        roster.mine && repeaters.ownerControls
          ? {
              onPolicyChange: (open) => void run(repeaters.setPolicy(roster.rosterId, open)),
              onRemoveMember: (member) => void run(repeaters.removeMember(roster.rosterId, member)),
              onRemoveMachine: (machine) =>
                void run(repeaters.removeMachine(roster.rosterId, machine)),
              onSetInviter: repeaters.inviteControls
                ? (member, inviter) =>
                    void run(repeaters.setInviter(roster.rosterId, member, inviter))
                : undefined,
            }
          : undefined
      }
      invite={
        roster.canInvite && repeaters.inviteControls
          ? {
              candidates: inviteCandidates(roster, repeaters.friends),
              onInvite: (member) => void run(repeaters.invite(roster.rosterId, member)),
            }
          : undefined
      }
    />
  );
  const mayInvite = [sections.mine, ...sections.carryingMe].some((r) => r?.canInvite && !r.open);

  if (status === 'unsupported') {
    return (
      <SettingsPage title="Repeaters">
        {stash}
        <ThemedText type="small" themeColor="textSecondary">
          Repeaters need the installed app, on a build that has them.
        </ThemedText>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Repeaters"
      subtitle="Computers that keep your sealed trail for friends while your phone sleeps. They can never read it."
    >
      {error || actionError ? (
        <ThemedText accessibilityRole="alert" type="small" style={{ color: chrome.amber }}>
          {actionError ?? error}
        </ThemedText>
      ) : null}

      {stash}

      <SettingsSection label="MY REPEATERS">
        {sections.mine ? card(sections.mine) : null}
        <ClaimRepeaterForm
          // A second scan while the page is open replaces what the first one filled in.
          key={initialLink ?? 'none'}
          accent={chrome.green}
          warning={chrome.amber}
          firstRepeater={sections.mine === null}
          initialLink={initialLink}
          onClaim={repeaters.claim}
        />
      </SettingsSection>

      {mayInvite && repeaters.autoInvite !== null ? (
        <SettingsSection label="NEW FRIENDS">
          <View style={styles.option}>
            <View style={styles.copy}>
              <ThemedText type="small">Invite new friends</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                When you pair, offer to invite them to the invite-only repeaters you can invite to.
                They still choose whether their trail is carried.
              </ThemedText>
            </View>
            <Switch
              accessibilityRole="switch"
              accessibilityLabel="Invite new friends to my repeaters"
              value={repeaters.autoInvite}
              onValueChange={(on) => void run(repeaters.setAutoInvite(on))}
              trackColor={{ true: chrome.green, false: chrome.steel }}
            />
          </View>
        </SettingsSection>
      ) : null}

      {sections.carryingMe.length > 0 ? (
        <SettingsSection label="CARRYING MY TRAIL">{sections.carryingMe.map(card)}</SettingsSection>
      ) : null}

      {sections.throughFriends.length > 0 ? (
        <SettingsSection label="AVAILABLE THROUGH FRIENDS">
          {sections.throughFriends.map(card)}
        </SettingsSection>
      ) : null}

      {sections.others.length > 0 ? (
        <SettingsSection label="KNOWN TO THIS PHONE">{sections.others.map(card)}</SettingsSection>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
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
