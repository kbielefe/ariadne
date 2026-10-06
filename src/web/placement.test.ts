import { describe, expect, it } from 'vitest';
import { placeNew, type Pos } from './placement';

const size = () => ({ w: 180, h: 52 });
const down = { x: 0, y: 142 };
const apart = (a: Pos, b: Pos) => Math.abs(a.x - b.x) >= 180 || Math.abs(a.y - b.y) >= 52;

describe('placeNew', () => {
  it('leaves placed nodes alone and only returns new ones', () => {
    const pos = new Map([['a', { x: 0, y: 0 }]]);
    const out = placeNew(['a', 'b'], [{ src: 'a', dst: 'b' }], pos, size, down);
    expect([...out.keys()]).toEqual(['b']);
    expect(pos.get('a')).toEqual({ x: 0, y: 0 });
  });

  it('puts what a node needs one step down, and what needs it one step up', () => {
    const pos = new Map([['a', { x: 0, y: 0 }]]);
    const out = placeNew(['a', 'kid', 'boss'], [{ src: 'a', dst: 'kid' }, { src: 'boss', dst: 'a' }], pos, size, down);
    expect(out.get('kid')).toEqual({ x: 0, y: 142 });
    expect(out.get('boss')).toEqual({ x: 0, y: -142 });
  });

  it('slides sideways to the nearest free spot instead of overlapping', () => {
    const pos = new Map([
      ['a', { x: 0, y: 0 }],
      ['k1', { x: 0, y: 142 }],
    ]);
    const out = placeNew(['k2', 'k3'], [{ src: 'a', dst: 'k2' }, { src: 'a', dst: 'k3' }], pos, size, down);
    const all = [...pos.values(), ...out.values()];
    for (const p of all) for (const q of all) if (p !== q) expect(apart(p, q)).toBe(true);
    expect(out.get('k2')!.y).toBe(142);
    expect(out.get('k3')!.y).toBe(142);
  });

  it('grows chains of new nodes outward, and puts unconnected ones past everything', () => {
    const pos = new Map([['a', { x: 0, y: 0 }]]);
    const out = placeNew(['c', 'b', 'lone'], [{ src: 'a', dst: 'b' }, { src: 'b', dst: 'c' }], pos, size, down);
    expect(out.get('b')!.y).toBe(142);
    expect(out.get('c')!.y).toBe(284);
    expect(out.get('lone')!.y).toBeGreaterThan(284);
  });

  it('works sideways too (left to right)', () => {
    const out = placeNew(['b'], [{ src: 'a', dst: 'b' }], new Map([['a', { x: 0, y: 0 }]]), size, { x: 270, y: 0 });
    expect(out.get('b')).toEqual({ x: 270, y: 0 });
  });
});
