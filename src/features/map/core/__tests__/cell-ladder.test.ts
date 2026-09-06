import { CAMERA_MAX_ZOOM } from '../../config';
import {
  H3_COARSEST_RES,
  H3_DISPLAY_RES,
  H3_MIN_LADDER_ZOOM,
  H3_MIN_RENDER_ZOOM,
  resForZoom,
} from '../cell-ladder';

describe('resForZoom', () => {
  it('uses the fixed display resolution at readable zooms', () => {
    expect(resForZoom(CAMERA_MAX_ZOOM)).toBe(H3_DISPLAY_RES);
    expect(resForZoom(16)).toBe(H3_DISPLAY_RES);
    expect(resForZoom(H3_MIN_RENDER_ZOOM)).toBe(H3_DISPLAY_RES);
  });

  it('steps one resolution coarser just below the display band', () => {
    expect(resForZoom(H3_MIN_RENDER_ZOOM - 0.01)).toBe(H3_DISPLAY_RES - 1);
  });

  it('never gets finer as the camera pulls back', () => {
    let previous = resForZoom(CAMERA_MAX_ZOOM);
    for (let zoom = CAMERA_MAX_ZOOM; zoom >= 0; zoom -= 0.05) {
      const res = resForZoom(zoom);
      if (res === null) {
        // Once the ladder ends it must stay ended, or the layer would flicker
        // back on as the user keeps zooming out.
        expect(resForZoom(zoom - 0.05)).toBeNull();
        continue;
      }
      expect(res).toBeLessThanOrEqual(previous as number);
      expect(res).toBeGreaterThanOrEqual(H3_COARSEST_RES);
      previous = res;
    }
  });

  it('covers every zoom from the ladder floor to the camera ceiling', () => {
    for (let zoom = H3_MIN_LADDER_ZOOM + 0.01; zoom <= CAMERA_MAX_ZOOM; zoom += 0.05) {
      expect(resForZoom(zoom)).not.toBeNull();
    }
  });

  it('walks the full ladder between the display band and the floor', () => {
    const seen = new Set<number>();
    for (let zoom = H3_MIN_RENDER_ZOOM; zoom >= H3_MIN_LADDER_ZOOM + 0.01; zoom -= 0.05) {
      const res = resForZoom(zoom);
      if (res !== null) seen.add(res);
    }
    // Every rung from the coarsest to the display resolution is actually used.
    for (let res = H3_COARSEST_RES; res <= H3_DISPLAY_RES; res++) {
      expect(seen).toContain(res);
    }
  });

  it('hides exploration below the coarsest rung', () => {
    expect(resForZoom(H3_MIN_LADDER_ZOOM - 0.01)).toBeNull();
    expect(resForZoom(1)).toBeNull();
  });
});
