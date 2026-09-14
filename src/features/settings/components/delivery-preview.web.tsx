import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { View } from 'react-native';

import type { DeliveryStageProps } from './delivery-stage';

// Onboarding reaches this diagram before the map has initialized CanvasKit.
export function DeliveryPreview(props: DeliveryStageProps) {
  return (
    <WithSkiaWeb
      getComponent={() => import('./delivery-stage')}
      componentProps={props}
      opts={{ locateFile: (file: string) => `/${file}` }}
      fallback={<View style={{ height: props.height }} />}
    />
  );
}
