import { useState } from 'react';
import { type Href, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { ThemedText } from '@/components/themed-text';
import { SettingsPage } from '@/features/settings/components/settings-page';
import { STASH_RETENTION_MS } from '@/features/social/core/delivery-mode';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';
import { useTheme } from '@/hooks/use-theme';

import { EnrollSheet } from '../components/enroll-sheet';
import {
  AddRow,
  Group,
  GroupCard,
  GroupRow,
  RowButton,
  RowSwitch,
} from '../components/grouped-list';
import { useRepeaterChrome } from '../components/repeater-chrome';
import { retentionWords, rosterRowDetail, type RosterView } from '../core/repeaters';
import { useRepeaters } from '../hooks/use-repeaters';

/**
 * Settings → Repeaters (REPEATERS.md §4.4): everything that may keep your sealed location for
 * friends while your phone sleeps, one row each, in the order a person decides about them.
 *
 * - WHO CARRIES YOUR LOCATION: the stash (its switch is the delivery mode, so this page and
 *   Settings → Delivery are one setting), your own roster (opening Your repeaters, where its
 *   machines, policy and people live), and every other roster that carries you. Off is a Withdraw.
 * - OFFERED: rosters on friends' cards (§4.2). On asks first, in a sheet that says what enrolling
 *   means; an invite-only roster nobody invited you to shows a lock instead of a switch.
 * - KNOWN TO THIS PHONE: everything else it has heard of.
 *
 * Nothing here gates reading: any phone may pull from any repeater (§2.1). What you opt into is
 * carrying. A scanned claim link no longer lands here — it opens the claim screen.
 */
export default function RepeatersScreen() {
  const { chrome } = useRepeaterChrome();
  const theme = useTheme();
  const router = useRouter();
  const repeaters = useRepeaters({ refreshNames: true });
  const { status, sections, error, busyRoster } = repeaters;
  const [actionError, setActionError] = useState<string | null>(null);
  const { snapshot, setDeliveryMode } = useLocationSharing();
  const [stashBusy, setStashBusy] = useState(false);
  const [asking, setAsking] = useState<RosterView | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

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
  }

  const addRepeater = () => router.push('/settings/repeaters/claim' as Href);
  const people = (rosterId: string) =>
    router.push(`/settings/repeaters/people?roster=${encodeURIComponent(rosterId)}` as Href);

  const stashRow = snapshot?.delivery.stashConfigured ? (
    <GroupRow
      first
      title="streetCryptid stash"
      detail={`hosted · ${retentionWords(STASH_RETENTION_MS)} · memory only`}
      right={
        <RowSwitch
          value={snapshot.delivery.mode === 'stash'}
          accent={chrome.green}
          disabled={stashBusy}
          accessibilityLabel="Carry my location on the streetCryptid stash"
          onChange={(carry) => {
            setStashBusy(true);
            void run(
              setDeliveryMode(carry ? 'stash' : 'mutual').then(
                () => null,
                () => 'Could not change the stash setting. Try again.'
              )
            ).finally(() => setStashBusy(false));
          }}
        />
      }
    />
  ) : null;

  const addCard = (
    <GroupCard>
      <AddRow first label="Add a repeater" accent={chrome.green} onPress={addRepeater} />
    </GroupCard>
  );

  if (status === 'unsupported') {
    return (
      <SettingsPage title="Repeaters">
        {stashRow ? (
          <Group label="Who carries your location">
            <GroupCard>{stashRow}</GroupCard>
          </Group>
        ) : null}
        <ThemedText type="small" themeColor="textSecondary">
          Repeaters need the installed app, on a build that has them.
        </ThemedText>
      </SettingsPage>
    );
  }

  const { mine } = sections;
  const offeredRow = (r: RosterView, first: boolean) => (
    <GroupRow
      key={r.rosterId}
      first={first}
      title={r.ownerLabel}
      detail={rosterRowDetail(r)}
      dimmed={!r.canEnroll}
      right={
        r.canEnroll ? (
          <RowSwitch
            value={false}
            accent={chrome.green}
            disabled={busyRoster === r.rosterId}
            accessibilityLabel={`Carry my location on ${r.ownerLabel}`}
            onChange={(on) => {
              if (on) {
                setAskError(null);
                setAsking(r);
              }
            }}
          />
        ) : (
          <SymbolView
            accessibilityLabel={
              r.open
                ? 'The owner removed you. Only a new invite lets you back.'
                : 'Invite only, and nobody has invited you'
            }
            name={{ ios: 'lock', android: 'lock', web: 'lock' }}
            size={15}
            tintColor={theme.textSecondary}
          />
        )
      }
    />
  );
  const offered = sections.throughFriends.filter((r) => r.canEnroll).length;

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

      {stashRow || mine || sections.carryingMe.length > 0 ? (
        <Group label="Who carries your location">
          <GroupCard>
            {stashRow}
            {mine ? (
              <GroupRow
                first={!stashRow}
                title="Your repeaters"
                detail={rosterRowDetail(mine)}
                onPress={() => router.push('/settings/repeaters/mine' as Href)}
                accessibilityLabel="Open your repeaters"
              />
            ) : null}
            {sections.carryingMe.map((r, i) => (
              <GroupRow
                key={r.rosterId}
                first={!stashRow && !mine && i === 0}
                title={r.ownerLabel}
                detail={rosterRowDetail(r)}
                right={
                  <>
                    {r.canInvite && repeaters.inviteControls ? (
                      <RowButton
                        label="INVITE"
                        color={chrome.green}
                        accessibilityLabel={`Invite friends to ${r.ownerLabel}`}
                        onPress={() => people(r.rosterId)}
                      />
                    ) : null}
                    <RowSwitch
                      value
                      accent={chrome.green}
                      disabled={busyRoster === r.rosterId}
                      accessibilityLabel={`Carry my location on ${r.ownerLabel}`}
                      onChange={(on) => {
                        if (!on) void run(repeaters.setCarried(r.rosterId, false));
                      }}
                    />
                  </>
                }
              />
            ))}
          </GroupCard>
        </Group>
      ) : null}

      {sections.throughFriends.length > 0 ? (
        <Group
          label="Offered"
          badge={offered > 0 ? `${offered} NEW` : undefined}
          badgeColor={chrome.amber}
        >
          <GroupCard>{sections.throughFriends.map((r, i) => offeredRow(r, i === 0))}</GroupCard>
        </Group>
      ) : null}

      {sections.others.length > 0 ? (
        <Group label="Known to this phone">
          <GroupCard>{sections.others.map((r, i) => offeredRow(r, i === 0))}</GroupCard>
        </Group>
      ) : null}

      {mine ? (
        addCard
      ) : (
        <Group label="Your repeaters">
          <GroupCard>
            <GroupRow
              first
              title="Add a repeater"
              text="Run trail-stash on a computer that stays on, then scan the code it shows."
              onPress={addRepeater}
            />
          </GroupCard>
        </Group>
      )}

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
