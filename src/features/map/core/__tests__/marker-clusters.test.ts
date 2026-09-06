import { clusterMarkers } from '../marker-clusters';

describe('clusterMarkers', () => {
  it('keeps separated markers independent', () => {
    const markers = [
      { id: 'one', anchor: [10, 10] as [number, number] },
      { id: 'two', anchor: [100, 100] as [number, number] },
    ];

    expect(clusterMarkers(markers)).toEqual([[markers[0]], [markers[1]]]);
  });

  it('groups overlapping markers in their original order', () => {
    const markers = [
      { id: 'one', anchor: [10, 10] as [number, number] },
      { id: 'two', anchor: [20, 20] as [number, number] },
      { id: 'three', anchor: [100, 100] as [number, number] },
    ];

    expect(clusterMarkers(markers)).toEqual([[markers[0], markers[1]], [markers[2]]]);
  });

  it('includes transitively overlapping markers in the same stack', () => {
    const markers = [
      { id: 'one', anchor: [0, 0] as [number, number] },
      { id: 'two', anchor: [40, 0] as [number, number] },
      { id: 'three', anchor: [80, 0] as [number, number] },
    ];

    expect(clusterMarkers(markers)).toEqual([markers]);
  });

  it('honours a caller-supplied overlap distance', () => {
    const markers = [
      { id: 'one', anchor: [0, 0] as [number, number] },
      { id: 'two', anchor: [60, 0] as [number, number] },
    ];

    // Apart at the default budget…
    expect(clusterMarkers(markers)).toHaveLength(2);
    // …and together once the caller widens it. This is what makes clustering
    // survive a zoom-out: the view converts its screen-space budget into
    // anchor-space by dividing by the committed scale.
    expect(clusterMarkers(markers, 44 / 0.25)).toEqual([markers]);
  });

  it('splits a group again as the budget shrinks', () => {
    const markers = [
      { id: 'one', anchor: [0, 0] as [number, number] },
      { id: 'two', anchor: [30, 0] as [number, number] },
    ];

    expect(clusterMarkers(markers, 44 / 1)).toEqual([markers]);
    // Zoomed IN (committed scale 4), the same two are comfortably apart.
    expect(clusterMarkers(markers, 44 / 4)).toHaveLength(2);
  });
});
