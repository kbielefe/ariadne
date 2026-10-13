// Shares, proposals, and the spool. The host moves bytes; this decides what they mean.
import { randomBytes, randomUUID } from 'node:crypto';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import type { Connection } from '@libp2p/interface';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { bytesEqual, canonical, publicMultiaddr, shareView, urlToMultiaddr } from '../../shared/federation';
import type { Edge, Node, Op } from '../../shared/model';
import { Ops, USER_ID } from '../../shared/model';
import type { Core } from '../core';
import type { Db } from '../db';
import { withTx } from '../db';
import type { Hub } from '../hub';
import { applyOps } from '../ops';
import { Conflict, Invalid, findNode, who, type Who } from '../store';
import { b64, unb64 } from './codec';
import { Host } from './host';
import { ident, loadIdentity, type Identity } from './identity';
import type { ProposalMsg, SignedEdge, SignedNode, Snap, Snapshot, SyncMsg, SyncReply } from './messages';
import { CTL, PAIR, SPOOL, SYNC } from './messages';
import * as repo from './repo';
import { openSeal, seal } from './seal';

export interface ApplyOutcome {
  results: { op: string; id: string; ref?: string }[];
  pending: { id: string; home: string; error?: string }[];
  nowReady: { id: string; title: string }[];
}

export interface FederationOptions {
  keyFile?: string;
  /** In tests, a key that already exists. */
  identity?: Identity;
  listen?: { host: string; port: number };
  relay: 'off' | 'server' | 'client';
  publicUrl?: string;
  lanUrl?: string;
}

const INVITE = 'ariadne1.';

export class Federation {
  core: Core | null = null;
  readonly host: Host;
  private personId: string | null = null;

  private constructor(
    readonly db: Db,
    readonly hub: Hub,
    readonly id: Identity,
    private readonly opt: FederationOptions,
  ) {
    this.host = new Host({
      identity: id,
      ...(opt.listen ? { listen: opt.listen } : {}),
      relay: opt.relay,
      hooks: {
        allowed: (peer) => this.allowed(peer),
        pair: (remote, token, addrs, circuit, publicKey) => this.onPair(remote, token, addrs, circuit, publicKey),
        ticket: (remote, hash, expires) => this.onTicket(remote, hash, expires),
        redeem: (remote, token) => this.onRedeem(remote, token),
        spoolPut: (remote, to, blob) => this.onSpoolPut(remote, to, blob),
        spoolPull: (remote) => this.onSpoolPull(remote),
        spoolAck: (remote, ids) => repo.spoolAck(db, remote, ids),
        sync: (remote, msg) => this.onSync(remote, msg),
      },
    });
  }

  static async start(db: Db, hub: Hub, opt: FederationOptions): Promise<Federation> {
    const id = opt.identity ?? (await loadIdentity(opt.keyFile ?? 'secrets/peer_key'));
    const fed = new Federation(db, hub, id, opt);
    await fed.host.start();
    await fed.claim();
    return fed;
  }

  get peerId() {
    return this.id.peerId;
  }

  /** Addresses we tell other people to dial, LAN first. */
  announce(): string[] {
    const out: string[] = [];
    if (this.opt.lanUrl) out.push(urlToMultiaddr(this.opt.lanUrl.includes('://') ? this.opt.lanUrl : `ws://${this.opt.lanUrl}/p2p`, this.peerId));
    if (this.opt.publicUrl) out.push(publicMultiaddr(this.opt.publicUrl, this.peerId));
    if (!out.length && this.host.listenAddr) out.push(this.host.listenAddr);
    return out;
  }

  async stop(): Promise<void> {
    await this.host.stop();
  }

  async claim(): Promise<void> {
    await this.db.query('UPDATE nodes SET home = $1 WHERE home IS NULL', [this.peerId]);
    const existing = await repo.selfPerson(this.db, this.peerId);
    if (existing) {
      this.personId = existing;
      return;
    }
    const node = await withTx(this.db, (tx) =>
      import('../store').then((s) => s.insertNode({ tx, who: who(null, 'sync'), home: this.peerId }, { kind: 'person', title: 'This Ariadne', attrs: { peer: this.peerId } })),
    );
    this.personId = node.id;
    this.hub.changed();
  }

