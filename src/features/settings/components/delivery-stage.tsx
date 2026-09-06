'use no memo'; // react-compiler: keep it away from Skia JSI objects

import {
  Canvas,
  ClipOp,
  PaintStyle,
  Picture,
  Skia,
  createPicture,
  type SkCanvas,
  type SkFont,
} from '@shopify/react-native-skia';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import {
  REDUCED_MOTION_FRAME,
  buildDeliveryScene,
  formatCountdown,
  type DeliveryScene,
  type PayloadNode,
  type PhoneNode,
  type StageSize,
} from '@/features/social/core/delivery-timeline';
import type { DeliveryMode } from '@/features/social/core/delivery-mode';

/**
 * The delivery diagram: three phones, some sealed squares, and the honest failure in the middle.
 *
 * Deliberately loaded through `React.lazy` by the screen, never imported directly, so
 * `@shopify/react-native-skia` does not evaluate in the settings graph. On web, importing Skia
 * snapshots `global.CanvasKit` at module-eval time; if that happens before the map's
 * `WithSkiaWeb` has loaded CanvasKit, the `Skia` singleton freezes with an undefined CanvasKit
 * and every later `MakeImage` throws. Same reasoning as `cryptid-profile-editor`'s lazy
 * `SignalColorPicker` — this is the second leaf to need it, and for exactly the same reason.
 *
 * ## Why the clock is on the JS thread
 *
 * The scene is rebuilt from scratch every frame by {@link buildDeliveryScene}, which is a plain
 * function — turning it into a worklet would mean making the whole timeline module worklet-safe
 * for a diagram on a settings page nobody keeps open. So `t` advances with `requestAnimationFrame`
 * on the JS thread and the picture is rebuilt in a memo. The map owns the UI thread; this does
 * not compete with it, because the two are never on screen together.
 *
 * Under Reduce Motion the loop never starts: each mode freezes on the frame that states its
 * outcome (see `REDUCED_MOTION_FRAME`), which is a true picture rather than a blank one.
 */

export interface DeliveryStagePalette {
  /** The lattice, the payload fill when opened, and the live edges. */
  readonly accent: string;
  /** Sealed payload edges and the loose dots inside them. */
  readonly ramp: readonly [string, string, string, string];
  /** Phone faces and the slab. */
  readonly surface: string;
  /** Face of a phone whose screen is dead. */
  readonly surfaceOff: string;
  /** Labels under the phones. */
  readonly label: string;
  /** Hairlines. */
  readonly hairline: string;
  /** The countdown once it is nearly out. */
  readonly warning: string;
  /** Cut-out inside an opened payload — reads as a hole, so it matches the ground. */
  readonly ground: string;
}

interface DeliveryStageProps {
  readonly mode: DeliveryMode;
  readonly palette: DeliveryStagePalette;
  /** Seconds for one full loop. The design's default is 10. */
  readonly loopSeconds?: number;
  readonly height?: number;
}

const DEFAULT_HEIGHT = 340;
const MONO = 'IBMPlexMono_500Medium';

let cachedFont: SkFont | null = null;

/**
 * Best effort at the app's mono face, falling back to the platform default.
 *
 * Resolved on first paint rather than at module scope — this file is lazily imported precisely
 * so that Skia does not evaluate early, and reaching into `Skia` at import time would give that
 * back. Skia's system FontMgr does not see faces expo-font registered at runtime on every
 * platform, and a diagram whose four micro-labels render in the system mono is a far smaller
 * problem than one that throws while resolving a typeface.
 */
function stageFont(): SkFont {
  if (cachedFont) return cachedFont;
  try {
    const typeface = Skia.FontMgr.System().matchFamilyStyle(MONO, {});
    if (typeface) {
      cachedFont = Skia.Font(typeface, 11);
      return cachedFont;
    }
  } catch {
    // Fall through to the default face.
  }
  cachedFont = Skia.Font(undefined, 11);
  return cachedFont;
}

/** Deterministic scatter, so a failing payload comes apart the same way every loop. */
function hash(a: number, b: number, s: number): number {
  const x = Math.sin(a * 12.9898 + b * 78.233 + s * 3.17) * 43758.5453;
  return x - Math.floor(x);
}

function rrect(x: number, y: number, w: number, h: number, r: number) {
  return Skia.RRectXY(Skia.XYWHRect(x, y, w, h), r, r);
}

function withAlpha(color: string, alpha: number) {
  const c = Skia.Color(color);
  return Skia.Color(
    `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${alpha})`
  );
}

