import { describe, expect, it } from 'vitest';
import { publicMultiaddr, shareView, urlToMultiaddr } from './federation';
import type { Edge, Node } from './model';
import { USER_ID } from './model';

const node = (id: string, title: string, kind: Node['kind'] = 'task'): Node => ({
  id,
  kind,
  title,
  body: '',
  status: kind === 'task' ? 'open' : null,
  attrs: {},
  version: 1,
  home: 'peer-a',
  createdAt: '',
  updatedAt: '',
});
const edge = (src: string, dst: string, kind: Edge['kind'] = 'needs'): Edge => ({ id: `${src}>${dst}`, src, kind, dst, note: '', createdAt: '' });

describe('shareView', () => {
  it('walks out from the root and leaves inbound tasks behind', () => {
    const root = node('r', 'root');
    const child = node('c', 'child');
    const other = node('o', 'other');
    const view = shareView([root, child, other], [edge('r', 'c'), edge('o', 'r')], 'r', null);
    expect(view.nodes.map((n) => n.id).sort()).toEqual(['c', 'r']);
    expect(view.edges).toHaveLength(1);
  });

  it('never includes You, and rewrites an edge to You onto this instance', () => {
    const root = node('r', 'root');
    const me = node(USER_ID, 'You', 'person');
    const self = node('self', 'This Ariadne', 'person');
    const involves = edge('r', USER_ID, 'involves');
    involves.id = 'edge-1';
    const view = shareView([root, me, self], [involves], 'r', 'self');
    expect(view.nodes.map((n) => n.id)).not.toContain(USER_ID);
    expect(view.edges[0]).toMatchObject({ src: 'r', dst: 'self' });
    expect(JSON.stringify(view)).not.toContain(USER_ID);
  });
});

describe('urlToMultiaddr', () => {
  const peer = '12D3KooWexample';
  it('turns an https origin into the wss path a cloudflared tunnel serves', () => {
    expect(publicMultiaddr('https://ariadne.example.com', peer)).toBe(`/dns4/ariadne.example.com/tcp/443/tls/ws/http-path/p2p/p2p/${peer}`);
  });
  it('keeps a LAN ws address on its port', () => {
    expect(urlToMultiaddr('ws://10.1.1.5:3100/p2p', peer)).toBe(`/ip4/10.1.1.5/tcp/3100/ws/http-path/p2p/p2p/${peer}`);
  });
});
