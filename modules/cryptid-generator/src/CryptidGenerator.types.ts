export type CryptidGeneratorAvailability = 'available' | 'downloadable' | 'unavailable';

export interface NativeGeneratedCryptid {
  name: string;
  sigil: string;
}

export interface CryptidGeneratorApi {
  availability(): Promise<CryptidGeneratorAvailability>;
  generate(description: string, seed: number): Promise<NativeGeneratedCryptid>;
}
