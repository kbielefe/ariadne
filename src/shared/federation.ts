// What a share contains, and the addresses peers dial. No I/O.
import { reachable } from './graph';
import { type Edge, type Node, USER_ID } from './model';

/** Walk out from the root. `You` is never shared; edges that touched it point at this instance's person instead. */
export function shareView(nodes: readonly Node[], edges: readonly Edge[], rootId: string, selfPersonId: string | null): { nodes: Node[]; edges: Edge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rewritten: Edge[] = [];
  for (const e of edges) {
    if (e.src !== USER_ID && e.dst !== USER_ID) {
      rewritten.push(e);
      continue;
    }
    if (!selfPersonId) continue;
    const src = e.src === USER_ID ? selfPersonId : e.src;
    const dst = e.dst === USER_ID ? selfPersonId : e.dst;
    if (src !== dst) rewritten.push({ ...e, src, dst });
  }
  const ids = reachable(rewritten, rootId, { direction: 'down' });
  ids.delete(USER_ID);
  const keep = new Set([...ids.keys()].filter((id) => (id !== rootId ? byId.has(id) || id === selfPersonId : true)));
  const outNodes = [...keep].map((id) => byId.get(id)).filter((n): n is Node => !!n && n.id !== USER_ID);
  const outEdges = rewritten.filter((e) => keep.has(e.src) && keep.has(e.dst) && e.src !== USER_ID && e.dst !== USER_ID);
  return { nodes: outNodes, edges: outEdges };
}

/** Stable bytes for signatures. Key order does not matter on the way in. */
export function canonical(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(sortKeys(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A WebSocket URL this instance can be reached on, as a libp2p multiaddr.
 * `https://host` and `wss://host/p2p` both become a `tls/ws` address, so a
 * cloudflared tunnel in front of the HTTP server can carry the connection.
 */
export function urlToMultiaddr(url: string, peerId: string): string {
  const u = new URL(url);
  const secure = u.protocol === 'wss:' || u.protocol === 'https:';
  const port = u.port || (secure ? '443' : '80');
  const host = u.hostname;
  const base = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? `/ip4/${host}` : `/dns4/${host}`;
  const path = u.pathname.replace(/^\/+|\/+$/g, '');
  const httpPath = path ? `/http-path/${path}` : '';
  return `${base}/tcp/${port}${secure ? '/tls/ws' : '/ws'}${httpPath}/p2p/${peerId}`;
}

/** Public site origin plus the `/p2p` path Fastify proxies to the WebSocket listener. */
export function publicMultiaddr(origin: string, peerId: string): string {
  const u = new URL(origin);
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  u.pathname = '/p2p';
  u.search = '';
  u.hash = '';
  return urlToMultiaddr(u.toString(), peerId);
}
