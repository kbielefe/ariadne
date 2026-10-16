import { describe, expect, it } from 'vitest';
import { type Edge, type EdgeKind, type Node, USER_ID } from '../shared/model';
import { ALL, applySteps, back, centre, focusStep, forward, parseSteps, record, type Step, type StepGraph, stepLabel, stepsKey } from './steps';

let seq = 0;
const node = (title: string, p: Partial<Node> = {}): Node => ({
  id: `00000000-0000-4000-8000-${String(++seq + 100).padStart(12, '0')}`,
  kind: 'task',
  title,
  body: '',
  status: 'open',
  attrs: {},
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...p,
});
const edge = (src: Node, kind: EdgeKind, dst: Node): Edge => ({ id: `${src.id}-${kind}>${dst.id}`, src: src.id, kind, dst: dst.id, note: '', createdAt: '' });
const step = (op: Step['op'], ids: Node[], up = 0, down = 0, on = true): Step => ({ id: String(++seq), op, seed: { type: 'nodes', ids: ids.map((n) => n.id) }, reach: { up, down }, on });

// A needs A1 and A2; A1 needs A1a. A1 and B1 use resource R. B needs B1.
const you = node('You', { id: USER_ID, kind: 'person', status: null });
const a = node('Task A');
const a1 = node('A1');
const a1a = node('A1a');
const a2 = node('A2');
const b = node('Task B');
const b1 = node('B1');
const r = node('Resource R', { kind: 'resource', status: null });
const nodes = [you, a, a1, a1a, a2, b, b1, r];
const edges = [edge(a, 'needs', a1), edge(a, 'needs', a2), edge(a1, 'needs', a1a), edge(b, 'needs', b1), edge(a1, 'uses', r), edge(b1, 'uses', r)];

const graph = (ns: Node[] = nodes, es: Edge[] = edges): StepGraph => ({ walk: es, edges: es, byId: new Map(ns.map((n) => [n.id, n])) });
const all = (ns: Node[] = nodes) => new Set(ns.map((n) => n.id));
const titles = (ids: Set<string>, ns: Node[] = nodes) => ns.filter((n) => ids.has(n.id)).map((n) => n.title);
const run = (steps: Step[], g = graph(), base = new Set(g.byId.keys())) => titles(applySteps(base, steps, g), [...g.byId.values()]);

describe('applySteps', () => {
  it('no steps shows the whole base', () => {
    expect(run([])).toEqual(nodes.map((n) => n.title));
  });

  it('Show replaces; reach grows the seed by children and parents', () => {
    expect(run([step('replace', [a], 0, ALL)])).toEqual(['Task A', 'A1', 'A1a', 'A2', 'Resource R']);
    expect(run([step('replace', [a], 0, 1)])).toEqual(['Task A', 'A1', 'A2']);
    expect(run([step('replace', [a1a], ALL, 0)])).toEqual(['Task A', 'A1', 'A1a']);
    expect(run([step('replace', [a1])])).toEqual(['A1']);
  });

  it('parents and children are separate walks: no siblings', () => {
    expect(run([step('replace', [a1], 1, 1)])).toEqual(['Task A', 'A1', 'A1a', 'Resource R']);
  });

  it('tasks under A that use R: Show A + all children, then Keep only R + 1 level of parents', () => {
    expect(run([step('replace', [a], 0, ALL), step('intersect', [r], 1, 0)])).toEqual(['A1', 'Resource R']);
  });

  it('Add unions and Hide subtracts', () => {
    expect(run([step('replace', [a], 0, 1), step('union', [b])])).toEqual(['Task A', 'A1', 'A2', 'Task B']);
    expect(run([step('subtract', [a1, r])])).toEqual(['You', 'Task A', 'A1a', 'A2', 'Task B', 'B1']);
  });

  it('skips steps that are off', () => {
    expect(run([step('replace', [a]), step('replace', [b], 0, 0, false)])).toEqual(['Task A']);
  });

  it('walks through tasks only, so people do not spread it to everyone else\'s work', () => {
    const will = node('Will', { kind: 'person', status: null });
    const theirs = node('Will\'s task');
    const g = graph([...nodes, will, theirs], [...edges, edge(a2, 'involves', will), edge(will, 'working_on', theirs)]);
    expect(run([step('replace', [a], 0, ALL)], g)).toEqual(['Task A', 'A1', 'A1a', 'A2', 'Resource R', 'Will']);
    // From a person as the seed, the walk does go on.
    expect(run([step('replace', [will], 0, ALL)], g)).toEqual(['Will', 'Will\'s task']);
    // Tasks that use R: R's parents, but not on through them.
    expect(run([step('replace', [r], ALL, 0)], g)).toEqual(['Task A', 'A1', 'Task B', 'B1', 'Resource R']);
  });

  it('walks through nodes outside the base, but only returns the base', () => {
    const base = all(nodes.filter((n) => n !== a1));
    expect(run([step('replace', [a], 0, ALL)], graph(), base)).toEqual(['Task A', 'A1a', 'A2', 'Resource R']);
  });

  it('follows only the walk edges', () => {
    const g = { ...graph(), walk: edges.filter((e) => e.kind === 'needs') };
    expect(run([step('replace', [a], 0, ALL)], g)).toEqual(['Task A', 'A1', 'A1a', 'A2']);
  });

  it('re-applies to a changed graph: new subtasks join, deleted seeds drop out', () => {
    const s = [step('replace', [a], 0, ALL)];
    const a3 = node('A3');
    expect(run(s, graph([...nodes, a3], [...edges, edge(a, 'needs', a3)]))).toContain('A3');
    expect(run(s, graph(nodes.filter((n) => n !== a)))).toEqual([]);
  });

  it('a task-state seed is read afresh', () => {
    const yours: Step = { id: 'y', op: 'replace', seed: { type: 'state', states: ['yours'] }, reach: { up: 0, down: 0 }, on: true };
    expect(run([yours])).toEqual([]);
    expect(run([yours], graph(nodes, [...edges, edge(a2, 'waits_on', you)]))).toEqual(['A2']);
    const ready: Step = { ...yours, seed: { type: 'state', states: ['ready'] } };
    expect(run([ready])).toEqual(['A1a', 'A2', 'B1']);
  });
});

