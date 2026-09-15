import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { DeliveryPreview } from '../delivery-preview.web';
import type { DeliveryStagePalette } from '../delivery-stage';

jest.mock('@shopify/react-native-skia/lib/module/web', () => ({ WithSkiaWeb: () => null }));
jest.mock('../delivery-stage', () => {
  throw new Error('The delivery diagram must not load before CanvasKit is ready');
});

describe('web delivery preview', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('initializes CanvasKit before loading the diagram during first-run onboarding', () => {
    const palette: DeliveryStagePalette = {
      accent: '#fff',
      ramp: ['#000', '#555', '#aaa', '#fff'],
      surface: '#222',
      surfaceOff: '#111',
      label: '#fff',
      hairline: '#444',
      warning: '#f00',
      ground: '#000',
    };
    act(() => {
      renderer = create(<DeliveryPreview mode="stash" height={340} palette={palette} />);
    });
    const gate = renderer.root.findByType(WithSkiaWeb);
    expect(gate.props.componentProps).toEqual({ mode: 'stash', height: 340, palette });
    expect(gate.props.getComponent).toEqual(expect.any(Function));
    expect(gate.props.opts.locateFile('canvaskit.wasm')).toBe('/canvaskit.wasm');
  });
});
