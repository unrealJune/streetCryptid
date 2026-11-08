import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { CryptidThemes } from '@/constants/theme';
import { SettingsPage, SettingsSection } from '@/features/settings/components/settings-page';
import { useColorScheme } from '@/hooks/use-color-scheme';

import { ClaimRepeaterForm } from '../components/claim-repeater-form';
import { RosterCard } from '../components/roster-card';
import { checkClaimLink, type RosterView } from '../core/repeaters';
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
 */
export default function RepeatersScreen() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const repeaters = useRepeaters();
  const { status, sections, error, busyRoster } = repeaters;
  const [actionError, setActionError] = useState<string | null>(null);
  const { claim } = useLocalSearchParams<{ claim?: string }>();
  const scanned = typeof claim === 'string' ? checkClaimLink(claim) : null;
  const initialLink = scanned?.ok ? scanned.link : undefined;

  async function run(outcome: Promise<string | null>) {
    setActionError(null);
    const failure = await outcome;
    if (failure) setActionError(failure);
  }

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
            }
          : undefined
      }
    />
  );

  if (status === 'unsupported') {
    return (
      <SettingsPage title="Repeaters">
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
