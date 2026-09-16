import {
  allowedDetents,
  clampDetent,
  COLLAPSED_BODY_HEIGHT,
  detentHeights,
  pickDetent,
  TAB_BAR_HEIGHT,
  type DrawerDetent,
} from '../../core/drawer-detents';

const SCREEN = { screenHeight: 844, insetTop: 59, insetBottom: 34, margin: 16, gripHeight: 16 };

describe('detentHeights', () => {
  it('caps peek so a long roster does not open at full length', () => {
    const short = detentHeights({ ...SCREEN, peekBody: 160 });
    const long = detentHeights({ ...SCREEN, peekBody: 900 });

    // A short body sits at its own height…
    expect(short.peek).toBeLessThan(long.peek);
    // …and a long one stops at the ceiling rather than swallowing the map.
    expect(long.peek).toBeCloseTo(844 * 0.38, 5);
  });

  it('counts only the chrome that lives INSIDE the drawer', () => {
    // The bottom inset and the island margin are the drawer's own marginBottom at peek. Counting
    // them here too left a band of empty island under the body that minimizing could not close.
    const withGrip = detentHeights({ ...SCREEN, peekBody: 160 });
    expect(withGrip.peek).toBe(160 + TAB_BAR_HEIGHT + 16);

    // A single-detent body renders no grip, so peek must not reserve its strip either.
    const noGrip = detentHeights({ ...SCREEN, peekBody: 160, gripHeight: 0 });
    expect(noGrip.peek).toBe(160 + TAB_BAR_HEIGHT);
  });

  it('opens at full height before the body has measured', () => {
    const heights = detentHeights({ ...SCREEN, peekBody: 0 });

    // Zero would flash an empty island on the first frame.
    expect(heights.peek).toBe(heights.full);
  });

  it('collapses mid onto full when the gap is too small to be a stop', () => {
    // A body that already fills most of the screen leaves no room for a middle stop.
    const heights = detentHeights({
      screenHeight: 300,
      insetTop: 59,
      insetBottom: 34,
      margin: 16,
      gripHeight: 18,
      peekBody: 90,
    });

    expect(heights.mid).toBe(heights.full);
  });

  it('keeps mid between peek and full when there is room for it', () => {
    const heights = detentHeights({ ...SCREEN, peekBody: 160 });

    expect(heights.mid).toBeGreaterThan(heights.peek);
    expect(heights.mid).toBeLessThan(heights.full);
  });

  it('never returns a negative height on a viewport smaller than its insets', () => {
    const heights = detentHeights({
      screenHeight: 20,
      insetTop: 59,
      insetBottom: 34,
      margin: 16,
      gripHeight: 18,
      peekBody: 0,
    });

    expect(heights.full).toBe(0);
    expect(heights.peek).toBe(0);
  });
});

describe('allowedDetents', () => {
  it('stops a body at the highest detent it has content for', () => {
    expect(allowedDetents('peek')).toEqual(['peek']);
    expect(allowedDetents('mid')).toEqual(['peek', 'mid']);
    expect(allowedDetents('full')).toEqual(['peek', 'mid', 'full']);
  });
});

describe('pickDetent', () => {
  const DETENTS: readonly DrawerDetent[] = ['peek', 'mid', 'full'];
  const HEIGHTS: Record<DrawerDetent, number> = { collapsed: 78, peek: 200, mid: 450, full: 780 };

  it('lets a single long drag reach the minimized stop from full screen', () => {
    const detents = allowedDetents('full', 'collapsed');
    expect(pickDetent(78, 0, 780, detents, HEIGHTS)).toBe('collapsed');
    expect(pickDetent(78, 900, 780, detents, HEIGHTS)).toBe('collapsed');
    expect(pickDetent(780, -900, 78, detents, HEIGHTS)).toBe('full');
  });

  it('keeps a collapsed drawer reopenable', () => {
    const detents = allowedDetents('full', 'collapsed');
    expect(pickDetent(90, -900, 78, detents, HEIGHTS)).toBe('peek');
  });

  it('leaves a one-line summary showing at collapsed rather than chrome alone', () => {
    // Collapsed used to be the grip and tab bar with the body clipped to nothing, so minimizing
    // the roster left a bar that said nothing about what was in it.
    const heights = detentHeights({ ...SCREEN, peekBody: 900 });
    expect(heights.collapsed).toBe(TAB_BAR_HEIGHT + 16 + COLLAPSED_BODY_HEIGHT);
  });

  it('lets a flick outrank the distance travelled', () => {
    // Barely moved, but thrown upward: intent beats displacement.
    expect(pickDetent(210, -900, 200, DETENTS, HEIGHTS)).toBe('mid');
    expect(pickDetent(440, 900, 450, DETENTS, HEIGHTS)).toBe('peek');
  });

  it('falls back to where it started when a slow drag does not commit', () => {
    // 30px of a 250px span, released slowly.
    expect(pickDetent(230, 0, 200, DETENTS, HEIGHTS)).toBe('peek');
  });

  it('advances once a slow drag crosses the commit threshold', () => {
    // 100px of a 250px span is past 32%.
    expect(pickDetent(300, 0, 200, DETENTS, HEIGHTS)).toBe('mid');
  });

  it('has nowhere further to go at the ends', () => {
    expect(pickDetent(800, -900, 780, DETENTS, HEIGHTS)).toBe('full');
    expect(pickDetent(190, 900, 200, DETENTS, HEIGHTS)).toBe('peek');
  });

  it('respects a body that is only allowed one detent', () => {
    const only: readonly DrawerDetent[] = ['peek'];
    expect(pickDetent(400, -900, 200, only, HEIGHTS)).toBe('peek');
  });

  it('measures travel from where the drag began, not from the nearest stop', () => {
    // Released mid-flight between mid and full, having started at mid: 165 of a 330px span.
    expect(pickDetent(615, 0, 450, DETENTS, HEIGHTS)).toBe('full');
  });
});

describe('clampDetent — the allowed range moving under a resting drawer', () => {
  it('leaves an allowed detent exactly where it is', () => {
    expect(clampDetent('mid', ['peek', 'mid', 'full'])).toBe('mid');
  });

  it('raises a collapsed ME panel one stop when the exploration cutoff takes collapsed away', () => {
    // Zooming past the cutoff drops `collapsed` from the range. The panel should rise to `peek`,
    // not stay pointing at a stop that no longer exists — that mismatch is what left a one-line
    // body inside an island still sized for the three-line one.
    expect(clampDetent('collapsed', ['peek'])).toBe('peek');
  });

  it('lowers a full drawer onto a mid ceiling rather than jumping to the top stop', () => {
    expect(clampDetent('full', ['peek', 'mid'])).toBe('mid');
  });

  it('picks the NEAREST allowed stop, not the tallest', () => {
    // The old fallback resolved every out-of-range detent to `topDetent`, which is only right by
    // accident when the range shrinks from the top.
    expect(clampDetent('collapsed', ['peek', 'mid', 'full'])).toBe('peek');
  });
});
