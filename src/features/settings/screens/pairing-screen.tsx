import { useCallback } from 'react';
import { useColorScheme } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { CryptidThemes } from '@/constants/theme';
import { PairLinkAction } from '@/features/social/components/pair-link-action';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import { SettingsPage, SettingsSection } from '../components/settings-page';

/**
 * The invite-link pairing fallback.
 *
 * Bump is the real thing and it lives on the map: open the FRIENDS island and touch
 * two phones together. This page exists for the case bump cannot cover — two people
 * who are not in the same room.
 */
export default function PairingScreen() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;

  const { pairing, refreshPairing, createPairInvite, pairFromInput, respondPair } =
    useLocationSharing();

  useFocusEffect(
    useCallback(() => {
      void refreshPairing();
    }, [refreshPairing])
  );

  return (
    <SettingsPage title="Link pairing" subtitle="For when two phones cannot meet">
      <SettingsSection label="INVITE LINK">
        <ThemedText type="small" themeColor="textSecondary">
          Bump lives on the map: open the FRIENDS tab and touch two phones together. Use a link only
          when you cannot meet in person.
        </ThemedText>
        {pairing ? (
          <PairLinkAction
            accent={chrome.green}
            errorAccent={chrome.amber}
            pairing={pairing}
            onCreateInvite={createPairInvite}
            onPairInput={pairFromInput}
            onReject={(sessionId) => respondPair(sessionId, false)}
          />
        ) : null}
        {pairing?.inviteLink ? (
          // Plain-text mirror of the most recently created invite link. The Share
          // Sheet's "Copy" action doesn't reliably surface on the iOS Simulator's
          // pasteboard for `simctl pbpaste`/E2E tooling to read back, so this gives
          // Maestro (and anyone debugging by hand) a way to read the exact token
          // straight out of the accessibility tree instead.
          //
          // It sits here rather than under Debug so `.maestro/pairing/*.yaml` can
          // create and read a token without leaving the page — a navigation between
          // those two steps is a navigation that can race the counterpart redeeming
          // the invite.
          <ThemedText testID="debug-invite-link" type="small" themeColor="textSecondary" selectable>
            {pairing.inviteLink}
          </ThemedText>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
