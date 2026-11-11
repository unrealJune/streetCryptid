/**
 * The mothman sigil (`assets/images/mothman-logo.svg`) as four rows of strokes, so the splash can
 * flip it in one row at a time. Coordinates are the logo's 1024-unit grid; every stroke is 27
 * units wide with round caps. The head dots and the amber eyes are circles, kept separate because
 * they are fills, and the eyes arrive last.
 */
export interface SigilRow {
  /** One SVG path string, every stroke in the row. */
  readonly strokes: string;
  /** Filled dots belonging to the row. */
  readonly dots: readonly { readonly cx: number; readonly cy: number; readonly r: number }[];
  /** The row's vertical centre, which it flips about. */
  readonly centerY: number;
}

export const SIGIL_CENTER_X = 512;
export const SIGIL_STROKE = 27;

export const SIGIL_ROWS: readonly SigilRow[] = [
  {
    // \.    ./
    strokes: 'M 261.12 275.12 L 314.88 370.88 M 709.12 370.88 L 762.88 275.12',
    dots: [
      { cx: 352, cy: 323, r: 16.74 },
      { cx: 672, cy: 323, r: 16.74 },
    ],
    centerY: 323,
  },
  {
    //  \(  )/   — the eyes are drawn on their own
    strokes:
      'M 325.12 401.12 L 378.88 496.88 M 428.8 401.12 Q 387.84 449 428.8 496.88 ' +
      'M 595.2 401.12 Q 636.16 449 595.2 496.88 M 645.12 496.88 L 698.88 401.12',
    dots: [],
    centerY: 449,
  },
  {
    //   )~~(
    strokes:
      'M 403.2 527.12 Q 444.16 575 403.2 622.88 ' +
      'M 449.28 575 C 463.36 555 472.32 555 480 575 C 487.68 595 496.64 595 510.72 575 ' +
      'M 513.28 575 C 527.36 555 536.32 555 544 575 C 551.68 595 560.64 595 574.72 575 ' +
      'M 620.8 527.12 Q 579.84 575 620.8 622.88',
    dots: [],
    centerY: 575,
  },
  {
    //  /_||_\
    strokes:
      'M 325.12 748.88 L 378.88 653.12 M 386 748.88 L 446 748.88 M 480 653.12 L 480 748.88 ' +
      'M 544 653.12 L 544 748.88 M 578 748.88 L 638 748.88 M 645.12 653.12 L 698.88 748.88',
    dots: [],
    centerY: 701,
  },
];

export const SIGIL_EYES = [
  { cx: 480, cy: 441.44, r: 17.28 },
  { cx: 544, cy: 441.44, r: 17.28 },
] as const;
