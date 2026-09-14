import { getStashConfig } from 'iroh-location';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, useColorScheme } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { CryptidThemes, Spacing } from '@/constants/theme';
import { DeliveryOptions } from '@/features/settings/components/delivery-options';
import { SettingsPage } from '@/features/settings/components/settings-page';
import { NEW_USER_DELIVERY_MODE, type DeliveryMode } from '@/features/social/core/delivery-mode';
import {
  createPersistentKV,
  loadDeliveryMode,
  saveDeliveryMode,
} from '@/features/social/net/persistence';

import { CryptidProfileEditor } from '../components/cryptid-profile-editor';
import type { CryptidProfile } from '../core/profile';
import { useCryptidProfile } from '../hooks/use-cryptid-profile';

export function AccountOnboardingScreen({
  onSaveStart,
  onComplete,
}: {
  onSaveStart: () => void;
  onComplete: () => void;
}) {
  const { error: profileError, profile, saveProfile } = useCryptidProfile();
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const [kv] = useState(createPersistentKV);
  const [availability] = useState(() => ({ stashConfigured: getStashConfig() !== null }));
  const [draft, setDraft] = useState<CryptidProfile | null>(profile);
  const [step, setStep] = useState<'profile' | 'delivery'>('profile');
  const [mode, setMode] = useState<DeliveryMode>(NEW_USER_DELIVERY_MODE);
  const [ready, setReady] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    void loadDeliveryMode(kv, NEW_USER_DELIVERY_MODE)
      .then((saved) => {
        if (!active) return;
        setMode(saved);
        setReady(true);
        setError(null);
      })
      .catch(() => {
        if (active) setError('Could not load delivery preferences. Try again.');
      });
    return () => {
      active = false;
    };
  }, [kv, loadAttempt]);

  async function finish() {
    if (!draft || !ready || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    onSaveStart();
    try {
      await saveDeliveryMode(kv, mode);
      // A profile is the completed-onboarding marker. Save it only after delivery, so
      // closing the app between these steps never skips the delivery choice on relaunch.
      await saveProfile(draft);
      onComplete();
    } catch {
      setError('Could not finish setup. Try again.');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  if (step === 'profile') {
    return (
      <CryptidProfileEditor
        initialProfile={draft}
        mode="onboarding"
        notice={profileError}
        onDone={() => setStep('delivery')}
        onSave={async (next) => setDraft(next)}
      />
    );
  }

  return (
    <SettingsPage kind="onboarding" title="Delivery" testID="delivery-onboarding">
      {ready ? (
        <DeliveryOptions
          selected={mode}
          availability={availability}
          disabled={saving}
          onSelect={setMode}
        />
      ) : !error ? (
        <ThemedText type="small" themeColor="textSecondary">
          Loading delivery preferences…
        </ThemedText>
      ) : null}
      {error ? (
        <ThemedText accessibilityRole="alert" type="small">
          {error}
        </ThemedText>
      ) : null}
      {!ready && error ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading delivery preferences"
          onPress={() => setLoadAttempt((attempt) => attempt + 1)}
        >
          <ThemedText type="smallBold">Retry loading delivery preferences</ThemedText>
        </Pressable>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to profile"
          disabled={saving}
          onPress={() => setStep('profile')}
          style={styles.back}
        >
          <ThemedText type="smallBold">Back</ThemedText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue with selected delivery"
          accessibilityState={{ disabled: !ready || saving, busy: saving }}
          disabled={!ready || saving}
          onPress={() => void finish()}
          testID="onboarding-delivery-continue"
          style={({ pressed }) => [
            styles.continue,
            { backgroundColor: chrome.green, opacity: !ready || saving ? 0.4 : pressed ? 0.65 : 1 },
          ]}
        >
          <ThemedText type="smallBold" style={{ color: chrome.bg }}>
            {saving ? 'Saving…' : 'Continue'}
          </ThemedText>
        </Pressable>
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: Spacing.three },
  back: { justifyContent: 'center', padding: Spacing.three },
  continue: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    flex: 1,
    padding: Spacing.three,
  },
});
