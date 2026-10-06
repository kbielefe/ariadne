import { describe, expect, it } from 'vitest';
import { type Body, nudgeStep } from './nudge';

const body = (x: number, y: number): Body => ({ x, y, w: 180, h: 52, vx: 0, vy: 0 });
const settle = (bodies: Map<string, Body>, edges: { src: string; dst: string }[], held: string) => {
  for (let i = 0; i < 400; i++) if (nudgeStep(bodies, edges, held, { edge: 180 }).most < 0.05) break;
};
const collide = (a: Body, b: Body) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

describe('nudgeStep', () => {
  it('pulls a linked node along after the held one', () => {
    const bodies = new Map([
      ['held', body(1000, 0)],
      ['kid', body(0, 0)],
    ]);
    settle(bodies, [{ src: 'held', dst: 'kid' }], 'held');
    const d = Math.abs(bodies.get('kid')!.x - 1000);
    expect(d).toBeGreaterThan(180);
    expect(d).toBeLessThan(400);
    expect(bodies.get('held')!.x).toBe(1000);
  });

  it('pushes what it bumps, and that pushes the next one along', () => {
    const bodies = new Map([
      ['held', body(0, 0)],
      ['a', body(100, 0)],
      ['b', body(300, 0)],
      ['far', body(3000, 3000)],
    ]);
    settle(bodies, [], 'held');
    const all = [...bodies.values()];
    for (const p of all) for (const q of all) if (p !== q) expect(collide(p, q)).toBe(false);
    expect(bodies.get('far')).toMatchObject({ x: 3000, y: 3000 });
  });

  it('leaves untouched, unlinked nodes alone', () => {
    const bodies = new Map([
      ['held', body(0, 0)],
      ['kid', body(250, 0)],
      ['near', body(0, 200)],
    ]);
    settle(bodies, [{ src: 'held', dst: 'kid' }], 'held');
    expect(bodies.get('near')).toMatchObject({ x: 0, y: 200 });
  });
});
