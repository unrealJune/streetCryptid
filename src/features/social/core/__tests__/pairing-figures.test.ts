import { isPairingFigureIndex, PAIRING_FIGURE_COUNT, pairingFigure } from '../pairing-figures';

describe('pairing figures', () => {
  it('provides one stable, unique ASCII figure for every pair/2 catalog index', () => {
    const figures = Array.from({ length: PAIRING_FIGURE_COUNT }, (_, index) =>
      pairingFigure(index)
    );

    expect(new Set(figures.map((figure) => figure.art)).size).toBe(PAIRING_FIGURE_COUNT);
    expect(new Set(figures.map((figure) => figure.name)).size).toBe(PAIRING_FIGURE_COUNT);
    expect(figures[0]).toEqual({
      index: 0,
      name: 'round eyes, raised arms',
      art: ['  .-.  ', ' (o o) ', ' \\ | / ', '  / \\  '].join('\n'),
    });
    expect(figures[PAIRING_FIGURE_COUNT - 1].index).toBe(255);
  });

  it('rejects indices outside the native catalog', () => {
    expect(isPairingFigureIndex(0)).toBe(true);
    expect(isPairingFigureIndex(255)).toBe(true);
    expect(isPairingFigureIndex(-1)).toBe(false);
    expect(isPairingFigureIndex(256)).toBe(false);
    expect(isPairingFigureIndex(1.5)).toBe(false);
    expect(() => pairingFigure(256)).toThrow(RangeError);
  });
});
