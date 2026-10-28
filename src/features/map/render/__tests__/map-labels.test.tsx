import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { scaleFor } from '../../core/camera';
import { PEAK_LABEL_MIN_ZOOM, type MapLabel } from '../../core/map-labels';
import type { CameraState, MapPeak, Viewport } from '../../core/types';
import { mergePacked, packGeometry, type PackedGeometry } from '../../tiles/packed-geometry';
import { useStableMapLabels } from '../map-labels';

jest.mock('react-native-reanimated', () => ({}));

const viewport: Viewport = { width: 400, height: 360 };
const cameraAt = (x = 0, zoom = 10): CameraState => ({
  center: [0.5 + x / scaleFor(10), 0.5],
  zoom,
});
const peak = (name: string, x: number, y = 0): MapPeak => ({
  name,
  world: [0.5 + x / scaleFor(10), 0.5 + y / scaleFor(10)],
  kind: 'peak',
  rank: 1,
  customaryFt: false,
});
const data = (peaks: MapPeak[]) =>
  packGeometry({ streets: [], transit: [], rivers: [], water: [], parks: [], places: [], peaks });

interface Props {
  geometry: PackedGeometry | null;
  camera: CameraState;
  viewport?: Viewport;
  peaksEnabled?: boolean;
}

function Result({ labels }: { labels: readonly MapLabel[] }) {
  return <>{labels.map((label) => label.text).join('|')}</>;
}

function Harness(props: Props) {
  const labels = useStableMapLabels(props.geometry, props.camera, props.viewport ?? viewport, {
    peaksEnabled: props.peaksEnabled ?? true,
  });
  return <Result labels={labels} />;
}

describe('viewport label placement', () => {
  let renderer: ReactTestRenderer | null = null;
  const draw = (props: Props) => {
    act(() => {
      if (renderer) renderer.update(<Harness {...props} />);
      else renderer = create(<Harness {...props} />);
    });
    if (!renderer) throw new Error('Label harness did not mount');
    return renderer.root.findByType(Result).props.labels as readonly MapLabel[];
  };
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it('keeps visible labels as the sampled camera pans and displayed tiles arrive', () => {
    const initial = data([peak('Rainier', -10), peak('Western peak', -100, 80)]);
    const first = draw({ geometry: initial, camera: cameraAt() });
    const more = mergePacked([initial, data([peak('Competing summit', 35)])]);
    const next = draw({ geometry: more, camera: cameraAt(40) });
    expect(next.map((label) => label.text)).toEqual(['RAINIER', 'WESTERN PEAK']);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).toBe(first[1]);
  });

  it('does no placement work for an unrelated render with identical visual inputs', () => {
    const props = { geometry: data([peak('Rainier', 0)]), camera: cameraAt() };
    const first = draw(props);
    expect(draw({ ...props })).toBe(first);
  });

  it('uses viewport edges and layer visibility, not the prefetched extent', () => {
    const geometry = data([peak('Rainier', 0), peak('New summit', 600)]);
    expect(draw({ geometry, camera: cameraAt() }).map((label) => label.text)).toEqual(['RAINIER']);
    expect(draw({ geometry, camera: cameraAt(600) }).map((label) => label.text)).toEqual([
      'NEW SUMMIT',
    ]);
    expect(draw({ geometry, camera: cameraAt(600), peaksEnabled: false })).toEqual([]);
  });

  it('releases labels when zoom eligibility or displayed geometry changes', () => {
    const geometry = data([peak('Rainier', 0)]);
    expect(draw({ geometry, camera: cameraAt() })).toHaveLength(1);
    expect(draw({ geometry, camera: cameraAt(0, PEAK_LABEL_MIN_ZOOM - 0.01) })).toEqual([]);
    expect(draw({ geometry: null, camera: cameraAt() })).toEqual([]);
  });
});
