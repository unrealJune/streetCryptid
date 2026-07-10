import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import {
  derivePairingExperienceStage,
  pairingHapticCadence,
  type PairingExperienceStage,
} from '../core/pairing-experience';
import type { PairingSnapshot } from '../net/location-sharing';

async function pulse(stage: PairingExperienceStage): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      const type =
        stage === 'seeking'
          ? Haptics.AndroidHaptics.Segment_Frequent_Tick
          : stage === 'contact'
            ? Haptics.AndroidHaptics.Gesture_Start
            : stage === 'joining'
              ? Haptics.AndroidHaptics.Context_Click
              : Haptics.AndroidHaptics.Segment_Tick;
      await Haptics.performAndroidHapticsAsync(type);
      return;
    }

    const strength = pairingHapticCadence(stage)?.strength;
    const style =
      strength === 'rigid'
        ? Haptics.ImpactFeedbackStyle.Rigid
        : strength === 'medium'
          ? Haptics.ImpactFeedbackStyle.Medium
          : Haptics.ImpactFeedbackStyle.Light;
    await Haptics.impactAsync(style);
  } catch {
    // Haptics are experiential only; pairing must never depend on them.
  }
}

async function pop(): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      await Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Gesture_End);
      await new Promise((resolve) => setTimeout(resolve, 70));
      await Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Confirm);
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    await new Promise((resolve) => setTimeout(resolve, 70));
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {
    // See pulse(): no haptic failure may affect protocol state.
  }
}

export function usePairingHaptics(pairing: PairingSnapshot | null, enabled: boolean): void {
  const poppedDiscoveryRef = useRef<string | null>(null);
  const stage = pairing ? derivePairingExperienceStage(pairing) : 'idle';

  useEffect(() => {
    if (!enabled || stage === 'idle' || stage === 'discovered') return;
    const cadence = pairingHapticCadence(stage);
    if (!cadence) return;

    void pulse(stage);
    const timer = setInterval(() => {
      void pulse(stage);
    }, cadence.delayMs);
    return () => clearInterval(timer);
  }, [enabled, stage]);

  useEffect(() => {
    const friend = pairing?.discoveredFriend;
    if (!enabled || !friend) return;
    const discoveryId = `${friend.endpointId}:${friend.pairedAt ?? 0}`;
    if (poppedDiscoveryRef.current === discoveryId) return;
    poppedDiscoveryRef.current = discoveryId;
    void pop();
  }, [enabled, pairing?.discoveredFriend]);
}
