import type { CryptidGenerationProgressEvent, NativeGeneratedCryptid } from 'cryptid-generator';

interface FakeGenerator {
  availability: jest.Mock<Promise<string>, []>;
  generate: jest.Mock<Promise<NativeGeneratedCryptid>, [string, number]>;
  addListener: jest.Mock;
  emit(event: CryptidGenerationProgressEvent): void;
}

const holder: { mod: FakeGenerator | null } = { mod: null };

jest.mock('cryptid-generator', () => ({
  tryGetCryptidGenerator: () => holder.mod,
}));

jest.mock('@/features/dev/telemetry', () => ({
  recordEventLog: jest.fn(),
}));

// eslint-disable-next-line import/first -- mocks must be registered before the module loads
import {
  generateCryptid,
  progressFromNativeEvent,
  type CryptidGenerationPhase,
} from '../cryptid-generator';

const SAMPLE: NativeGeneratedCryptid = {
  name: 'Fog Moth',
  sigil: ' (oo)\n /||\\\n /  \\\n ~~~~',
};

function makeGenerator(): FakeGenerator {
  const listeners: ((event: CryptidGenerationProgressEvent) => void)[] = [];
  return {
    availability: jest.fn(async () => 'available'),
    generate: jest.fn(async (_description: string, _seed: number) => SAMPLE),
    addListener: jest.fn(
      (_name: string, listener: (event: CryptidGenerationProgressEvent) => void) => {
        listeners.push(listener);
        return { remove: jest.fn() };
      }
    ),
    emit(event) {
      listeners.forEach((listener) => listener(event));
    },
  };
}

describe('cryptid generation progress', () => {
  afterEach(() => {
    holder.mod = null;
  });

  it('describes native download progress with a ratio and readable sizes', () => {
    const progress = progressFromNativeEvent({
      phase: 'downloadingModel',
      downloadedBytes: 250_000_000,
      totalBytes: 1_000_000_000,
    });

    expect(progress.title).toContain('Downloading');
    expect(progress.ratio).toBeCloseTo(0.25);
    expect(progress.detail).toBe('250 MB of 1.0 GB downloaded.');
  });

  it('labels retries so a stalled first attempt is explainable', () => {
    const progress = progressFromNativeEvent({
      phase: 'generating',
      attempt: 2,
      detail: 'Retrying after: the model exceeded its context window.',
    });

    expect(progress.attempt).toBe(2);
    expect(progress.detail).toContain('Attempt 2.');
  });

  it('reports every phase in order for a successful system generation', async () => {
    const generator = makeGenerator();
    generator.generate.mockImplementation(async () => {
      generator.emit({ phase: 'preparingModel' });
      generator.emit({ phase: 'generating', attempt: 1 });
      return SAMPLE;
    });
    holder.mod = generator;

    const phases: CryptidGenerationPhase[] = [];
    const result = await generateCryptid('a fog moth', 7, {
      onProgress: (progress) => phases.push(progress.phase),
    });

    expect(result.source).toBe('system');
    expect(result.fallbackReason).toBeUndefined();
    expect(phases).toEqual([
      'starting',
      'checkingModel',
      'preparingModel',
      'generating',
      'checkingArt',
      'done',
    ]);
  });

  it('falls back to the offline maker and surfaces why the model failed', async () => {
    const generator = makeGenerator();
    generator.generate.mockRejectedValue(
      new Error('The system model wrote past its context window before finishing the icon.')
    );
    holder.mod = generator;

    const phases: CryptidGenerationPhase[] = [];
    const result = await generateCryptid('a fog moth', 7, {
      onProgress: (progress) => phases.push(progress.phase),
    });

    expect(result.source).toBe('local');
    expect(result.fallbackReason).toContain('context window');
    expect(phases).toContain('fallback');
  });

  it('falls back when the phone reports no usable model', async () => {
    const generator = makeGenerator();
    generator.availability.mockResolvedValue('unavailable');
    holder.mod = generator;

    const result = await generateCryptid('a fog moth', 7);

    expect(generator.generate).not.toHaveBeenCalled();
    expect(result.source).toBe('local');
    expect(result.fallbackReason).toContain('unavailable');
  });

  it('falls back when the module is missing entirely', async () => {
    const result = await generateCryptid('a fog moth', 7);

    expect(result.source).toBe('local');
    expect(result.fallbackReason).toContain('bridge');
  });
});