  /**
   * `relay` when the other instance cannot dial this one (no public address, or it is off this LAN).
   * The invite then names the relay, and this instance takes a reservation there first.
   */
  async invite(via: 'direct' | 'relay' = 'direct'): Promise<string> {
    const token = randomBytes(24).toString('hex');
    const exp = new Date(Date.now() + 15 * 60 * 1000);
    await repo.insertInvite(this.db, token, exp);
    const relay = await this.relayPeer();
    const throughRelay = via === 'relay' || (!this.host.listenAddr && !!relay);
    if (throughRelay) {
      if (!relay) throw new Invalid('pair with a relay first');
      const conn = await this.host.dial(relay.addrs);
      await this.host.waitReservation();
      await this.host.rpc(conn, CTL, { t: 'ticket', hash: repo.sha256(token), expires: exp.toISOString() });
    }
    const body = { v: 1, peerId: this.peerId, token, exp: exp.toISOString(), dial: throughRelay && relay ? relay.addrs : this.announce(), relay: throughRelay };
    return INVITE + Buffer.from(JSON.stringify(body)).toString('base64url');
  }

  async accept(invite: string): Promise<void> {
    if (!invite.startsWith(INVITE)) throw new Invalid('not an Ariadne invite');
    const body = JSON.parse(Buffer.from(invite.slice(INVITE.length), 'base64url').toString()) as { peerId: string; token: string; dial: string[]; relay: boolean };
    let conn: Connection;
    if (body.relay) {
      const relay = await this.host.dial(body.dial);
      await this.host.rpc(relay, CTL, { t: 'redeem', token: body.token });
      // The first dial tried to reserve before the ticket was redeemed, and the relay refused.
      // Drop it and dial again so the reservation is requested now that we are allowed.
      await relay.close();
      await this.host.dial(body.dial);
      await this.host.waitReservation();
      conn = await this.host.dialCircuit(body.dial, body.peerId);
    } else conn = await this.host.dial(body.dial);
    const reply = (await this.host.rpc(conn, PAIR, { token: body.token, addrs: this.announce() })) as { t?: string; error?: string; offersRelay?: boolean; publicKey?: string; addrs?: string[] };
    if (reply.t === 'err') throw new Invalid(reply.error ?? 'pair failed');
    const publicKey = unb64(reply.publicKey ?? '');
    if (peerIdFromPublicKey(publicKeyFromRaw(publicKey)).toString() !== body.peerId) throw new Invalid('peer id does not match its key');
    await repo.upsertPeer(this.db, {
      peerId: body.peerId,
      publicKey,
      label: '',
      addrs: body.relay ? [] : body.dial,
      relay: body.relay ? body.dial : [],
      offersRelay: !!reply.offersRelay,
    });
  }

  async share(rootId: string, peerId: string): Promise<string> {
    if (rootId === USER_ID) throw new Invalid('You stays on this instance');
    const home = await repo.nodeHome(this.db, rootId);
    if (home !== this.peerId) throw new Invalid('only the home instance can share a node');
    if (!(await repo.getPeer(this.db, peerId))) throw new Invalid('pair with that peer first');
    const id = await repo.createShare(this.db, rootId, this.peerId, [this.peerId, peerId]);
    await this.publish(true);
    return id;
  }

  async status() {
    const [peers, shares, pending] = await Promise.all([repo.listPeers(this.db), repo.listShares(this.db), repo.pendingProposals(this.db)]);
    return { peerId: this.peerId, announce: this.announce(), listen: this.host.listenAddr, peers, shares, pending, selfPersonId: this.personId };
  }

