import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';

import { getTelemetry } from '@/features/dev/telemetry';
import { useTheme } from '@/hooks/use-theme';

import {
  pendingPermissionSteps,
  projectedPermissionSteps,
  seedLegacyInstall,
  showsPermissionIntro,
  type PermissionContext,
  type PermissionStepId,
} from '../core/permission-steps';
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
import { PermissionIntroScreen, PermissionStepScreen } from '../screens/permission-step-screen';

type Run =
  | { phase: 'loading' }
  | { phase: 'done' }
  | {
      phase: 'asking';
      ctx: PermissionContext;
      /** The overview is showing. */
      intro: boolean;
      /** Steps answered this run, for the step count. */
      answered: number;
      busy: boolean;
    };

/**
 * Every OS permission the app needs, asked in one place, one step per permission
 * (`core/permission-steps.ts` decides which), before anything else can ask.
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
  const theme = useTheme();
  const [kv] = useState(createPersistentKV);
  const [run, setRun] = useState<Run>({ phase: 'loading' });
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    void (async () => {
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
      const ctx = seeded ?? loaded;
      const pending = pendingPermissionSteps(ctx);
      if (!active) return;
      setRun(
        pending.length === 0
          ? { phase: 'done' }
          : { phase: 'asking', ctx, intro: showsPermissionIntro(pending), answered: 0, busy: false }
      );
    })().catch(() => {
      if (active) setRun({ phase: 'done' });
    });
    return () => {
      active = false;
    };
  }, [kv]);

  if (run.phase === 'loading') {
    return <View style={[styles.loading, { backgroundColor: theme.background }]} />;
  }
  if (run.phase === 'done') return children;

  const { ctx } = run;
  const pending = pendingPermissionSteps(ctx);
  const step = pending[0];
  if (!step) return children;

  if (run.intro) {
    return (
      <PermissionIntroScreen
        steps={projectedPermissionSteps(ctx)}
        onContinue={() => setRun({ ...run, intro: false })}
      />
    );
  }

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
        ? saveLocationDisclosureChoice(kv, disclosure)
        : null,
      savePermissionAsked(kv, current),
      current === 'battery' ? saveBackgroundReliabilityAsked(kv) : null,
    ]).catch(() => undefined);
    record(current, allow, granted, run.ctx.platform);
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
        : { phase: 'asking', ctx: next, intro: false, answered: run.answered + 1, busy: false }
    );
  }

  const total = run.answered + projectedPermissionSteps(ctx).length;
  return (
    <PermissionStepScreen
      key={step}
      step={step}
      platform={ctx.platform}
      position={total > 1 ? [run.answered + 1, total] : null}
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
  platform: string
) {
  getTelemetry()
    .startSpan('onboarding.permission', {
      attributes: {
        'permission.step': step,
        choice: allow ? 'continue' : 'skip',
        ...(granted === undefined ? {} : { 'permission.granted': granted }),
        platform,
      },
    })
    .end();
}

const styles = StyleSheet.create({
  loading: { flex: 1 },
});
