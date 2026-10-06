import { describe, expect, it } from 'vitest';
import type { EdgeKind, NodeKind } from '../shared/model';
import { layered, type LayoutEdge, type LayoutNode, radial, rankDir } from './layouts';
import { NODE_SIZE, type Pos } from './placement';

const n = (id: string, order: number, kind: NodeKind = 'task'): LayoutNode => ({ id, kind, order });
const e = (src: string, dst: string, kind: EdgeKind = 'needs'): LayoutEdge => ({ src, dst, kind });
const overlap = (a: Pos, b: Pos) => Math.abs(a.x - b.x) < NODE_SIZE.task.w && Math.abs(a.y - b.y) < NODE_SIZE.task.h;

/** Build a forest: node i's parents (things that need it) are parentOf(i). */
function forest(count: number, parentOf: (i: number) => number[], order: number[]) {
  const nodes = [...Array(count).keys()].map((i) => n(`n${i}`, order[i]!));
  const edges = [...Array(count).keys()].flatMap((i) => parentOf(i).map((p) => e(`n${p}`, `n${i}`)));
  return { nodes, edges };
}

describe('layered', () => {
  it('lays a fan of children out in sort order, top-down and left-right', async () => {
    for (const count of [7, 15]) {
      const order = [0, ...[...Array(count - 1).keys()].map((i) => ((i * 5) % (count - 1)) + 1)];
      const { nodes, edges } = forest(count, (i) => (i ? [0] : []), order);
      const { pos } = await layered(nodes, edges);
      const along = rankDir(count) === 'LR' ? 'y' : 'x';
      const kids = nodes.slice(1).sort((a, b) => pos.get(a.id)![along] - pos.get(b.id)![along]);
      expect(kids.map((k) => k.order)).toEqual([...Array(count - 1).keys()].map((i) => i + 1));
    }
  });

  it('puts what a task needs one rank past it', async () => {
    const { pos, flow } = await layered([n('a', 0), n('b', 1)], [e('a', 'b')]);
    expect(pos.get('b')!.y - pos.get('a')!.y).toBe(flow.y);
  });

  it('keeps leaf siblings in sort order in random forests, without overlaps', async () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 100; trial++) {
      const count = 4 + Math.floor(rnd() * 25);
      const order = [...Array(count).keys()].sort(() => rnd() - 0.5);
      const parents = [...Array(count).keys()].map((i) => (i && rnd() > 0.15 ? [Math.floor(rnd() * i)] : []));
      const { nodes, edges } = forest(count, (i) => parents[i]!, order);
      const { pos } = await layered(nodes, edges);
      const along = rankDir(count) === 'LR' ? 'y' : 'x';
      for (const p of nodes) {
        const leaves = nodes.filter((k) => parents[Number(k.id.slice(1))]!.includes(Number(p.id.slice(1))) && !parents.some((ps) => ps.includes(Number(k.id.slice(1)))));
        const seen = leaves.sort((a, b) => pos.get(a.id)![along] - pos.get(b.id)![along]).map((k) => k.order);
        expect(seen).toEqual([...seen].sort((a, b) => a - b));
      }
      for (const a of nodes) for (const b of nodes) if (a !== b) expect(overlap(pos.get(a.id)!, pos.get(b.id)!)).toBe(false);
    }
  });

  it('keeps people and resources out of the task ranks, in a lane level with their tasks', async () => {
    const nodes = [n('top', 0), n('mid', 1), n('low', 2), n('ann', 3, 'person'), n('repo', 4, 'resource')];
    const edges = [e('top', 'mid'), e('mid', 'low'), e('low', 'ann', 'involves'), e('top', 'repo', 'uses'), e('mid', 'repo', 'uses')];
    const { pos } = await layered(nodes, edges);
    const taskX = Math.max(...['top', 'mid', 'low'].map((id) => pos.get(id)!.x));
    expect(pos.get('ann')!.x).toBeGreaterThan(taskX);
    expect(pos.get('ann')!.y).toBe(pos.get('low')!.y);
    expect(pos.get('repo')!.y).toBe((pos.get('top')!.y + pos.get('mid')!.y) / 2);
    // Without the lane, `involves` would have pushed ann a rank below low; the tasks are three ranks apart as before.
    expect(pos.get('low')!.y - pos.get('top')!.y).toBe(2 * (NODE_SIZE.task.h + 90));
  });

  it('draws an org chart top down when no tasks are shown', async () => {
    const nodes = [n('boss', 0, 'person'), n('dev', 1, 'person'), n('crew', 2, 'team')];
    const { pos } = await layered(nodes, [e('dev', 'boss', 'reports_to'), e('dev', 'crew', 'member_of')]);
    expect(pos.get('boss')!.y).toBeLessThan(pos.get('dev')!.y);
    expect(pos.get('crew')!.y).toBeLessThan(pos.get('dev')!.y);
  });

  it('puts people with no tasks past the lane', async () => {
    const nodes = [n('t', 0), n('ann', 1, 'person'), n('boss', 2, 'person')];
    const { pos } = await layered(nodes, [e('t', 'ann', 'involves'), e('ann', 'boss', 'reports_to')]);
    expect(pos.get('boss')!.x).toBeGreaterThan(pos.get('ann')!.x);
  });
});

describe('radial', () => {
  const dist = (p: Pos) => Math.hypot(p.x, p.y);

  it('puts the focus in the middle and each step out on its own ring', () => {
    const nodes = [n('f', 0), n('a', 1), n('b', 2), n('c', 3), n('far', 4)];
    const { pos } = radial(nodes, [e('f', 'a'), e('f', 'b'), e('c', 'f'), e('a', 'far')], 'f');
    expect(pos.get('f')).toEqual({ x: 0, y: 0 });
    const r1 = ['a', 'b', 'c'].map((id) => dist(pos.get(id)!));
    expect(Math.max(...r1) - Math.min(...r1)).toBeLessThan(1e-6);
    expect(dist(pos.get('far')!)).toBeGreaterThan(r1[0]!);
  });

  it('centres on the tops without a focus, and puts unreachable nodes outside', () => {
    const nodes = [n('top', 0), n('kid', 1), n('alone', 2, 'person'), n('boss', 3, 'person'), n('dev', 4, 'person')];
    const { pos } = radial(nodes, [e('top', 'kid'), e('dev', 'boss', 'reports_to')], null);
    // tops: top, alone, boss (nothing above them); kid and dev a ring further out
    for (const id of ['kid', 'dev']) expect(dist(pos.get(id)!)).toBeGreaterThan(dist(pos.get('top')!));
  });

  it('never overlaps nodes, even crowded rings', () => {
    const nodes = [n('f', 0), ...[...Array(30).keys()].map((i) => n(`k${i}`, i + 1)), ...[...Array(40).keys()].map((i) => n(`g${i}`, i + 31))];
    const edges = [...[...Array(30).keys()].map((i) => e('f', `k${i}`)), ...[...Array(40).keys()].map((i) => e(`k${i % 30}`, `g${i}`))];
    const { pos } = radial(nodes, edges, 'f');
    const ps = [...pos.values()];
    for (const a of ps) for (const b of ps) if (a !== b) expect(overlap(a, b)).toBe(false);
  });
});
