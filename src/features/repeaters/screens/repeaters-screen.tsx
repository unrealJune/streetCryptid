import { useState } from 'react';
import { type Href, useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { SettingsPage, SettingsSection } from '@/features/settings/components/settings-page';
import { STASH_RETENTION_MS } from '@/features/social/core/delivery-mode';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import { EnrollSheet } from '../components/enroll-sheet';
import { RepeaterCard } from '../components/repeater-card';
import { useRepeaterChrome } from '../components/repeater-chrome';
import { StashCard } from '../components/stash-card';
import { retentionWords, rosterLine, vouchLine, type RosterView } from '../core/repeaters';
import { useRepeaters } from '../hooks/use-repeaters';

/**
 * Settings → Repeaters (REPEATERS.md §4.4): everything that may keep your sealed location for
 * friends while your phone sleeps, in the order a person decides about them.
 *
 * - STASH: the hosted one, owned by nobody (§5.1). Its switch is the delivery mode, so this page
 *   and Settings → Delivery are one setting.
 * - MY REPEATERS: your roster, opening the roster map (machines, policy) and its people; or a way
 *   to add your first machine.
 * - CARRYING MY LOCATION: other people's rosters you are enrolled in. Off is a Withdraw.
 * - AVAILABLE THROUGH FRIENDS: rosters on friends' cards (§4.2). On asks first, in a sheet that
 *   says what enrolling means; an invite-only roster nobody invited you to says so instead.
 *
 * Nothing here gates reading: any phone may pull from any repeater (§2.1). What you opt into is
 * carrying. A scanned claim link no longer lands here — it opens the claim screen.
 */
export default function RepeatersScreen() {
  const { chrome } = useRepeaterChrome();
  const router = useRouter();
  const repeaters = useRepeaters();
  const { status, sections, error, busyRoster } = repeaters;
  const [actionError, setActionError] = useState<string | null>(null);
  const { snapshot, setDeliveryMode } = useLocationSharing();
  const [stashBusy, setStashBusy] = useState(false);
  const [asking, setAsking] = useState<RosterView | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [justEnrolled, setJustEnrolled] = useState<string | null>(null);

  async function run(outcome: Promise<string | null>) {
    setActionError(null);
    const failure = await outcome;
    if (failure) setActionError(failure);
  }

  async function enroll(roster: RosterView) {
    setAskError(null);
    const failure = await repeaters.setCarried(roster.rosterId, true);
    if (failure) {
      setAskError(failure);
      return;
    }
    setAsking(null);
    setJustEnrolled(roster.rosterId);
  }

  const people = (rosterId: string) =>
    router.push(`/settings/repeaters/people?roster=${encodeURIComponent(rosterId)}` as Href);

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

  const machineLine = (r: RosterView) => r.machines.map((m) => m.short).join('  ');

  const carryingCard = (r: RosterView) => (
    <RepeaterCard
      key={r.rosterId}
      title={r.ownerLabel}
      lines={[rosterLine(r), machineLine(r)]}
      accent={chrome.green}
      highlighted={justEnrolled === r.rosterId}
      link={
        r.canInvite && repeaters.inviteControls
          ? { label: 'Invite friends', onPress: () => people(r.rosterId) }
          : undefined
      }
      carry={{
        value: true,
        text: 'Kept on these machines, sealed, for friends to pick up while your phone sleeps.',
        disabled: busyRoster === r.rosterId,
        accessibilityLabel: `Carry my location on ${r.ownerLabel}`,
        onChange: (on) => {
          if (!on) void run(repeaters.setCarried(r.rosterId, false));
        },
      }}
    />
  );

  const offeredCard = (r: RosterView) => (
    <RepeaterCard
      key={r.rosterId}
      title={r.ownerLabel}
      lines={[rosterLine(r), vouchLine(r), machineLine(r)].filter((l): l is string => !!l)}
      accent={chrome.green}
      highlighted={asking?.rosterId === r.rosterId}
      carry={
        r.canEnroll
          ? {
              value: false,
              text: 'Off. These machines do not keep your location.',
              disabled: busyRoster === r.rosterId,
              accessibilityLabel: `Carry my location on ${r.ownerLabel}`,
              onChange: (on) => {
                if (on) {
                  setAskError(null);
                  setAsking(r);
                }
              },
            }
          : {
              value: false,
              locked: true,
              text: 'Invite only, and nobody has invited you yet.',
              accessibilityLabel: `Carry my location on ${r.ownerLabel}`,
              onChange: () => undefined,
            }
      }
    />
  );

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

  const mine = sections.mine;
  return (
    <SettingsPage
      title="Repeaters"
      subtitle="Computers that keep your sealed location for friends while your phone sleeps. They can never read it."
    >
      {error || actionError ? (
        <ThemedText accessibilityRole="alert" type="small" style={{ color: chrome.amber }}>
          {actionError ?? error}
        </ThemedText>
      ) : null}

      {stash}

      <SettingsSection label="MY REPEATERS">
        {mine ? (
          <RepeaterCard
            title="Your repeaters"
            lines={[
              `${rosterLine(mine)}${mine.carriesMe ? '' : ' · not carrying you'}`,
              machineLine(mine),
            ]}
            accent={chrome.green}
            onOpen={() => router.push('/settings/repeaters/roster' as Href)}
            openLabel="Open your roster"
            link={{ label: 'People', onPress: () => people(mine.rosterId) }}
          />
        ) : (
          <RepeaterCard
            title="Add a repeater"
            lines={[
              'Run trail-stash on a computer that stays on, then scan the code it shows.',
            ]}
            accent={chrome.green}
            onOpen={() => router.push('/settings/repeaters/claim' as Href)}
            openLabel="Add a repeater"
            link={
              sections.carryingMe.length + sections.throughFriends.length > 0
                ? {
                    label: 'See the roster map',
                    onPress: () => router.push('/settings/repeaters/roster' as Href),
                  }
                : undefined
            }
          />
        )}
      </SettingsSection>

      {sections.carryingMe.length > 0 ? (
        <SettingsSection label="CARRYING MY LOCATION">
          {sections.carryingMe.map(carryingCard)}
        </SettingsSection>
      ) : null}

      {sections.throughFriends.length > 0 ? (
        <SettingsSection label="AVAILABLE THROUGH FRIENDS">
          {sections.throughFriends.map(offeredCard)}
        </SettingsSection>
      ) : null}

      {sections.others.length > 0 ? (
        <SettingsSection label="KNOWN TO THIS PHONE">
          {sections.others.map(offeredCard)}
        </SettingsSection>
      ) : null}

      <EnrollSheet
        roster={asking}
        busy={asking !== null && busyRoster === asking.rosterId}
        error={askError}
        onEnroll={() => asking && void enroll(asking)}
        onDismiss={() => setAsking(null)}
      />
    </SettingsPage>
  );
}
