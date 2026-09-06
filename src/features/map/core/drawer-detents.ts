/** How far up the drawer is: the island at rest, half the screen, or all of it. */
export type DrawerDetent = 'peek' | 'mid' | 'full';

export const DETENT_ORDER: readonly DrawerDetent[] = ['peek', 'mid', 'full'];

/** Fraction of the usable height the `mid` detent occupies. */
const MID_FRACTION = 0.56;
/**
 * Ceiling on `peek`, as a fraction of the screen. Peek is otherwise the body's own measured
 * height, which for a five-friend roster is the whole list — a "peek" as tall as the thing it is
 * peeking at. Short bodies (a friend's summary) stay at their natural height and never reach this.
 */
const PEEK_FRACTION = 0.38;
/** Smallest gap worth making a separate stop. A detent that moves the drawer 30px feels broken. */
const MIN_DETENT_GAP = 80;

/** Past this much of the way to the next detent, a drag lands there instead of falling back. */
const TRAVEL_COMMIT = 0.32;
/** A flick faster than this (px/s) picks the next detent regardless of how far it travelled. */
const FLING_SPEED = 550;

/** `IslandTabs`: 44pt targets plus its own 8pt padding, top and bottom. */
export const TAB_BAR_HEIGHT = 60;
/**
 * Grip strip height — the drawer's own affordance, above whatever body it carries. Only counted
 * when the drawer actually has somewhere to go: a body with one detent renders no grip, because a
 * handle on a surface that cannot move is 18px of furniture claiming to be a control.
 */
export const GRIP_HEIGHT = 18;

/**
 * Detent geometry, kept clear of Reanimated and the component tree so it can be reasoned about
 * (and tested) as the arithmetic it is. `MapDrawer` is the only caller.
 */

/** Detents a body is allowed to reach, in ascending height order. */
export function allowedDetents(max: DrawerDetent): readonly DrawerDetent[] {
  return DETENT_ORDER.slice(0, DETENT_ORDER.indexOf(max) + 1);
}

/**
 * Resolved pixel height of each detent.
 *
 * `peek` is the body's own measured height, capped so a long roster does not open at full length;
 * `full` is everything below the top inset. `mid` collapses onto `full` when the gap is too small
 * to be worth a stop.
 */
export function detentHeights(input: {
  peekBody: number;
  screenHeight: number;
  insetTop: number;
  insetBottom: number;
  /** The island's own margin (`Spacing.three`), passed in so this module stays free of theme. */
  margin: number;
  /** `GRIP_HEIGHT` when the drawer renders a grip, 0 when it has a single detent and does not. */
  gripHeight: number;
}): Record<DrawerDetent, number> {
  const { peekBody, screenHeight, insetTop, insetBottom, margin, gripHeight } = input;
  const full = Math.max(0, screenHeight - insetTop - margin);
  // Only what the drawer carries INSIDE itself. The bottom inset and the island margin are the
  // drawer's own `marginBottom` at peek — counting them here too added a band of empty island
  // under the body that no amount of minimizing could close, because it was never the body's.
  const chrome = TAB_BAR_HEIGHT + gripHeight;
  // Before the body has measured, peek and full coincide: opening at zero height would flash an
  // empty island on the first frame.
  const peek =
    peekBody > 0 ? Math.min(peekBody + chrome, screenHeight * PEEK_FRACTION, full) : full;
  const midCandidate = (screenHeight - insetBottom) * MID_FRACTION;
  const mid =
    midCandidate > peek + MIN_DETENT_GAP && midCandidate < full - MIN_DETENT_GAP
      ? midCandidate
      : full;
  return { peek, mid, full };
}

/**
 * Where a released drag lands.
 *
 * Velocity outranks distance: a flick is a statement of intent, and making someone drag a third of
 * the screen to open a drawer they clearly threw open is the difference between a control that
 * feels alive and one that feels like it is arguing.
 *
 * Travel is measured from where the drag BEGAN rather than from the nearest stop — a drag released
 * halfway between two detents has committed to the one it is heading for, and snapping it back to
 * whichever it happens to be nearest would ignore the gesture that was actually made.
 *
 * A worklet: this runs on the UI thread from the pan gesture's `onEnd`.
 */
export function pickDetent(
  height: number,
  velocityY: number,
  from: number,
  detents: readonly DrawerDetent[],
  heights: Record<DrawerDetent, number>
): DrawerDetent {
  'worklet';
  // Inlined rather than a helper call: the Reanimated plugin hoists each `worklet` separately, and
  // one calling another does not survive the transform.
  let fromIndex = 0;
  let bestGap = Infinity;
  for (let index = 0; index < detents.length; index += 1) {
    const gap = Math.abs(heights[detents[index]] - from);
    if (gap < bestGap) {
      bestGap = gap;
      fromIndex = index;
    }
  }

  if (velocityY < -FLING_SPEED) return detents[Math.min(fromIndex + 1, detents.length - 1)];
  if (velocityY > FLING_SPEED) return detents[Math.max(fromIndex - 1, 0)];

  const travelled = height - heights[detents[fromIndex]];
  const next = travelled > 0 ? fromIndex + 1 : fromIndex - 1;
  if (next < 0 || next >= detents.length) return detents[fromIndex];

  const span = Math.abs(heights[detents[next]] - heights[detents[fromIndex]]);
  if (span > 0 && Math.abs(travelled) / span >= TRAVEL_COMMIT) return detents[next];
  return detents[fromIndex];
}
