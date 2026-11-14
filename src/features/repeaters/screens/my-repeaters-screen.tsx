import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { type Href, useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { SettingsPage } from '@/features/settings/components/settings-page';

import {
  AddRow,
  Group,
  GroupCard,
  GroupRow,
  RowButton,
  RowSwitch,
  Segmented,
} from '../components/grouped-list';
import { useRepeaterChrome } from '../components/repeater-chrome';
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
 * carried, and an invite carries nobody by itself. Every removal asks once, in the row.
 */
export default function MyRepeatersScreen() {
  const { chrome } = useRepeaterChrome();
  const router = useRouter();
  const repeaters = useRepeaters({ refreshNames: true });
  const mine = repeaters.sections.mine;
  const [error, setError] = useState<string | null>(null);
  /** The machine or person whose REMOVE is waiting for a second tap. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** The person whose actions are open under their row. */
  const [opened, setOpened] = useState<string | null>(null);

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
          <Group label="Machines">
            <GroupCard>
              <GroupRow
                first
                title="No repeaters yet"
                text="Run trail-stash on a computer that stays on, then scan the code it shows."
              />
              <AddRow label="Add a repeater" accent={chrome.green} onPress={addRepeater} />
            </GroupCard>
          </Group>
        ) : null}
      </SettingsPage>
    );
  }

  const busy = repeaters.busyRoster === mine.rosterId;
  const errorText = error ?? repeaters.error;
  const owner = repeaters.ownerControls;
  const others = mine.members.filter((m) => !m.isMe);
  const candidates = repeaters.inviteControls ? inviteCandidates(mine, repeaters.friends) : [];

  /** CANCEL / CONFIRM under a row whose REMOVE was tapped once. */
  const confirmBelow = (key: string, copy: string, label: string, onConfirm: () => void) =>
    confirming === key ? (
      <View style={styles.confirm}>
        <ThemedText accessibilityRole="alert" type="small" themeColor="textSecondary">
          {copy}
        </ThemedText>
        <View style={styles.actions}>
          <RowButton label="CANCEL" onPress={() => setConfirming(null)} />
          <RowButton
            label="CONFIRM REMOVE"
            color={chrome.amber}
            borderColor={chrome.amber}
            disabled={busy}
            accessibilityLabel={`Confirm: ${label}`}
            onPress={() => {
              setConfirming(null);
              onConfirm();
            }}
          />
        </View>
      </View>
    ) : null;

  return (
    <SettingsPage title="Your repeaters" backLabel="Repeaters" subtitle={rosterLine(mine)}>
      {errorText ? (
        <ThemedText accessibilityRole="alert" type="small" style={{ color: chrome.amber }}>
          {errorText}
        </ThemedText>
      ) : null}

      <GroupCard>
        <GroupRow
          first
          title="Carry my location"
          text={
            mine.carriesMe
              ? 'On these machines, sealed, for friends to pick up while your phone sleeps.'
              : 'Off. These machines do not keep your location.'
          }
          right={
            <RowSwitch
              value={mine.carriesMe}
              accent={chrome.green}
              disabled={busy}
              accessibilityLabel="Carry my location on your repeaters"
              onChange={(carry) => void run(repeaters.setCarried(mine.rosterId, carry))}
            />
          }
        />
      </GroupCard>

      <Group label={`Machines · ${mine.machines.length}`}>
        <GroupCard>
          {mine.machines.map((machine, i) => {
            const key = `machine:${machine.id}`;
            const label = `Remove machine ${machine.label}`;
            return (
              <GroupRow
                key={machine.id}
                first={i === 0}
                title={machine.label}
                detail={machine.name ? machine.short : null}
                right={
                  owner && confirming !== key ? (
                    <RowButton
                      label="REMOVE"
                      color={chrome.amber}
                      disabled={busy}
                      accessibilityLabel={label}
                      onPress={() => setConfirming(key)}
                    />
                  ) : null
                }
                below={confirmBelow(
                  key,
                  'Once it hears, it stops carrying anyone and shows a new claim code. Getting it back means claiming it again.',
                  label,
                  () => void run(repeaters.removeMachine(mine.rosterId, machine.id))
                )}
              />
            );
          })}
          <AddRow
            first={mine.machines.length === 0}
            label="Add a machine"
            accent={chrome.green}
            onPress={addRepeater}
          />
        </GroupCard>
      </Group>

      {owner ? (
        <Group label="Who can join">
          <Segmented
            accessibilityLabel="Who can join"
            value={mine.open ? 'open' : 'invite'}
            options={[
              { value: 'invite', label: 'Invite only' },
              { value: 'open', label: 'Anyone' },
            ]}
            disabled={busy}
            onChange={(next) => void run(repeaters.setPolicy(mine.rosterId, next === 'open'))}
          />
          <ThemedText type="small" themeColor="textSecondary">
            {mine.open
              ? 'Anyone who learns of it may ask it to carry them.'
              : 'Only people you invite. Nobody already carried is dropped.'}
          </ThemedText>
        </Group>
      ) : null}

      <Group label={`People · ${mine.carried} carried`}>
        <GroupCard>
          {mine.members.some((m) => m.isMe) ? <GroupRow first title="You" /> : null}
          {mine.members.length === 0 ? (
            <GroupRow
              first
              title={mine.carried > 0 ? `${mine.carried} people` : 'Nobody yet'}
              dimmed
            />
          ) : null}
          {others.map((member, i) => {
            const inviter = mine.inviters.some((p) => p.id === member.id);
            const key = `member:${member.id}`;
            const label = `Remove ${member.label}`;
            const open = opened === member.id;
            return (
              <GroupRow
                key={member.id}
                first={i === 0 && !mine.members.some((m) => m.isMe)}
                title={member.label}
                detail={inviter ? 'can invite' : null}
                right={
                  owner ? (
                    <RowButton
                      label="···"
                      accessibilityLabel={`Options for ${member.label}`}
                      onPress={() => {
                        setConfirming(null);
                        setOpened(open ? null : member.id);
                      }}
                    />
                  ) : null
                }
                below={
                  open && confirming !== key ? (
                    <View style={styles.actions}>
                      {repeaters.inviteControls && !mine.open ? (
                        <RowButton
                          label={inviter ? 'NO INVITES' : 'LET INVITE'}
                          disabled={busy}
                          accessibilityLabel={
                            inviter
                              ? `Stop ${member.label} inviting people`
                              : `Let ${member.label} invite people`
                          }
                          onPress={() =>
                            void run(repeaters.setInviter(mine.rosterId, member.id, !inviter))
                          }
                        />
                      ) : null}
                      <RowButton
                        label="REMOVE"
                        color={chrome.amber}
                        disabled={busy}
                        accessibilityLabel={label}
                        onPress={() => setConfirming(key)}
                      />
                    </View>
                  ) : (
                    confirmBelow(
                      key,
                      'Stop carrying their location? Only a new invite lets them back.',
                      label,
                      () => {
                        setOpened(null);
                        void run(repeaters.removeMember(mine.rosterId, member.id));
                      }
                    )
                  )
                }
              />
            );
          })}
          {mine.invited.map((person) => (
            <GroupRow key={person.id} title={person.label} detail="invited" dimmed />
          ))}
        </GroupCard>
      </Group>

      {repeaters.inviteControls && mine.canInvite ? (
        <Group label="Invite">
          <GroupCard>
            {mine.open ? (
              <GroupRow
                first
                title="Anyone may join already"
                text="Invite someone only to let back a person who was removed."
                dimmed
              />
            ) : null}
            {candidates.length === 0 && !mine.open ? (
              <GroupRow first title="Every friend is already in it or invited" dimmed />
            ) : null}
            {candidates.map((person, i) => (
              <GroupRow
                key={person.id}
                first={i === 0 && !mine.open}
                title={person.label}
                right={
                  <RowButton
                    label="INVITE"
                    color={chrome.green}
                    disabled={busy}
                    accessibilityLabel={`Invite ${person.label}`}
                    onPress={() => void run(repeaters.invite(mine.rosterId, person.id))}
                  />
                }
              />
            ))}
            {!mine.open && repeaters.autoInvite !== null ? (
              <GroupRow
                title="Invite new friends"
                text="Everyone you pair with from now on. They still choose whether their location is carried."
                right={
                  <RowSwitch
                    value={repeaters.autoInvite}
                    accent={chrome.green}
                    accessibilityLabel="Invite new friends to my repeaters"
                    onChange={(on) => void run(repeaters.setAutoInvite(on))}
                  />
                }
              />
            ) : null}
          </GroupCard>
        </Group>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  confirm: { gap: Spacing.two },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, justifyContent: 'flex-end' },
});
