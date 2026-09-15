export type DistanceUnit = 'km' | 'mi';

export function formatDistanceValue(
  distanceM: number | null,
  unit: DistanceUnit = 'km'
): string | null {
  if (distanceM === null || !Number.isFinite(distanceM)) return null;
  const metres = Math.max(0, distanceM);
  if (unit === 'mi') {
    const miles = metres / 1609.344;
    if (miles < 1) return `${Math.round(metres / 0.3048 / 10) * 10} ft`;
    return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
  }
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}
