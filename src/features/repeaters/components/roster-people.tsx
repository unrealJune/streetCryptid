import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import type { RosterPerson, RosterView } from '../core/repeaters';
import { RemovableRow } from './removable-row';

/** The owner's controls over people, present only on the roster this phone owns. */
export interface RosterOwnerActions {
  readonly onRemoveMember: (member: string) => void;
  /** Grant or revoke `inviter` (REPEATERS.md §3.2); absent on a binary without it. */
  readonly onSetInviter?: (member: string, inviter: boolean) => void;
}

/** Inviting friends, on any roster this phone may invite to (owner or inviter). */
export interface RosterInviteActions {
  /** Friends who are not in it, not invited, and not its owner. */
  readonly candidates: readonly RosterPerson[];
  readonly onInvite: (member: string) => void;
}

interface RosterPeopleProps {
  readonly roster: RosterView;
  /** Accent for actions. */
  readonly accent: string;
  /** Colour of a destructive action once it asks to be confirmed. */
  readonly warning: string;
  /** A change to this roster is in flight. */
  readonly busy: boolean;
  readonly owner?: RosterOwnerActions;
  readonly invite?: RosterInviteActions;
}

/**
 * The people in one roster: who it carries, who may invite, who is invited, and the friends who
 * could be (REPEATERS.md §3.2). Machines and the policy sit beside it on Your repeaters; this is a list,
 * because people outnumber machines and a list is what reads at that size. Members see who else
 * is carried (§3.3), so a member's view shows the list too, without the owner's actions.
 */
export function RosterPeople({ roster, accent, warning, busy, owner, invite }: RosterPeopleProps) {
  const theme = useTheme();
  const divider = { borderTopColor: theme.backgroundSelected };
  const others = roster.members.filter((m) => !m.isMe);

  return (
    <View style={[styles.card, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.list}>
        <ThemedText type="small" themeColor="textSecondary">
          CARRYING
        </ThemedText>
        {roster.members.some((m) => m.isMe) ? <ThemedText type="small">You</ThemedText> : null}
        {others.length === 0 && !roster.members.some((m) => m.isMe) ? (
          <ThemedText type="small" themeColor="textSecondary">
            {roster.members.length === 0 && roster.carried > 0
              ? `${roster.carried} ${roster.carried === 1 ? 'person' : 'people'}`
              : 'Nobody yet.'}
          </ThemedText>
        ) : null}
        {others.map((member) => {
          const inviter = roster.inviters.some((i) => i.id === member.id);
          const label = inviter ? `${member.label} · can invite` : member.label;
          if (!owner) {
            return (
              <ThemedText key={member.id} type="small">
                {label}
              </ThemedText>
            );
          }
          const onSetInviter = owner.onSetInviter;
          return (
            <RemovableRow
              key={member.id}
              label={label}
              accent={accent}
              warning={warning}
              busy={busy}
              removeLabel={`Remove ${member.label}`}
              confirmCopy="Stop carrying their location? Only a new invite lets them back."
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

      {invite && roster.canInvite ? (
        <View style={[styles.list, styles.divided, divider]}>
          <ThemedText type="small" themeColor="textSecondary">
            INVITE
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {roster.open
              ? 'Anyone may join already. Invite someone only to let back a person who was removed.'
              : 'An invite lets a friend choose to have their location carried here. It carries nobody by itself.'}
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
