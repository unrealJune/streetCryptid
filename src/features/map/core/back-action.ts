import type { DrawerDetent } from './drawer-detents';

/**
 * What the Android system back should do to the map, given what is layered over it.
 *
 * `null` means "not ours" — let the OS have the press, which from the map means leaving the app.
 */
export type MapBackAction = 'close-layers' | 'close-detail' | 'collapse-drawer' | null;

/** The map's own state, as far as a back press is concerned. */
export interface MapBackState {
  /** The layers popover is showing. */
  layersOpen: boolean;
  /** A locator is selected — a friend's detail pane, or our own trail. */
  selectedEndpoint: string | null;
  detent: DrawerDetent;
}

/**
 * Decide one back press.
 *
 * The map is the root route and everything over it is local state rather than a pushed screen, so
 * the system back had nothing to pop and went straight to exiting the app — which meant opening a
 * friend from the roster and swiping back closed streetCryptid outright. This restores the contract
 * people already expect: **back closes what you opened, one layer per press, and only then exits.**
 *
 * Ordered most-nested first, which is the order they can be stacked in: the layers popover sits
 * over the drawer, and a friend's pane is inside a drawer that may have been raised to read it.
 *
 * `peek` and `collapsed` are deliberately not claimed. They are the drawer's resting states rather
 * than something the user opened, and consuming a press there would make back feel unable to leave
 * the app at all — the opposite failure, and a more annoying one because it has no escape. A map
 * with nothing open exits on the first press, exactly as it always did.
 */
export function resolveMapBackAction(state: MapBackState): MapBackAction {
  if (state.layersOpen) return 'close-layers';
  if (state.selectedEndpoint) return 'close-detail';
  if (state.detent === 'mid' || state.detent === 'full') return 'collapse-drawer';
  return null;
}
