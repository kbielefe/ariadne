import { describe, expect, it } from 'vitest';
import { impacts, readiness } from './graph';
import type { Edge, Node, TaskStatus } from './model';

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

describe('readiness', () => {
  it('a task that waits_on someone is blocked, not ready, even with nothing open it needs', () => {
    const byId = tasks({ w: 'open', done: 'done' });
    const edges = [needs('w', 'done'), { ...needs('w', 'ann'), kind: 'waits_on' as const }];
    expect(readiness(byId.get('w')!, edges, byId)).toEqual({ ready: false, waitingOn: [], external: ['ann'] });
    expect(readiness(byId.get('w')!, [needs('w', 'done')], byId)).toEqual({ ready: true, waitingOn: [], external: [] });
  });
});
