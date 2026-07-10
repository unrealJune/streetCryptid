import { NativeModule, requireNativeModule } from 'expo-modules-core';

import type {
  CryptidGeneratorApi,
  CryptidGeneratorAvailability,
  NativeGeneratedCryptid,
} from './CryptidGenerator.types';

export declare class CryptidGeneratorNativeModule
  extends NativeModule
  implements CryptidGeneratorApi
{
  availability(): Promise<CryptidGeneratorAvailability>;
  generate(description: string, seed: number): Promise<NativeGeneratedCryptid>;
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
