import {
  MAP_PERF_FRAME_BUDGET_MS,
  createMapPerfScenarios,
  summarizeFrameDeltas,
} from '../map-perf';

describe('map performance harness', () => {
  it('summarizes over-budget and dropped frames against the 60 fps target', () => {
    const summary = summarizeFrameDeltas([
      MAP_PERF_FRAME_BUDGET_MS,
      MAP_PERF_FRAME_BUDGET_MS * 2,
      MAP_PERF_FRAME_BUDGET_MS * 3.2,
    ]);

    expect(summary.frames).toBe(3);
    expect(summary.overBudgetFrames).toBe(2);
    expect(summary.estimatedDroppedFrames).toBe(3);
    expect(summary.maxFrameMs).toBeCloseTo(MAP_PERF_FRAME_BUDGET_MS * 3.2);
  });

  it('covers the requested cold/warm zoom and pan sequence', () => {
    const anchor = { center: [0.25, 0.5] as const, zoom: 15 };
    const scenarios = createMapPerfScenarios(anchor, { width: 390, height: 780 });

    expect(scenarios.map((scenario) => scenario.name)).toEqual([
      'zoom-out-new',
      'zoom-in',
      'zoom-out-cached',
      'pan-new',
      'pan-cached',
    ]);
    expect(scenarios[0].camera.zoom).toBeCloseTo(13.6);
    expect(scenarios[1].camera).toBe(anchor);
    expect(scenarios[2].camera).toEqual(scenarios[0].camera);
    expect(scenarios[4].camera).toEqual(scenarios[0].camera);

    const startBucket = Math.floor(anchor.center[0] * 2 ** 10);
    const coldPanBucket = Math.floor(scenarios[3].camera.center[0] * 2 ** 10);
    expect(Math.abs(coldPanBucket - startBucket)).toBe(1);
    expect(scenarios[3].durationMs).toBeGreaterThanOrEqual(800);
    expect(scenarios[3].durationMs).toBeLessThanOrEqual(3000);
  });

  it('optionally exercises the finest data zoom and close-zoom pans', () => {
    const anchor = { center: [0.25, 0.5] as const, zoom: 15 };
    const scenarios = createMapPerfScenarios(anchor, { width: 390, height: 780 }, true);

    expect(scenarios.slice(5).map(({ name }) => name)).toEqual([
      'zoom-16',
      'zoom-17',
      'zoom-18',
      'pan-18-new',
      'pan-18-cached',
      'zoom-16-cached',
    ]);
    expect(scenarios.slice(5).map(({ camera }) => camera.zoom)).toEqual([16, 17, 18, 18, 18, 16]);
    expect(scenarios[8].camera.center[0]).toBeGreaterThan(anchor.center[0]);
    expect(scenarios[9].camera.center).toEqual(anchor.center);
    expect(scenarios[10].camera).toEqual(scenarios[5].camera);
  });
});
