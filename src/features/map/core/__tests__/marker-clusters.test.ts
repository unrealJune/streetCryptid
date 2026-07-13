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
});
