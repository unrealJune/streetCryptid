import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';

import { getTelemetry } from '@/features/dev/telemetry';
import { useTheme } from '@/hooks/use-theme';

import {
  pendingPermissionSteps,
  permissionJourney,
  permissionOutcome,
  projectedPermissionSteps,
  seedLegacyInstall,
  type PermissionContext,
  type PermissionOutcome,
  type PermissionStepId,
} from '../core/permission-steps';
import type { PersistentKV } from '../net/background/persistent-kv';
import { readPermissionFacts, requestPermissionStep } from '../net/permission-requests';
import {
  createPersistentKV,
  loadBackgroundReliabilityAsked,
  loadLocationDisclosureChoice,
  loadPermissionsAsked,
  saveBackgroundReliabilityAsked,
  saveLocationDisclosureChoice,
  savePermissionAsked,
} from '../net/persistence';
import { PermissionJourneyScreen } from '../screens/permissions-journey-screen';

type Run =
  | { phase: 'loading' }
  | { phase: 'done' }
  | {
      phase: 'asking';
      ctx: PermissionContext;
      /** The rows the run opened with, so one never vanishes when an answer drops it. */
      planned: readonly PermissionStepId[];
      /** This run's answers, for the collapsed rows. */
      outcomes: Partial<Record<PermissionStepId, PermissionOutcome>>;
      busy: boolean;
    };

/**
 * Every OS permission the app needs, asked in one place before anything else can ask: one page,
 * one row per permission, opened in turn (`core/permission-steps.ts` decides which).
 *
 * It sits in front of `LocationSharingProvider` on purpose: node init used to request Bluetooth
 * and nearby devices the moment a profile existed, on top of whatever screen was up, and iOS raised
 * its Bluetooth and local-network alerts when the node first touched the radio or the LAN. With the
 * steps answered first, init's checks find the decisions already made and the BLE transport
 * attaches with its grant in place. Replaces `LocationDisclosureGate` (the location step is that
 * disclosure) and `BackgroundReliabilityGate` (the battery step).
 *
 * A failure to read anything opens the app: nothing here may stand between someone and the map.
 */
export function PermissionsGate({ children }: PropsWithChildren) {
  const [done, setDone] = useState(false);
  if (done) return children;
  return <PermissionSteps onDone={() => setDone(true)} />;
}

/**
 * The steps themselves. `replay` (Settings → Debug) runs every step that exists on this phone
 * again, as on a fresh install: nothing already asked or granted is skipped, and the answers are
 * saved like the first time. `saveLocationChoice` lets a replay route the location answer through
 * the mounted provider, which holds the disclosure in state.
 */
export function PermissionSteps({
  replay = false,
  onDone,
  saveLocationChoice,
}: {
  replay?: boolean;
  onDone: () => void;
  saveLocationChoice?: (accepted: boolean) => Promise<void>;
}) {
  const theme = useTheme();
  const [kv] = useState(createPersistentKV);
  const [run, setRun] = useState<Run>({ phase: 'loading' });
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const ctx = replay ? await replayContext() : await loadContext(kv);
      if (!active) return;
      setRun(
        pendingPermissionSteps(ctx).length === 0
          ? { phase: 'done' }
          : {
              phase: 'asking',
              ctx,
              planned: projectedPermissionSteps(ctx),
              outcomes: {},
              busy: false,
            }
      );
    })().catch(() => {
      if (active) setRun({ phase: 'done' });
    });
    return () => {
      active = false;
    };
  }, [kv, replay]);

  // `onDone` must be idempotent: a caller re-rendering with a new one after the end calls it again.
  const over = run.phase === 'done';
  useEffect(() => {
    if (over) onDone();
  }, [over, onDone]);

  // Also what shows for the one frame between the last answer and `onDone` taking over.
  const blank = <View style={[styles.loading, { backgroundColor: theme.background }]} />;
  if (run.phase !== 'asking') return blank;

  const { ctx } = run;
  const step = pendingPermissionSteps(ctx)[0];
  if (!step) return blank;

  async function answer(current: PermissionStepId, allow: boolean) {
    if (inFlight.current || run.phase !== 'asking') return;
    inFlight.current = true;
    setRun({ ...run, busy: true });
    const granted = allow ? await requestPermissionStep(current) : undefined;
    const disclosure =
      current === 'location' ? (allow ? 'accepted' : 'declined') : run.ctx.disclosure;
    // Recorded before moving on, and never awaited past a failure: a store that cannot write
    // costs a step asked twice on the next launch, never a stuck screen.
    await Promise.all([
      current === 'location' && disclosure !== null
        ? saveLocationChoice
          ? saveLocationChoice(allow)
          : saveLocationDisclosureChoice(kv, disclosure)
        : null,
      savePermissionAsked(kv, current),
      current === 'battery' ? saveBackgroundReliabilityAsked(kv) : null,
    ]).catch(() => undefined);
    record(current, allow, granted, run.ctx.platform, replay);
    inFlight.current = false;

    const next: PermissionContext = {
      ...run.ctx,
      disclosure,
      asked: new Set([...run.ctx.asked, current]),
      recorded: true,
      granted: { ...run.ctx.granted, [current]: granted ?? run.ctx.granted[current] },
    };
    setRun(
      pendingPermissionSteps(next).length === 0
        ? { phase: 'done' }
        : {
            ...run,
            ctx: next,
            outcomes: { ...run.outcomes, [current]: permissionOutcome(allow, granted) },
            busy: false,
          }
    );
  }

  return (
    <PermissionJourneyScreen
      rows={permissionJourney(run.planned, ctx, run.outcomes)}
      platform={ctx.platform}
      busy={run.busy}
      onChoice={(allow) => void answer(step, allow)}
    />
  );
}

/**
 * One span per answer, so "did they say no, or did the prompt never appear" is answerable.
 * `granted` is absent when the OS could not say (iOS local network, a dialog left open).
 */
function record(
  step: PermissionStepId,
  allow: boolean,
  granted: boolean | undefined,
  platform: string,
  replay: boolean
) {
  getTelemetry()
    .startSpan('onboarding.permission', {
      attributes: {
        'permission.step': step,
        choice: allow ? 'continue' : 'skip',
        ...(granted === undefined ? {} : { 'permission.granted': granted }),
        platform,
        ...(replay ? { 'permission.replay': true } : {}),
      },
    })
    .end();
}

/** What this install has answered, as the gate reads it on launch. */
async function loadContext(kv: PersistentKV): Promise<PermissionContext> {
  const [disclosure, asked, batteryAsked, facts] = await Promise.all([
    loadLocationDisclosureChoice(kv),
    loadPermissionsAsked(kv),
    loadBackgroundReliabilityAsked(kv),
    readPermissionFacts(),
  ]);
  const loaded: PermissionContext = {
    ...facts,
    disclosure,
    asked: new Set([...(asked ?? []), ...(batteryAsked ? (['battery'] as const) : [])]),
    recorded: asked !== null,
  };
  const seeded = seedLegacyInstall(loaded);
  if (seeded) await savePermissionAsked(kv, ...seeded.asked).catch(() => undefined);
  return seeded ?? loaded;
}

/**
 * A fresh install on this phone: nothing answered, nothing granted. `granted` is cleared rather
 * than read so a step the OS already allows is still shown (its request returns at once).
 */
async function replayContext(): Promise<PermissionContext> {
  const facts = await readPermissionFacts();
  return { ...facts, granted: {}, disclosure: null, asked: new Set(), recorded: true };
}

const styles = StyleSheet.create({
  loading: { flex: 1 },
});
