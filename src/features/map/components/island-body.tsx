import { StyleSheet } from 'react-native';

import { Spacing } from '@/constants/theme';

import { COLLAPSED_BODY_HEIGHT, COLLAPSED_ROW_HEIGHT } from '../core/drawer-detents';

/**
 * Header geometry every drawer body shares, so "minimized" is one shape rather than each body's
 * idea of small.
 *
 * There is no chevron here any more. ME collapsed with a chevron and FRIENDS collapsed with the
 * drawer's grip, which meant the same gesture on two panels of the same surface did two different
 * things — and the chevron's 48pt touch target was the tallest thing in either header, so it set
 * the island's resting height for a control that duplicated the grip. The grip is now the only way
 * to size the drawer, on both tabs.
 *
 * `expanded`/`minimized` are the body's outer padding; `header` is the top row; `summary` is the
 * accessible block that leads it.
 */
export const islandBody = StyleSheet.create({
  expanded: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  minimized: {
    paddingHorizontal: Spacing.three,
    // Pinned, not padded: this is the body height `collapsed` is derived from, and a row that
    // measured a point taller than the detent it is in would hand the ScrollView inside the
    // drawer more content than frame — a one-line panel that scrolls under your finger.
    height: COLLAPSED_BODY_HEIGHT,
    // Top-aligned, and that is what centres it. The grip strip sits ABOVE this body inside the
    // same island, so it already supplies the row's top margin; centring within the body alone
    // counted the grip twice and left the line visibly low, with the roster's add button resting
    // on the tab bar's divider. `COLLAPSED_BODY_HEIGHT` is the row plus one grip's worth of air,
    // so the gap under the line and the strip over it are the same height by construction.
    justifyContent: 'flex-start',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    // Floor, not a fixed height: it only bites on the shorter of the two headers (ME's 26pt line),
    // and it is what makes both tabs collapse to a row of the same height.
    minHeight: COLLAPSED_ROW_HEIGHT,
  },
  summary: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
});
