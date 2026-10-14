import { describe, expect, it } from 'vitest';
import type { Node } from '../shared/model';
import { matchNodes } from './match';

const node = (title: string, body = '', status: Node['status'] = 'open') => ({ id: title, kind: 'task', title, body, status, attrs: {}, version: 1, createdAt: '', updatedAt: '' }) as Node;

describe('matchNodes', () => {
  it('puts title matches first, then body matches with the matching line', () => {
    const nodes = [node('Ship signing', 'later'), node('Release', 'Notes\n**Decision (Karl):** skip signing for now'), node('Old signing', '', 'done')];
    const m = matchNodes(nodes, 'signing');
    expect(m.map((x) => x.node.title)).toEqual(['Ship signing', 'Old signing', 'Release']);
    expect(m[2]).toMatchObject({ line: 'Decision (Karl): skip signing for now', decision: true });
    expect(m[0]!.line).toBeUndefined();
  });

  it('labels only decision lines as decisions', () => {
    const [m] = matchNodes([node('Release', 'We talked about **Decision** making')], 'talked');
    expect(m).toMatchObject({ decision: false });
  });
});
