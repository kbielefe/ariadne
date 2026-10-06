// Layouts for the graph view, as pure functions from nodes and edges to positions.
import type { ELK, ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { EdgeKind, NodeKind } from '../shared/model';
import { NODE_SIZE, type Pos, type View } from './placement';

export const LAYOUTS = {
  layered: 'Layered',
  radial: 'Radial',
  force: 'Force',
} as const;
export type LayoutName = keyof typeof LAYOUTS;
export const DEFAULT_LAYOUT: LayoutName = 'layered';
export const isLayout = (s: unknown): s is LayoutName => typeof s === 'string' && Object.hasOwn(LAYOUTS, s);

export interface LayoutNode {
  id: string;
  kind: NodeKind;
  /** Position in the current sort. */
  order: number;
}
export interface LayoutEdge {
  src: string;
  dst: string;
  kind: EdgeKind;
}

export const RANK_SEP = 90;
const NODE_SEP = 14;
const LANE_GAP = 60;

/** Wide graphs read better left to right: a fan of many children becomes a tall column. */
export const rankDir = (nodeCount: number): 'TB' | 'LR' => (nodeCount > 10 ? 'LR' : 'TB');

// ELK is big; load it the first time something is laid out.
let elk: Promise<ELK> | null = null;
const getElk = () => (elk ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default()));

/** ELK layered positions (centres) for these nodes and edges, keeping the given order where it adds no crossings. */
async function elkLayered(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], dir: 'TB' | 'LR'): Promise<Map<string, Pos>> {
  const byOrder = <T>(f: (x: T) => number) => (a: T, b: T) => f(a) - f(b);
  const order = new Map(nodes.map((n) => [n.id, n.order]));
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': dir === 'LR' ? 'RIGHT' : 'DOWN',
      'elk.spacing.nodeNode': String(NODE_SEP),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(RANK_SEP),
      'elk.spacing.componentComponent': String(LANE_GAP),
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.considerModelOrder.components': 'MODEL_ORDER',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: [...nodes].sort(byOrder((n) => n.order)).map((n) => ({ id: n.id, width: NODE_SIZE[n.kind].w, height: NODE_SIZE[n.kind].h })),
    edges: [...edges].sort(byOrder((e) => order.get(e.src)! * nodes.length + order.get(e.dst)!)).map((e, i) => ({ id: `e${i}`, sources: [e.src], targets: [e.dst] })),
  };
  const out = await (await getElk()).layout(graph);
  return new Map((out.children ?? []).map((c) => [c.id, { x: c.x! + c.width! / 2, y: c.y! + c.height! / 2 }]));
}

/** Org edges point up the hierarchy (to the manager or team); flip them so the hierarchy reads top down. */
const downward = (e: LayoutEdge): LayoutEdge => (e.kind === 'reports_to' || e.kind === 'member_of' ? { ...e, src: e.dst, dst: e.src } : e);

/**
 * Tasks are layered by `needs` alone: what a task needs sits one rank past it.
 * People, teams, and resources linked to those tasks go in a lane beside them, level with their tasks,
 * so they never push a task to another rank. Anything else (say, the org chart) is laid out past the lane.
 * With no tasks shown, everything is layered by its own edges.
 */
