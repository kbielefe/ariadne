// Live nudging for the force layout: while you drag a node, its neighbours follow on springs
// and anything they bump into is pushed aside, which can push the next node along.
// Nothing else moves.
import type { Pos, Size } from './placement';

export interface Body extends Pos, Size {
  vx: number;
  vy: number;
}

export interface NudgeOptions {
  /** Ideal distance between linked nodes, on top of half their widths. */
  edge: number;
}

const SPRING = 0.03;
const PUSH = 0.35;
const DAMPING = 0.6;
const MAX_SPEED = 30;
const MARGIN = 24;

/** How far two boxes (plus a margin) overlap on each axis; both positive means they collide. */
function overlap(a: Body, b: Body) {
  return { x: (a.w + b.w) / 2 + MARGIN - Math.abs(a.x - b.x), y: (a.h + b.h) / 2 + MARGIN - Math.abs(a.y - b.y) };
}

/**
 * One simulation step. `held` is the dragged node: it doesn't move here, but everything around it does.
 * Returns the ids that moved, and the largest distance any of them moved.
 */
export function nudgeStep(bodies: Map<string, Body>, edges: readonly { src: string; dst: string }[], held: string, o: NudgeOptions): { moved: Set<string>; most: number } {
  if (!bodies.has(held)) return { moved: new Set(), most: 0 };
  // Who may move: the held node's neighbours (they follow), and, spreading out, anything a moving node bumps.
  const followers = new Set<string>();
  for (const e of edges) {
    if (e.src === held && e.dst !== held && bodies.has(e.dst)) followers.add(e.dst);
    if (e.dst === held && e.src !== held && bodies.has(e.src)) followers.add(e.src);
  }
  const mobile = new Set(followers);
  const front = [held, ...mobile];
  while (front.length) {
    const a = bodies.get(front.pop()!)!;
    for (const [id, b] of bodies) {
      if (id === held || mobile.has(id)) continue;
      const v = overlap(a, b);
      if (v.x > 0 && v.y > 0) {
        mobile.add(id);
        front.push(id);
      }
    }
  }

  const force = new Map([...mobile].map((id) => [id, { x: 0, y: 0 }]));
  const add = (id: string, x: number, y: number) => {
    const f = force.get(id);
    if (f) {
      f.x += x;
      f.y += y;
    }
  };
  // Springs on the followers' edges: towards the held node, balanced against their other links.
  for (const e of edges) {
    const a = bodies.get(e.src);
    const b = bodies.get(e.dst);
    if (!a || !b || e.src === e.dst || !(followers.has(e.src) || followers.has(e.dst))) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const want = o.edge + (a.w + b.w) / 4;
    const f = SPRING * (d - want);
    add(e.src, (f * dx) / d, (f * dy) / d);
    add(e.dst, (-f * dx) / d, (-f * dy) / d);
  }
  // Collisions push apart along the axis that separates them soonest.
  for (const id of mobile) {
    const a = bodies.get(id)!;
    for (const [other, b] of bodies) {
      if (other === id) continue;
      const v = overlap(a, b);
      if (v.x <= 0 || v.y <= 0) continue;
      if (v.x / (a.w + b.w) < v.y / (a.h + b.h)) add(id, PUSH * v.x * (Math.sign(a.x - b.x) || 1), 0);
      else add(id, 0, PUSH * v.y * (Math.sign(a.y - b.y) || 1));
    }
  }

  let most = 0;
  const moved = new Set<string>();
  for (const [id, f] of force) {
    const b = bodies.get(id)!;
    b.vx = (b.vx + f.x) * DAMPING;
    b.vy = (b.vy + f.y) * DAMPING;
    const speed = Math.hypot(b.vx, b.vy);
    if (speed > MAX_SPEED) {
      b.vx *= MAX_SPEED / speed;
      b.vy *= MAX_SPEED / speed;
    }
    if (speed < 0.05) continue;
    b.x += b.vx;
    b.y += b.vy;
    moved.add(id);
    most = Math.max(most, Math.min(speed, MAX_SPEED));
  }
  return { moved, most };
}
