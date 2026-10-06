// How the graph view orders nodes within a layout rank (siblings side by side).
import type { LayoutOptions, NodeCollection, NodeSingular } from 'cytoscape';
import { readiness } from '../shared/graph';
import type { Edge, Node } from '../shared/model';

export const SORTS = {
  ready: 'Ready first',
  oldest: 'Oldest first',
  newest: 'Newest first',
  updated: 'Recently updated',
  title: 'Title (A–Z)',
} as const;
export type Sort = keyof typeof SORTS;
export const DEFAULT_SORT: Sort = 'ready';
export const isSort = (s: unknown): s is Sort => typeof s === 'string' && Object.hasOwn(SORTS, s);

/** Ready tasks, then waiting ones, then other kinds, then done and dropped. */
function readyRank(n: Node, edges: readonly Edge[], byId: ReadonlyMap<string, Node>): number {
  if (n.kind !== 'task') return 2;
  if (n.status === 'open') return readiness(n, edges, byId).ready ? 0 : 1;
  return 3;
}

/** The nodes in display order. Ties go by title. */
export function sortNodes(nodes: readonly Node[], sort: Sort, edges: readonly Edge[], byId: ReadonlyMap<string, Node>): Node[] {
  const byTitle = (a: Node, b: Node) => a.title.localeCompare(b.title);
  const rank = sort === 'ready' ? new Map(nodes.map((n) => [n.id, readyRank(n, edges, byId)])) : null;
  const cmp: Record<Sort, (a: Node, b: Node) => number> = {
    ready: (a, b) => rank!.get(a.id)! - rank!.get(b.id)!,
    oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    title: () => 0,
  };
  return [...nodes].sort((a, b) => cmp[sort](a, b) || byTitle(a, b));
}

/** Wide graphs read better left to right: a fan of many children becomes a tall column. */
export const rankDir = (nodeCount: number): 'TB' | 'LR' => (nodeCount > 10 ? 'LR' : 'TB');

export const RANK_SEP = 90;

/**
 * dagre options for the graph view. Every element carries `data.order` (its position in the sort).
 * dagre places siblings in the reverse of the order it receives them, so feed them reversed.
 * It still moves siblings when that removes edge crossings; `orderLeafSiblings` fixes the leaves.
 */
export function layoutOptions(nodeCount: number): LayoutOptions {
  return {
    name: 'dagre',
    rankDir: rankDir(nodeCount),
    nodeSep: 14,
    rankSep: RANK_SEP,
    animate: false,
    fit: true,
    padding: 30,
    sort: (a: NodeSingular, b: NodeSingular) => (b.data('order') as number) - (a.data('order') as number),
  } as LayoutOptions;
}

/**
 * After a layout: leaves with exactly the same parents (or none) swap places so they follow the sort.
 * The drawing is otherwise identical (same slots, same parents), so no edge crossings are added.
 */
export function orderLeafSiblings(nodes: NodeCollection, dir: 'TB' | 'LR') {
  const axis = dir === 'LR' ? 'y' : 'x';
  const groups = new Map<string, NodeSingular[]>();
  nodes.forEach((n) => {
    if (n.outgoers('node').nonempty()) return;
    const key = `${Math.round(n.position(axis === 'x' ? 'y' : 'x'))}|${n.incomers('node').map((p) => p.id()).sort().join(',')}`;
    groups.set(key, [...(groups.get(key) ?? []), n]);
  });
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const slots = g.map((n) => ({ ...n.position() })).sort((a, b) => a[axis] - b[axis]);
    const ordered = [...g].sort((a, b) => (a.data('order') as number) - (b.data('order') as number));
    ordered.forEach((n, i) => n.position(slots[i]!));
  }
}
