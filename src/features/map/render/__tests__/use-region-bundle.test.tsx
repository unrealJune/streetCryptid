import type { SkImage } from '@shopify/react-native-skia';
import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { runOnUI } from 'react-native-worklets';

import { CryptidThemes } from '@/constants/cryptid-theme';

import type { MapRegion } from '../../engine/map-engine';
import { EMPTY_PACKED } from '../../tiles/packed-geometry';
import { useRegionBundle, type RegionBundle } from '../use-region-bundle';

let mockPlatform = 'web';
const mockUIJobs: (() => void)[] = [];

function mockImage(): SkImage {
  let disposed = false;
  const dispose = jest.fn(() => {
    disposed = true;
  });
  const size = () => {
    if (disposed) throw new Error('Cannot draw a deleted image');
    return 1;
  };
  const unexpected = () => {
    throw new Error('Unexpected image operation in lifetime test');
  };
  return {
    __typename__: 'Image',
    dispose,
    [Symbol.dispose]: dispose,
    width: size,
    height: size,
    getImageInfo: unexpected,
    getNativeTextureUnstable: unexpected,
    makeShaderOptions: unexpected,
    makeShaderCubic: unexpected,
    encodeToBytes: unexpected,
    encodeToBase64: unexpected,
    readPixels: unexpected,
    makeNonTextureImage: unexpected,
  };
}

jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockPlatform;
    },
  },
}));
jest.mock('react-native-worklets', () => ({
  runOnUI: jest.fn((work: () => void) => () => mockUIJobs.push(work)),
}));
jest.mock('../region-shader', () => ({
  makeRegionTextures: () => ({
    mask: mockImage(),
    ground: mockImage(),
    terrain: mockImage(),
    hasElevation: false,
  }),
  makeCellStateImage: () => mockImage(),
  renderRegionImage: () => mockImage(),
}));
jest.mock('../../perf/map-perf', () => ({
  emitMapPerfEvent: jest.fn(),
  isMapPerfRunEnabled: () => false,
  perfNow: () => 0,
}));

function region(publication: number): MapRegion {
  return {
    publication,
    spec: {
      rect: { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4 },
      maskWidth: 100,
      maskHeight: 200,
      zoom: 15,
      tileZoom: 14,
      cellRes: 9,
    },
    geometry: EMPTY_PACKED,
    cellField: { res: 9, cells: [] },
    places: [],
    explorationVersion: 0,
    timing: {
      tiles: 0,
      coldStart: false,
      cellFieldCacheHit: false,
      sourceMs: 0,
      mergeMs: 0,
      yieldMs: 0,
      cellFieldMs: 0,
      cellEnumerateMs: 0,
      cellCentersMs: 0,
      cellAnnotateMs: 0,
      totalMs: 0,
      fetchMs: 0,
      buildMs: 0,
    },
  };
}

const options = {
  palette: CryptidThemes.daybreak.canvas,
  lutImage: mockImage(),
  explorationEnabled: true,
  highwaysEnabled: true,
  transitEnabled: true,
  structuresEnabled: true,
};
let latest: RegionBundle | null = null;
function Harness({ at }: { at: MapRegion | null }) {
  const bundle = useRegionBundle(at, options);
  useEffect(() => {
    latest = bundle;
  }, [bundle]);
  return null;
}

let root: ReactTestRenderer;
beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockPlatform = 'web';
  mockUIJobs.length = 0;
  latest = null;
  await act(async () => {
    root = create(<Harness at={null} />);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  jest.useRealTimers();
});

async function draw(publication: number): Promise<RegionBundle> {
  await act(async () => root.update(<Harness at={region(publication)} />));
  await act(async () => {
    jest.runAllTimers();
  });
  expect(latest?.region.publication).toBe(publication);
  return latest!;
}

it('keeps retired web images alive for queued draws, then releases them exactly once', async () => {
  const first = await draw(1);
  const drawn = jest.fn();
  mockUIJobs.push(() => {
    expect(first.image?.width()).toBe(1);
    expect(first.cellImage?.width()).toBe(1);
    drawn();
  });
  const second = await draw(2);
  const outgoing = await draw(3);
  const current = await draw(4);
  expect(first.image?.dispose).not.toHaveBeenCalled();
  expect(first.cellImage?.dispose).not.toHaveBeenCalled();
  expect(runOnUI).toHaveBeenCalledTimes(1);

  while (mockUIJobs.length) mockUIJobs.shift()!();
  expect(drawn).toHaveBeenCalledTimes(1);
  expect(first.image?.dispose).toHaveBeenCalledTimes(1);
  expect(first.cellImage?.dispose).toHaveBeenCalledTimes(1);
  for (const bundle of [second, outgoing, current]) {
    expect(bundle.image?.dispose).not.toHaveBeenCalled();
    expect(bundle.cellImage?.dispose).not.toHaveBeenCalled();
  }
});

it.each(['ios', 'android'])('keeps immediate wrapper release on %s', async (platform) => {
  mockPlatform = platform;
  const first = await draw(1);
  await draw(2);
  const outgoing = await draw(3);
  const current = await draw(4);
  expect(runOnUI).not.toHaveBeenCalled();
  expect(first.image?.dispose).toHaveBeenCalledTimes(1);
  expect(first.cellImage?.dispose).toHaveBeenCalledTimes(1);
  for (const bundle of [outgoing, current]) {
    expect(bundle.image?.dispose).not.toHaveBeenCalled();
    expect(bundle.cellImage?.dispose).not.toHaveBeenCalled();
  }
});
