import { createTelemetry } from '../telemetry';
import { getDeviceResource } from '../resource';

/** Pull the resource attribute key/value pairs out of an OTLP resourceSpans payload. */
function resourceAttrs(body: any): Record<string, string> {
  const attrs = body.resourceSpans[0].resource.attributes as { key: string; value: any }[];
  return Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]));
}

describe('getDeviceResource', () => {
  it('always includes a normalized, low-cardinality os.name', () => {
    const resource = getDeviceResource();
    expect(typeof resource['os.name']).toBe('string');
    expect(['iOS', 'Android', 'web']).toContain(resource['os.name']);
  });

  it('stamps the device attributes onto the exported OTLP resource alongside service.name', async () => {
    const sent: any[] = [];
    const telemetry = createTelemetry({
      endpoint: 'http://collector:4318',
      resource: getDeviceResource(),
      transport: async (_url, body) => {
        sent.push(JSON.parse(body));
      },
    });
    telemetry.startSpan('bg.wake').end();
    await telemetry.flush();

    const attrs = resourceAttrs(sent[0]);
    expect(attrs['service.name']).toBe('streetcryptid-app');
    expect(attrs['os.name']).toBeDefined();
  });
});
