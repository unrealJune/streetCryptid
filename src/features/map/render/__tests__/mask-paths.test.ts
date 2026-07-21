import { computeRegionSpec } from '../../core/region';
import type { CameraState, MapGeometry, Viewport, WorldPoint } from '../../core/types';
import { buildMaskPaths } from '../mask-paths';

const camera: CameraState = { center: [0.3, 0.3], zoom: 15 };
const viewport: Viewport = { width: 400, height: 800 };
const spec = computeRegionSpec(camera, viewport, { dataZooms: { min: 0, max: 14 } });
const { minX, minY, maxX, maxY } = spec.rect;
const lx = (t: number): number => minX + (maxX - minX) * t;
const ly = (t: number): number => minY + (maxY - minY) * t;

const EMPTY: MapGeometry = { streets: [], rivers: [], water: [], parks: [], places: [] };

describe('buildMaskPaths', () => {
  it('returns all-empty strings for empty geometry', () => {
    const p = buildMaskPaths(EMPTY, spec);
    expect(p.streets).toEqual(['', '', '', '', '']);
    expect(p.park).toBe('');
    expect(p.water).toBe('');
    expect(p.rivers).toBe('');
  });

  it('groups streets into one SVG polyline per road class', () => {
    const geometry: MapGeometry = {
      ...EMPTY,
      streets: [
        {
          roadClass: 0,
          points: [
            [lx(0.1), ly(0.1)],
            [lx(0.9), ly(0.1)],
          ] as WorldPoint[],
        },
        {
          roadClass: 0,
          points: [
            [lx(0.1), ly(0.2)],
            [lx(0.9), ly(0.2)],
          ] as WorldPoint[],
        },
        {
          roadClass: 3,
          points: [
            [lx(0.1), ly(0.3)],
            [lx(0.9), ly(0.3)],
          ] as WorldPoint[],
        },
      ],
    };
    const p = buildMaskPaths(geometry, spec);
    // class 0 has two ways → two M commands in one string; class 3 has one.
    expect((p.streets[0].match(/M/g) ?? []).length).toBe(2);
    expect((p.streets[3].match(/M/g) ?? []).length).toBe(1);
    expect(p.streets[1]).toBe('');
    expect(p.streets[2]).toBe('');
    expect(p.streets[4]).toBe('');
  });

  it('closes ring fills with Z (even-odd sub-paths)', () => {
    const ring: WorldPoint[] = [
      [lx(0.2), ly(0.2)],
      [lx(0.4), ly(0.2)],
      [lx(0.4), ly(0.4)],
      [lx(0.2), ly(0.4)],
    ];
    const geometry: MapGeometry = {
      ...EMPTY,
      parks: [{ rings: [ring] }],
      water: [{ rings: [ring] }],
    };
    const p = buildMaskPaths(geometry, spec);
    expect(p.park.startsWith('M')).toBe(true);
    expect(p.park.endsWith('Z')).toBe(true);
    expect(p.water.endsWith('Z')).toBe(true);
  });

  it('emits river centerlines as open polylines', () => {
    const geometry: MapGeometry = {
      ...EMPTY,
      rivers: [
        {
          points: [
            [lx(0.1), ly(0.5)],
            [lx(0.9), ly(0.6)],
          ] as WorldPoint[],
        },
      ],
    };
    const p = buildMaskPaths(geometry, spec);
    expect(p.rivers.startsWith('M')).toBe(true);
    expect(p.rivers).toContain('L');
    expect(p.rivers).not.toContain('Z');
  });

  it('drops degenerate (single-point) ways', () => {
    const geometry: MapGeometry = {
      ...EMPTY,
      streets: [{ roadClass: 2, points: [[lx(0.5), ly(0.5)]] as WorldPoint[] }],
    };
    expect(buildMaskPaths(geometry, spec).streets[2]).toBe('');
  });

  it('projects into the mask pixel box', () => {
    const geometry: MapGeometry = {
      ...EMPTY,
      streets: [
        {
          roadClass: 1,
          points: [
            [lx(0.05), ly(0.05)],
            [lx(0.95), ly(0.95)],
          ] as WorldPoint[],
        },
      ],
    };
    const coords = buildMaskPaths(geometry, spec)
      .streets[1].replace(/[ML]/g, ' ')
      .trim()
      .split(/\s+/)
      .map(Number);
    for (let i = 0; i < coords.length; i += 2) {
      expect(coords[i]).toBeGreaterThanOrEqual(-1);
      expect(coords[i]).toBeLessThanOrEqual(spec.maskWidth + 1);
      expect(coords[i + 1]).toBeGreaterThanOrEqual(-1);
      expect(coords[i + 1]).toBeLessThanOrEqual(spec.maskHeight + 1);
    }
  });
});
