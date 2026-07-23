'use no memo'; // react-compiler: this hook intentionally owns mutable JSI frame counters

import { useCallback, useEffect, useRef } from 'react';
import { useFrameCallback, useSharedValue } from 'react-native-reanimated';

import { viewTransformFor, type ViewTransform } from '../core/camera';
import { coversView } from '../core/region';
import type { CameraState, Viewport } from '../core/types';
import type { MapRegion } from '../engine/map-engine';
import {
  MAP_PERF_FRAME_BUDGET_MS,
  beginMapPerfScenario,
  createMapPerfScenarios,
  emitMapPerfEvent,
  isMapPerfRunEnabled,
  perfNow,
  snapshotMapPerfPipeline,
  summarizeFrameDeltas,
  type FrameSummary,
  type MapPerfScenario,
  type RegionRenderTiming,
} from './map-perf';

const BETWEEN_SCENARIOS_MS = 250;
const SCENARIO_TIMEOUT_MS = 30_000;

export interface RenderedMapRegion {
  readonly region: MapRegion;
  readonly timing: RegionRenderTiming;
}

interface ActiveScenario {
  readonly index: number;
  readonly definition: MapPerfScenario;
  readonly transform: ViewTransform;
  readonly startRegion: MapRegion;
  readonly startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  animationEndedAt: number | null;
}

interface JsFrameSampler {
  raf: number;
  last: number | null;
  deltas: number[];
}

