import { describe, expect, it } from 'vitest';
import { impacts, reachable, readiness, skipEdges, taskState } from './graph';
import { type Edge, type Node, type TaskStatus, USER_ID } from './model';

const needs = (src: string, dst: string): Edge => ({ id: `${src}>${dst}`, src, kind: 'needs', dst, note: '', createdAt: '' });
const tasks = (statuses: Record<string, TaskStatus>) =>
  new Map(Object.entries(statuses).map(([id, status]) => [id, { id, kind: 'task', status } as Node]));

describe('impacts', () => {
  it('counts distinct tasks that transitively need each task, not itself', () => {
    // a needs b and c; b and c both need d; d needs e. Diamond: d counts a once.
    const edges = [needs('a', 'b'), needs('a', 'c'), needs('b', 'd'), needs('c', 'd'), needs('d', 'e'), { ...needs('a', 'p'), kind: 'involves' as const }];
    const m = impacts(edges, tasks({ a: 'open', b: 'open', c: 'open', d: 'open', e: 'open' }));
    expect(Object.fromEntries(m)).toEqual({ a: 0, b: 1, c: 1, d: 3, e: 4 });
  });

  it('does not count done or dropped tasks, but counts the open tasks that need them', () => {
    // a (open) needs b (done) needs c (dropped) needs d.
    const m = impacts([needs('a', 'b'), needs('b', 'c'), needs('c', 'd')], tasks({ a: 'open', b: 'done', c: 'dropped', d: 'open' }));
    expect(Object.fromEntries(m)).toEqual({ a: 0, b: 1, c: 1, d: 1 });
  });

  it('counts a task once when it is reached by several paths, including through closed tasks', () => {
    // a needs b, c, and d directly; b (done) and c (dropped) also need d. Three paths from a to d.
    const edges = [needs('a', 'b'), needs('a', 'c'), needs('a', 'd'), needs('b', 'd'), needs('c', 'd')];
    const m = impacts(edges, tasks({ a: 'open', b: 'done', c: 'dropped', d: 'open' }));
    expect(m.get('d')).toBe(1);
  });

  it('has no entry for tasks without needs edges (callers treat them as 0)', () => {
    expect(impacts([], new Map()).size).toBe(0);
  });
});

describe('skipEdges', () => {
  const ids = (es: Edge[]) => es.map((e) => e.id).sort();
  const covers = (edges: Edge[], removed: string[]) => {
    const gone = skipEdges(edges);
    expect(ids(gone)).toEqual([...removed].sort());
    const keep = edges.filter((e) => !gone.includes(e));
    for (const e of gone) expect(reachable(keep, e.src, { kinds: ['needs'] }).has(e.dst)).toBe(true);
    expect(skipEdges(keep)).toEqual([]);
  };

  it('drops A → C when A → B → C already connects them', () => {
    covers([needs('a', 'b'), needs('b', 'c'), needs('a', 'c')], ['a>c']);
  });

  it('drops a shortcut along a path longer than two', () => {
    covers([needs('a', 'b'), needs('b', 'c'), needs('c', 'd'), needs('a', 'd')], ['a>d']);
  });

  it('drops every shortcut on a chain and leaves the chain', () => {
    covers([needs('a', 'b'), needs('b', 'c'), needs('c', 'd'), needs('a', 'c'), needs('a', 'd'), needs('b', 'd')], ['a>c', 'a>d', 'b>d']);
  });

  it('drops the chord of a diamond and keeps both branches', () => {
    covers([needs('a', 'b'), needs('a', 'c'), needs('b', 'd'), needs('c', 'd'), needs('a', 'd')], ['a>d']);
  });

  it('keeps a single edge and two parents of one child', () => {
    expect(skipEdges([needs('a', 'b')])).toEqual([]);
    expect(skipEdges([needs('a', 'c'), needs('b', 'c')])).toEqual([]);
  });

  it('does not treat another edge kind as a needs path', () => {
    const involves: Edge = { ...needs('a', 'c'), id: 'involve', kind: 'involves' };
    const edges = [needs('a', 'b'), needs('b', 'c'), needs('a', 'c'), involves];
    expect(ids(skipEdges(edges))).toEqual(['a>c']);
    expect(skipEdges(edges, 'involves')).toEqual([]);
  });
});

describe('readiness', () => {
  it('a task that waits_on someone is blocked, not ready, even with nothing open it needs', () => {
    const byId = tasks({ w: 'open', done: 'done' });
    const edges = [needs('w', 'done'), { ...needs('w', 'ann'), kind: 'waits_on' as const }];
    expect(readiness(byId.get('w')!, edges, byId)).toEqual({ ready: false, waitingOn: [], external: ['ann'], theirs: [] });
    expect(readiness(byId.get('w')!, [needs('w', 'done')], byId)).toEqual({ ready: true, waitingOn: [], external: [], theirs: [] });
  });
});

describe('taskState', () => {
  const waitsOn = (src: string, dst: string): Edge => ({ ...needs(src, dst), kind: 'waits_on' });
  const state = (edges: Edge[], statuses: Record<string, TaskStatus> = { t: 'open', sub: 'open', done: 'done' }) => {
    const byId = tasks(statuses);
    return taskState(readiness(byId.get('t')!, edges, byId));
  };

  it('ready: nothing open below and no waits_on, so an agent can take it', () => {
    expect(state([needs('t', 'done')])).toBe('ready');
  });

  it('yours: waits only on You', () => {
    expect(state([waitsOn('t', USER_ID)])).toBe('yours');
  });

  it('blocked: waits on anyone else, even when it also waits on You', () => {
    expect(state([waitsOn('t', 'ann')])).toBe('blocked');
    expect(state([waitsOn('t', 'ann'), waitsOn('t', USER_ID)])).toBe('blocked');
  });

  it('waiting: open subtasks come before your turn', () => {
    expect(state([needs('t', 'sub')])).toBe('waiting');
    expect(state([needs('t', 'sub'), waitsOn('t', USER_ID)])).toBe('waiting');
  });

  it('theirs: someone else is working on it, so it is never ready for you, whatever else it waits on', () => {
    const workingOn = (src: string, dst: string): Edge => ({ ...needs(src, dst), kind: 'working_on' });
    expect(state([workingOn('will', 't')])).toBe('theirs');
    expect(state([workingOn('will', 't'), needs('t', 'sub'), waitsOn('t', 'ann')])).toBe('theirs');
    // You working on it changes nothing.
    expect(state([workingOn(USER_ID, 't')])).toBe('ready');
  });
});
