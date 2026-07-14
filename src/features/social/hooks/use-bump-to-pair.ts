import { Accelerometer } from 'expo-sensors';
import { useEffect, useRef, useState } from 'react';

import { createBumpDetector } from '../core/bump-detector';

export type BumpSensorStatus = 'off' | 'checking' | 'ready' | 'unavailable' | 'denied' | 'error';

export interface BumpSensorState {
  status: BumpSensorStatus;
  lastDetectedAt: number | null;
  lastIntensity: number;
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useBumpToPair(
  enabled: boolean,
  onBump: (intensity: number) => void | Promise<void>
): BumpSensorState {
  const callbackRef = useRef(onBump);
  const [state, setState] = useState<BumpSensorState>({
    status: enabled ? 'checking' : 'off',
    lastDetectedAt: null,
    lastIntensity: 0,
    error: null,
  });

  useEffect(() => {
    callbackRef.current = onBump;
  }, [onBump]);

  useEffect(() => {
    if (!enabled) return;

    let active = true;
    let subscription: { remove(): void } | null = null;
    const detector = createBumpDetector();

    const start = async (): Promise<void> => {
      setState((current) => ({ ...current, status: 'checking', error: null }));
      if (!(await Accelerometer.isAvailableAsync())) {
        if (active) setState((current) => ({ ...current, status: 'unavailable' }));
        return;
      }

      let permission = await Accelerometer.getPermissionsAsync();
      if (!permission.granted && permission.canAskAgain) {
        permission = await Accelerometer.requestPermissionsAsync();
      }
      if (!permission.granted) {
        if (active) setState((current) => ({ ...current, status: 'denied' }));
        return;
      }
      if (!active) return;

      Accelerometer.setUpdateInterval(20);
      subscription = Accelerometer.addListener((measurement) => {
        if (!active) return;
        const result = detector.push({
          x: measurement.x,
          y: measurement.y,
          z: measurement.z,
          timestampMs:
            typeof measurement.timestamp === 'number' ? measurement.timestamp * 1000 : Date.now(),
        });
        if (!result.detected) return;

        const detectedAt = Date.now();
        setState({
          status: 'ready',
          lastDetectedAt: detectedAt,
          lastIntensity: result.intensity,
          error: null,
        });
        void callbackRef.current(result.intensity);
      });

      if (active) setState((current) => ({ ...current, status: 'ready', error: null }));
    };

    void start().catch((error: unknown) => {
      if (active) {
        setState((current) => ({
          ...current,
          status: 'error',
          error: errorMessage(error),
        }));
      }
    });

    return () => {
      active = false;
      subscription?.remove();
      detector.reset();
    };
  }, [enabled]);

  return enabled ? state : { ...state, status: 'off', error: null };
}
