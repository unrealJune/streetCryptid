import { tryGetIrohLocation } from 'iroh-location';
import { useEffect, useState, type PropsWithChildren } from 'react';
import { AppState, Platform } from 'react-native';

import { getTelemetry } from '@/features/dev/telemetry';
import {
  createPersistentKV,
  loadBackgroundReliabilityAsked,
  saveBackgroundReliabilityAsked,
} from '../net/persistence';
import { useLocationSharing } from '../hooks/use-location-sharing';
import { BackgroundReliabilityScreen } from '../screens/background-reliability-screen';

/**
 * Shows `BackgroundReliabilityScreen` once, on Android, after background location was accepted —
 * for a new install that is the step straight after the location disclosure, and for an existing
 * one it is the next launch. Skipped when the phone is already exempt, on a binary too old to know
 * (the native functions are optional), and everywhere but Android.
 *
 * Must render inside `LocationDisclosureGate`, which guarantees `disclosureStatus` is settled.
 */
export function BackgroundReliabilityGate({ children }: PropsWithChildren) {
  const { disclosureStatus } = useLocationSharing();
  const [kv] = useState(createPersistentKV);
  /** `null` while the record loads. A failed read counts as asked: never block the app on it. */
  const [asked, setAsked] = useState<boolean | null>(null);

  const iroh = tryGetIrohLocation();
  const applies =
    Platform.OS === 'android' &&
    disclosureStatus === 'accepted' &&
    typeof iroh?.batteryOptimizationExempt === 'function' &&
    typeof iroh.requestBatteryOptimizationExemption === 'function';

  useEffect(() => {
    if (!applies) return;
    let active = true;
    void loadBackgroundReliabilityAsked(kv)
      .then((value) => active && setAsked(value))
      .catch(() => active && setAsked(true));
    return () => {
      active = false;
    };
  }, [applies, kv]);

  if (!applies) return children;
  if (asked === null) return null;
  if (asked || iroh?.batteryOptimizationExempt?.()) return children;

  function answer(choice: 'allow' | 'skip') {
    const mod = tryGetIrohLocation();
    const shown =
      choice === 'allow' ? (mod?.requestBatteryOptimizationExemption?.() ?? false) : false;
    void saveBackgroundReliabilityAsked(kv).catch(() => undefined);
    setAsked(true);
    if (choice === 'skip' || !shown) {
      record(choice, shown, mod?.batteryOptimizationExempt?.());
      return;
    }
    // The system dialog is its own activity; the answer is readable once we are active again.
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      sub.remove();
      record(choice, shown, tryGetIrohLocation()?.batteryOptimizationExempt?.());
    });
  }

  return (
    <BackgroundReliabilityScreen onAllow={() => answer('allow')} onSkip={() => answer('skip')} />
  );
}

/** One span per answer, so "did they say no, or did the prompt never appear" is answerable. */
function record(choice: 'allow' | 'skip', shown: boolean, exempt: boolean | undefined) {
  getTelemetry()
    .startSpan('onboarding.battery_exemption', {
      attributes: { choice, 'prompt.shown': shown, 'battery.optimization_exempt': exempt },
    })
    .end();
}
