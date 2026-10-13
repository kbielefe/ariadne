// WebSocket libp2p host. Cloudflared tunnels HTTP upgrades, so this never listens on raw TCP.
import { noise } from '@chainsafe/libp2p-noise';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import type { Connection, PeerId, Stream } from '@libp2p/interface';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { webSockets } from '@libp2p/websockets';
import { yamux } from '@libp2p/yamux';
import { createLibp2p, type Libp2p } from 'libp2p';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { frames } from './codec';

/**
 * `@libp2p/websockets` refuses a multiaddr that carries `/http-path`, which is how a
 * cloudflared hostname exposes `/p2p`. The bytes are still a WebSocket; keep those addresses.
 */
/** Circuit Relay v2's matcher also ignores `/http-path`, so a relay reached at `/p2p` would be undialable. */
function circuitAllowingPath() {
  return (components: unknown) => {
    const transport = circuitRelayTransport()(components as never);
    const inner = transport.dialFilter.bind(transport);
    transport.dialFilter = (addrs: Multiaddr[]) => {
      const list = Array.isArray(addrs) ? addrs : [addrs];
      const kept = inner(list);
      const extra = list.filter((ma) => {
        const s = ma.toString();
        return s.includes('/p2p-circuit') && s.includes('/http-path/') && !kept.some((k) => k.equals(ma));
      });
      return [...kept, ...extra];
    };
    return transport;
  };
}

function webSocketsAllowingPath() {
  return (components: unknown) => {
    const ws = webSockets()(components as never);
    const inner = ws.dialFilter.bind(ws);
    ws.dialFilter = (addrs: Multiaddr[]) => {
      const kept = inner(addrs);
      const extra = addrs.filter((ma) => {
        const s = ma.toString();
        return s.includes('/ws') && s.includes('/http-path/') && !s.includes('/p2p-circuit') && !kept.some((k) => k.equals(ma));
      });
      return [...kept, ...extra];
    };
    return ws;
  };
}
import type { Identity } from './identity';
import { CTL, PAIR, SPOOL, SYNC, type SyncMsg, type SyncReply } from './messages';

const STREAM = { runOnLimitedConnection: true as const };

export interface HostHooks {
  /** True if this peer may reserve, spool, or be relayed. */
  allowed(peerId: string): Promise<boolean>;
  pair(remote: string, token: string, addrs: string[], circuit: boolean, publicKey: Uint8Array): Promise<{ addrs: string[]; offersRelay: boolean }>;
  ticket(remote: string, hash: string, expires: string): Promise<void>;
  redeem(remote: string, token: string): Promise<void>;
  spoolPut(remote: string, to: string, blob: Uint8Array): Promise<void>;
  spoolPull(remote: string): Promise<{ id: string; from: string; body: string }[]>;
  spoolAck(remote: string, ids: string[]): Promise<void>;
  sync(remote: string, msg: SyncMsg): Promise<SyncReply>;
}

export interface HostOptions {
  identity: Identity;
  /** Bind a WebSocket. C, which accepts nothing, leaves this unset and only dials. */
  listen?: { host: string; port: number };
  relay: 'off' | 'server' | 'client';
  hooks: HostHooks;
}

export class Host {
  private node!: Libp2p;
  private pingTimer?: NodeJS.Timeout;
  readonly announce: string[] = [];

  constructor(private readonly o: HostOptions) {}

  get peerId() {
    return this.o.identity.peerId;
  }

  get listenAddr(): string | null {
    const ma = this.node?.getMultiaddrs().find((a) => String(a).includes('/ws') && !String(a).includes('p2p-circuit'));
    return ma ? `${String(ma)}/p2p/${this.peerId}` : null;
  }

  async start(): Promise<void> {
    const listen: string[] = [];
    if (this.o.listen) listen.push(`/ip4/${this.o.listen.host}/tcp/${this.o.listen.port}/ws`);
    // A reservation is how a peer with no public port receives relayed connections.
    if (this.o.relay === 'client') listen.push('/p2p-circuit');
    this.node = await createLibp2p({
      privateKey: this.o.identity.key,
      addresses: { listen },
      transports: [webSocketsAllowingPath(), circuitAllowingPath()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: {
        // LAN addresses are private. The default gater would refuse them.
        denyDialMultiaddr: async () => false,
        denyInboundRelayReservation: async (peer: PeerId) => !(await this.o.hooks.allowed(peer.toString())),
        denyOutboundRelayedConnection: async (source: PeerId, dest: PeerId) => {
          const ok = await this.o.hooks.allowed(source.toString());
          const okDest = await this.o.hooks.allowed(dest.toString());
          return !ok || !okDest;
        },
      },
      services: {
        identify: identify(),
        ping: ping({ runOnLimitedConnection: true }),
        ...(this.o.relay === 'server'
          ? {
              relay: circuitRelayServer({
                reservations: {
                  maxReservations: 32,
                  // Snapshots are larger than the 128KiB default cap.
                  defaultDataLimit: 32n * 1024n * 1024n,
                  // Seconds. The relay multiplies this by 1000 when it arms the limit.
                  defaultDurationLimit: 24 * 60 * 60,
                },
              }),
            }
          : {}),
      },
    });
    await this.serve();
    // Cloudflared closes quiet WebSockets. A ping keeps the tunnel, and the reservation, up.
    this.pingTimer = setInterval(() => {
      const ping = this.node.services.ping as { ping(peer: PeerId): Promise<unknown> };
      for (const peer of this.node.getPeers()) void ping.ping(peer).catch(() => {});
    }, 25_000);
    this.pingTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.node) await this.node.stop();
  }

