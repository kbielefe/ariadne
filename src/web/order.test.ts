import cytoscape, { type ElementDefinition } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '../shared/model';
import { isSort, layoutOptions, orderLeafSiblings, rankDir, sortNodes } from './order';

cytoscape.use(dagre);

let seq = 0;
const node = (title: string, p: Partial<Node> = {}): Node => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
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

/** Lay out like the graph view does, headless. */
function layout(n: number, parentOf: (i: number) => number[], order: number[]) {
  const cy = cytoscape({ headless: true, styleEnabled: true, style: [{ selector: 'node', style: { width: 180, height: 52 } }] });
  const els: ElementDefinition[] = [];
  for (let i = 0; i < n; i++) els.push({ group: 'nodes', data: { id: `n${i}`, order: order[i] } });
  for (let i = 0; i < n; i++) for (const p of parentOf(i)) els.push({ group: 'edges', data: { id: `e${p}-${i}`, source: `n${p}`, target: `n${i}`, order: order[i] } });
  cy.add(els);
  cy.layout(layoutOptions(n)).run();
  orderLeafSiblings(cy.nodes(), rankDir(n));
  return cy;
}
const along = (cy: cytoscape.Core, id: string) => cy.$id(id).position(rankDir(cy.nodes().length) === 'LR' ? 'y' : 'x');

describe('layout order', () => {
  it('lays a fan of children out in sort order, top-down and left-right', () => {
    for (const n of [7, 15]) {
      const order = [0, ...[...Array(n - 1).keys()].map((i) => ((i * 5) % (n - 1)) + 1)];
      const cy = layout(n, (i) => (i ? [0] : []), order);
      const kids = cy.nodes().filter((x) => x.id() !== 'n0').map((x) => x.id()).sort((p, q) => along(cy, p) - along(cy, q));
      expect(kids.map((id) => cy.$id(id).data('order'))).toEqual([...Array(n - 1).keys()].map((i) => i + 1));
    }
  });

  it('keeps leaf siblings in sort order in random forests', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 200; trial++) {
      const n = 4 + Math.floor(rnd() * 25);
      const order = [...Array(n).keys()].sort(() => rnd() - 0.5);
      const parents = [...Array(n).keys()].map((i) => (i && rnd() > 0.15 ? [Math.floor(rnd() * i)] : []));
      const cy = layout(n, (i) => parents[i]!, order);
      cy.nodes().forEach((p) => {
        const leaves = p.outgoers('node').filter((k) => (k as cytoscape.NodeSingular).outgoers('node').empty()).map((k) => k.id());
        const seen = leaves.sort((x, y) => along(cy, x) - along(cy, y)).map((id) => cy.$id(id).data('order') as number);
        expect(seen).toEqual([...seen].sort((x, y) => x - y));
      });
    }
  });
});
