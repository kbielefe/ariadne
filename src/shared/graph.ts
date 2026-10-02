// Pure graph helpers, used by the server (context packs, MCP) and the web UI (filters).
import type { Edge, EdgeKind, Node } from './model';

export type Direction = 'down' | 'up' | 'both';

export interface ReachOptions {
  /** down follows edges src → dst (what X needs, uses, involves...). up follows them backwards. */
  direction?: Direction;
  kinds?: readonly EdgeKind[];
  depth?: number;
}

/** Ids reachable from `start` (including it), breadth first. */
export function reachable(edges: readonly Edge[], start: string, o: ReachOptions = {}): Map<string, number> {
  const direction = o.direction ?? 'down';
  const kinds = o.kinds ? new Set(o.kinds) : null;
  const maxDepth = o.depth ?? Infinity;
  const out = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    const list = out.get(a);
    if (list) list.push(b);
    else out.set(a, [b]);
  };
  for (const e of edges) {
    if (kinds && !kinds.has(e.kind)) continue;
    if (direction !== 'up') add(e.src, e.dst);
    if (direction !== 'down') add(e.dst, e.src);
  }
  const seen = new Map([[start, 0]]);
  let frontier = [start];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const n of out.get(id) ?? [])
        if (!seen.has(n)) {
          seen.set(n, d);
          next.push(n);
        }
    frontier = next;
  }
  return seen;
}

/** Tasks that (transitively) need this task, nearest first. Their context is inherited. */
export function ancestorTasks(edges: readonly Edge[], taskId: string): string[] {
  const r = reachable(edges, taskId, { direction: 'up', kinds: ['needs'] });
  r.delete(taskId);
  return [...r.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/** A task is a root (what v1 called an Outcome) when no task needs it. */
export function isRoot(edges: readonly Edge[], taskId: string): boolean {
  return !edges.some((e) => e.kind === 'needs' && e.dst === taskId);
}

export interface Readiness {
  ready: boolean;
  /** open tasks this one needs */
  waitingOn: string[];
}

export function readiness(task: Node, edges: readonly Edge[], byId: ReadonlyMap<string, Node>): Readiness {
  const waitingOn = edges.filter((e) => e.kind === 'needs' && e.src === task.id && byId.get(e.dst)?.status === 'open').map((e) => e.dst);
  return { ready: task.status === 'open' && waitingOn.length === 0, waitingOn };
}

/** Would adding src -kind-> dst close a cycle? (Is src already reachable from dst?) */
export function wouldCycle(edges: readonly Edge[], kind: EdgeKind, src: string, dst: string): boolean {
  return src === dst || reachable(edges, dst, { kinds: [kind] }).has(src);
}

// A decision is a line in a node's body, by convention `**Decision (Karl, 2026-10-02):** text`
// (optionally a list item). store.ts has the same pattern in SQL.
const DECISION_LINE = /^[ \t]*(?:[-*][ \t]+)?\*\*Decision\b.*$/;

export const isDecisionLine = (line: string): boolean => DECISION_LINE.test(line);

/** The decision lines in a body, trimmed. */
export const decisionLines = (body: string): string[] => body.split('\n').filter(isDecisionLine).map((l) => l.trim());
