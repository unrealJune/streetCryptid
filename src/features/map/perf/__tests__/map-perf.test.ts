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
});
