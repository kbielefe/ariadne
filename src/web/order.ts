// The orders the graph view can sort nodes in; layouts keep siblings in this order.
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
