import { visibleWorldRect } from '../camera';
import { H3_MIN_LADDER_ZOOM, resForZoom } from '../cell-ladder';
import {
  OCEAN_ANCHORS,
  OCEAN_CRYPTID_MAX_ZOOM,
  oceanCryptidOpacity,
  SEA_CRYPTIDS,
  visibleOceanCryptids,
} from '../ocean-cryptids';
import type { CameraState, Viewport } from '../types';

const viewport: Viewport = { width: 390, height: 800 };
const globe: CameraState = { center: [0.5, 0.5], zoom: 2 };

describe('OCEAN_ANCHORS', () => {
  it('has unique ids and a real figure for each', () => {
    expect(new Set(OCEAN_ANCHORS.map((a) => a.id)).size).toBe(OCEAN_ANCHORS.length);
    for (const anchor of OCEAN_ANCHORS) {
      expect(SEA_CRYPTIDS[anchor.figure % SEA_CRYPTIDS.length].art.length).toBeGreaterThan(0);
    }
  });

  it('keeps ocean anchors inside the world and void anchors outside it', () => {
    const inWorld = OCEAN_ANCHORS.filter((a) => !a.id.startsWith('void-'));
    const outside = OCEAN_ANCHORS.filter((a) => a.id.startsWith('void-'));

    expect(inWorld.length).toBeGreaterThan(0);
    expect(outside.length).toBeGreaterThan(0);
    for (const { world } of inWorld) {
      expect(world[0]).toBeGreaterThanOrEqual(0);
      expect(world[0]).toBeLessThanOrEqual(1);
      expect(world[1]).toBeGreaterThan(0);
      expect(world[1]).toBeLessThan(1);
    }
    // The letterbox past the Mercator cutoff is the point of these.
    for (const { world } of outside) {
      expect(world[1] < 0 || world[1] > 1).toBe(true);
    }
  });
});

describe('oceanCryptidOpacity', () => {
  it('is silent above the zoom gate and full below the fade band', () => {
    expect(oceanCryptidOpacity(OCEAN_CRYPTID_MAX_ZOOM)).toBe(0);
    expect(oceanCryptidOpacity(OCEAN_CRYPTID_MAX_ZOOM + 4)).toBe(0);
    expect(oceanCryptidOpacity(1)).toBe(1);
  });

  it('fades in rather than popping', () => {
    const justInside = oceanCryptidOpacity(OCEAN_CRYPTID_MAX_ZOOM - 0.1);
    expect(justInside).toBeGreaterThan(0);
    expect(justInside).toBeLessThan(1);
  });

  it('takes over as the exploration ladder runs out', () => {
    // The gate sits above the ladder floor, so the two layers overlap briefly
    // instead of leaving a band where the map is both blank and empty.
    expect(OCEAN_CRYPTID_MAX_ZOOM).toBeGreaterThan(H3_MIN_LADDER_ZOOM);
    expect(oceanCryptidOpacity(H3_MIN_LADDER_ZOOM - 0.01)).toBeGreaterThan(0);
    expect(resForZoom(H3_MIN_LADDER_ZOOM - 0.01)).toBeNull();
  });
});

describe('visibleOceanCryptids', () => {
  it('draws nothing above the zoom gate', () => {
    expect(visibleOceanCryptids({ center: [0.5, 0.5], zoom: 12 }, viewport)).toEqual([]);
    expect(visibleOceanCryptids({ ...globe, zoom: OCEAN_CRYPTID_MAX_ZOOM }, viewport)).toEqual([]);
  });

  it('places cryptids at globe zoom', () => {
    const placed = visibleOceanCryptids(globe, viewport);
    expect(placed.length).toBeGreaterThan(0);
    for (const cryptid of placed) {
      expect(cryptid.art.length).toBeGreaterThan(0);
      expect(cryptid.phase).toBeGreaterThanOrEqual(0);
      expect(cryptid.phase).toBeLessThan(1);
    }
  });

  it('is deterministic for the same camera', () => {
    expect(visibleOceanCryptids(globe, viewport)).toEqual(visibleOceanCryptids(globe, viewport));
  });

  it('gives each figure a distinct drift phase', () => {
    const placed = visibleOceanCryptids(globe, viewport);
    expect(new Set(placed.map((c) => c.phase)).size).toBe(placed.length);
  });

  it('respects the cap', () => {
    expect(visibleOceanCryptids(globe, viewport, { max: 2 })).toHaveLength(2);
  });

  it('only places anchors at or near the visible rect', () => {
    const view = visibleWorldRect(globe, viewport);
    // A generous slack for the off-screen margin the layer deliberately keeps.
    const slack = 0.05;
    for (const { world } of visibleOceanCryptids(globe, viewport, { max: 99 })) {
      expect(world[0]).toBeGreaterThanOrEqual(view.minX - slack);
      expect(world[0]).toBeLessThanOrEqual(view.maxX + slack);
      expect(world[1]).toBeGreaterThanOrEqual(view.minY - slack);
      expect(world[1]).toBeLessThanOrEqual(view.maxY + slack);
    }
  });

  it('drops anchors the camera has panned away from', () => {
    // Two anchors far enough apart in x that no single z5 view holds both.
    const pacific = OCEAN_ANCHORS.find((a) => a.id === 'pacific-n')!;
    const indian = OCEAN_ANCHORS.find((a) => a.id === 'indian')!;
    expect(Math.abs(pacific.world[0] - indian.world[0])).toBeGreaterThan(0.3);

    const at = (anchorId: string) => {
      const target = OCEAN_ANCHORS.find((a) => a.id === anchorId)!;
      const camera: CameraState = { center: target.world, zoom: 5 };
      return visibleOceanCryptids(camera, viewport, { max: 99 }).map((c) => c.id);
    };

    // Centring on an anchor must show it, and must not show the far one.
    expect(at('pacific-n')).toContain('pacific-n');
    expect(at('pacific-n')).not.toContain('indian');
    expect(at('indian')).toContain('indian');
    expect(at('indian')).not.toContain('pacific-n');
  });
});
