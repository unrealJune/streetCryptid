import { useState } from 'react';
import { type Href, useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { SettingsPage, SettingsSection } from '@/features/settings/components/settings-page';

import { AutoInviteSwitch } from '../components/auto-invite-switch';
import { OptionSwitch } from '../components/option-switch';
import { useRepeaterChrome } from '../components/repeater-chrome';
import { RosterMachines } from '../components/roster-machines';
import { RosterPeople } from '../components/roster-people';
import { inviteCandidates, rosterLine } from '../core/repeaters';
import { useRepeaters } from '../hooks/use-repeaters';

/**
 * Settings → Repeaters → Your repeaters: everything about the roster this phone owns, on one page
 * (REPEATERS.md §4.4), in the order a person decides about it — whether it carries you, which
 * machines are in it, who may join, and who it carries.
 *
 * People live here rather than on their own page because they are the roster's, the same as its
 * machines and its policy; the People page remains for other people's rosters this phone may
 * invite to. Every control is what the roster rules allow the owner (§3.2): REMOVE takes a machine
 * out (it then releases itself and shows a new claim code), the policy never drops anyone already
 * carried, and an invite carries nobody by itself.
 */
export default function MyRepeatersScreen() {
  const { chrome } = useRepeaterChrome();
  const router = useRouter();
  const repeaters = useRepeaters({ refreshNames: true });
  const mine = repeaters.sections.mine;
  const [error, setError] = useState<string | null>(null);

  async function run(outcome: Promise<string | null>) {
    setError(null);
    const failure = await outcome;
    if (failure) setError(failure);
  }

  const addRepeater = () => router.push('/settings/repeaters/claim' as Href);

  if (!mine) {
    return (
      <SettingsPage title="Your repeaters" backLabel="Repeaters">
        {repeaters.status === 'ready' ? (
          <SettingsSection label="MACHINES">
            <ThemedText type="small" themeColor="textSecondary">
              You have no repeaters yet. Run trail-stash on a computer that stays on, then scan the
              code it shows.
            </ThemedText>
          </SettingsSection>
        ) : null}
      </SettingsPage>
    );
  }

  const busy = repeaters.busyRoster === mine.rosterId;
  const errorText = error ?? repeaters.error;

  return (
    <SettingsPage title="Your repeaters" backLabel="Repeaters" subtitle={rosterLine(mine)}>
      {errorText ? (
        <ThemedText accessibilityRole="alert" type="small" style={{ color: chrome.amber }}>
          {errorText}
        </ThemedText>
      ) : null}

      <SettingsSection label="YOUR LOCATION">
        <OptionSwitch
          title="Carry my location"
          text={
            mine.carriesMe
              ? 'Kept on these machines, sealed, for friends to pick up while your phone sleeps.'
              : 'Off. These machines do not keep your location.'
          }
          accessibilityLabel="Carry my location on your repeaters"
          value={mine.carriesMe}
          accent={chrome.green}
          disabled={busy}
          onChange={(carry) => void run(repeaters.setCarried(mine.rosterId, carry))}
        />
      </SettingsSection>

      <SettingsSection label="MACHINES">
        <RosterMachines
          roster={mine}
          accent={chrome.green}
          warning={chrome.amber}
          busy={busy}
          onRemove={
            repeaters.ownerControls
              ? (machine) => void run(repeaters.removeMachine(mine.rosterId, machine))
              : undefined
          }
          onAdd={addRepeater}
        />
      </SettingsSection>

      {repeaters.ownerControls ? (
        <SettingsSection label="WHO CAN JOIN">
          <OptionSwitch
            title="Open to anyone"
            text={
              mine.open
                ? 'Anyone who learns of it may ask it to carry them.'
                : 'Only people you invite. Nobody already carried is dropped.'
            }
            value={mine.open}
            accent={chrome.green}
            disabled={busy}
            onChange={(open) => void run(repeaters.setPolicy(mine.rosterId, open))}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection label="PEOPLE">
        <RosterPeople
          roster={mine}
          accent={chrome.green}
          warning={chrome.amber}
          busy={busy}
          owner={
            repeaters.ownerControls
              ? {
                  onRemoveMember: (member) =>
                    void run(repeaters.removeMember(mine.rosterId, member)),
                  onSetInviter: repeaters.inviteControls
                    ? (member, inviter) =>
                        void run(repeaters.setInviter(mine.rosterId, member, inviter))
                    : undefined,
                }
              : undefined
          }
          invite={
            repeaters.inviteControls
              ? {
                  candidates: inviteCandidates(mine, repeaters.friends),
                  onInvite: (member) => void run(repeaters.invite(mine.rosterId, member)),
                }
              : undefined
          }
        />
        {!mine.open && repeaters.autoInvite !== null ? (
          <AutoInviteSwitch
            value={repeaters.autoInvite}
            accent={chrome.green}
            onChange={(on) => void run(repeaters.setAutoInvite(on))}
          />
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
