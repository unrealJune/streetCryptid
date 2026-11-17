import { useCallback, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { AccountOnboardingScreen } from '@/features/account/screens/account-onboarding-screen';
import { PermissionSteps } from '@/features/social/components/permissions-gate';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';
import { useTheme } from '@/hooks/use-theme';

type Stage = 'closed' | 'account' | 'permissions';

/**
 * Run first-launch onboarding again on a phone that finished it: the splash, profile, privacy and
 * delivery screens, then every permission step that exists on this phone (`PermissionSteps` in
 * replay mode). It is the real flow, not a preview, so answers are saved — through the running
 * service and provider, so the app does not need a restart to see them. A permission the OS has
 * already decided returns at once, so its step shows but its system prompt does not; to see the
 * prompts, revoke them in system settings first.
 */
export function OnboardingReplayRow({ accent }: { accent: string }) {
  const theme = useTheme();
  const { setDeliveryMode, acknowledgeLocationDisclosure } = useLocationSharing();
  const [stage, setStage] = useState<Stage>('closed');
  const close = useCallback(() => setStage('closed'), []);

  return (
    <View style={[styles.container, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.copy}>
        <ThemedText type="smallBold">Replay onboarding</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Setup and every permission step, as on a fresh install. Answers are saved.
        </ThemedText>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Replay onboarding"
        onPress={() => setStage('account')}
        testID="debug-replay-onboarding"
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
      >
        <ThemedText type="code" style={{ color: accent }}>
          REPLAY
        </ThemedText>
      </Pressable>

      <Modal
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={close}
        visible={stage !== 'closed'}
      >
        <View style={[styles.sheet, { backgroundColor: theme.background }]}>
          {stage === 'account' ? (
            <AccountOnboardingScreen
              replay
              onSaveStart={() => undefined}
              onComplete={() => setStage('permissions')}
              saveDelivery={setDeliveryMode}
            />
          ) : stage === 'permissions' ? (
            <PermissionSteps
              replay
              onDone={close}
              saveLocationChoice={acknowledgeLocationDisclosure}
            />
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    padding: Spacing.three,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
  action: {
    paddingVertical: Spacing.one,
  },
  pressed: {
    opacity: 0.58,
  },
  sheet: {
    flex: 1,
  },
});