function drawPhone(canvas: SkCanvas, phone: PhoneNode, palette: DeliveryStagePalette): void {
  const { rect } = phone;
  const dim = phone.off || phone.dim;
  const live = phone.off ? 0 : phone.wake;
  const lit = typeof phone.lit === 'number' ? phone.lit : phone.lit ? 1 : 0;

  const body = rrect(rect.x, rect.y, rect.w, rect.h, 11);

  const face = Skia.Paint();
  face.setColor(
    withAlpha(phone.off ? palette.surfaceOff : palette.surface, phone.off ? 0.92 : 0.62)
  );
  canvas.drawRRect(body, face);

  const edge = Skia.Paint();
  edge.setStyle(PaintStyle.Stroke);
  edge.setStrokeWidth(1);
  edge.setColor(withAlpha(palette.accent, (dim ? 0.12 : 0.34) + lit * 0.5));
  if (dim) edge.setPathEffect(Skia.PathEffect.MakeDash([3, 4], 0));
  canvas.drawRRect(body, edge);

  canvas.save();
  canvas.clipRRect(body, ClipOp.Intersect, true);
  if (phone.off) {
    // One flat line: the screen is dead, and a dead screen is not a dim screen.
    const flat = Skia.Paint();
    flat.setStyle(PaintStyle.Stroke);
    flat.setStrokeWidth(1.5);
    flat.setColor(withAlpha(palette.label, 0.2));
    canvas.drawLine(
      rect.x + rect.w * 0.3,
      rect.y + rect.h / 2,
      rect.x + rect.w * 0.7,
      rect.y + rect.h / 2,
      flat
    );
  } else {
    // The lattice relights column by column, left to right.
    const dot = Skia.Paint();
    const cols = Math.max(1, Math.floor((rect.w - 12) / 8));
    let ci = 0;
    for (let x = rect.x + 8; x < rect.x + rect.w - 4; x += 8, ci++) {
      const on = Math.min(1, Math.max(0, live * cols * 1.6 - ci));
      if (on <= 0) continue;
      dot.setColor(withAlpha(palette.accent, 0.11 * on));
      for (let y = rect.y + 8; y < rect.y + rect.h - 4; y += 8) {
        canvas.drawRect(Skia.XYWHRect(x, y, 1.4, 1.4), dot);
      }
    }
    // A single ring pulse marks the wake itself, and only while it is happening.
    if (live > 0.02 && live < 0.99) {
      const ring = Skia.Paint();
      ring.setStyle(PaintStyle.Stroke);
      ring.setStrokeWidth(1);
      ring.setColor(withAlpha(palette.accent, 1 - live));
      canvas.drawCircle(rect.x + rect.w / 2, rect.y + rect.h / 2, 6 + live * rect.h * 0.55, ring);
    }
  }
  canvas.restore();
}

function drawPayload(canvas: SkCanvas, payload: PayloadNode, palette: DeliveryStagePalette): void {
  const alpha = payload.alpha * (1 - payload.scatter);
  if (alpha <= 0.01) return;

  const opened = payload.resolve > 0.5;
  const size = 16 * payload.scale * (1 - payload.scatter * 0.35);
  const half = size / 2;
  const box = rrect(payload.x - half, payload.y - half, size, size, 3.5 * payload.scale);

  const fill = Skia.Paint();
  fill.setColor(
    opened ? withAlpha(palette.accent, alpha) : withAlpha(palette.surface, alpha * 0.86)
  );
  canvas.drawRRect(box, fill);

  const edge = Skia.Paint();
  edge.setStyle(PaintStyle.Stroke);
  edge.setStrokeWidth(1);
  edge.setColor(withAlpha(opened ? palette.accent : palette.ramp[3], alpha));
  canvas.drawRRect(box, edge);

  const d = 2.6 * payload.scale;
  if (opened) {
    // A cut-out, not a tick: the payload is open, and the hole is the ground showing through.
    const hole = Skia.Paint();
    hole.setColor(withAlpha(palette.ground, alpha));
    canvas.drawRect(Skia.XYWHRect(payload.x - d / 2, payload.y - d / 2, d, d), hole);
    return;
  }

  // Four loose dots, still sealed inside. On failure they let go and drift outward.
  const off = size * 0.21;
  const dot = Skia.Paint();
  for (let i = 0; i < 4; i++) {
    const sx = i % 2 ? 1 : -1;
    const sy = i < 2 ? -1 : 1;
    const j = payload.scatter * 26;
    dot.setColor(
      withAlpha(palette.ramp[2 + (i % 2)], alpha * (0.55 + hash(i, payload.seed, 3) * 0.45))
    );
    canvas.drawRect(
      Skia.XYWHRect(
        payload.x +
          sx * off -
          d / 2 +
          sx * j +
          (hash(i, payload.seed, 5) - 0.5) * payload.scatter * 12,
        payload.y +
          sy * off -
          d / 2 +
          sy * j +
          (hash(i, payload.seed, 7) - 0.5) * payload.scatter * 12,
        d,
        d
      ),
      dot
    );
  }
}

