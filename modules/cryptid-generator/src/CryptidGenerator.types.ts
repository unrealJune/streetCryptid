export type CryptidGeneratorAvailability = 'available' | 'downloadable' | 'unavailable';

/** Phases the native side reports while it works towards an icon. */
export type NativeGenerationPhase =
  'checkingModel' | 'downloadingModel' | 'preparingModel' | 'generating' | 'formatting';

export interface CryptidGenerationProgressEvent {
  phase: NativeGenerationPhase;
  /** Short native-side explanation, e.g. why a retry started. */
  detail?: string | null;
  /** 1-based attempt counter for the inference step. */
  attempt?: number;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
}

export interface CryptidGeneratorAvailabilityDetail {
  status: CryptidGeneratorAvailability;
  /** Native reason code, e.g. `modelNotReady` or `deviceNotEligible`. */
  reason?: string | null;
}

export interface NativeGeneratedCryptid {
  name: string;
  sigil: string;
}

export interface CryptidGeneratorApi {
  availability(): Promise<CryptidGeneratorAvailability>;
  generate(description: string, seed: number): Promise<NativeGeneratedCryptid>;
}
