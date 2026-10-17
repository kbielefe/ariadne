// Pure graph helpers, used by the server (context packs, MCP) and the web UI (filters).
import { type Edge, type EdgeKind, type Node, USER_ID } from './model';

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

/**
 * Edges of `kind` that a longer path of the same kind already covers: the transitive reduction.
 * `u → v` is a skip when some direct successor of `u` can reach `v`, so the path has length at least 2
 * (A → D drops when the only route is A → B → C → D). One pass on the original graph. On a DAG, dropping
 * them all at once keeps reachability. `needs`, `reports_to`, and `member_of` are kept acyclic on write.
 */
export function skipEdges(edges: readonly Edge[], kind: EdgeKind = 'needs'): Edge[] {
  const adj = new Map<string, string[]>();
  const ofKind: Edge[] = [];
  for (const e of edges) {
    if (e.kind !== kind) continue;
    ofKind.push(e);
    const list = adj.get(e.src);
    if (list) list.push(e.dst);
    else adj.set(e.src, [e.dst]);
  }
  // Nodes reachable from `start` in one or more steps.
  const desc = new Map<string, Set<string>>();
  const descendants = (start: string): Set<string> => {
    const hit = desc.get(start);
    if (hit) return hit;
    const seen = new Set<string>();
    const stack = [...(adj.get(start) ?? [])];
    while (stack.length) {
      const y = stack.pop()!;
      if (seen.has(y)) continue;
      seen.add(y);
      for (const z of adj.get(y) ?? []) if (!seen.has(z)) stack.push(z);
    }
    desc.set(start, seen);
    return seen;
  };
  // Nodes each src reaches in two or more steps, through one of its direct successors.
  const via = new Map<string, Set<string>>();
  const reachableVia = (src: string): Set<string> => {
    const hit = via.get(src);
    if (hit) return hit;
    const set = new Set<string>();
    for (const w of adj.get(src) ?? []) for (const d of descendants(w)) set.add(d);
    via.set(src, set);
    return set;
  };
  return ofKind.filter((e) => reachableVia(e.src).has(e.dst));
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
  /** who other than You is working on it (working_on edges into it): theirs, so never ready for the user */
  theirs: string[];
}

export function readiness(task: Node, edges: readonly Edge[], byId: ReadonlyMap<string, Node>): Readiness {
  const waitingOn = edges.filter((e) => e.kind === 'needs' && e.src === task.id && byId.get(e.dst)?.status === 'open').map((e) => e.dst);
  const external = edges.filter((e) => e.kind === 'waits_on' && e.src === task.id).map((e) => e.dst);
  const theirs = edges.filter((e) => e.kind === 'working_on' && e.dst === task.id && e.src !== USER_ID).map((e) => e.src);
  return { ready: task.status === 'open' && waitingOn.length === 0 && external.length === 0 && theirs.length === 0, waitingOn, external, theirs };
}

/**
 * Who can move an open task now:
 * - `ready`: anyone, an agent included (nothing open below it, no waits_on).
 * - `yours`: only the user. It waits on You (a review, a decision, a remote step) and on nothing else.
 * - `blocked`: someone or something outside the user's control (waits_on another person, team, or resource).
 * - `waiting`: its open subtasks.
 * - `theirs`: someone other than You is working on it (working_on), e.g. a teammate's steward intent. Never ready for
 *   the user or their agents, whatever else it waits on.
 */
export type TaskState = 'ready' | 'yours' | 'blocked' | 'waiting' | 'theirs';

export function taskState(r: Readiness): TaskState {
  if (r.ready) return 'ready';
  if (r.theirs.length) return 'theirs';
  if (r.external.some((x) => x !== USER_ID)) return 'blocked';
  if (r.external.length && !r.waitingOn.length) return 'yours';
  return 'waiting';
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
