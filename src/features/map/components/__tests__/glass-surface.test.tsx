import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { IslandPressable } from '../glass-surface';

// `jest.mock` is hoisted above the imports above, so this is in place before they resolve.
// Liquid glass ON, overriding the project-wide default in `jest.setup.js`. Everything else in the
// suite renders the opaque surface; this file is the other half.
const mockGlassProps = jest.fn();
jest.mock('expo-glass-effect', () => {
  const { View } = jest.requireActual('react-native');
  return {
    GlassView: (props: Record<string, unknown>) => {
      mockGlassProps(props);
      return <View {...props} />;
    },
    GlassContainer: View,
    isLiquidGlassAvailable: () => true,
    isGlassEffectAPIAvailable: () => true,
  };
});

jest.mock('@/global.css', () => ({}));

describe('IslandPressable on liquid glass', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    mockGlassProps.mockClear();
  });

  function render(theme = CryptidThemes.daybreak) {
    act(() => {
      renderer = create(
        <IslandPressable accessibilityLabel="Control" radius={24} theme={theme}>
          {null}
        </IslandPressable>
      );
    });
    return renderer.root
      .findAllByProps({ accessibilityLabel: 'Control' })
      .find((node) => typeof node.props.style === 'function')!;
  }

  it('hands the surface over to the material instead of painting it', () => {
    const pressable = render();
    const style = pressable.props.style({ pressed: false }) as Record<string, unknown>[];

    // An opaque background behind the material would be the material blurring a flat colour.
    expect(style).toContainEqual(expect.objectContaining({ backgroundColor: 'transparent' }));
    // The border stays: it is the app's own edge, and the glass does not draw one.
    expect(style).toContainEqual(
      expect.objectContaining({ borderColor: CryptidThemes.daybreak.chrome.islandBorder })
    );
  });

  it('lets the material answer the press rather than dimming it as well', () => {
    const pressable = render();
    const pressed = pressable.props.style({ pressed: true }) as Record<string, unknown>[];

    expect(pressed).toContainEqual(expect.objectContaining({ opacity: 1 }));
    expect(mockGlassProps).toHaveBeenCalledWith(expect.objectContaining({ isInteractive: true }));
  });

  it('passes the radius as a prop, because style alone leaves the effect square', () => {
    render();
    // `GlassEffectModule.swift` builds the corner configuration from `Prop("borderRadius")`; a
    // radius that only reached `style` would leave a square UIVisualEffectView inside a rounded
    // parent.
    expect(mockGlassProps).toHaveBeenCalledWith(expect.objectContaining({ borderRadius: 24 }));
  });

  it("follows the app's colour scheme, not the phone's", () => {
    // `use-color-scheme.ts` lets someone run the app dark on a light phone; `'auto'` would put a
    // light material under dark chrome.
    render(CryptidThemes.deepsea);
    expect(mockGlassProps).toHaveBeenCalledWith(expect.objectContaining({ colorScheme: 'dark' }));
  });
});
