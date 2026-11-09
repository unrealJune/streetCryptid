import { tryGetIrohLocation, type NativeTelemetryPush } from 'iroh-location';

import { getTelemetry, reportOsDiagnostics, type ShipperPush } from '@/features/dev/telemetry';

/** What one press of the debug screen's "push logs" button did, per half of the app. */
export interface TelemetryPushResult {
  /** The JS journal (`shipper.ts`); `undefined` when no collector is configured. */
  js?: ShipperPush;
  /** The Rust core's offline spool; `undefined` on a binary that predates the push. */
  native?: NativeTelemetryPush;
  /** iOS MetricKit payloads turned into `ios.diagnostic` spans before the journal went out. */
  osDiagnostics: number;
}

interface PushSources {
  native: {
    pushTelemetryNow?(): Promise<NativeTelemetryPush>;
    takeCrashDiagnostics?(): Promise<string[]>;
  } | null;
  pushJournal(): Promise<ShipperPush | undefined>;
}

function defaultSources(): PushSources {
  return {
    native: tryGetIrohLocation(),
    pushJournal: () => getTelemetry().pushNow?.() ?? Promise.resolve(undefined),
  };
}

/**
 * Send everything this phone is holding, now: MetricKit's spool into the journal, then the JS
 * journal and the Rust spool, each ignoring its backoff. Both halves normally drain only when
 * something new is exported, so a phone that went quiet (an iPhone reclaimed in the background, or
 * one that was offline through a pairing) can hold its telemetry for hours. Never rejects.
 */
export async function pushAllTelemetry(
  sources: PushSources = defaultSources()
): Promise<TelemetryPushResult> {
  // First, so the spans it records ride the journal push below.
  const osDiagnostics = await reportOsDiagnostics(sources.native);
  const pushNative =
    typeof sources.native?.pushTelemetryNow === 'function'
      ? sources.native.pushTelemetryNow().catch(() => undefined)
      : Promise.resolve(undefined);
  const [js, native] = await Promise.all([
    sources.pushJournal().catch(() => undefined),
    pushNative,
  ]);
  return { js, native, osDiagnostics };
}

function kib(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`;
}

/** One status line per half, in the order they matter for "where did the iPhone's logs go". */
export function describeTelemetryPush(result: TelemetryPushResult): string[] {
  const lines: string[] = [];
  const { js, native } = result;
  if (js?.disabled) {
    // Rust is switched off with it, so its line would only say "not configured".
    return ['Sending is off (Settings → App & Data)'];
  }
  if (!js) {
    lines.push('JS: no collector configured');
  } else if (!js.reachable) {
    lines.push(`JS: collector unreachable — sent ${js.sent}, ${js.remaining} rows still queued`);
  } else {
    lines.push(`JS: sent ${js.sent} rows, ${js.remaining} left`);
  }
  if (!native) {
    lines.push('Rust: this build cannot push (update the app)');
  } else if (!native.configured) {
    lines.push('Rust: telemetry not configured');
  } else {
    const left = `${native.remainingBatches} batches (${kib(native.remainingBytes)}) left`;
    const dropped = native.dropped > 0 ? `, ${native.dropped} dropped` : '';
    lines.push(
      native.reachable
        ? `Rust: sent ${native.delivered} batches${dropped}, ${left}`
        : `Rust: collector unreachable — sent ${native.delivered}${dropped}, ${left}`
    );
  }
  if (result.osDiagnostics > 0) {
    lines.push(`iOS: ${result.osDiagnostics} OS diagnostics reported`);
  }
  return lines;
}
