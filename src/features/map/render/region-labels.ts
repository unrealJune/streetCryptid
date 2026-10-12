import {
  DEFAULT_PEAK_LABEL_OPTIONS,
  isDefaultPeakLabelOptions,
  selectMapLabels,
  type PeakLabelOptions,
} from '../core/map-labels';
import type { MapRegion } from '../engine/map-engine';

/** Re-place from geometry, not capped labels, without rebuilding the data region. */
export function labelsForRegion(
  region: Pick<MapRegion, 'geometry' | 'spec' | 'labels'>,
  options: PeakLabelOptions = DEFAULT_PEAK_LABEL_OPTIONS
) {
  return isDefaultPeakLabelOptions(options)
    ? region.labels
    : selectMapLabels(region.geometry, region.spec, options);
}
