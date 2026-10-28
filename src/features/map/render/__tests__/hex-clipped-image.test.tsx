import type { SkImage } from '@shopify/react-native-skia';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { ScreenHexLattice } from '../../core/hex-lattice';
import { HexClippedImage } from '../hex-clipped-image';

jest.mock('react-native-reanimated', () => ({}));
jest.mock('@shopify/react-native-skia', () => ({
  Group: 'div',
  Image: 'img',
  ImageShader: 'span',
  Rect: 'rect',
  Shader: 'filter',
  Skia: {
    RuntimeEffect: { Make: () => ({}) },
    XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
  },
}));

const rect = { x: 100, y: 200, width: 400, height: 900 };
const imageRect = { x: 99.7, y: 199.8, width: 400.9, height: 900.6 };
const image = {} as SkImage;
const lattice = { originX: 10, originY: -4, radius: 20, rotation: 0.3, strokeWidth: 0.8 };

describe('pixel-aligned bitmap placement', () => {
  let renderer: ReactTestRenderer | null = null;
  const draw = (clip: ScreenHexLattice | null) => {
    act(() => {
      renderer = create(
        <HexClippedImage image={image} rect={rect} imageRect={imageRect} lattice={clip} />
      );
    });
    if (!renderer) throw new Error('Image harness did not mount');
    return renderer.root;
  };
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it('places the plain bitmap at its pixel bounds while clipping to the data region', () => {
    const root = draw(null);
    expect(root.findByType('img').props).toMatchObject(imageRect);
    expect(root.findByType('div').props.clip).toEqual(rect);
  });

  it('uses the same bitmap bounds in the interior and every hex-edge shader', () => {
    const root = draw(lattice);
    expect(root.findByType('img').props).toMatchObject(imageRect);
    const edges = root.findAllByType('span');
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) expect(edge.props.rect).toEqual(imageRect);
    for (const shader of root.findAllByType('filter')) {
      expect(shader.props.uniforms.uHexRect).toEqual([rect.x, rect.y, rect.width, rect.height]);
    }
  });
});
