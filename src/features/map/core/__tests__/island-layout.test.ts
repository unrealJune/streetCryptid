import { islandLayout } from '../island-layout';

const GUTTER = 16;

describe('islandLayout', () => {
  it('is the bottom drawer, between the side insets, on a phone-width window', () => {
    expect(islandLayout(393, 0, 0, GUTTER)).toEqual({
      column: false,
      frame: { left: 0, right: 0 },
      chromeLeft: GUTTER,
    });
    // iPhone Duo's rail, or a landscape notch, on either edge.
    expect(islandLayout(430, 84, 0, GUTTER).frame).toEqual({ left: 84, right: 0 });
  });

  it('is the drawer before the first layout has measured the window', () => {
    expect(islandLayout(0, 0, 0, GUTTER).column).toBe(false);
  });

  it('becomes a leading column on a wide window, with chrome starting after it', () => {
    const layout = islandLayout(1024, 0, 0, GUTTER);
    expect(layout.column).toBe(true);
    // 420 of column plus the drawer's own gutter on each side.
    expect(layout.frame).toEqual({ left: 0, width: 420 + GUTTER * 2 });
    expect(layout.chromeLeft).toBe(420 + GUTTER * 2);
    expect(islandLayout(1024, 84, 0, GUTTER).frame.left).toBe(84);
  });

  it('never overflows a window only just past the breakpoint', () => {
    const { frame } = islandLayout(600, 90, 90, GUTTER);
    expect(frame.left + (frame.width ?? 0) + 90).toBeLessThanOrEqual(600);
  });
});
