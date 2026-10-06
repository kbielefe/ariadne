// Stable positions for the graph view: each view remembers where its nodes are,
// and nodes that appear later are placed beside their neighbours instead of re-laying out everything.
import type { NodeKind } from '../shared/model';
import { remember } from './api';

export interface Pos {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}

/** A remembered arrangement. `flow` points from a node toward what it needs (one rank step). */
export interface View {
  flow: Pos;
  pos: Map<string, Pos>;
}

/** Drawn node sizes; layouts and placement keep this much room. */
export const NODE_SIZE: Record<NodeKind, Size> = { task: { w: 180, h: 52 }, person: { w: 120, h: 52 }, team: { w: 130, h: 52 }, resource: { w: 140, h: 52 } };

const STORE = 'graphViews';
const MAX_VIEWS = 12;
const GAP = 14;

type Stored = [key: string, flow: Pos, pos: Record<string, [number, number]>][];

function readStore(): Stored {
  try {
    const s: unknown = JSON.parse(remember.get(STORE) ?? '[]');
    return Array.isArray(s) ? (s as Stored) : [];
  } catch {
    return [];
  }
}

export function loadView(key: string): View | null {
  const hit = readStore().find((v) => v[0] === key);
  if (!hit) return null;
  return { flow: hit[1], pos: new Map(Object.entries(hit[2]).map(([id, [x, y]]) => [id, { x, y }])) };
}

/** Save a view as the most recent; the oldest views beyond MAX_VIEWS are forgotten. */
export function saveView(key: string, v: View) {
  const pos = Object.fromEntries([...v.pos].map(([id, p]) => [id, [Math.round(p.x), Math.round(p.y)]]));
  remember.set(STORE, JSON.stringify([[key, v.flow, pos], ...readStore().filter((s) => s[0] !== key)].slice(0, MAX_VIEWS)));
}

const overlaps = (a: Pos, as: Size, b: Pos, bs: Size) => Math.abs(a.x - b.x) * 2 < as.w + bs.w + GAP * 2 && Math.abs(a.y - b.y) * 2 < as.h + bs.h + GAP * 2;

/**
 * Positions for `ids` (in sort order) that aren't placed yet, without moving anything that is.
 * A node goes one `flow` step past what needs it, or one step before what it needs, then slides
 * sideways to the nearest free spot. Nodes with no placed neighbours start a row past everything.
 */
export function placeNew(ids: readonly string[], edges: readonly { src: string; dst: string }[], pos: ReadonlyMap<string, Pos>, size: (id: string) => Size, flow: Pos): Map<string, Pos> {
  const placed = new Map(pos);
  const out = new Map<string, Pos>();
  const len = Math.hypot(flow.x, flow.y) || 1;
  const side = { x: -flow.y / len, y: flow.x / len };
  const free = (id: string, at: Pos) => {
    const s = size(id);
    const step = Math.abs(side.x) * (s.w + GAP) + Math.abs(side.y) * (s.h + GAP);
    for (let i = 0; ; i++) {
      const k = i % 2 ? (i + 1) / 2 : -i / 2;
      const p = { x: at.x + side.x * step * k, y: at.y + side.y * step * k };
      if (![...placed].some(([o, q]) => overlaps(p, s, q, size(o)))) return p;
    }
  };
  const mean = (ps: Pos[]) => ({ x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length });
  const put = (id: string, p: Pos) => {
    placed.set(id, p);
    out.set(id, p);
  };

  // Each pass places what has a placed neighbour, so chains of new nodes grow outward.
  let todo = ids.filter((id) => !placed.has(id));
  for (let progress = true; todo.length && progress; ) {
    progress = false;
    for (const id of todo) {
      const up = edges.filter((e) => e.dst === id && placed.has(e.src)).map((e) => placed.get(e.src)!);
      const down = edges.filter((e) => e.src === id && placed.has(e.dst)).map((e) => placed.get(e.dst)!);
      if (!up.length && !down.length) continue;
      const m = mean(up.length ? up : down);
      const sign = up.length ? 1 : -1;
      put(id, free(id, { x: m.x + flow.x * sign, y: m.y + flow.y * sign }));
      progress = true;
    }
    todo = todo.filter((id) => !placed.has(id));
  }

  // The rest: a row one step past the far edge of everything placed.
  if (todo.length) {
    const ps = [...placed.values()];
    const far = ps.length ? Math.max(...ps.map((p) => (p.x * flow.x + p.y * flow.y) / len)) + len : 0;
    const start = ps.length ? Math.min(...ps.map((p) => p.x * side.x + p.y * side.y)) : 0;
    for (const id of todo) put(id, free(id, { x: (flow.x / len) * far + side.x * start, y: (flow.y / len) * far + side.y * start }));
  }
  return out;
}
