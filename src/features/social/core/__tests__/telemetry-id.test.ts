import { telemetryInstanceId } from '../telemetry-id';

describe('telemetryInstanceId', () => {
  it('is the first ten hex of the endpoint id, the form spans carry', () => {
    expect(telemetryInstanceId('84F86B144A0123456789abcdef')).toBe('84f86b144a');
    expect(telemetryInstanceId(' cd736d206b99 ')).toBe('cd736d206b');
  });
});
