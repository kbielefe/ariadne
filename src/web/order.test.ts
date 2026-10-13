import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '../shared/model';
import { isSort, sortNodes } from './order';

let seq = 0;
const node = (title: string, p: Partial<Node> = {}): Node => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  kind: 'task',
  title,
  body: '',
  status: 'open',
  attrs: {},
  version: 1,
  home: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...p,
});
const needs = (src: Node, dst: Node): Edge => ({ id: `${src.id}>${dst.id}`, src: src.id, kind: 'needs', dst: dst.id, note: '', createdAt: '' });

describe('sortNodes', () => {
  const a = node('Bravo', { createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' });
  const b = node('Alpha', { createdAt: '2026-01-03T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' });
  const c = node('Charlie', { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z' });
  const done = node('Delta', { status: 'done' });
  const person = node('Echo', { kind: 'person', status: null });
  const all = [done, person, c, b, a];
  const byId = new Map(all.map((n) => [n.id, n]));
  const edges = [needs(a, c)]; // a waits on c
  const titles = (s: Parameters<typeof sortNodes>[1]) => sortNodes(all, s, edges, byId).map((n) => n.title);

  it('ready first: ready tasks, waiting tasks, other kinds, closed; ties by title', () => {
    expect(titles('ready')).toEqual(['Alpha', 'Charlie', 'Bravo', 'Echo', 'Delta']);
  });
  it('by creation, update, and title', () => {
    expect(titles('oldest')).toEqual(['Charlie', 'Delta', 'Echo', 'Bravo', 'Alpha']);
    expect(titles('newest')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']); // last three tie
    expect(titles('updated')).toEqual(['Charlie', 'Bravo', 'Alpha', 'Delta', 'Echo']);
    expect(titles('title')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
  });
  it('rejects unknown saved values', () => {
    expect(isSort('newest')).toBe(true);
    expect(isSort('status')).toBe(false);
    expect(isSort('toString')).toBe(false);
  });
});
