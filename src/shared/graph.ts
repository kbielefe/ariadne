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

/**
 * Impact of each task: how many distinct tasks (transitively) need it, not counting itself.
 * A task nothing needs has impact 0. Done and dropped tasks don't count themselves,
 * but the walk goes through them, so open tasks that need them still count.
 */
export function impacts(edges: readonly Edge[], byId: ReadonlyMap<string, Node>): Map<string, number> {
  const neededBy = new Map<string, string[]>();
  const tasks = new Set<string>();
  for (const e of edges) {
    if (e.kind !== 'needs') continue;
    tasks.add(e.src).add(e.dst);
    const list = neededBy.get(e.dst);
    if (list) list.push(e.src);
    else neededBy.set(e.dst, [e.src]);
  }
  const out = new Map<string, number>();
  for (const id of tasks) {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length)
      for (const up of neededBy.get(stack.pop()!) ?? [])
        if (!seen.has(up)) {
          seen.add(up);
          stack.push(up);
        }
    seen.delete(id);
    let n = 0;
    for (const up of seen) if (byId.get(up)?.status === 'open') n++;
    out.set(id, n);
  }
  return out;
}

/** A task is a root (what v1 called an Outcome) when no task needs it. */
export function isRoot(edges: readonly Edge[], taskId: string): boolean {
  return !edges.some((e) => e.kind === 'needs' && e.dst === taskId);
}

export interface Readiness {
  ready: boolean;
  /** open tasks this one needs */
  waitingOn: string[];
  /** who or what outside the user's control it waits on (waits_on edges): blocked until the task is closed */
  external: string[];
}

export function readiness(task: Node, edges: readonly Edge[], byId: ReadonlyMap<string, Node>): Readiness {
  const waitingOn = edges.filter((e) => e.kind === 'needs' && e.src === task.id && byId.get(e.dst)?.status === 'open').map((e) => e.dst);
  const external = edges.filter((e) => e.kind === 'waits_on' && e.src === task.id).map((e) => e.dst);
  return { ready: task.status === 'open' && waitingOn.length === 0 && external.length === 0, waitingOn, external };
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
