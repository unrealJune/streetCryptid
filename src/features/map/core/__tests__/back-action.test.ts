import { resolveMapBackAction, type MapBackState } from '../back-action';

const state = (overrides: Partial<MapBackState> = {}): MapBackState => ({
  layersOpen: false,
  selectedEndpoint: null,
  detent: 'peek',
  ...overrides,
});

describe('resolveMapBackAction', () => {
  it('lets the press through when nothing is open', () => {
    expect(resolveMapBackAction(state())).toBeNull();
  });

  it('does not claim the drawer at rest', () => {
    // `peek` is where the drawer lives, and `collapsed` is the user having minimized it. Neither is
    // something they opened, so back must still be able to leave the app.
    expect(resolveMapBackAction(state({ detent: 'peek' }))).toBeNull();
    expect(resolveMapBackAction(state({ detent: 'collapsed' }))).toBeNull();
  });

  it('collapses a raised drawer before exiting', () => {
    expect(resolveMapBackAction(state({ detent: 'mid' }))).toBe('collapse-drawer');
    expect(resolveMapBackAction(state({ detent: 'full' }))).toBe('collapse-drawer');
  });

  it('closes a selected friend before touching the drawer', () => {
    // The reported bug: open a friend from the roster, swipe back, app closes.
    expect(resolveMapBackAction(state({ selectedEndpoint: 'aabb', detent: 'mid' }))).toBe(
      'close-detail'
    );
  });

  it('closes a selection even at the resting detent', () => {
    expect(resolveMapBackAction(state({ selectedEndpoint: 'aabb' }))).toBe('close-detail');
  });

  it('closes the layers popover first of all', () => {
    expect(
      resolveMapBackAction(state({ layersOpen: true, selectedEndpoint: 'aabb', detent: 'full' }))
    ).toBe('close-layers');
  });

  it('unwinds a fully stacked map one press at a time', () => {
    // Each press resolves one layer, and the map is only left on the press after the last of them.
    let current = state({ layersOpen: true, selectedEndpoint: 'aabb', detent: 'full' });
    expect(resolveMapBackAction(current)).toBe('close-layers');
    current = { ...current, layersOpen: false };
    expect(resolveMapBackAction(current)).toBe('close-detail');
    // `closeDetail` clears the selection AND drops the drawer back to `peek`.
    current = { ...current, selectedEndpoint: null, detent: 'peek' };
    expect(resolveMapBackAction(current)).toBeNull();
  });
});
