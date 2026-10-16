// Filter steps for the graph view: an ordered list of set operations, each on a seed grown by
// parents and children. Steps are rules, not results: they are re-applied to the graph on every
// change, so new subtasks join "A + all children" and a task that becomes yours joins "yours tasks".
import { type Direction, readiness, type TaskState, taskState } from '../shared/graph';
import type { Edge, Node } from '../shared/model';

export type StepOp = 'replace' | 'union' | 'intersect' | 'subtract';
export const STEP_OPS: Record<StepOp, string> = { replace: 'Show', union: 'Add', intersect: 'Keep only', subtract: 'Hide' };

export const TASK_STATES: TaskState[] = ['ready', 'yours', 'blocked', 'waiting', 'theirs'];

export type Seed =
  /** Nodes picked by hand: a snapshot of the selection when the step was made. */
  | { type: 'nodes'; ids: string[] }
  /** Open tasks in these states, read afresh each time. */
  | { type: 'state'; states: TaskState[] };

/** How far to grow the seed: steps up (what needs it) and down (what it needs, uses, involves). 0 none, ALL any depth. */
export interface Reach {
  up: number;
  down: number;
}
export const ALL = -1;

export interface Step {
  id: string;
  op: StepOp;
  seed: Seed;
  reach: Reach;
  /** Off steps stay in the list but do nothing. */
  on: boolean;
}

export interface StepGraph {
  /** Edges the walks follow (the view's edge kinds). */
  walk: readonly Edge[];
  /** Every edge, for task states. */
  edges: readonly Edge[];
  byId: ReadonlyMap<string, Node>;
}

/** The seed's nodes that still exist. */
export function seedIds(seed: Seed, g: StepGraph): string[] {
  if (seed.type === 'nodes') return seed.ids.filter((id) => g.byId.has(id));
  const want = new Set(seed.states);
  return [...g.byId.values()].filter((n) => n.kind === 'task' && n.status === 'open' && want.has(taskState(readiness(n, g.edges, g.byId)))).map((n) => n.id);
}

/**
 * Add what `start` reaches going `direction`, up to `depth` levels (ALL for any). The walk passes through tasks
 * only: a person, team, or resource it reaches is added but not walked on from (unless it is the seed), so
 * "A + all children" stops at A's people instead of spreading through them to everyone else's work.
 */
function grow(out: Set<string>, g: StepGraph, start: string, direction: 'up' | 'down', depth: number) {
  if (depth === 0) return;
  const next = new Map<string, string[]>();
  for (const e of g.walk) {
    const [from, to] = direction === 'down' ? [e.src, e.dst] : [e.dst, e.src];
    const list = next.get(from);
    if (list) list.push(to);
    else next.set(from, [to]);
  }
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 1; (depth === ALL || d <= depth) && frontier.length; d++) {
    const ahead: string[] = [];
    for (const id of frontier)
      for (const n of next.get(id) ?? [])
        if (!seen.has(n)) {
          seen.add(n);
          out.add(n);
          if (g.byId.get(n)?.kind === 'task') ahead.push(n);
        }
    frontier = ahead;
  }
}

/** The nodes one step stands for: its seed plus the parents and children it reaches. */
export function stepIds(step: Step, g: StepGraph): Set<string> {
  const out = new Set<string>();
  for (const id of seedIds(step.seed, g)) {
    out.add(id);
    // Two walks, not 'both': parents of parents, never their other children.
    grow(out, g, id, 'up', step.reach.up);
    grow(out, g, id, 'down', step.reach.down);
  }
  return out;
}

/**
 * Apply the steps that are on, in order, starting from `base` (what the kind and status filters let through).
 * Walks cross nodes outside `base` (a done task still links its children), but only `base` is returned.
 */
export function applySteps(base: ReadonlySet<string>, steps: readonly Step[], g: StepGraph): Set<string> {
  let cur = new Set(base);
  for (const s of steps) {
    if (!s.on) continue;
    const ids = stepIds(s, g);
    if (s.op === 'replace') cur = ids;
    else if (s.op === 'union') for (const id of ids) cur.add(id);
    else if (s.op === 'intersect') cur = new Set([...cur].filter((id) => ids.has(id)));
    else for (const id of ids) cur.delete(id);
  }
  return new Set([...cur].filter((id) => base.has(id)));
}

