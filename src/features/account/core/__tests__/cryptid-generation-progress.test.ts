import type {
  CryptidGenerationProgressEvent,
  NativeGeneratedCryptid,
  NativeGenerationRequest,
} from 'cryptid-generator';

interface FakeGenerator {
  availability: jest.Mock<Promise<string>, []>;
  generate: jest.Mock<Promise<NativeGeneratedCryptid>, [string, number]>;
  generateCandidates?: jest.Mock<Promise<NativeGeneratedCryptid[]>, [NativeGenerationRequest]>;
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
  resetRecentSigilMemory,
  selectBestCandidate,
  type CryptidGenerationPhase,
} from '../cryptid-generator';

/** Scores well above the acceptance bar (it is an archetype-shaped drawing). */
const GOOD: NativeGeneratedCryptid = {
  name: 'Fog Moth',
  sigil: ['   .---.', '  / o o \\', ' |   ~   |', '  \\ /|\\ /', "   '---'"].join('\n'),
};

/** Two ragged lines: valid ASCII, nowhere near icon shaped. */
const POOR: NativeGeneratedCryptid = { name: 'Scribble', sigil: '(oo)\n/||\\' };

function makeGenerator(): FakeGenerator {
  const listeners: ((event: CryptidGenerationProgressEvent) => void)[] = [];
  return {
    availability: jest.fn(async () => 'available'),
    generate: jest.fn(async (_description: string, _seed: number) => GOOD),
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

function withCandidates(
  generator: FakeGenerator,
  rounds: NativeGeneratedCryptid[][]
): FakeGenerator {
  let round = 0;
  generator.generateCandidates = jest.fn(
    async (_request: NativeGenerationRequest) => rounds[Math.min(round++, rounds.length - 1)]
  );
  return generator;
}

describe('cryptid generation progress', () => {
  beforeEach(() => {
    resetRecentSigilMemory();
  });

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
    const generator = withCandidates(makeGenerator(), [[POOR, GOOD]]);
    generator.generateCandidates?.mockImplementation(async () => {
      generator.emit({ phase: 'preparingModel' });
      generator.emit({ phase: 'generating', attempt: 1 });
      return [POOR, GOOD];
    });
    holder.mod = generator;

    const phases: CryptidGenerationPhase[] = [];
    const result = await generateCryptid('a fog moth', 7, {
      onProgress: (progress) => phases.push(progress.phase),
    });

    expect(result.source).toBe('system');
    expect(result.name).toBe('Fog Moth');
    expect(result.fallbackReason).toBeUndefined();
    expect(phases).toEqual([
      'starting',
      'checkingModel',
      'preparingModel',
      'generating',
      'scoring',
      'checkingArt',
      'done',
    ]);
  });

  it('hands the prompt built in JS to the native bridge', async () => {
    const generator = withCandidates(makeGenerator(), [[GOOD]]);
    holder.mod = generator;

    await generateCryptid('a rain-soaked moth', 7);

    const request = generator.generateCandidates?.mock.calls[0][0];
    expect(request?.candidateCount).toBeGreaterThan(1);
    expect(request?.instructions).toContain('Rules:');
    expect(request?.prompt).toContain('a rain-soaked moth');
    expect(request?.prompt).toContain('silhouette:');
    expect(request?.attempt).toBe(1);
  });

  it('runs a repair round with the scorer defects when the first sketches are poor', async () => {
    const generator = withCandidates(makeGenerator(), [[POOR], [GOOD]]);
    holder.mod = generator;

    const phases: CryptidGenerationPhase[] = [];
    const result = await generateCryptid('a fog moth', 7, {
      onProgress: (progress) => phases.push(progress.phase),
    });

    expect(phases).toContain('repairing');
    expect(result.source).toBe('system');
    const repair = generator.generateCandidates?.mock.calls[1][0];
    expect(repair?.attempt).toBe(2);
    expect(repair?.prompt).toContain('4 to 8 lines');
    expect(repair?.prompt).toContain('(oo)');
  });

  it('blends the model name with an offline render when no sketch is icon shaped', async () => {
    const generator = withCandidates(makeGenerator(), [[POOR], [POOR]]);
    holder.mod = generator;

    const result = await generateCryptid('a fog moth', 7);

    expect(result.source).toBe('hybrid');
    expect(result.name).toBe('Scribble');
    expect(result.fallbackReason).toContain('not icon shaped');
  });

  it('falls back to the offline maker and surfaces why the model failed', async () => {
    const generator = makeGenerator();
    generator.generateCandidates = jest
      .fn()
      .mockRejectedValue(
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
    const generator = withCandidates(makeGenerator(), [[GOOD]]);
    generator.availability.mockResolvedValue('unavailable');
    holder.mod = generator;

    const result = await generateCryptid('a fog moth', 7);

    expect(generator.generateCandidates).not.toHaveBeenCalled();
    expect(result.source).toBe('local');
    expect(result.fallbackReason).toContain('unavailable');
  });

  it('falls back when the module is missing entirely', async () => {
    const result = await generateCryptid('a fog moth', 7);

    expect(result.source).toBe('local');
    expect(result.fallbackReason).toContain('bridge');
  });

  it('degrades to the legacy single-shot bridge on older binaries', async () => {
    const generator = makeGenerator();
    holder.mod = generator;

    const result = await generateCryptid('a fog moth', 7);

    expect(generator.generate).toHaveBeenCalled();
    expect(result.source).toBe('system');
  });
});

describe('best-of-N selection', () => {
  beforeEach(() => {
    resetRecentSigilMemory();
  });

  it('picks the most icon-shaped candidate', () => {
    expect(selectBestCandidate([POOR, GOOD])?.name).toBe('Fog Moth');
  });

  it('ignores candidates that cannot be stored on a profile', () => {
    expect(selectBestCandidate([{ name: 'Empty', sigil: '   \n  ' }])).toBeNull();
  });

  it('penalizes art the model has already produced recently', async () => {
    const generator = withCandidates(makeGenerator(), [[GOOD]]);
    holder.mod = generator;
    await generateCryptid('a fog moth', 7);
    holder.mod = null;

    const repeated = selectBestCandidate([GOOD]);
    expect(repeated?.repeated).toBe(true);
    expect(repeated?.score).toBeLessThan(repeated?.report.score ?? 0);
  });
});
