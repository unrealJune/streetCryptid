import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { SettingsPage, SettingsSection } from '@/features/settings/components/settings-page';

import { AutoInviteSwitch } from '../components/auto-invite-switch';
import { useRepeaterChrome } from '../components/repeater-chrome';
import { RosterPeople } from '../components/roster-people';
import { inviteCandidates, rosterLine, type RosterView } from '../core/repeaters';
import { useRepeaters } from '../hooks/use-repeaters';

/**
 * Settings → Repeaters → People: who a roster carries and who may join it (REPEATERS.md §3.2).
 * Opened from a carrier's card on Settings → Repeaters (INVITE FRIENDS), as `?roster=<id>`;
 * without one, your own roster, whose people Your repeaters already lists in place.
 *
 * "Invite new friends" (auto-invite) is here, beside the invite lists it pre-fills at pairing.
 */
export default function RosterPeopleScreen() {
  const { chrome } = useRepeaterChrome();
  const repeaters = useRepeaters();
  const { sections } = repeaters;
  const params = useLocalSearchParams<{ roster?: string }>();
  const [error, setError] = useState<string | null>(null);

  const all = [
    sections.mine,
    ...sections.carryingMe,
    ...sections.throughFriends,
    ...sections.others,
  ];
  const roster: RosterView | null =
    (typeof params.roster === 'string'
      ? all.find((r) => r?.rosterId === params.roster)
      : sections.mine) ?? null;

  async function run(outcome: Promise<string | null>) {
    setError(null);
    const failure = await outcome;
    if (failure) setError(failure);
  }

  const mayAutoInvite = [sections.mine, ...sections.carryingMe].some(
    (r) => r?.canInvite && !r.open
  );

  return (
    <SettingsPage
      title="People"
      backLabel="Repeaters"
      subtitle={roster ? `${roster.ownerLabel} · ${rosterLine(roster)}` : undefined}
    >
      {error ? (
        <ThemedText accessibilityRole="alert" type="small" style={{ color: chrome.amber }}>
          {error}
        </ThemedText>
      ) : null}

      {roster ? (
        <SettingsSection label={roster.mine ? 'YOUR ROSTER' : 'THEIR ROSTER'}>
          <RosterPeople
            roster={roster}
            accent={chrome.green}
            warning={chrome.amber}
            busy={repeaters.busyRoster === roster.rosterId}
            owner={
              roster.mine && repeaters.ownerControls
                ? {
                    onRemoveMember: (member) =>
                      void run(repeaters.removeMember(roster.rosterId, member)),
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
        </SettingsSection>
      ) : repeaters.status === 'ready' ? (
        <ThemedText type="small" themeColor="textSecondary">
          This phone does not know that roster any more.
        </ThemedText>
      ) : null}

      {mayAutoInvite && repeaters.autoInvite !== null ? (
        <SettingsSection label="NEW FRIENDS">
          <AutoInviteSwitch
            value={repeaters.autoInvite}
            accent={chrome.green}
            onChange={(on) => void run(repeaters.setAutoInvite(on))}
          />
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
