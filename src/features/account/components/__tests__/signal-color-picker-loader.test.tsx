import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SignalColorPicker } from '../signal-color-picker-loader.web';

jest.mock('@shopify/react-native-skia/lib/module/web', () => ({
  WithSkiaWeb: () => null,
}));

jest.mock('../signal-color-picker', () => {
  throw new Error('The Skia picker must not load before CanvasKit is ready');
});

describe('web signal color picker loader', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('passes picker controls through a CanvasKit gate without importing the Skia leaf', () => {
    const onChange = jest.fn();
    act(() => {
      renderer = create(<SignalColorPicker color="#FF0000" onChange={onChange} />);
    });

    const gate = renderer.root.findByType(WithSkiaWeb);
    expect(gate.props.componentProps).toEqual({ color: '#FF0000', onChange });
    expect(gate.props.getComponent).toEqual(expect.any(Function));
    expect(gate.props.opts.locateFile('canvaskit.wasm')).toBe('/canvaskit.wasm');

    act(() => {
      renderer.update(<SignalColorPicker color="#00FF00" disabled onChange={onChange} />);
    });
    expect(renderer.root.findByType(WithSkiaWeb).props.componentProps).toEqual({
      color: '#00FF00',
      disabled: true,
      onChange,
    });
  });
});
