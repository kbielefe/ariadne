// Layouts for the graph view, as pure functions from nodes and edges to positions.
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { EdgeKind, NodeKind } from '../shared/model';
import { NODE_SIZE, type Pos, type View } from './placement';

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

const elk = new ELK();

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
  const out = await elk.layout(graph);
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
