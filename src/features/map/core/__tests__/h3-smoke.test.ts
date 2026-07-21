import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { cellToLatLng, cellToParent, gridDisk, isValidCell, latLngToCell } from 'h3-js';

describe('h3-js smoke', () => {
  it('round-trips a Seattle fix at res 10', () => {
    const cell = latLngToCell(47.62, -122.32, 10);
    expect(isValidCell(cell)).toBe(true);
    const [lat, lng] = cellToLatLng(cell);
    // Cell center must be within one cell (~131 m ≈ 0.0012° lat) of the input.
    expect(Math.abs(lat - 47.62)).toBeLessThan(0.002);
    expect(Math.abs(lng - -122.32)).toBeLessThan(0.003);
    expect(latLngToCell(lat, lng, 10)).toBe(cell);
  });

  it('walks the hierarchy and neighborhood', () => {
    const cell = latLngToCell(47.62, -122.32, 10);
    const parent = cellToParent(cell, 7);
    expect(isValidCell(parent)).toBe(true);
    expect(cellToParent(cell, 10)).toBe(cell);
    expect(gridDisk(cell, 1)).toHaveLength(7);
  });

  it('ships no utf-16le TextDecoder (Hermes crashes on it; guards the bun patch)', () => {
    // uber/h3-js#203 — Hermes rejects new TextDecoder('utf-16le') at parse time.
    // The bun patch rewrites it to utf-8; a version bump that drops the patch
    // must fail here before it reaches a device.
    const dist = join(__dirname, '..', '..', '..', '..', '..', 'node_modules', 'h3-js', 'dist');
    const bundles = readdirSync(dist).filter((f) => f.endsWith('.js'));
    expect(bundles.length).toBeGreaterThan(0);
    for (const bundle of bundles) {
      expect(readFileSync(join(dist, bundle), 'utf8')).not.toContain('utf-16le');
    }
  });
});
