export type CryptidGeneratorAvailability = 'available' | 'downloadable' | 'unavailable';

/** Phases the native side reports while it works towards an icon. */
export type NativeGenerationPhase =
  | 'checkingModel'
  | 'downloadingModel'
  | 'preparingModel'
  | 'generating'
  | 'formatting';

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

/**
 * One unit of work for the model. Prompting lives in JS (see `cryptid-prompt.ts`) so prompt
 * strategy can change without a native rebuild; the native side only runs what it is handed.
 */
export interface NativeGenerationRequest {
  /** System-level instructions, including the few-shot exemplars. */
  instructions: string;
  /** The turn itself: description, traits, or the repair feedback. */
  prompt: string;
  /** Sampling seed. Each candidate offsets from it so the draws differ. */
  seed: number;
  /** How many independent drawings to return. Best-of-N is scored on the JS side. */
  candidateCount: number;
  maxOutputTokens: number;
  temperature: number;
  maxLines: number;
  maxColumns: number;
  /** 1-based round, mirrored back on progress events. */
  attempt: number;
}

export interface CryptidGeneratorApi {
  availability(): Promise<CryptidGeneratorAvailability>;
  generate(description: string, seed: number): Promise<NativeGeneratedCryptid>;
  /** Optional: only present in builds that ship the best-of-N bridge. */
  generateCandidates?(request: NativeGenerationRequest): Promise<NativeGeneratedCryptid[]>;
}
