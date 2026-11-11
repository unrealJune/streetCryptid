import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { StyleSheet, View } from 'react-native';

import type { SplashCanvasProps } from './splash-canvas';

// A fresh install opens on the splash, before the map has initialized CanvasKit.
export function SplashCanvas(props: SplashCanvasProps) {
  return (
    <WithSkiaWeb
      getComponent={async () => {
        const { SplashCanvas: Canvas } = await import('./splash-canvas');
        return { default: Canvas };
      }}
      componentProps={props}
      opts={{ locateFile: (file: string) => `/${file}` }}
      fallback={<View pointerEvents="none" style={StyleSheet.absoluteFill} />}
    />
  );
}