  async dial(addrs: string[]): Promise<Connection> {
    let last: unknown;
    for (const addr of addrs) {
      try {
        return await this.node.dial(multiaddr(addr), { signal: AbortSignal.timeout(5_000) });
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new Error('dial failed');
  }

  /** Dial `target` through a relay. The target must already hold a reservation there. */
  async dialCircuit(relayAddrs: string[], target: string): Promise<Connection> {
    let last: unknown;
    for (const addr of relayAddrs) {
      try {
        const ma: Multiaddr = multiaddr(addr).encapsulate(`/p2p-circuit/p2p/${target}`);
        return await this.node.dial(ma, { signal: AbortSignal.timeout(8_000) });
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new Error('relay dial failed');
  }

  /** Wait until this node has a reservation, which is what makes it dialable through the relay. */
  async waitReservation(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 8_000) {
      if (this.node.getMultiaddrs().some((a) => String(a).includes('/p2p-circuit/'))) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error('relay did not grant a reservation');
  }

  async rpc(conn: Connection, protocol: string, msg: unknown): Promise<unknown> {
    const stream = await conn.newStream(protocol, STREAM);
    const io = frames(stream);
    await io.send(msg);
    const reply = await Promise.race([
      io.recv(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${protocol} timed out`)), 8_000)),
    ]);
    await stream.close().catch(() => {});
    return reply;
  }

  private async serve(): Promise<void> {
    const remoteOf = (conn: Connection) => conn.remotePeer.toString();
    const circuit = (conn: Connection) => String(conn.remoteAddr).includes('p2p-circuit');
    await this.node.handle(PAIR, (stream, conn) => this.answer(stream, conn, async (msg) => {
      const m = msg as { token?: string; addrs?: string[] };
      const key = publicKeyBytes(conn.remotePeer);
      return { t: 'paired', ...(await this.o.hooks.pair(remoteOf(conn), m.token ?? '', m.addrs ?? [], circuit(conn), key)) };
    }), STREAM);
    await this.node.handle(CTL, (stream, conn) => this.answer(stream, conn, async (msg) => {
      const m = msg as { t?: string; hash?: string; expires?: string; token?: string };
      if (m.t === 'ticket') await this.o.hooks.ticket(remoteOf(conn), m.hash ?? '', m.expires ?? '');
      else if (m.t === 'redeem') await this.o.hooks.redeem(remoteOf(conn), m.token ?? '');
      else throw new Error('unknown relay message');
      return { t: 'ok' };
    }), STREAM);
    await this.node.handle(SPOOL, (stream, conn) => this.answer(stream, conn, async (msg) => {
      const m = msg as { t?: string; to?: string; body?: string; ids?: string[] };
      const remote = remoteOf(conn);
      if (m.t === 'put') {
        await this.o.hooks.spoolPut(remote, m.to ?? '', Buffer.from(m.body ?? '', 'base64'));
        return { t: 'ok' };
      }
      if (m.t === 'pull') return { t: 'frames', frames: await this.o.hooks.spoolPull(remote) };
      if (m.t === 'ack') {
        await this.o.hooks.spoolAck(remote, m.ids ?? []);
        return { t: 'ok' };
      }
      throw new Error('unknown spool message');
    }), STREAM);
    await this.node.handle(SYNC, (stream, conn) => this.answer(stream, conn, async (msg) => ({ t: 'sync-ok', ...(await this.o.hooks.sync(remoteOf(conn), msg as SyncMsg)) })), STREAM);
  }

  private async answer(stream: Stream, _conn: Connection, fn: (msg: unknown) => Promise<unknown>): Promise<void> {
    const io = frames(stream);
    try {
      const msg = await io.recv();
      await io.send(await fn(msg));
    } catch (err) {
      await io.send({ t: 'err', error: err instanceof Error ? err.message : String(err) }).catch(() => {});
    }
  }
}

/** Ed25519 peer ids carry the public key. Some libp2p versions expose it as `.raw`, some as the bytes themselves. */
function publicKeyBytes(peer: PeerId): Uint8Array {
  const pk = (peer as { publicKey?: { raw?: Uint8Array } | Uint8Array }).publicKey;
  if (pk instanceof Uint8Array) return pk;
  if (pk && pk.raw instanceof Uint8Array) return pk.raw;
  return new Uint8Array();
}
