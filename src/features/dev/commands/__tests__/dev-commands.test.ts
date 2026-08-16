import type { TrailReplicaAuthor } from 'iroh-location';

import { getEventLog, resetEventLogForTesting } from '@/features/dev/telemetry/event-log';

import { DEV_COMMAND_NAMES, runDevCommand } from '../dev-commands';

/**
 * The e2e command channel's contract, which `scripts/e2e/lib/device.sh` depends on byte for byte:
 * `device_dev_command` polls `event_log` for a `dev.command` row carrying ITS nonce and reads the
 * result out of `details`. A silent failure here presents to the harness as a hang, so the two
 * things that must always hold are "a row is always written" and "the row carries the id".
 */

type Context = Parameters<typeof runDevCommand>[2];

function context(overrides: Partial<Context> = {}): Context {
  return {
    syncTrail: async () => {},
    trailReplicaStatus: async (): Promise<TrailReplicaAuthor[]> => [],
    ...overrides,
  };
}

function commandRows() {
  return getEventLog().filter((entry) => entry.action === 'dev.command');
}

describe('dev command channel', () => {
  beforeEach(() => resetEventLogForTesting());

  it('runs sync-trail through the ordinary service method', async () => {
    const since: number[] = [];
    await runDevCommand(
      'sync-trail',
      'n1',
      context({
        syncTrail: async (sinceTs = -1) => {
          since.push(sinceTs);
        },
      })
    );

    expect(since).toEqual([0]);
    const [row] = commandRows();
    expect(row.status).toBe('ok');
    expect(row.details).toMatchObject({ id: 'n1', cmd: 'sync-trail' });
  });

  it('reports the replica, per author, with no location data in it', async () => {
    await runDevCommand(
      'replica-status',
      'n2',
      context({
        trailReplicaStatus: async () => [
          { author: 'aa11', seq: 7, fixTs: 1234, hasContent: true },
          { author: 'bb22', seq: 0, fixTs: 0, hasContent: false },
        ],
      })
    );

    const [row] = commandRows();
    expect(row.status).toBe('ok');
    expect(row.details).toMatchObject({
      id: 'n2',
      authors: [
        { author: 'aa11', seq: 7, fixTs: 1234, hasContent: true },
        { author: 'bb22', seq: 0, fixTs: 0, hasContent: false },
      ],
    });
  });

  // An unknown name has to be visible: the harness is waiting on a row, so a silent no-op would
  // present as a hang and send whoever is debugging it looking at the network instead.
  it('records an unknown command as a typed error rather than doing nothing', async () => {
    await runDevCommand('not-a-command', 'n3', context());

    const [row] = commandRows();
    expect(row.status).toBe('error');
    expect(String(row.details.error)).toContain('unknown dev command: not-a-command');
    expect(String(row.details.error)).toContain(DEV_COMMAND_NAMES.join(', '));
  });

  // Same reason: a throwing handler must land as a row, not as a rejected promise nobody reads.
  it('records a failing handler instead of rejecting', async () => {
    await expect(
      runDevCommand(
        'sync-trail',
        'n4',
        context({
          syncTrail: async () => {
            throw new Error('node not started');
          },
        })
      )
    ).resolves.toBeUndefined();

    const [row] = commandRows();
    expect(row.status).toBe('error');
    expect(row.details).toMatchObject({ id: 'n4', cmd: 'sync-trail' });
    expect(String(row.details.error)).toContain('node not started');
  });
});
