/**
 * Width past which the island stops being a bottom drawer: tablets, unfolded foldables (Android
 * book-style phones, iPhone Duo), desktop windows and landscape phones. A full-width bottom sheet
 * there is a long, shallow strip with three rows of friends in it, so the island becomes a column
 * of cards on the leading edge (`IslandColumn`), ME and FRIENDS both open and each as tall as its
 * content, and the map keeps the rest of the window.
 */
const WIDE_LAYOUT_MIN_WIDTH = 600;
/** The column's own width; a phone's width, so its rows read the same as they do in the drawer. */
const ISLAND_COLUMN_WIDTH = 420;

export interface IslandLayout {
  /** Whether the island is the always-open leading column rather than the bottom drawer. */
  readonly column: boolean;
  /**
   * Horizontal placement of the island layer. The drawer brings its own `gutter` of side margin in
   * both modes, so a column's layer is the column plus a gutter on each side.
   */
  readonly frame: { readonly left: number; readonly right?: number; readonly width?: number };
  /** Where chrome that shares the top row with the column may start (its trailing gutter). */
  readonly chromeLeft: number;
  /**
   * How much of the map, from the leading edge, the island hides. Whatever the map centres on (a
   * friend, your own position, the opening camera) is centred in the rest. 0 for the drawer, which
   * covers the bottom and moves.
   */
  readonly obscuredLeft: number;
}

/**
 * Where the island sits for a window `width` wide (0 before the first layout). `gutter` is the
 * island's side margin, which the drawer applies itself.
 */
export function islandLayout(
  width: number,
  insetLeft: number,
  insetRight: number,
  gutter: number
): IslandLayout {
  if (width < WIDE_LAYOUT_MIN_WIDTH) {
    return {
      column: false,
      frame: { left: insetLeft, right: insetRight },
      chromeLeft: insetLeft + gutter,
      obscuredLeft: 0,
    };
  }
  const frameWidth = Math.min(ISLAND_COLUMN_WIDTH + gutter * 2, width - insetLeft - insetRight);
  return {
    column: true,
    frame: { left: insetLeft, width: frameWidth },
    chromeLeft: insetLeft + frameWidth,
    obscuredLeft: insetLeft + frameWidth - gutter,
  };
}