  /** Local ops commit here. Ops on a node homed elsewhere are proposals. */
  async apply(w: Who, input: unknown): Promise<ApplyOutcome> {
    const ops = Ops.parse(input);
    const { local, foreign } = await this.classify(ops);
    let results: ApplyOutcome['results'] = [];
    let nowReady: ApplyOutcome['nowReady'] = [];
    if (local.length) {
      const closing = local.flatMap((op) => (op.op === 'update_node' && op.status && op.status !== 'open' && !op.id.startsWith('$') ? [op.id] : []));
      const out = await withTx(this.db, async (tx) => {
        const wasOpen = closing.length ? (await tx.query(`SELECT id FROM nodes WHERE id::text = ANY($1) AND status = 'open'`, [closing])).rows.map((r) => r.id as string) : [];
        const applied = await applyOps({ tx, who: w, home: this.peerId }, local);
        const ready = this.core ? await this.core.newlyReady(tx, wasOpen) : [];
        return { applied, ready };
      });
      results = out.applied;
      nowReady = out.ready;
      this.hub.changed();
    }
    const pending: ApplyOutcome['pending'] = [];
    for (const [home, hops] of foreign) {
      const id = randomUUID();
      const proposed = substitute(hops, results);
      await repo.insertProposal(this.db, id, home, proposed);
      const peer = await repo.getPeer(this.db, home);
      if (!peer) {
        pending.push({ id, home, error: 'not paired with that instance' });
        continue;
      }
      try {
        const reply = await this.syncPeer(peer);
        const mine = reply.results.find((r) => r.id === id);
        if (mine?.ok && mine.results) results = results.concat(mine.results);
        else {
          if (mine?.node) await withTx(this.db, (tx) => repo.upsertReplica(tx, this.peerId, mine.node!));
          pending.push({ id, home, ...(mine?.error ? { error: mine.error } : {}) });
        }
      } catch (err) {
        pending.push({ id, home, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (local.length) await this.publish(true);
    return { results, pending, nowReady };
  }

  async afterLocal(): Promise<void> {
    await this.publish(true);
  }

  /** Pull anything waiting on relays, renew our reservation, and sync every paired peer. */
  async sync(): Promise<void> {
    await this.flush();
  }

  async assertUndoable(changeset: string): Promise<void> {
    const rows = await this.db.query(`SELECT via, entity, entity_id FROM audit WHERE changeset = $1`, [changeset]);
    for (const row of rows.rows) {
      if (row.via !== 'sync' || row.entity !== 'node') continue;
      const home = await repo.nodeHome(this.db, row.entity_id as string);
      if (home && home !== this.peerId) throw new Invalid('That change is homed on another Ariadne. Undo it there.');
    }
  }

  // ---------------------------------------------------------------- sync

  private async publish(dial: boolean): Promise<void> {
    const shares = await repo.listShares(this.db);
    for (const share of shares) {
      if (share.rootHome !== this.peerId) continue;
      const snapshot = await this.buildSnapshot(share);
      const body = { snapshot };
      const prev = await repo.latestSnap(this.db, share.id);
      if (prev && bytesEqual(canonical((prev.body as { snapshot: Snapshot }).snapshot), canonical(snapshot))) continue;
      const seq = (prev?.seq ?? 0) + 1;
      const sig = await this.sign(binding(snapshot));
      await repo.appendLog(this.db, share.id, seq, this.peerId, body, sig);
    }
    if (dial) await this.flush();
  }

  private async flush(): Promise<void> {
    await this.ensureRelay();
    await this.pullSpools();
    for (const peer of await repo.listPeers(this.db)) {
      try {
        await this.syncPeer(peer);
      } catch {
        /* syncPeer spools when the dial fails; a second failure means the relay is down too */
      }
    }
  }

  private async syncPeer(peer: repo.PeerRow): Promise<SyncReply> {
    const msg = await this.outbound(peer.peerId);
    guard(msg);
    let conn: Connection;
    try {
      if (peer.addrs.length) {
        conn = await this.host.dial(peer.addrs);
        if (peer.offersRelay) await this.host.waitReservation();
      } else if (peer.relay.length) conn = await this.host.dialCircuit(peer.relay, peer.peerId);
      else throw new Error('no address');
    } catch {
      await this.spool(peer, msg);
      return { snaps: [], results: [] };
    }
    const reply = (await this.host.rpc(conn, SYNC, msg)) as { t?: string; error?: string } & SyncReply;
    if (reply.t === 'err') throw new Error(reply.error ?? 'sync failed');
    for (const snap of reply.snaps ?? []) await this.applySnap(snap);
    for (const result of reply.results ?? []) await repo.finishProposal(this.db, result.id, peer.peerId, result.ok ? 'committed' : 'rejected', result.error, result.results ?? null);
    return { snaps: reply.snaps ?? [], results: reply.results ?? [] };
  }

  private async onSync(remote: string, msg: SyncMsg): Promise<SyncReply> {
    guard(msg);
    for (const snap of msg.snaps ?? []) await this.applySnap(snap);
    await this.takeAttests(msg.attests ?? { nodes: [], edges: [] });
    const results = [];
    for (const proposal of msg.proposals ?? []) results.push(await this.takeProposal(remote, proposal));
    await this.publish(false);
    return { snaps: await this.snapsFor(remote), results };
  }

  private async outbound(peerId: string): Promise<SyncMsg> {
    const pending = await repo.pendingProposals(this.db, peerId);
    return { snaps: await this.snapsFor(peerId), attests: await this.attests(peerId), proposals: await this.attach(pending) };
  }

  private async snapsFor(peerId: string): Promise<Snap[]> {
    const out: Snap[] = [];
    for (const share of await repo.listShares(this.db)) {
      if (share.rootHome !== this.peerId || !share.members.includes(peerId)) continue;
      const latest = await repo.latestSnap(this.db, share.id);
      if (!latest) continue;
      const body = latest.body as { snapshot: Snapshot };
      out.push({ shareId: share.id, seq: latest.seq, rootId: share.rootId, rootHome: share.rootHome, members: share.members, snapshot: body.snapshot, sig: latest.signature });
    }
    return out;
  }

  private async buildSnapshot(share: repo.ShareRow): Promise<Snapshot> {
    const { nodes, edges } = await repo.graph(this.db);
    const view = shareView(nodes, edges, share.rootId, this.personId);
    const signedNodes: SignedNode[] = [];
    for (const node of view.nodes) {
      const signed = await this.signedNode(node);
      if (signed) signedNodes.push(signed);
    }
    const have = new Set(signedNodes.map((n) => n.node.id));
    const signedEdges: SignedEdge[] = [];
    for (const edge of view.edges) {
      if (!have.has(edge.src) || !have.has(edge.dst)) continue;
      const signed = await this.signedEdge(edge, nodes);
      if (signed) signedEdges.push(signed);
    }
    return { nodes: signedNodes, edges: signedEdges };
  }

  private async signedNode(node: Node): Promise<SignedNode | null> {
    const home = node.home ?? this.peerId;
    if (home === this.peerId) return { node: { ...node, home }, sig: await this.sign(canonical(node.home ? node : { ...node, home })) };
    const stored = await repo.loadSig(this.db, 'node', node.id, node.version);
    return stored ? { node: stored.payload as Node, sig: stored.signature } : null;
  }

  private async signedEdge(edge: Edge, nodes: Node[]): Promise<SignedEdge | null> {
    const src = nodes.find((n) => n.id === edge.src);
    const home = src?.home ?? this.peerId;
    if (home === this.peerId) return { edge, sig: await this.sign(canonical(edge)) };
    const stored = await repo.loadSig(this.db, 'edge', edge.id, 0);
    return stored ? { edge: stored.payload as Edge, sig: stored.signature } : null;
  }

  private async attests(peerId: string): Promise<SyncMsg['attests']> {
    const { nodes, edges } = await repo.graph(this.db);
    const nodesOut: SignedNode[] = [];
    const edgesOut: SignedEdge[] = [];
    for (const share of await repo.listShares(this.db)) {
      if (!share.members.includes(peerId) || share.rootHome === this.peerId) continue;
      const view = shareView(nodes, edges, share.rootId, this.personId);
      for (const node of view.nodes) if ((node.home ?? this.peerId) === this.peerId) nodesOut.push({ node: { ...node, home: this.peerId }, sig: await this.sign(canonical({ ...node, home: this.peerId })) });
      for (const edge of view.edges) {
        const src = nodes.find((n) => n.id === edge.src);
        if ((src?.home ?? this.peerId) === this.peerId) edgesOut.push({ edge, sig: await this.sign(canonical(edge)) });
      }
    }
    return { nodes: nodesOut, edges: edgesOut };
  }

  private async attach(pending: { id: string; home: string; ops: Op[] }[]): Promise<ProposalMsg[]> {
    const out: ProposalMsg[] = [];
    for (const p of pending) {
      const attachments: SignedNode[] = [];
      for (const op of p.ops) {
        if (op.op !== 'create_edge') continue;
        const dst = await findNode(this.db, op.dst);
        if (dst && (dst.home ?? this.peerId) === this.peerId) attachments.push({ node: { ...dst, home: this.peerId }, sig: await this.sign(canonical({ ...dst, home: this.peerId })) });
      }
      out.push({ id: p.id, ops: p.ops, attachments });
    }
    return out;
  }

  private async takeAttests(attests: SyncMsg['attests']): Promise<void> {
    for (const signed of attests.nodes) {
      await this.verifyNode(signed);
      await repo.saveSig(this.db, 'node', signed.node.id, signed.node.version, signed.node.home ?? '', signed.node, signed.sig);
      await withTx(this.db, (tx) => repo.upsertReplica(tx, this.peerId, signed.node));
    }
    for (const signed of attests.edges) {
      await this.verifyEdge(signed);
      await repo.saveSig(this.db, 'edge', signed.edge.id, 0, '', signed.edge, signed.sig);
    }
    if (attests.nodes.length) this.hub.changed();
  }

  private async takeProposal(from: string, proposal: ProposalMsg): Promise<SyncReply['results'][number]> {
    const seen = await this.db.query('SELECT status, result FROM proposals WHERE id = $1', [proposal.id]);
    if (seen.rows[0]?.status === 'committed') return { id: proposal.id, ok: true, results: (seen.rows[0].result as ApplyOutcome['results']) ?? [] };
    const shares = (await repo.listShares(this.db)).filter((s) => s.members.includes(from) && s.members.includes(this.peerId));
    if (!shares.length) return { id: proposal.id, ok: false, error: 'not a member of a share' };
    try {
      for (const attachment of proposal.attachments) await this.verifyNode(attachment);
      const { nodes, edges } = await repo.graph(this.db);
      const sharedIds = new Set(shares.flatMap((s) => [...shareView(nodes, edges, s.rootId, this.personId).nodes.map((n) => n.id)]));
      for (const op of proposal.ops) {
        if (op.op === 'update_node' || op.op === 'delete_node') {
          if (!sharedIds.has(op.id)) throw new Invalid('that node is not in a share with you');
          const home = await repo.nodeHome(this.db, op.id);
          if (home && home !== this.peerId) throw new Invalid('that node is homed elsewhere');
        } else if (op.op === 'create_edge') {
          if (!sharedIds.has(op.src)) throw new Invalid('the edge source is not in a share with you');
        } else throw new Invalid('propose a change to an existing shared node');
      }
      const results = await withTx(this.db, async (tx) => {
        for (const attachment of proposal.attachments) {
          await repo.saveSig(tx, 'node', attachment.node.id, attachment.node.version, attachment.node.home ?? from, attachment.node, attachment.sig);
          await repo.upsertReplica(tx, this.peerId, attachment.node);
        }
        return applyOps({ tx, who: who(null, 'sync'), home: this.peerId }, proposal.ops);
      });
      await repo.finishProposal(this.db, proposal.id, this.peerId, 'committed', undefined, results);
      this.hub.changed();
      return { id: proposal.id, ok: true, results };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let node: Node | undefined;
      const update = proposal.ops.find((op) => op.op === 'update_node');
      if (err instanceof Conflict && update && update.op === 'update_node') node = (await findNode(this.db, update.id)) ?? undefined;
      await repo.finishProposal(this.db, proposal.id, this.peerId, 'rejected', message).catch(() => {});
      return { id: proposal.id, ok: false, error: message, ...(node ? { node } : {}) };
    }
  }

  private async applySnap(snap: Snap): Promise<void> {
    if (!snap.members?.includes(this.peerId)) return;
    const have = await repo.latestSeq(this.db, snap.shareId);
    if (snap.seq <= have) return;
    const rootPub = await this.pubOf(snap.rootHome);
    if (!(await publicKeyFromRaw(rootPub).verify(binding(snap.snapshot), unb64(snap.sig)))) throw new Invalid('bad share signature');
    guard(snap);
    for (const signed of snap.snapshot.nodes) await this.verifyNode(signed);
    const inSnap = new Map(snap.snapshot.nodes.map((n) => [n.node.id, n.node]));
    for (const signed of snap.snapshot.edges) await this.verifyEdge(signed, inSnap);
    const { nodes } = await repo.graph(this.db);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    await withTx(this.db, async (tx) => {
      await repo.ensureShare(tx, snap.shareId, snap.rootId, snap.rootHome, snap.members);
      for (const signed of snap.snapshot.nodes) {
        await repo.saveSig(tx, 'node', signed.node.id, signed.node.version, signed.node.home ?? '', signed.node, signed.sig);
        await repo.upsertReplica(tx, this.peerId, signed.node);
      }
      for (const signed of snap.snapshot.edges) {
        await repo.saveSig(tx, 'edge', signed.edge.id, 0, '', signed.edge, signed.sig);
        await repo.upsertReplicaEdge(tx, signed.edge);
      }
      const nextNodes = new Set(snap.snapshot.nodes.map((n) => n.node.id));
      for (const id of await repo.shareNodeIds(this.db, snap.shareId)) {
        if (nextNodes.has(id)) continue;
        const home = byId.get(id)?.home;
        if (home && home !== this.peerId) await repo.dropReplicaNode(tx, id);
      }
      const nextEdges = new Set(snap.snapshot.edges.map((e) => e.edge.id));
      for (const id of await repo.shareEdgeIds(this.db, snap.shareId)) {
        if (nextEdges.has(id)) continue;
        const edge = (await repo.graph(this.db)).edges.find((e) => e.id === id);
        const srcHome = edge ? byId.get(edge.src)?.home : null;
        if (srcHome && srcHome !== this.peerId) await repo.dropReplicaEdge(tx, id);
      }
      await repo.setShareMembers(tx, snap.shareId, [...nextNodes], [...nextEdges]);
      await tx.query('INSERT INTO share_log (share_id, seq, author, body, signature) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [
        snap.shareId,
        snap.seq,
        snap.rootHome,
        JSON.stringify({ snapshot: snap.snapshot }),
        snap.sig,
      ]);
    });
    this.hub.changed();
  }

  // ---------------------------------------------------------------- relay and pairing

  private async allowed(peerId: string): Promise<boolean> {
    return (await repo.allowedPeers(this.db)).has(peerId);
  }

  private async onPair(remote: string, token: string, addrs: string[], circuit: boolean, publicKey: Uint8Array): Promise<{ addrs: string[]; offersRelay: boolean; publicKey: string }> {
    if (!(await repo.takeInvite(this.db, token))) throw new Invalid('invite is no longer valid');
    const raw = publicKey.length ? publicKey : ((await peerKey(remote)) ?? new Uint8Array());
    if (!raw.length) throw new Invalid('peer id has no public key');
    const pub = publicKeyFromRaw(raw);
    if (peerIdFromPublicKey(pub).toString() !== remote) throw new Invalid('peer id does not match its key');
    const relay = circuit ? ((await this.relayPeer())?.addrs ?? []) : [];
    await repo.upsertPeer(this.db, { peerId: remote, publicKey: pub.raw, label: '', addrs: circuit ? [] : addrs, relay, offersRelay: false });
    await repo.allowPeer(this.db, remote, null);
    return { addrs: this.announce(), offersRelay: this.opt.relay === 'server', publicKey: b64(this.id.publicKey) };
  }

  private async onTicket(remote: string, hash: string, expires: string): Promise<void> {
    if (!(await this.allowed(remote))) throw new Invalid('not paired');
    await this.db.query(
      `INSERT INTO relay_tickets (token_hash, issuer, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at, used = false`,
      [hash, remote, new Date(expires)],
    );
  }

  private async onRedeem(remote: string, token: string): Promise<void> {
    if (!(await repo.takeTicket(this.db, token))) throw new Invalid('ticket is no longer valid');
    await repo.allowPeer(this.db, remote, new Date(Date.now() + 15 * 60 * 1000));
  }

  private async onSpoolPut(remote: string, to: string, blob: Uint8Array): Promise<void> {
    if (!(await this.allowed(remote)) || !(await this.allowed(to))) throw new Invalid('relay refused');
    await repo.spoolPut(this.db, to, remote, blob);
  }

  private async onSpoolPull(remote: string): Promise<{ id: string; from: string; body: string }[]> {
    if (!(await this.allowed(remote))) throw new Invalid('relay refused');
    return repo.spoolPull(this.db, remote);
  }

  private async spool(peer: repo.PeerRow, msg: SyncMsg): Promise<void> {
    if (!peer.relay.length) throw new Error(`${peer.peerId} is unreachable`);
    const blob = seal(peer.publicKey, new TextEncoder().encode(JSON.stringify(msg)));
    const conn = await this.host.dial(peer.relay);
    const reply = (await this.host.rpc(conn, SPOOL, { t: 'put', to: peer.peerId, body: b64(blob) })) as { t?: string; error?: string };
    if (reply.t === 'err') throw new Error(reply.error ?? 'spool refused');
  }

  private async pullSpools(): Promise<void> {
    const seen = new Set<string>();
    const relays: string[][] = [];
    for (const peer of await repo.listPeers(this.db)) {
      const addrs = peer.offersRelay ? peer.addrs : peer.relay;
      const key = addrs.join('|');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      relays.push(addrs);
    }
    for (const addrs of relays) {
      try {
        const conn = await this.host.dial(addrs);
        const reply = (await this.host.rpc(conn, SPOOL, { t: 'pull' })) as { frames?: { id: string; from: string; body: string }[] };
        const ids: string[] = [];
        for (const frame of reply.frames ?? []) {
          const msg = JSON.parse(new TextDecoder().decode(openSeal(this.id.seed, unb64(frame.body)))) as SyncMsg;
          await this.onSync(frame.from, msg);
          ids.push(frame.id);
        }
        if (ids.length) await this.host.rpc(conn, SPOOL, { t: 'ack', ids });
      } catch {
        /* the relay is down */
      }
    }
  }

  private async relayPeer(): Promise<repo.PeerRow | null> {
    return (await repo.listPeers(this.db)).find((p) => p.offersRelay) ?? null;
  }

  /** Dial the relay again and wait until it lists us as reachable through it. */
  private async ensureRelay(): Promise<void> {
    const relay = await this.relayPeer();
    if (!relay || this.opt.relay !== 'client') return;
    try {
      await this.host.dial(relay.addrs);
      await this.host.waitReservation();
    } catch {
      /* sync still tries a direct dial, and spools when that fails */
    }
  }

  private async pubOf(peerId: string): Promise<Uint8Array> {
    if (peerId === this.peerId) return this.id.publicKey;
    const peer = await repo.getPeer(this.db, peerId);
    if (!peer) throw new Invalid(`unknown peer ${peerId}`);
    return peer.publicKey;
  }

  private async verifyNode(signed: SignedNode): Promise<void> {
    if (!signed.node.home) throw new Invalid('shared node has no home');
    const pub = await this.pubOf(signed.node.home);
    if (!(await publicKeyFromRaw(pub).verify(canonical(signed.node), unb64(signed.sig)))) throw new Invalid(`bad signature on ${signed.node.title}`);
  }

  private async verifyEdge(signed: SignedEdge, extra?: Map<string, Node>): Promise<void> {
    const { nodes } = await repo.graph(this.db);
    const src = extra?.get(signed.edge.src) ?? nodes.find((n) => n.id === signed.edge.src) ?? (await findNode(this.db, signed.edge.src));
    const home = src?.home;
    if (!home) throw new Invalid('edge source has no home');
    const pub = await this.pubOf(home);
    if (!(await publicKeyFromRaw(pub).verify(canonical(signed.edge), unb64(signed.sig)))) throw new Invalid('bad edge signature');
  }

  private async sign(bytes: Uint8Array): Promise<string> {
    return b64(await this.id.key.sign(bytes));
  }

  private async classify(ops: Op[]): Promise<{ local: Op[]; foreign: Map<string, Op[]> }> {
    const local: Op[] = [];
    const foreign = new Map<string, Op[]>();
    const put = (home: string | null, op: Op) => {
      if (!home || home === this.peerId) local.push(op);
      else {
        const list = foreign.get(home) ?? [];
        list.push(op);
        foreign.set(home, list);
      }
    };
    for (const op of ops) {
      if (op.op === 'create_node') put(null, op);
      else if ((op.op === 'update_node' || op.op === 'delete_node') && op.id.startsWith('$')) put(null, op);
      else if (op.op === 'update_node' || op.op === 'delete_node') put(await repo.nodeHome(this.db, op.id), op);
      else if (op.op === 'create_edge') put(op.src.startsWith('$') ? null : await repo.nodeHome(this.db, op.src), op);
      else if (op.op === 'delete_edge' && !op.id && op.src) put(op.src.startsWith('$') ? null : await repo.nodeHome(this.db, op.src), op);
      else if ((op.op === 'update_edge' || op.op === 'delete_edge') && op.id) {
        const src = await this.db.query('SELECT src FROM edges WHERE id = $1', [op.id]);
        put(src.rows[0] ? await repo.nodeHome(this.db, src.rows[0].src as string) : null, op);
      } else put(null, op);
    }
    return { local, foreign };
  }
}

/** Re-export so tests can build an identity without a file. */
export { ident };

function binding(snapshot: Snapshot): Uint8Array {
  return canonical({
    nodes: snapshot.nodes.map((n) => ({ id: n.node.id, v: n.node.version, sig: n.sig })),
    edges: snapshot.edges.map((e) => ({ id: e.edge.id, sig: e.sig })),
  });
}

function guard(value: unknown): void {
  if (JSON.stringify(value).includes(USER_ID)) throw new Invalid('refusing to send the local You id');
}

function substitute(ops: Op[], results: { ref?: string; id: string }[]): Op[] {
  const refs = new Map(results.filter((r) => r.ref).map((r) => [r.ref!, r.id]));
  const sub = (v: string) => (v.startsWith('$') ? (refs.get(v.slice(1)) ?? v) : v);
  return ops.map((op) => {
    if (op.op === 'update_node' || op.op === 'delete_node') return { ...op, id: sub(op.id) };
    if (op.op === 'create_edge') return { ...op, src: sub(op.src), dst: sub(op.dst) };
    if (op.op === 'delete_edge' && op.src && op.dst) return { ...op, src: sub(op.src), dst: sub(op.dst) };
    return op;
  });
}

/** Peer ids carry the Ed25519 key. Used when the session has already authenticated `remote`. */
async function peerKey(peerId: string): Promise<Uint8Array | null> {
  const { peerIdFromString } = await import('@libp2p/peer-id');
  const id = peerIdFromString(peerId);
  return id.publicKey?.raw ?? null;
}
