import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { View } from 'react-native';

import type { SignalColorPickerProps } from './signal-color-picker';

export function SignalColorPicker(props: SignalColorPickerProps) {
  return (
    <WithSkiaWeb
      getComponent={async () => {
        const { SignalColorPicker: Picker } = await import('./signal-color-picker');
        return { default: Picker };
      }}
      componentProps={props}
      opts={{ locateFile: (file: string) => `/${file}` }}
      fallback={<View style={{ height: 300 }} />}
    />
  );
}
