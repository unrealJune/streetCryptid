import {
  allowedDetents,
  detentHeights,
  pickDetent,
  type DrawerDetent,
} from '../../core/drawer-detents';

const SCREEN = { screenHeight: 844, insetTop: 59, insetBottom: 34, margin: 16, gripHeight: 18 };

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
    expect(withGrip.peek).toBe(160 + 60 + 18);

    // A single-detent body renders no grip, so peek must not reserve its strip either.
    const noGrip = detentHeights({ ...SCREEN, peekBody: 160, gripHeight: 0 });
    expect(noGrip.peek).toBe(160 + 60);
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
  const HEIGHTS: Record<DrawerDetent, number> = { peek: 200, mid: 450, full: 780 };

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
