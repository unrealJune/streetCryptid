import { useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import type { RosterPerson, RosterView } from '../core/repeaters';

/** The owner's controls, present only on the roster this phone owns. */
export interface RosterOwnerActions {
  readonly onPolicyChange: (open: boolean) => void;
  readonly onRemoveMember: (member: string) => void;
  readonly onRemoveMachine: (repeaterId: string) => void;
  /** Grant or revoke `inviter` (REPEATERS.md §3.2); absent on a binary without it. */
  readonly onSetInviter?: (member: string, inviter: boolean) => void;
}

/** Inviting friends, on any roster this phone may invite to (owner or inviter). */
export interface RosterInviteActions {
  /** Friends who are not in it, not invited, and not its owner. */
  readonly candidates: readonly RosterPerson[];
  readonly onInvite: (member: string) => void;
}

interface RosterCardProps {
  readonly roster: RosterView;
  /** Accent for the switches' on track and for actions. */
  readonly accent: string;
  /** Colour of a destructive action once it asks to be confirmed. */
  readonly warning: string;
  /** A change to this roster is in flight. */
  readonly busy: boolean;
  readonly onCarryChange: (carry: boolean) => void;
  readonly owner?: RosterOwnerActions;
  readonly invite?: RosterInviteActions;
}

/**
 * One roster: whose it is, its machines, and the one choice there is about it for everyone,
 * whether it carries your trail (REPEATERS.md §2.1: carrying is the only opt-in). On your own
 * roster it also holds the owner's controls: who may enrol, and removing people or machines.
 */
export function RosterCard({
  roster,
  accent,
  warning,
  busy,
  onCarryChange,
  owner,
  invite,
}: RosterCardProps) {
  const theme = useTheme();
  const machines = roster.machines.length;
  const detail = [
    `${machines} ${machines === 1 ? 'machine' : 'machines'}`,
    roster.open ? 'open to anyone' : 'invite only',
    `carrying ${roster.carried} ${roster.carried === 1 ? 'person' : 'people'}`,
  ].join(' · ');
  const divider = { borderTopColor: theme.backgroundSelected };

  return (
    <View style={[styles.card, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.copy}>
        <ThemedText type="smallBold">{roster.ownerLabel}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {detail}
        </ThemedText>
        {roster.vouchers.length > 0 && !owner ? (
          <ThemedText type="small" themeColor="textSecondary">
            {`Vouched for by ${roster.vouchers.map((v) => v.label).join(', ')}`}
          </ThemedText>
        ) : null}
      </View>

      {owner ? null : machines > 0 ? (
        <ThemedText type="code" themeColor="textSecondary">
          {roster.machines.map((m) => m.short).join('  ')}
        </ThemedText>
      ) : null}

      <View style={[styles.option, styles.divided, divider]}>
        <View style={styles.copy}>
          <ThemedText type="small">Carry my trail</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {roster.carriesMe
              ? 'Kept on these machines, sealed, for friends to pick up while your phone sleeps.'
              : roster.canEnrol
                ? 'Off. These machines do not keep your trail.'
                : 'Invite only, and nobody has invited you yet.'}
          </ThemedText>
        </View>
        {roster.carriesMe || roster.canEnrol ? (
          <Switch
            accessibilityRole="switch"
            accessibilityLabel={`Carry my trail on ${roster.ownerLabel}`}
            disabled={busy}
            value={roster.carriesMe}
            onValueChange={onCarryChange}
            trackColor={{ true: accent, false: theme.backgroundSelected }}
          />
        ) : null}
      </View>

      {owner ? (
        <>
          <View style={[styles.option, styles.divided, divider]}>
            <View style={styles.copy}>
              <ThemedText type="small">Open to anyone</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {roster.open
                  ? 'Anyone who learns of it may ask it to carry their trail.'
                  : 'Only people you invite may ask. Nobody already carried is dropped.'}
              </ThemedText>
            </View>
            <Switch
              accessibilityRole="switch"
              accessibilityLabel="Open to anyone"
              disabled={busy}
              value={roster.open}
              onValueChange={owner.onPolicyChange}
              trackColor={{ true: accent, false: theme.backgroundSelected }}
            />
          </View>

          <View style={[styles.list, styles.divided, divider]}>
            <ThemedText type="small" themeColor="textSecondary">
              MACHINES
            </ThemedText>
            {roster.machines.map((machine) => (
              <ListRow
                key={machine.id}
                label={machine.short}
                code
                accent={accent}
                warning={warning}
                busy={busy}
                removeLabel={`Remove machine ${machine.short}`}
                confirmCopy="Take it out? It stops serving your roster."
                onRemove={() => owner.onRemoveMachine(machine.id)}
              />
            ))}
          </View>

          {roster.members.some((m) => !m.isMe) ? (
            <View style={[styles.list, styles.divided, divider]}>
              <ThemedText type="small" themeColor="textSecondary">
                CARRYING
              </ThemedText>
              {roster.members
                .filter((m) => !m.isMe)
                .map((member) => {
                  const inviter = roster.inviters.some((i) => i.id === member.id);
                  const onSetInviter = owner.onSetInviter;
                  return (
                    <ListRow
                      key={member.id}
                      label={inviter ? `${member.label} · can invite` : member.label}
                      accent={accent}
                      warning={warning}
                      busy={busy}
                      removeLabel={`Remove ${member.label}`}
                      confirmCopy="Stop carrying their trail? Only a new invite lets them back."
                      onRemove={() => owner.onRemoveMember(member.id)}
                      secondary={
                        onSetInviter && !roster.open
                          ? {
                              label: inviter ? 'NO INVITES' : 'LET INVITE',
                              accessibilityLabel: inviter
                                ? `Stop ${member.label} inviting people`
                                : `Let ${member.label} invite people`,
                              onPress: () => onSetInviter(member.id, !inviter),
                            }
                          : undefined
                      }
                    />
                  );
                })}
            </View>
          ) : null}
        </>
      ) : null}

      {invite && roster.canInvite ? (
        <View style={[styles.list, styles.divided, divider]}>
          <ThemedText type="small" themeColor="textSecondary">
            INVITE
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {roster.open
              ? 'Anyone may join already. Invite someone only to let back a person who was removed.'
              : 'An invite lets a friend choose to have their trail carried here. It carries nobody by itself.'}
          </ThemedText>
          {roster.invited.map((person) => (
            <ThemedText key={person.id} type="small" themeColor="textSecondary">
              {`${person.label} · invited`}
            </ThemedText>
          ))}
          {invite.candidates.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary">
              Every friend is already in it or invited.
            </ThemedText>
          ) : (
            invite.candidates.map((person) => (
              <View key={person.id} style={styles.listRow}>
                <View style={styles.copy}>
                  <ThemedText type="small">{person.label}</ThemedText>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Invite ${person.label}`}
                  accessibilityState={{ disabled: busy }}
                  disabled={busy}
                  onPress={() => invite.onInvite(person.id)}
                  style={({ pressed }) => [styles.action, (pressed || busy) && styles.pressed]}
                >
                  <ThemedText type="code" style={{ color: accent }}>
                    INVITE
                  </ThemedText>
                </Pressable>
              </View>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

/** One machine or person, with a REMOVE that asks once before it acts. */
function ListRow({
  label,
  code = false,
  accent,
  warning,
  busy,
  removeLabel,
  confirmCopy,
  onRemove,
  secondary,
}: {
  readonly label: string;
  readonly code?: boolean;
  readonly accent: string;
  readonly warning: string;
  readonly busy: boolean;
  readonly removeLabel: string;
  readonly confirmCopy: string;
  readonly onRemove: () => void;
  /** A second, reversible action beside REMOVE, taken without confirming. */
  readonly secondary?: {
    readonly label: string;
    readonly accessibilityLabel: string;
    readonly onPress: () => void;
  };
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <View style={styles.listRow}>
      <View style={styles.copy}>
        <ThemedText type={code ? 'code' : 'small'}>{label}</ThemedText>
        {confirming ? (
          <ThemedText accessibilityRole="alert" type="small" themeColor="textSecondary">
            {confirmCopy}
          </ThemedText>
        ) : null}
      </View>
      {secondary && !confirming ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={secondary.accessibilityLabel}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={secondary.onPress}
          style={({ pressed }) => [styles.action, (pressed || busy) && styles.pressed]}
        >
          <ThemedText type="code" themeColor="textSecondary">
            {secondary.label}
          </ThemedText>
        </Pressable>
      ) : null}
      {confirming ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={() => setConfirming(false)}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <ThemedText type="code" themeColor="textSecondary">
            CANCEL
          </ThemedText>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={confirming ? `Confirm: ${removeLabel}` : removeLabel}
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          setConfirming(false);
          onRemove();
        }}
        style={({ pressed }) => [styles.action, (pressed || busy) && styles.pressed]}
      >
        <ThemedText type="code" style={{ color: confirming ? warning : accent }}>
          REMOVE
        </ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
    padding: Spacing.three,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
  },
  option: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
  },
  list: {
    gap: Spacing.two,
  },
  listRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
  },
  action: {
    paddingVertical: Spacing.one,
  },
  pressed: {
    opacity: 0.58,
  },
});
