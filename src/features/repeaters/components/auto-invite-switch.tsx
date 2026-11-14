import { OptionSwitch } from './option-switch';

/**
 * "Invite new friends" (auto-invite, REPEATERS.md §3.2): whether the invite to this phone's
 * invite-only repeaters starts switched on at pairing. Shown beside the invite lists it pre-fills,
 * on Your repeaters and on the People page of any roster this phone may invite to.
 */
export function AutoInviteSwitch({
  value,
  accent,
  onChange,
}: {
  readonly value: boolean;
  readonly accent: string;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <OptionSwitch
      title="Invite new friends"
      text="When you pair, the invite to your invite-only repeaters starts switched on. They still choose whether their location is carried."
      accessibilityLabel="Invite new friends to my repeaters"
      value={value}
      accent={accent}
      onChange={onChange}
    />
  );
}
