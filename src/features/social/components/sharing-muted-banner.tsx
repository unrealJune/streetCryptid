import { Linking, StyleSheet, Text } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

import { PressableAction } from './pressable-action';

/**
 * The map's one persistent warning: this phone believes it is sharing and the OS will not let it.
 *
 * ## Why it exists
 * Background location can be taken away without anyone touching the app. iOS re-prompts days after
 * the grant with a map of everywhere you have been, and a good many people downgrade to "While
 * Using"; far more common in a TestFlight group, a REINSTALL resets authorization outright. In
 * either case the pool, the friends list and the map all keep working, and the phone publishes
 * nothing the moment it is put away.
 *
 * On 2026-09-17 that is exactly what happened: an iPhone reinstalled at 04:02 UTC, paired at a bar
 * at 04:04, published exactly one fix — the pairing introduction, sent while the app was still
 * open — and went dark for the rest of the night. Its own `device.health` said
 * `sharing.enabled=true` and `perm.background=denied` in the same record. Her friend saw a dot that
 * never moved and assumed the pairing had failed. Nothing anywhere in the app said otherwise: the
 * status existed on the snapshot and was rendered only inside the transports DIAGNOSTICS screen.
 *
 * ## Why it is on the map, and why it does not dismiss
 * A pairing that completes into silence is indistinguishable from a pairing that did not work, and
 * the person who needs to know is the one whose phone is muted — not the friend watching a stale
 * dot. So it goes where they already are. It cannot be dismissed because the condition cannot be
 * dismissed: it is one tap from fixed, and until it is fixed, the app is telling their friends
 * something untrue.
 *
 * The tap opens this app's page in system Settings, which is the only place either platform lets
 * "Always" be granted — `requestBackgroundPermissionsAsync` does not prompt for it on Android 11+
 * at all, so there is no in-app dialog to offer instead.
 */
export function SharingMutedBanner({ theme }: { readonly theme: CryptidTheme }) {
  return (
    <PressableAction
      accessibilityHint="Opens this app's page in system settings."
      accessibilityLabel="Background location is off. Friends only see you while the app is open. Tap to fix."
      accessibilityRole="button"
      haptic="tap"
      onPress={() => {
        void Linking.openSettings();
      }}
      style={[
        styles.banner,
        { backgroundColor: theme.chrome.island, borderColor: theme.chrome.amber },
      ]}
    >
      <Text style={[styles.label, { color: theme.chrome.amber }]} numberOfLines={1}>
        BACKGROUND LOCATION OFF
      </Text>
      <Text style={[styles.detail, { color: theme.chrome.ink }]} numberOfLines={2}>
        Friends only see you while this app is open. Tap to allow it all the time.
      </Text>
    </PressableAction>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: Spacing.two,
    borderWidth: 1,
    gap: Spacing.half,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  label: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  detail: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 12,
    lineHeight: 16,
  },
});
