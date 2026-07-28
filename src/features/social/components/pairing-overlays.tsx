import { Modal, ScrollView, StyleSheet, View, useColorScheme } from 'react-native';

import { CryptidThemes, Spacing } from '@/constants/theme';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import { CryptidDiscoveryCelebration } from './cryptid-discovery-celebration';
import { PairingVerificationPanel } from './pairing-verification-panel';

/**
 * Pairing interrupts, mounted once for the whole app.
 *
 * Both of these used to live on the Friends screen. With the tab bar gone and the
 * roster folded into the map's island, a verification challenge can arrive while
 * you are looking at the map or sitting in Settings — so they have to be global.
 *
 * The identity check is deliberately a blocking modal rather than an island: it is
 * the one moment where getting it wrong grants a stranger your location, and it
 * needs the full ASCII figure grid to be legible.
 */
export function PairingOverlays() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const {
    pairing,
    submitPairChoice,
    confirmPairDisplay,
    cancelPair,
    acknowledgeDiscoveredFriend,
    rejectDiscoveredFriend,
  } = useLocationSharing();

  const verifications = pairing?.verifications ?? [];
  const pending = verifications.length > 0;

  return (
    <>
      <Modal
        animationType="fade"
        onRequestClose={() => {
          const first = verifications[0];
          if (first) void cancelPair(first.sessionId);
        }}
        transparent
        visible={pending}
      >
        <View
          accessibilityViewIsModal
          style={[styles.scrim, { backgroundColor: `${chrome.void}F5` }]}
        >
          <ScrollView
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
            style={styles.scroll}
          >
            <PairingVerificationPanel
              accent={chrome.green}
              onCancel={cancelPair}
              onChoose={submitPairChoice}
              onConfirm={confirmPairDisplay}
              verifications={verifications}
            />
          </ScrollView>
        </View>
      </Modal>

      <CryptidDiscoveryCelebration
        friend={pairing?.discoveredFriend ?? null}
        onAcknowledge={acknowledgeDiscoveredFriend}
        onReject={rejectDiscoveredFriend}
      />
    </>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    justifyContent: 'center',
  },
  scroll: {
    flexGrow: 0,
  },
  content: {
    padding: Spacing.four,
  },
});
