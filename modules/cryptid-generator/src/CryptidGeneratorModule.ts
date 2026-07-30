import { NativeModule, requireNativeModule } from 'expo-modules-core';

import type {
  CryptidGenerationProgressEvent,
  CryptidGeneratorApi,
  CryptidGeneratorAvailability,
  CryptidGeneratorAvailabilityDetail,
  NativeGeneratedCryptid,
  NativeGenerationRequest,
} from './CryptidGenerator.types';

/** Emitted while `generate` runs so the UI can name the current phase. */
export type CryptidGeneratorEvents = {
  onGenerationProgress: (event: CryptidGenerationProgressEvent) => void;
};

export declare class CryptidGeneratorNativeModule
  extends NativeModule<CryptidGeneratorEvents>
  implements CryptidGeneratorApi
{
  availability(): Promise<CryptidGeneratorAvailability>;
  /** Optional: only present in builds that ship the detailed availability bridge. */
  availabilityDetail?(): Promise<CryptidGeneratorAvailabilityDetail>;
  generate(description: string, seed: number): Promise<NativeGeneratedCryptid>;
  /**
   * Optional: only present in builds that ship the best-of-N bridge. Older binaries fall back to
   * `generate`, so this must always be feature-detected before use.
   */
  generateCandidates?(request: NativeGenerationRequest): Promise<NativeGeneratedCryptid[]>;
}

let cached: CryptidGeneratorNativeModule | null | undefined;

export function tryGetCryptidGenerator(): CryptidGeneratorNativeModule | null {
  if (cached !== undefined) return cached;
  try {
    cached = requireNativeModule<CryptidGeneratorNativeModule>('CryptidGenerator');
  } catch {
    cached = null;
  }
  return cached;
}

export function getCryptidGenerator(): CryptidGeneratorNativeModule {
  const module = tryGetCryptidGenerator();
  if (!module) {
    throw new Error(
      'CryptidGenerator native module is unavailable. It requires a custom development build.'
    );
  }
  return module;
}