export async function layered(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Promise<View> {
  if (!nodes.length) return { flow: { x: 0, y: NODE_SIZE.task.h + RANK_SEP }, pos: new Map() };
  const tasks = nodes.filter((n) => n.kind === 'task');
  const core = tasks.length ? tasks : nodes;
  const inCore = new Set(core.map((n) => n.id));
  const dir = rankDir(core.length);
  // rank: the axis along which ranks go; side: the axis along which a rank's nodes sit.
  const rank = dir === 'LR' ? 'x' : 'y';
  const side = dir === 'LR' ? 'y' : 'x';
  const flow = { x: 0, y: 0, [rank]: (rank === 'x' ? NODE_SIZE.task.w : NODE_SIZE.task.h) + RANK_SEP } as Pos;
  const half = (n: LayoutNode, axis: 'x' | 'y') => (axis === 'x' ? NODE_SIZE[n.kind].w : NODE_SIZE[n.kind].h) / 2;

  const coreEdges = edges.filter((e) => inCore.has(e.src) && inCore.has(e.dst) && (!tasks.length || e.kind === 'needs')).map(downward);
  const pos = await elkLayered(core, coreEdges, dir);
  let edge = Math.max(...core.map((n) => pos.get(n.id)![side] + half(n, side)));

  // The lane: each linked node level with the middle of its tasks, sliding along the lane to make room.
  const others = nodes.filter((n) => !inCore.has(n.id));
  const linked = others
    .map((n) => {
      const at = edges.flatMap((e) => (e.src === n.id && inCore.has(e.dst) ? [e.dst] : e.dst === n.id && inCore.has(e.src) ? [e.src] : [])).map((id) => pos.get(id)![rank]);
      return { n, want: at.length ? at.reduce((a, b) => a + b, 0) / at.length : null };
    })
    .filter((x): x is { n: LayoutNode; want: number } => x.want != null)
    .sort((a, b) => a.want - b.want || a.n.order - b.n.order);
  if (linked.length) {
    const width = Math.max(...linked.map(({ n }) => half(n, side)));
    const at = edge + LANE_GAP + width;
    let next = -Infinity;
    for (const { n, want } of linked) {
      const c = Math.max(want, next + half(n, rank));
      pos.set(n.id, { [side]: at, [rank]: c } as unknown as Pos);
      next = c + half(n, rank) + NODE_SEP;
    }
    edge = at + width;
  }

  // The rest, laid out on its own past the lane, starting level with the top rank.
  const rest = others.filter((n) => !pos.has(n.id));
  if (rest.length) {
    const ids = new Set(rest.map((n) => n.id));
    const sub = await elkLayered(rest, edges.filter((e) => ids.has(e.src) && ids.has(e.dst)).map(downward), dir);
    const min = (axis: 'x' | 'y') => Math.min(...[...sub].map(([id, p]) => p[axis] - half(rest.find((n) => n.id === id)!, axis)));
    const top = Math.min(...core.map((n) => pos.get(n.id)![rank] - half(n, rank)));
    const dSide = edge + LANE_GAP - min(side);
    const dRank = top - min(rank);
    for (const [id, p] of sub) pos.set(id, { [side]: p[side] + dSide, [rank]: p[rank] + dRank } as unknown as Pos);
  }
  return { flow, pos };
}

const RING_GAP = 40;

/**
 * Rings around a centre: the focus if there is one, otherwise the tops of the graph
 * (tasks nothing needs, or managers and teams). Each ring is one step further away, by any edge.
 * Nodes in a ring follow their nearest inner neighbour around the circle, then the sort.
 */
export function radial(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], focus: string | null): View {
  const step = NODE_SIZE.task.w + RING_GAP;
  const flow = { x: 0, y: step };
  if (!nodes.length) return { flow, pos: new Map() };
  const sorted = [...nodes].sort((a, b) => a.order - b.order);
  const ids = new Set(nodes.map((n) => n.id));
  const shown = edges.filter((e) => ids.has(e.src) && ids.has(e.dst));
  const below = new Set(shown.map(downward).map((e) => e.dst));
  const tops = focus && ids.has(focus) ? [focus] : sorted.filter((n) => !below.has(n.id)).map((n) => n.id);
  const centre = tops.length ? tops : [sorted[0]!.id];

  // Rings by breadth-first distance; whatever can't be reached goes on one more ring outside.
  const near = new Map<string, string[]>();
  for (const e of shown) {
    near.set(e.src, [...(near.get(e.src) ?? []), e.dst]);
    near.set(e.dst, [...(near.get(e.dst) ?? []), e.src]);
  }
  const ring = new Map(centre.map((id) => [id, 0]));
  for (let frontier = centre, d = 1; frontier.length; d++) {
    const next = frontier.flatMap((id) => (near.get(id) ?? []).filter((x) => !ring.has(x)));
    for (const id of next) ring.set(id, d);
    frontier = [...new Set(next)];
  }
  const outer = Math.max(...ring.values()) + 1;
  for (const n of sorted) if (!ring.has(n.id)) ring.set(n.id, outer);

  const pos = new Map<string, Pos>();
  const angle = new Map<string, number>();
  let radius = 0;
  for (let r = 0; r <= outer; r++) {
    const here = sorted.filter((n) => ring.get(n.id) === r);
    if (!here.length) continue;
    // Follow the inner neighbours around: the circular mean of their angles.
    const at = (n: LayoutNode) => {
      const inner = (near.get(n.id) ?? []).filter((x) => angle.has(x)).map((x) => angle.get(x)!);
      if (!inner.length) return Infinity;
      const a = Math.atan2(inner.reduce((s, t) => s + Math.sin(t), 0), inner.reduce((s, t) => s + Math.cos(t), 0));
      return a < -Math.PI / 2 ? a + 2 * Math.PI : a;
    };
    const keyed = here.map((n) => ({ n, a: at(n) })).sort((p, q) => p.a - q.a || p.n.order - q.n.order);
    // Far enough out that neighbours on the circle don't touch, and at least a step past the last ring.
    const fit = here.length > 1 ? step / (2 * Math.sin(Math.PI / here.length)) : 0;
    radius = r === 0 && here.length === 1 ? 0 : Math.max(fit, r === 0 ? 0 : radius + step);
    // Start at the top and go clockwise.
    keyed.forEach(({ n }, i) => {
      const t = -Math.PI / 2 + (2 * Math.PI * i) / here.length;
      angle.set(n.id, t);
      pos.set(n.id, radius ? { x: radius * Math.cos(t), y: radius * Math.sin(t) } : { x: 0, y: 0 });
    });
  }
  return { flow, pos };
}
