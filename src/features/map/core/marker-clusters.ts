import type { ScreenPoint } from './types';

export interface AnchoredMarker {
  readonly id: string;
  readonly anchor: ScreenPoint;
}

/** Groups markers whose anchors form a connected screen-space overlap. */
export function clusterMarkers<T extends AnchoredMarker>(
  markers: readonly T[],
  overlapDistance = 44
): T[][] {
  const remaining = new Set(markers.map((_, index) => index));
  const clusters: T[][] = [];
  const overlapDistanceSq = overlapDistance * overlapDistance;

  while (remaining.size > 0) {
    const first = remaining.values().next().value as number;
    remaining.delete(first);
    const pending = [first];
    const cluster: T[] = [];

    while (pending.length > 0) {
      const index = pending.pop() as number;
      const marker = markers[index];
      cluster.push(marker);

      for (const candidateIndex of remaining) {
        const candidate = markers[candidateIndex];
        const dx = marker.anchor[0] - candidate.anchor[0];
        const dy = marker.anchor[1] - candidate.anchor[1];
        if (dx * dx + dy * dy <= overlapDistanceSq) {
          remaining.delete(candidateIndex);
          pending.push(candidateIndex);
        }
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}