export function useMapPerfRunner({
  viewport,
  anchor,
  current,
  animate,
  commit,
}: {
  viewport: Viewport | null;
  anchor: CameraState;
  current: RenderedMapRegion | null;
  animate(
    transform: ViewTransform,
    index: number,
    durationMs: number,
    onFinished: (finishedIndex: number) => void
  ): void;
  commit(transform: ViewTransform): void;
}): void {
  const enabled = isMapPerfRunEnabled();
  const mountedAt = useRef(perfNow());
  const currentRef = useRef(current);
  const activeRef = useRef<ActiveScenario | null>(null);
  const launchFinishedRef = useRef(false);
  const nextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jsSamplerRef = useRef<JsFrameSampler | null>(null);
  const startScenarioRef = useRef<(index: number) => void>(() => undefined);

  const uiFrames = useSharedValue(0);
  const uiTotalMs = useSharedValue(0);
  const uiMaxMs = useSharedValue(0);
  const uiOverBudget = useSharedValue(0);
  const uiDropped = useSharedValue(0);
  const uiFrameCallback = useFrameCallback(({ timeSincePreviousFrame }) => {
    if (timeSincePreviousFrame === null) return;
    uiFrames.value += 1;
    uiTotalMs.value += timeSincePreviousFrame;
    uiMaxMs.value = Math.max(uiMaxMs.value, timeSincePreviousFrame);
    if (timeSincePreviousFrame > MAP_PERF_FRAME_BUDGET_MS * 1.25) uiOverBudget.value += 1;
    uiDropped.value += Math.max(
      0,
      Math.round(timeSincePreviousFrame / MAP_PERF_FRAME_BUDGET_MS) - 1
    );
  }, false);

  const beginSampling = useCallback(() => {
    uiFrames.set(0);
    uiTotalMs.set(0);
    uiMaxMs.set(0);
    uiOverBudget.set(0);
    uiDropped.set(0);
    uiFrameCallback.setActive(true);

    const sampler: JsFrameSampler = { raf: 0, last: null, deltas: [] };
    const tick = (timestamp: number) => {
      if (sampler.last !== null) sampler.deltas.push(timestamp - sampler.last);
      sampler.last = timestamp;
      sampler.raf = requestAnimationFrame(tick);
    };
    sampler.raf = requestAnimationFrame(tick);
    jsSamplerRef.current = sampler;
  }, [uiDropped, uiFrameCallback, uiFrames, uiMaxMs, uiOverBudget, uiTotalMs]);

  const stopSampling = useCallback((): { js: FrameSummary; ui: FrameSummary } => {
    const sampler = jsSamplerRef.current;
    if (sampler) cancelAnimationFrame(sampler.raf);
    jsSamplerRef.current = null;
    uiFrameCallback.setActive(false);
    const uiFrameCount = uiFrames.get();
    return {
      js: summarizeFrameDeltas(sampler?.deltas ?? []),
      ui: {
        frames: uiFrameCount,
        averageFrameMs: uiFrameCount > 0 ? uiTotalMs.get() / uiFrameCount : 0,
        maxFrameMs: uiMaxMs.get(),
        overBudgetFrames: uiOverBudget.get(),
        estimatedDroppedFrames: uiDropped.get(),
      },
    };
  }, [uiDropped, uiFrameCallback, uiFrames, uiMaxMs, uiOverBudget, uiTotalMs]);

  const finishScenario = useCallback(
    (status: 'complete' | 'timeout') => {
      const active = activeRef.current;
      const rendered = currentRef.current;
      if (!active) return;
      activeRef.current = null;
      clearTimeout(active.timeout);
      const finishedAt = perfNow();
      const frames = stopSampling();
      emitMapPerfEvent('scenario-result', {
        status,
        totalMs: finishedAt - active.startedAt,
        interactionMs:
          active.animationEndedAt === null ? null : active.animationEndedAt - active.startedAt,
        settleMs: active.animationEndedAt === null ? null : finishedAt - active.animationEndedAt,
        jsFrames: frames.js,
        uiFrames: frames.ui,
        pipeline: snapshotMapPerfPipeline(),
        engine: rendered?.region.timing ?? null,
        render: rendered?.timing ?? null,
        target: rendered
          ? {
              regionChanged: rendered.region !== active.startRegion,
              zoomError: Math.abs(rendered.region.spec.zoom - active.definition.camera.zoom),
              covered: viewport
                ? coversView(rendered.region.spec, active.definition.camera, viewport)
                : false,
            }
          : null,
      });
      if (viewport && active.index + 1 < createMapPerfScenarios(anchor, viewport).length) {
        nextTimerRef.current = setTimeout(
          () => startScenarioRef.current(active.index + 1),
          BETWEEN_SCENARIOS_MS
        );
      } else {
        emitMapPerfEvent('run-complete', {});
      }
    },
    [anchor, stopSampling, viewport]
  );

  const maybeFinish = useCallback(() => {
    const active = activeRef.current;
    const rendered = currentRef.current;
    if (!active || active.animationEndedAt === null || !rendered || !viewport) return;
    if (rendered.region === active.startRegion) return;
    if (Math.abs(rendered.region.spec.zoom - active.definition.camera.zoom) > 0.08) return;
    if (!coversView(rendered.region.spec, active.definition.camera, viewport)) return;
    finishScenario('complete');
  }, [finishScenario, viewport]);

  const onAnimationEnd = useCallback(
    (index: number) => {
      const active = activeRef.current;
      if (!active || active.index !== index) return;
      active.animationEndedAt = perfNow();
      commit(active.transform);
      requestAnimationFrame(() => requestAnimationFrame(maybeFinish));
    },
    [commit, maybeFinish]
  );

  const startScenario = useCallback(
    (index: number) => {
      const rendered = currentRef.current;
      if (!enabled || !viewport || !rendered) return;
      const definition = createMapPerfScenarios(anchor, viewport)[index];
      if (!definition) return;
      beginMapPerfScenario(definition.name);
      beginSampling();
      const transform = viewTransformFor(anchor, viewport, definition.camera);
      const active: ActiveScenario = {
        index,
        definition,
        transform,
        startRegion: rendered.region,
        startedAt: perfNow(),
        animationEndedAt: null,
        timeout: setTimeout(() => finishScenario('timeout'), SCENARIO_TIMEOUT_MS),
      };
      activeRef.current = active;
      animate(transform, index, definition.durationMs, onAnimationEnd);
    },
    [anchor, animate, beginSampling, enabled, finishScenario, onAnimationEnd, viewport]
  );

  useEffect(() => {
    startScenarioRef.current = startScenario;
  }, [startScenario]);

  useEffect(() => {
    currentRef.current = current;
    if (!enabled || !current) return;
    const firstPaint = !launchFinishedRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (firstPaint && !launchFinishedRef.current) {
          launchFinishedRef.current = true;
          const frames = stopSampling();
          emitMapPerfEvent('scenario-result', {
            status: 'complete',
            totalMs: perfNow() - mountedAt.current,
            interactionMs: 0,
            settleMs: perfNow() - mountedAt.current,
            jsFrames: frames.js,
            uiFrames: frames.ui,
            pipeline: snapshotMapPerfPipeline(),
            engine: current.region.timing,
            render: current.timing,
          });
          nextTimerRef.current = setTimeout(
            () => startScenarioRef.current(0),
            BETWEEN_SCENARIOS_MS
          );
          return;
        }
        maybeFinish();
      });
    });
  }, [current, enabled, maybeFinish, stopSampling]);

  useEffect(() => {
    if (!enabled) return;
    beginMapPerfScenario('launch');
    beginSampling();
    emitMapPerfEvent('runner-ready', {});
    return () => {
      if (nextTimerRef.current) clearTimeout(nextTimerRef.current);
      if (activeRef.current) clearTimeout(activeRef.current.timeout);
      const sampler = jsSamplerRef.current;
      if (sampler) cancelAnimationFrame(sampler.raf);
      uiFrameCallback.setActive(false);
    };
    // The runner starts once per mounted map; HMR/remount intentionally starts a fresh run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
