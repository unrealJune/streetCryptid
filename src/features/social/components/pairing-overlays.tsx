import { useEffect, useRef } from 'react';
import {
  BackHandler,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import { usePathname, useRouter } from 'expo-router';

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
 * This is an absolutely-positioned `View`, not RN's `<Modal>`. `<Modal>` presents
 * via its own native `UIViewController` on iOS, and UIKit only allows one active
 * modal presentation from a given presenting controller at a time: if this panel's
 * challenge landed while (or shortly after) the Settings screen — itself a native
 * `presentation: 'modal'` route — had been on screen, the Settings controller was
 * left in a state that silently blocked this Modal from ever presenting, even long
 * after Settings visibly closed. A plain View sidesteps native modal presentation
 * entirely, at the cost of not being able to render on top of Settings while
 * Settings itself is still open (Settings is a genuinely separate presented
 * controller). To compensate, this closes Settings itself the moment a new
 * challenge arrives, so a pending verification can never be stuck invisible behind
 * it — see the pathname effect below.
 */
export function PairingOverlays() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const { width, height } = useWindowDimensions();
  const router = useRouter();
  const pathname = usePathname();
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
  // `pairing.verifications` is a fresh array on every snapshot emission (the
  // service spreads it each poll), so it can never be a stable effect
  // dependency — key on the one thing that actually identifies "a new
  // challenge to react to" instead: the leading session id.
  const leadSessionId = verifications[0]?.sessionId ?? null;

  // A challenge landing while Settings is open would otherwise sit invisible behind
  // it (see the class doc above) — back out of Settings so the overlay is reachable.
  // Keyed on the leading session id so a second, later challenge triggers this again
  // even if the user has since reopened Settings.
  const dismissedForSessionId = useRef<string | null>(null);
  useEffect(() => {
    if (!leadSessionId || dismissedForSessionId.current === leadSessionId) return;
    if (pathname !== '/settings') return;
    dismissedForSessionId.current = leadSessionId;
    router.back();
  }, [leadSessionId, pathname, router]);

  useEffect(() => {
    if (Platform.OS !== 'android' || !leadSessionId) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      void cancelPair(leadSessionId);
      return true;
    });
    return () => subscription.remove();
  }, [leadSessionId, cancelPair]);

  return (
    <>
      {pending ? (
        <View
          accessibilityViewIsModal
          accessibilityRole="none"
          style={[styles.scrim, { backgroundColor: `${chrome.void}F5`, width, height }]}
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
      ) : null}

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
    position: 'absolute',
    top: 0,
    left: 0,
    justifyContent: 'center',
    zIndex: 1000,
    elevation: 1000,
  },
  scroll: {
    flexGrow: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: Spacing.four,
  },
});
