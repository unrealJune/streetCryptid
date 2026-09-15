import { lazy, Suspense } from 'react';
import { View } from 'react-native';

import type { DeliveryStageProps } from './delivery-stage';

const DeliveryStage = lazy(() => import('./delivery-stage'));

export function DeliveryPreview(props: DeliveryStageProps) {
  return (
    <Suspense fallback={<View style={{ height: props.height }} />}>
      <DeliveryStage {...props} />
    </Suspense>
  );
}
