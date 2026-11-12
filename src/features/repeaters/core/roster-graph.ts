import type { RosterSections, RosterView } from './repeaters';

/**
 * The roster map's layout (Settings → Repeaters → Your roster): you at the centre, your own
 * machines below the divide, everyone else's above it. Rosters that carry you are tied to you;
 * rosters friends offer float unconnected, because nothing links you to them until you enroll.
 *
 * Pure and deterministic (a seeded force pass), so the same rosters always land in the same
 * places and a re-read does not reshuffle the screen under a finger.
 */

export type GraphSide = 'mine' | 'joined' | 'available';

export interface GraphNode {
  /** The machine's endpoint id. */
  readonly id: string;
  readonly short: string;
  readonly rosterId: string;
  readonly side: GraphSide;
  /** Position as a fraction of the graph's width and height. */
  readonly fx: number;
  readonly fy: number;
}

export interface GraphLink {
  /** Endpoint ids, or `you`. */
  readonly a: string;
  readonly b: string;
  /** `mine`/`carry` tie a machine to you; `sibling` ties machines of one roster; `avail` floats. */
  readonly kind: 'mine' | 'carry' | 'sibling' | 'avail';
}

export interface RosterGraph {
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];
  /** One label per other person's roster, above its machines. */
  readonly clusters: readonly { rosterId: string; label: string; side: GraphSide; fx: number; fy: number }[];
}

export const YOU = 'you';

/** Past this many machines a side stops being readable; the list page still shows them all. */
export const MAX_GRAPH_MACHINES = 24;

interface Body {
  id: string;
  short: string;
  rosterId: string;
  side: GraphSide | 'you';
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export function rosterGraphRosters(sections: RosterSections): { roster: RosterView; side: GraphSide }[] {
  const out: { roster: RosterView; side: GraphSide }[] = [];
  for (const r of sections.carryingMe) out.push({ roster: r, side: 'joined' });
  for (const r of sections.throughFriends) out.push({ roster: r, side: 'available' });
  if (sections.mine) out.push({ roster: sections.mine, side: 'mine' });
  return out;
}

export function layoutRosterGraph(sections: RosterSections): RosterGraph {
  const W = 354;
  const H = 480;
  const MID = H / 2;
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  let budget = MAX_GRAPH_MACHINES;
  const rosters = rosterGraphRosters(sections)
    .map(({ roster, side }) => {
      const machines = roster.machines.slice(0, Math.max(0, budget));
      budget -= machines.length;
      return { roster, side, machines };
    })
    .filter((r) => r.machines.length > 0);

  const bodies: Body[] = [
    { id: YOU, short: '', rosterId: '', side: 'you', x: W / 2, y: MID, dx: 0, dy: 0 },
  ];
  const links: (GraphLink & { length: number })[] = [];
  const tops = rosters.filter((r) => r.side !== 'mine');
  for (const r of rosters) {
    const ti = tops.indexOf(r);
    const cx = r.side === 'mine' ? W / 2 : 50 + (ti + 0.5) * ((W - 100) / Math.max(1, tops.length));
    const cy = r.side === 'mine' ? MID + 110 : r.side === 'available' ? 60 : MID - 110;
    const kind = r.side === 'available' ? 'avail' : 'sibling';
    r.machines.forEach((m, i) => {
      bodies.push({
        id: m.id,
        short: m.short,
        rosterId: r.roster.rosterId,
        side: r.side,
        x: cx + (rnd() - 0.5) * 60,
        y: cy + (rnd() - 0.5) * 40,
        dx: 0,
        dy: 0,
      });
      if (i > 0) links.push({ a: r.machines[i - 1].id, b: m.id, kind, length: 50 });
      if (r.side === 'mine') links.push({ a: YOU, b: m.id, kind: 'mine', length: 110 });
      else if (r.side === 'joined' && i === 0) links.push({ a: YOU, b: m.id, kind: 'carry', length: 120 });
    });
    if (r.machines.length > 2) {
      links.push({ a: r.machines[r.machines.length - 1].id, b: r.machines[0].id, kind, length: 50 });
    }
  }

  const byId = new Map(bodies.map((b) => [b.id, b]));
  const ITERATIONS = 400;
  for (let it = 0; it < ITERATIONS; it++) {
    const cool = 1 - it / ITERATIONS;
    for (const n of bodies) {
      n.dx = 0;
      n.dy = 0;
    }
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const p = bodies[i];
        const q = bodies[j];
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        const d2 = Math.max(dx * dx + dy * dy, 25);
        const d = Math.sqrt(d2);
        const f = 3200 / d2;
        dx /= d;
        dy /= d;
        p.dx += dx * f;
        p.dy += dy * f;
        q.dx -= dx * f;
        q.dy -= dy * f;
      }
    }
    for (const l of links) {
      const p = byId.get(l.a)!;
      const q = byId.get(l.b)!;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - l.length) * 0.06;
      p.dx += (dx / d) * f;
      p.dy += (dy / d) * f;
      q.dx -= (dx / d) * f;
      q.dy -= (dy / d) * f;
    }
    for (const n of bodies) {
      if (n.side === 'you') continue;
      const gy = n.side === 'mine' ? MID + 120 : n.side === 'available' ? 80 : MID - 110;
      n.dx += (W / 2 - n.x) * 0.004;
      n.dy += (gy - n.y) * 0.01;
      const step = Math.hypot(n.dx, n.dy);
      const cap = 12 * cool + 0.5;
      const k = step > cap ? cap / step : 1;
      n.x = Math.min(W - 34, Math.max(34, n.x + n.dx * k));
      n.y =
        n.side === 'mine'
          ? Math.min(H - 30, Math.max(MID + 46, n.y + n.dy * k))
          : Math.min(MID - 46, Math.max(58, n.y + n.dy * k));
    }
  }

  const nodes: GraphNode[] = bodies
    .filter((b): b is Body & { side: GraphSide } => b.side !== 'you')
    .map((b) => ({
      id: b.id,
      short: b.short,
      rosterId: b.rosterId,
      side: b.side,
      fx: b.x / W,
      fy: b.y / H,
    }));
  const clusters = rosters
    .filter((r) => r.side !== 'mine')
    .map((r) => {
      const own = nodes.filter((n) => n.rosterId === r.roster.rosterId);
      return {
        rosterId: r.roster.rosterId,
        label: r.roster.ownerLabel.replace(/’s repeaters$/, ''),
        side: r.side,
        fx: own.reduce((sum, n) => sum + n.fx, 0) / own.length,
        fy: Math.min(...own.map((n) => n.fy)),
      };
    });
  return { nodes, links: links.map(({ a, b, kind }) => ({ a, b, kind })), clusters };
}
