import { useState } from 'react';

import { ThemedText } from '@/components/themed-text';
import { CryptidThemes } from '@/constants/theme';
import { SettingsPage, SettingsSection } from '@/features/settings/components/settings-page';
import { useColorScheme } from '@/hooks/use-color-scheme';

import { ClaimRepeaterForm } from '../components/claim-repeater-form';
import { RosterCard } from '../components/roster-card';
import type { RosterView } from '../core/repeaters';
import { useRepeaters } from '../hooks/use-repeaters';

/**
 * Settings → Repeaters (REPEATERS.md §4.4): the machines you own, whose repeaters carry your
 * trail, and the rosters this phone knows of that do not. A repeater is a computer that keeps
 * sealed trails it cannot read, so friends get yours while your phone sleeps.
 *
 * "Available through friends" (rosters learned from friends' `RepeaterCard`s) arrives with the
 * cards; until then a roster reaches this phone only by claiming one of its machines.
 */
export default function RepeatersScreen() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const { status, sections, error, busyRoster, claim, setCarried } = useRepeaters();
  const [carryError, setCarryError] = useState<string | null>(null);

  async function changeCarried(roster: RosterView, carry: boolean) {
    setCarryError(null);
    const failure = await setCarried(roster.rosterId, carry);
    if (failure) setCarryError(failure);
  }

  const card = (roster: RosterView) => (
    <RosterCard
      key={roster.rosterId}
      roster={roster}
      accent={chrome.green}
      busy={busyRoster === roster.rosterId}
      onCarryChange={(carry) => void changeCarried(roster, carry)}
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
      {error ? (
        <ThemedText accessibilityRole="alert" type="small" style={{ color: chrome.amber }}>
          {error}
        </ThemedText>
      ) : null}
      {carryError ? (
        <ThemedText accessibilityRole="alert" type="small" style={{ color: chrome.amber }}>
          {carryError}
        </ThemedText>
      ) : null}

      <SettingsSection label="MY REPEATERS">
        {sections.mine ? card(sections.mine) : null}
        <ClaimRepeaterForm
          accent={chrome.green}
          warning={chrome.amber}
          firstRepeater={sections.mine === null}
          onClaim={claim}
        />
      </SettingsSection>

      {sections.carryingMe.length > 0 ? (
        <SettingsSection label="CARRYING MY TRAIL">{sections.carryingMe.map(card)}</SettingsSection>
      ) : null}

      {sections.others.length > 0 ? (
        <SettingsSection label="KNOWN TO THIS PHONE">{sections.others.map(card)}</SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