function drawScene(
  canvas: SkCanvas,
  scene: DeliveryScene,
  palette: DeliveryStagePalette,
  size: StageSize,
  font: SkFont | null
): void {
  // Routes first: they are the ground the rest sits on, and never overdraw a payload.
  for (const route of scene.routes) {
    const paint = Skia.Paint();
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(1);
    paint.setPathEffect(Skia.PathEffect.MakeDash([2, 5], 0));
    paint.setColor(withAlpha(palette.accent, 0.1 + route.strength * 0.16));
    canvas.drawLine(route.from.x, route.from.y, route.to.x, route.to.y, paint);
  }

  if (scene.circle) {
    const ring = Skia.Paint();
    ring.setStyle(PaintStyle.Stroke);
    ring.setStrokeWidth(1);
    ring.setPathEffect(Skia.PathEffect.MakeDash([3, 5], 0));
    ring.setColor(withAlpha(palette.accent, scene.circle.alpha));
    canvas.drawOval(
      Skia.XYWHRect(
        scene.circle.center.x - scene.circle.radiusX,
        scene.circle.center.y - scene.circle.radiusY,
        scene.circle.radiusX * 2,
        scene.circle.radiusY * 2
      ),
      ring
    );
  }

  if (scene.slab) {
    const slab = rrect(
      scene.slab.rect.x,
      scene.slab.rect.y,
      scene.slab.rect.w,
      scene.slab.rect.h,
      8
    );
    const face = Skia.Paint();
    face.setColor(withAlpha(palette.surface, 0.72));
    canvas.drawRRect(slab, face);
    const edge = Skia.Paint();
    edge.setStyle(PaintStyle.Stroke);
    edge.setStrokeWidth(1);
    edge.setColor(withAlpha(palette.accent, scene.slab.holding ? 0.44 : 0.24));
    canvas.drawRRect(slab, edge);
  }

  for (const phone of scene.phones) drawPhone(canvas, phone, palette);
  for (const payload of scene.payloads) drawPayload(canvas, payload, palette);

  if (!font) return;

  const text = Skia.Paint();
  const centreText = (value: string, cx: number, y: number, color: Float32Array) => {
    text.setColor(color);
    const width = font.getTextWidth(value);
    canvas.drawText(value, cx - width / 2, y, text, font);
  };

  for (const phone of scene.phones) {
    centreText(
      phone.label,
      phone.rect.x + phone.rect.w / 2,
      phone.rect.y + phone.rect.h + 17,
      withAlpha(palette.label, phone.off || phone.dim ? 0.5 : 0.88)
    );
  }

  if (scene.slab) {
    centreText(
      scene.slab.label,
      scene.slab.rect.x + scene.slab.rect.w / 2,
      scene.slab.rect.y + scene.slab.rect.h + 20,
      withAlpha(palette.accent, 0.9)
    );
  }

  if (scene.countdownMs !== null && scene.slab) {
    const nearlyOut = scene.countdownMs < 5 * 60 * 1000;
    centreText(
      formatCountdown(scene.countdownMs),
      scene.slab.rect.x + scene.slab.rect.w / 2,
      scene.slab.rect.y + scene.slab.rect.h + 42,
      withAlpha(nearlyOut ? palette.warning : palette.label, 0.92)
    );
  }

  // The step word, bottom-left: what is happening right now, in the diagram's own vocabulary.
  centreText(scene.beat.word, size.width / 2, size.height - 4, withAlpha(palette.accent, 0.85));
}

export default function DeliveryStage({
  mode,
  palette,
  loopSeconds = 10,
  height = DEFAULT_HEIGHT,
}: DeliveryStageProps) {
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const [tick, setTick] = useState(0);
  const frame = useRef<number | null>(null);

  // Restart the loop whenever the mode changes: each story begins at its own beginning, and a
  // picker that dropped you into the middle of the next diagram would read as a glitch. The
  // accumulator lives in the closure, so nothing is set synchronously here — the first frame
  // callback is what moves `tick`, and it lands ~16ms later.
  useEffect(() => {
    if (reduceMotion) return;
    let last: number | null = null;
    let current = 0;
    const loop = (now: number) => {
      if (last === null) last = now;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      current = (current + dt / loopSeconds) % 1;
      setTick(current);
      frame.current = requestAnimationFrame(loop);
    };
    frame.current = requestAnimationFrame(loop);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [mode, loopSeconds, reduceMotion]);

  // Derived, never stored: under Reduce Motion there is no loop to hold a value, only the frame
  // each mode rests on.
  const t = reduceMotion ? REDUCED_MOTION_FRAME[mode] : tick;

  const picture = useMemo(() => {
    if (width <= 0) return null;
    const size = { width, height };
    const scene = buildDeliveryScene(mode, t, size);
    return createPicture(
      (canvas) => drawScene(canvas, scene, palette, size, stageFont()),
      Skia.XYWHRect(0, 0, width, height)
    );
  }, [mode, t, width, height, palette]);

  const scene = width > 0 ? buildDeliveryScene(mode, t, { width, height }) : null;

  return (
    <View
      // The diagram is decorative in the strict sense: everything it says is also said in the
      // body copy beside it. Screen readers get the copy, not a play-by-play of an animation.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.stage, { height }]}
      testID={scene ? `delivery-stage-${mode}-${scene.beat.word}` : `delivery-stage-${mode}`}
    >
      {picture ? (
        <Canvas style={StyleSheet.absoluteFill}>
          <Picture picture={picture} />
        </Canvas>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    width: '100%',
  },
});