describe('stepLabel', () => {
  const byId = graph().byId;
  it('names the op, seed, and reach', () => {
    expect(stepLabel(step('intersect', [a], 0, ALL), byId)).toBe('Keep only Task A + all children');
    expect(stepLabel(step('replace', [a1], 2, 1), byId)).toBe('Show A1 + 2 levels of parents + 1 level of children');
    expect(stepLabel(step('subtract', [a, b]), byId)).toBe('Hide 2 nodes');
    expect(stepLabel({ ...step('union', []), seed: { type: 'state', states: ['yours'] } }, byId)).toBe('Add yours tasks');
  });
  it('says when seeds are gone', () => {
    const gone = node('Gone');
    expect(stepLabel(step('replace', [gone]), byId)).toBe('Show (gone)');
    expect(stepLabel(step('replace', [a, gone]), byId)).toBe('Show 2 nodes (1 gone)');
  });
});

describe('centre and stepsKey', () => {
  it('centres on the last Show step that is on', () => {
    expect(centre([step('replace', [a]), step('replace', [b]), step('replace', [r], 0, 0, false)], graph())).toBe(b.id);
    expect(centre([step('union', [a])], graph())).toBeNull();
  });
  it('keys only the steps that are on, not their ids', () => {
    expect(stepsKey([step('replace', [a])])).toBe(stepsKey([step('replace', [a]), step('union', [b], 0, 0, false)]));
    expect(stepsKey([step('replace', [a])])).not.toBe(stepsKey([step('replace', [a], 0, 1)]));
  });
});

describe('parseSteps and focusStep', () => {
  it('keeps valid steps and drops the rest', () => {
    const good = step('replace', [a], 0, ALL);
    expect(parseSteps(JSON.stringify([good, { ...good, op: 'nope' }, { ...good, seed: { type: 'state', states: ['bogus'] } }, 7]))).toEqual([good]);
    expect(parseSteps('not json')).toEqual([]);
    expect(parseSteps(null)).toEqual([]);
  });
  it('turns the old focus into a Show step', () => {
    expect(focusStep('s', a.id).reach).toEqual({ up: 0, down: ALL });
    expect(focusStep('s', a.id, 'up', 2).reach).toEqual({ up: 2, down: 0 });
    expect(focusStep('s', a.id, 'both').reach).toEqual({ up: ALL, down: ALL });
  });
});

describe('history', () => {
  it('records, goes back and forward, and a new change drops the future', () => {
    const s1 = [step('replace', [a])];
    const s2 = [step('replace', [b])];
    let h = record(record({ past: [], now: [], future: [] }, s1), s2);
    h = back(h);
    expect(h.now).toBe(s1);
    h = forward(h);
    expect(h.now).toBe(s2);
    h = record(back(h), []);
    expect(h.future).toEqual([]);
    expect(h.past).toEqual([[], s1]);
    expect(back({ past: [], now: s1, future: [] }).now).toBe(s1);
  });
});