/** Hand-picked seeds of the steps that are on and show something (not Hide): drawn highlighted. */
export function shownSeeds(steps: readonly Step[], g: StepGraph): Set<string> {
  const out = new Set<string>();
  for (const s of steps) if (s.on && s.op !== 'subtract' && s.seed.type === 'nodes') for (const id of seedIds(s.seed, g)) out.add(id);
  return out;
}

/** Where a radial layout centres: the first seed of the last Show step that is on. */
export function centre(steps: readonly Step[], g: StepGraph): string | null {
  const s = steps.findLast((x) => x.on && x.op === 'replace' && x.seed.type === 'nodes');
  return s ? (seedIds(s.seed, g)[0] ?? null) : null;
}

const reachWords = (n: number, what: string) => (n === 0 ? '' : n === ALL ? `all ${what}` : `${n} level${n > 1 ? 's' : ''} of ${what}`);

/** Plain words for the step list, e.g. "Keep only PDP: gateway + all children". */
export function stepLabel(step: Step, byId: ReadonlyMap<string, Node>): string {
  let seed: string;
  if (step.seed.type === 'state') seed = `${step.seed.states.join(', ')} tasks`;
  else {
    const ids = step.seed.ids;
    const left = ids.filter((id) => byId.has(id));
    if (!left.length) seed = ids.length === 1 ? '(gone)' : `${ids.length} nodes (gone)`;
    else if (ids.length === 1) {
      const t = byId.get(ids[0]!)!.title;
      seed = t.length > 40 ? `${t.slice(0, 39)}…` : t;
    } else seed = `${ids.length} nodes${left.length < ids.length ? ` (${ids.length - left.length} gone)` : ''}`;
  }
  const grown = [reachWords(step.reach.up, 'parents'), reachWords(step.reach.down, 'children')].filter(Boolean);
  return `${STEP_OPS[step.op]} ${seed}${grown.length ? ` + ${grown.join(' + ')}` : ''}`;
}

/** A stable key for the steps that are on (for remembering a layout per view). */
export function stepsKey(steps: readonly Step[]): string {
  return JSON.stringify(steps.filter((s) => s.on).map((s) => [s.op, s.seed.type === 'nodes' ? s.seed.ids : s.seed.states, s.reach.up, s.reach.down]));
}

const isReach = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= ALL;

function isStep(x: unknown): x is Step {
  const s = x as Step;
  if (!s || typeof s.id !== 'string' || !(s.op in STEP_OPS) || typeof s.on !== 'boolean') return false;
  if (!s.reach || !isReach(s.reach.up) || !isReach(s.reach.down)) return false;
  if (s.seed?.type === 'nodes') return Array.isArray(s.seed.ids) && s.seed.ids.every((id) => typeof id === 'string');
  if (s.seed?.type === 'state') return Array.isArray(s.seed.states) && s.seed.states.every((t) => TASK_STATES.includes(t));
  return false;
}

/** Saved steps, dropping anything malformed. */
export function parseSteps(json: string | null): Step[] {
  try {
    const v: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter(isStep) : [];
  } catch {
    return [];
  }
}

/** The old single focus as a step: Show the focus, grown the way its direction and depth said. */
export function focusStep(id: string, focus: string, direction: Direction = 'down', depth = 0): Step {
  const d = depth > 0 ? depth : ALL;
  return { id, op: 'replace', seed: { type: 'nodes', ids: [focus] }, reach: { up: direction === 'down' ? 0 : d, down: direction === 'up' ? 0 : d }, on: true };
}

// ================================================================ history

export interface StepHistory {
  past: Step[][];
  now: Step[];
  future: Step[][];
}
const MAX_HISTORY = 50;

export const record = (h: StepHistory, now: Step[]): StepHistory => ({ past: [...h.past, h.now].slice(-MAX_HISTORY), now, future: [] });
export const back = (h: StepHistory): StepHistory => (h.past.length ? { past: h.past.slice(0, -1), now: h.past.at(-1)!, future: [h.now, ...h.future] } : h);
export const forward = (h: StepHistory): StepHistory => (h.future.length ? { past: [...h.past, h.now], now: h.future[0]!, future: h.future.slice(1) } : h);
