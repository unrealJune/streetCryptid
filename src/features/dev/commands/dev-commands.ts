import type { TrailReplicaAuthor } from 'iroh-location';

import { flushEventLog, recordEventLog } from '@/features/dev/telemetry';

/**
 * The developer command channel: `streetcryptid://dev?cmd=<name>&id=<nonce>`.
 *
 * It exists because the e2e harness needs to DRIVE a running app. Maestro's `launchApp`
 * force-terminates and relaunches on iOS (`.maestro/README.md`), which tears the iroh node down
 * and makes every subsequent assertion race a cold dial — the timing lottery
 * `scripts/e2e/PEER-RELAY-STATUS.md` documents. Opening a URL foregrounds a running app instead,
 * and the acknowledgement written here is a strictly better readiness signal than a rendered
 * view: it proves the sharing service answered, not merely that something painted.
 *
 * Every command calls an ORDINARY service method — there is no test-only path behind any of them.
 * `sync-trail` is exactly what a resume already runs; `replica-status` is local metadata with no
 * location data in it. That is also why this ships in Release ungated, on the same footing as the
 * Settings DEBUG section, whose `PUSH NOW` button is not `__DEV__`-gated either: the surface is a
 * convenience, not a new capability.
 */
export interface DevCommandContext {
  /** Reconcile the durable replica against the stash and the pool — the resume path. */
  syncTrail(sinceTs?: number): Promise<void>;
  /** What this device's replica can SERVE, per author. Presence, never payload. */
  trailReplicaStatus(): Promise<TrailReplicaAuthor[]>;
}

/** Whatever the command wants the harness to read back. Sanitised by `recordEventLog`. */
export type DevCommandDetails = Record<string, unknown>;

type DevCommandHandler = (context: DevCommandContext) => Promise<DevCommandDetails>;

/**
 * A typed map rather than a stringly-typed switch: adding a command is one entry, and an unknown
 * name is a typed error the harness can see rather than a silent no-op it would wait out.
 */
export const DEV_COMMANDS = {
  'sync-trail': async (context) => {
    await context.syncTrail(0);
    return {};
  },
  'replica-status': async (context) => {
    const authors = await context.trailReplicaStatus();
    return {
      authors: authors.map((slot) => ({
        author: slot.author,
        seq: slot.seq,
        fixTs: slot.fixTs,
        hasContent: slot.hasContent,
      })),
    };
  },
} as const satisfies Record<string, DevCommandHandler>;

export type DevCommandName = keyof typeof DEV_COMMANDS;

export const DEV_COMMAND_NAMES = Object.keys(DEV_COMMANDS) as DevCommandName[];

export function isDevCommandName(name: string): name is DevCommandName {
  return Object.prototype.hasOwnProperty.call(DEV_COMMANDS, name);
}

/**
 * Run `name` and write the result to the event log — the channel the harness already reads
 * (`device_dump_event_log`).
 *
 * `id` is echoed into the details so a poller waits for ITS invocation rather than matching a
 * stale row from an earlier pass, which is also what lets the same command be issued twice.
 *
 * A failure is reported, never thrown: the harness's diagnosis comes from the row, and a rejected
 * promise here would leave it waiting for a row that never arrives. The flush is not optional
 * either — the log persists asynchronously, so returning without it leaves the row unwritten
 * exactly when the harness starts looking for it.
 */
export async function runDevCommand(
  name: string,
  id: string,
  context: DevCommandContext
): Promise<void> {
  const started = Date.now();
  try {
    if (!isDevCommandName(name)) {
      throw new Error(`unknown dev command: ${name} (known: ${DEV_COMMAND_NAMES.join(', ')})`);
    }
    const details = await DEV_COMMANDS[name](context);
    recordEventLog({
      category: 'dev',
      action: 'dev.command',
      status: 'ok',
      summary: `dev command ${name} ok`,
      details: { id, cmd: name, durationMs: Date.now() - started, ...details },
    });
  } catch (error) {
    recordEventLog({
      category: 'dev',
      action: 'dev.command',
      status: 'error',
      summary: `dev command ${name} failed`,
      details: {
        id,
        cmd: name,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
  await flushEventLog();
}
