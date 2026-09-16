/** How far up the drawer is: the island at rest, half the screen, or all of it. */
export type DrawerDetent = 'collapsed' | 'peek' | 'mid' | 'full';

export const DETENT_ORDER: readonly DrawerDetent[] = ['collapsed', 'peek', 'mid', 'full'];

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

/**
 * `IslandTabs`: 44pt targets plus its own 8pt padding, top and bottom.
 *
 * Only the opening guess — the drawer measures the real bar and passes it in. It has to, because
 * peek is derived as body + chrome and then the bar is laid out INSIDE that: understating the bar
 * by even the hairline border leaves the body a pixel taller than the space it was given, and a
 * ScrollView one pixel short of its content is a panel that scrolls and rubber-bands under your
 * finger for no reason a user can see.
 */
export const TAB_BAR_HEIGHT = 52;
/**
 * Grip strip height — the drawer's own affordance, above whatever body it carries. Only counted
 * when the drawer actually has somewhere to go: a body with one detent renders no grip, because a
 * handle on a surface that cannot move is furniture claiming to be a control.
 */
export const GRIP_HEIGHT = 16;

/**
 * The collapsed row itself, sized off the TALLEST thing it can carry — the roster's 30pt add
 * button, not the 26pt type beside it. Bodies floor their header on it so ME and FRIENDS collapse
 * to one shape rather than to each body's idea of a line.
 */
export const COLLAPSED_ROW_HEIGHT = 30;

/**
 * The one-line summary every body shows at `collapsed`, and therefore the body height that detent
 * resolves to.
 *
 * `collapsed` used to be chrome alone — grip plus tab bar, with the body clipped to nothing — so
 * minimizing the roster left a bare bar that said nothing about what was in it. Both bodies now
 * collapse to the same single line (the place name and its percentage; the nearby count), which is
 * what makes minimizing one panel rather than two.
 *
 * A constant rather than a measurement: the line is one row of known type at a known size, and
 * measuring it would mean laying the compact body out at a detent it is not in yet. Bodies pin
 * themselves to it (`islandBody.minimized`) so the two can never disagree.
 */
export const COLLAPSED_BODY_HEIGHT = COLLAPSED_ROW_HEIGHT + GRIP_HEIGHT;

/**
 * Detent geometry, kept clear of Reanimated and the component tree so it can be reasoned about
 * (and tested) as the arithmetic it is. `MapDrawer` is the only caller.
 */

/**
 * What the drawer carries INSIDE itself at every detent, above and below the body. Exported
 * because the drawer needs the same figure to answer a question the heights alone cannot: how
 * tall the body's own frame is at a given detent, and therefore whether the list inside it has
 * anywhere to scroll.
 */
export function drawerChrome(gripHeight: number, tabBarHeight: number = TAB_BAR_HEIGHT): number {
  return tabBarHeight + gripHeight;
}

/** Detents a body is allowed to reach, in ascending height order. */
export function allowedDetents(
  max: DrawerDetent,
  min: DrawerDetent = 'peek'
): readonly DrawerDetent[] {
  return DETENT_ORDER.slice(DETENT_ORDER.indexOf(min), DETENT_ORDER.indexOf(max) + 1);
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
  /** The tab bar as actually laid out. Defaults to {@link TAB_BAR_HEIGHT} until it is measured. */
  tabBarHeight?: number;
}): Record<DrawerDetent, number> {
  const {
    peekBody,
    screenHeight,
    insetTop,
    insetBottom,
    margin,
    gripHeight,
    tabBarHeight = TAB_BAR_HEIGHT,
  } = input;
  const full = Math.max(0, screenHeight - insetTop - margin);
  // Only what the drawer carries INSIDE itself. The bottom inset and the island margin are the
  // drawer's own `marginBottom` at peek — counting them here too added a band of empty island
  // under the body that no amount of minimizing could close, because it was never the body's.
  const chrome = drawerChrome(gripHeight, tabBarHeight);
  // Before the body has measured, peek and full coincide: opening at zero height would flash an
  // empty island on the first frame.
  const peek =
    peekBody > 0 ? Math.min(peekBody + chrome, screenHeight * PEEK_FRACTION, full) : full;
  const midCandidate = (screenHeight - insetBottom) * MID_FRACTION;
  const mid =
    midCandidate > peek + MIN_DETENT_GAP && midCandidate < full - MIN_DETENT_GAP
      ? midCandidate
      : full;
  return { collapsed: Math.min(chrome + COLLAPSED_BODY_HEIGHT, full), peek, mid, full };
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

  const travelled = height - heights[detents[fromIndex]];
  const direction = travelled > 0 ? 1 : -1;
  let destination = fromIndex;
  for (let next = fromIndex + direction; next >= 0 && next < detents.length; next += direction) {
    const previousHeight = heights[detents[next - direction]];
    const span = Math.abs(heights[detents[next]] - previousHeight);
    const progress = (height - previousHeight) * direction;
    if (progress < span * TRAVEL_COMMIT) break;
    destination = next;
  }
  // A long drag may cross several stops; a short flick still advances at least one.
  if (velocityY < -FLING_SPEED)
    destination = Math.max(destination, Math.min(fromIndex + 1, detents.length - 1));
  if (velocityY > FLING_SPEED) destination = Math.min(destination, Math.max(fromIndex - 1, 0));
  return detents[destination];
}

/**
 * The nearest allowed detent to `detent`, for when the allowed RANGE moves under a drawer that is
 * already resting somewhere.
 *
 * The range is not fixed: `collapsed` is taken away from the ME panel when the camera zooms past
 * the exploration cutoff (a grip that moves nothing is worse than no grip), and `full` is given
 * back when the roster opens. Nothing resets the caller's detent when that happens, so it can be
 * left pointing at a stop that no longer exists — and a drawer resolving its height one way while
 * the body it carries is styled the other way is the whole of that bug.
 *
 * Nearest by ORDER, not a fall back to the top: a friend's pane dropping from `full` to a `mid`
 * ceiling should settle on `mid`, and a collapsed ME panel losing `collapsed` should rise one stop
 * to `peek` — not jump to whatever the tallest stop happens to be.
 */
export function clampDetent(detent: DrawerDetent, detents: readonly DrawerDetent[]): DrawerDetent {
  if (detents.includes(detent)) return detent;
  const index = DETENT_ORDER.indexOf(detent);
  let best = detents[0];
  let bestGap = Infinity;
  for (const candidate of detents) {
    const gap = Math.abs(DETENT_ORDER.indexOf(candidate) - index);
    if (gap < bestGap) {
      bestGap = gap;
      best = candidate;
    }
  }
  return best;
}
