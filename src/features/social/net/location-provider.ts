import type { LocationFix } from '../core/types';

/**
 * A source of the device's own location. Two implementations:
 *   - {@link ManualLocationProvider} — harness-friendly, works everywhere (no native dep).
 *   - {@link ExpoLocationProvider}   — real GPS via expo-location (foreground).
 */
export interface LocationProvider {
  getCurrent(): Promise<LocationFix>;
  /** Subscribe to updates; resolves to an unsubscribe fn. */
  watch(onFix: (fix: LocationFix) => void): Promise<() => void>;
}

/** An in-memory provider you drive by hand — ideal for the two-device prototype. */
export class ManualLocationProvider implements LocationProvider {
  private current: LocationFix;
  private readonly watchers = new Set<(fix: LocationFix) => void>();

  constructor(initial: LocationFix) {
    this.current = initial;
  }

  set(patch: Partial<LocationFix>): void {
    this.current = { ...this.current, ...patch, ts: Date.now() };
    this.watchers.forEach((w) => w(this.current));
  }

  /** Move the point by a small delta (harness "walk"). */
  nudge(dLat: number, dLon: number): void {
    this.set({ lat: this.current.lat + dLat, lon: this.current.lon + dLon });
  }

  async getCurrent(): Promise<LocationFix> {
    return this.current;
  }

  async watch(onFix: (fix: LocationFix) => void): Promise<() => void> {
    this.watchers.add(onFix);
    onFix(this.current);
    return () => {
      this.watchers.delete(onFix);
    };
  }
}
