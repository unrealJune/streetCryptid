import { H3_DISPLAY_RES, H3_MIN_RENDER_ZOOM, resForZoom } from '../cell-ladder';

describe('resForZoom', () => {
  it('uses the fixed display resolution at readable zooms', () => {
    expect(resForZoom(16)).toBe(H3_DISPLAY_RES);
    expect(resForZoom(H3_MIN_RENDER_ZOOM)).toBe(H3_DISPLAY_RES);
  });

  it('disables exploration below the readable zoom', () => {
    expect(resForZoom(H3_MIN_RENDER_ZOOM - 0.01)).toBeNull();
    expect(resForZoom(1)).toBeNull();
  });
});
