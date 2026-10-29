import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** A trailing inset at least this wide is a system rail (iPhone Duo's 84pt), not a notch. */
export const SYSTEM_RAIL_MIN_INSET = 64;

/**
 * The width of the system rail on the trailing edge, or 0 when there is none.
 *
 * iPhone Duo draws its status items in a vertical rail on the right edge, folded and unfolded,
 * and the space under them is otherwise empty. Primary actions move into it (the map's FABs,
 * onboarding's Back / Continue) rather than spending a bar or a column of the page beside it.
 * Inside the Settings sheet the nested `SafeAreaProvider` reports no inset, so a sheet never
 * sees a rail it does not touch.
 */
export function useSystemRail(): number {
  const { right } = useSafeAreaInsets();
  return right >= SYSTEM_RAIL_MIN_INSET ? right : 0;
}

/**
 * Mirrors a scroll view, and its content container back, so iOS draws the scroll bar on the
 * LEADING edge: with the rail's tabs on the trailing edge, a bar there ran across them. iOS has no
 * setting for the bar's side; this is the standard mirror trick, and touches, text and inputs are
 * unaffected because the content is mirrored twice. A mirrored scroll view's own horizontal
 * padding lands on the opposite side, so the caller swaps it.
 */
export const LEADING_SCROLL_BAR = { transform: [{ scaleX: -1 }] } as const;
