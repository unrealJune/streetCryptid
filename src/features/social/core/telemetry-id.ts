/**
 * The id a phone's developer telemetry ships under: `service.instance.id` on every span, the same
 * 10-hex form as `sc.author` and `sc.peer`. It is the first ten hex of the endpoint id, so a friend
 * card already holds it, and showing it there is how "her dot is stale" becomes a Grafana filter.
 * Both the stamping side (`configureDevTelemetry`) and the friend card read it from here so the two
 * spellings cannot drift. See infra/otel/README.md.
 */
export const TELEMETRY_ID_LENGTH = 10;

export function telemetryInstanceId(endpointId: string): string {
  return endpointId.trim().toLowerCase().slice(0, TELEMETRY_ID_LENGTH);
}
