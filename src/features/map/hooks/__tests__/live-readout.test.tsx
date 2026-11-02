import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  createLiveReadoutStore,
  quantizeCoverage,
  useLiveReadout,
  type LiveReadout,
  type LiveReadoutStore,
} from '../live-readout';

const selectCoverage = (readout: LiveReadout) => readout.coverage;
const selectPlace = (readout: LiveReadout) => readout.placeName;

describe('live readout store', () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
  });

  it('notifies only when a field actually changes', () => {
    const store = createLiveReadoutStore();
    const listener = jest.fn();
    store.subscribe(listener);
    store.set({ coverage: 0, placeName: null });
    expect(listener).not.toHaveBeenCalled();
    store.set({ placeName: 'Mercer Island' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get().placeName).toBe('Mercer Island');
  });

  it('quantizes to whole percents, the finest step the island shows', () => {
    expect(quantizeCoverage(0.01234)).toBe(0.01);
    expect(quantizeCoverage(0.4249)).toBe(0.42);
  });

  it('re-renders a subscriber only for the field it selected', () => {
    const store: LiveReadoutStore = createLiveReadoutStore();
    let coverageRenders = 0;
    let placeRenders = 0;
    function Coverage() {
      coverageRenders++;
      useLiveReadout(store, selectCoverage);
      return null;
    }
    function Place() {
      placeRenders++;
      useLiveReadout(store, selectPlace);
      return null;
    }
    act(() => {
      renderer = create(
        <>
          <Coverage />
          <Place />
        </>
      );
    });
    act(() => store.set({ coverage: 0.42 }));
    expect(coverageRenders).toBe(2);
    expect(placeRenders).toBe(1);
  });
});
