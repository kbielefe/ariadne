import { createHash, randomUUID } from 'node:crypto';
import type { Edge, Node, Op } from '../../shared/model';
import type { Db } from '../db';
import { withTx } from '../db';
import type { Q } from '../store';

/** A pool or a transaction. Both can run a query. */
type Sql = Q;
import { mapEdge, mapNode } from '../store';
import type { SignedEdge, SignedNode, Snapshot } from './messages';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface PeerRow {
  peerId: string;
  publicKey: Uint8Array;
  label: string;
  addrs: string[];
  relay: string[];
  offersRelay: boolean;
}

const mapPeer = (r: Record<string, unknown>): PeerRow => ({
  peerId: r.peer_id as string,
  publicKey: new Uint8Array(r.public_key as Buffer),
  label: r.label as string,
  addrs: (r.addrs as string[]) ?? [],
  relay: (r.relay as string[]) ?? [],
  offersRelay: r.offers_relay as boolean,
});

export async function listPeers(db: Db): Promise<PeerRow[]> {
  return (await db.query('SELECT * FROM peers ORDER BY paired_at')).rows.map(mapPeer);
}

export async function getPeer(db: Db, id: string): Promise<PeerRow | null> {
  const r = await db.query('SELECT * FROM peers WHERE peer_id = $1', [id]);
  return r.rows[0] ? mapPeer(r.rows[0]) : null;
}

export async function upsertPeer(db: Db, p: PeerRow): Promise<void> {
  await db.query(
    `INSERT INTO peers (peer_id, public_key, label, addrs, relay, offers_relay) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (peer_id) DO UPDATE SET public_key = EXCLUDED.public_key, label = EXCLUDED.label, addrs = EXCLUDED.addrs, relay = EXCLUDED.relay, offers_relay = EXCLUDED.offers_relay`,
    [p.peerId, Buffer.from(p.publicKey), p.label, p.addrs, p.relay, p.offersRelay],
  );
}

export async function allowPeer(db: Db, peerId: string, expires: Date | null): Promise<void> {
  await db.query(
    `INSERT INTO relay_allow (peer_id, expires_at) VALUES ($1, $2)
     ON CONFLICT (peer_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [peerId, expires],
  );
}

/** Paired peers, plus relay tickets that have not expired. */
export async function allowedPeers(db: Db): Promise<Set<string>> {
  const r = await db.query(
    `SELECT peer_id FROM peers
     UNION SELECT peer_id FROM relay_allow WHERE expires_at IS NULL OR expires_at > now()`,
  );
  return new Set(r.rows.map((x) => x.peer_id as string));
}

export async function insertInvite(db: Db, token: string, expires: Date): Promise<void> {
  await db.query('INSERT INTO invites (token_hash, expires_at) VALUES ($1, $2)', [sha256(token), expires]);
}

export async function takeInvite(db: Db, token: string): Promise<boolean> {
  const r = await db.query(`UPDATE invites SET used = true WHERE token_hash = $1 AND NOT used AND expires_at > now() RETURNING token_hash`, [sha256(token)]);
  return !!r.rowCount;
}

export async function insertTicket(db: Db, token: string, issuer: string, expires: Date): Promise<void> {
  await db.query('INSERT INTO relay_tickets (token_hash, issuer, expires_at) VALUES ($1, $2, $3)', [sha256(token), issuer, expires]);
}

export async function takeTicket(db: Db, token: string): Promise<boolean> {
  const r = await db.query(`UPDATE relay_tickets SET used = true WHERE token_hash = $1 AND NOT used AND expires_at > now() RETURNING token_hash`, [sha256(token)]);
  return !!r.rowCount;
}

export interface ShareRow {
  id: string;
  rootId: string;
  rootHome: string;
  members: string[];
}

export async function listShares(db: Db): Promise<ShareRow[]> {
  const r = await db.query(
    `SELECT s.id, s.root_id, s.root_home, coalesce(array_agg(m.peer_id) FILTER (WHERE m.peer_id IS NOT NULL), '{}') AS members
     FROM shares s LEFT JOIN share_members m ON m.share_id = s.id GROUP BY s.id`,
  );
  return r.rows.map((x) => ({ id: x.id as string, rootId: x.root_id as string, rootHome: x.root_home as string, members: x.members as string[] }));
}

export async function ensureShare(q: Sql, id: string, rootId: string, rootHome: string, members: string[]): Promise<void> {
  await q.query('INSERT INTO shares (id, root_id, root_home) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [id, rootId, rootHome]);
  for (const peer of members) await q.query('INSERT INTO share_members (share_id, peer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, peer]);
}

export async function createShare(db: Db, rootId: string, rootHome: string, members: string[]): Promise<string> {
  const id = randomUUID();
  await withTx(db, async (tx) => {
    await tx.query('INSERT INTO shares (id, root_id, root_home) VALUES ($1, $2, $3)', [id, rootId, rootHome]);
    for (const peer of members) await tx.query('INSERT INTO share_members (share_id, peer_id) VALUES ($1, $2)', [id, peer]);
  });
  return id;
}

export async function latestSeq(db: Db, shareId: string): Promise<number> {
  const r = await db.query('SELECT coalesce(max(seq), 0) AS n FROM share_log WHERE share_id = $1', [shareId]);
  return Number(r.rows[0].n);
}

export async function appendLog(db: Db, shareId: string, seq: number, author: string, body: unknown, signature: string): Promise<void> {
  await db.query('INSERT INTO share_log (share_id, seq, author, body, signature) VALUES ($1, $2, $3, $4, $5)', [shareId, seq, author, JSON.stringify(body), signature]);
}

export async function saveSig(db: Sql, kind: 'node' | 'edge', id: string, version: number, signer: string, payload: unknown, signature: string): Promise<void> {
  await db.query(
    `INSERT INTO object_sigs (kind, object_id, version, signer, payload, signature) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (kind, object_id, version) DO UPDATE SET signer = EXCLUDED.signer, payload = EXCLUDED.payload, signature = EXCLUDED.signature`,
    [kind, id, version, signer, JSON.stringify(payload), signature],
  );
}

export async function loadSig(db: Sql, kind: 'node' | 'edge', id: string, version: number): Promise<{ payload: unknown; signature: string; signer: string } | null> {
  const r = await db.query('SELECT payload, signature, signer FROM object_sigs WHERE kind = $1 AND object_id = $2 AND version = $3', [kind, id, version]);
  return r.rows[0] ? { payload: r.rows[0].payload, signature: r.rows[0].signature as string, signer: r.rows[0].signer as string } : null;
}

export async function nodeHome(db: Db, id: string): Promise<string | null> {
  const r = await db.query('SELECT home FROM nodes WHERE id = $1', [id]);
  if (!r.rows[0]) return null;
  return (r.rows[0].home as string) ?? null;
}

export async function selfPerson(db: Db, peerId: string): Promise<string | null> {
  const r = await db.query(`SELECT id FROM nodes WHERE kind = 'person' AND attrs->>'peer' = $1`, [peerId]);
  return (r.rows[0]?.id as string) ?? null;
}

export async function graph(db: Db): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const [nodes, edges] = await Promise.all([db.query('SELECT * FROM nodes'), db.query('SELECT * FROM edges')]);
  return { nodes: nodes.rows.map(mapNode), edges: edges.rows.map(mapEdge) };
}

/** Insert or replace a replica. A row homed on this instance is left as it is. */
export async function upsertReplica(q: Q, selfId: string, node: Node): Promise<void> {
  const cur = await q.query('SELECT home FROM nodes WHERE id = $1', [node.id]);
  const home = (cur.rows[0]?.home as string) ?? null;
  if (home === selfId || node.home === selfId) return;
  await q.query(
    `INSERT INTO nodes (id, kind, title, body, status, attrs, version, created_at, updated_at, home)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, title = EXCLUDED.title, body = EXCLUDED.body, status = EXCLUDED.status,
       attrs = EXCLUDED.attrs, version = EXCLUDED.version, updated_at = EXCLUDED.updated_at, home = EXCLUDED.home
     WHERE nodes.home IS DISTINCT FROM $11`,
    [node.id, node.kind, node.title, node.body, node.status, JSON.stringify(node.attrs), node.version, node.createdAt, node.updatedAt, node.home, selfId],
  );
}

export async function upsertReplicaEdge(q: Q, edge: Edge): Promise<void> {
  await q.query(
    `INSERT INTO edges (id, src, kind, dst, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (src, kind, dst) DO UPDATE SET note = EXCLUDED.note`,
    [edge.id, edge.src, edge.kind, edge.dst, edge.note, edge.createdAt],
  );
}

export async function shareNodeIds(db: Db, shareId: string): Promise<string[]> {
  const r = await db.query('SELECT node_id FROM share_nodes WHERE share_id = $1', [shareId]);
  return r.rows.map((x) => x.node_id as string);
}

export async function shareEdgeIds(db: Db, shareId: string): Promise<string[]> {
  const r = await db.query('SELECT edge_id FROM share_edges WHERE share_id = $1', [shareId]);
  return r.rows.map((x) => x.edge_id as string);
}

export async function setShareMembers(q: Q, shareId: string, nodeIds: string[], edgeIds: string[]): Promise<void> {
  await q.query('DELETE FROM share_nodes WHERE share_id = $1', [shareId]);
  await q.query('DELETE FROM share_edges WHERE share_id = $1', [shareId]);
  for (const id of nodeIds) await q.query('INSERT INTO share_nodes (share_id, node_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [shareId, id]);
  for (const id of edgeIds) await q.query('INSERT INTO share_edges (share_id, edge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [shareId, id]);
}

export async function dropReplicaNode(q: Q, id: string): Promise<void> {
  await q.query('DELETE FROM nodes WHERE id = $1', [id]);
}

export async function dropReplicaEdge(q: Q, id: string): Promise<void> {
  await q.query('DELETE FROM edges WHERE id = $1', [id]);
}

export async function insertProposal(db: Db, id: string, home: string, ops: Op[]): Promise<void> {
  await db.query(`INSERT INTO proposals (id, home, ops, status) VALUES ($1, $2, $3, 'pending')`, [id, home, JSON.stringify(ops)]);
}

export async function pendingProposals(db: Db, home?: string): Promise<{ id: string; home: string; ops: Op[] }[]> {
  const r = home
    ? await db.query(`SELECT id, home, ops FROM proposals WHERE status = 'pending' AND home = $1`, [home])
    : await db.query(`SELECT id, home, ops FROM proposals WHERE status = 'pending'`);
  return r.rows.map((x) => ({ id: x.id as string, home: x.home as string, ops: x.ops as Op[] }));
}

/** Insert or update. The home instance has no row until the proposal arrives, so an update alone would forget the result. */
export async function finishProposal(db: Sql, id: string, home: string, status: 'committed' | 'rejected', error?: string, result?: unknown): Promise<void> {
  await db.query(
    `INSERT INTO proposals (id, home, ops, status, error, result) VALUES ($1, $2, '[]', $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, result = EXCLUDED.result`,
    [id, home, status, error ?? null, result == null ? null : JSON.stringify(result)],
  );
}

export async function latestSnap(db: Db, shareId: string): Promise<{ seq: number; body: unknown; signature: string } | null> {
  const r = await db.query('SELECT seq, body, signature FROM share_log WHERE share_id = $1 ORDER BY seq DESC LIMIT 1', [shareId]);
  return r.rows[0] ? { seq: Number(r.rows[0].seq), body: r.rows[0].body, signature: r.rows[0].signature as string } : null;
}

export async function pendingForNode(db: Db, id: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM proposals WHERE status = 'pending' AND ops::text LIKE $1 LIMIT 1`, [`%${id}%`]);
  return !!r.rowCount;
}

const SPOOL_CAP = 8 * 1024 * 1024;

export async function spoolPut(db: Db, recipient: string, sender: string, blob: Uint8Array): Promise<void> {
  const size = await db.query('SELECT coalesce(sum(octet_length(blob)), 0) AS n FROM spool WHERE recipient = $1', [recipient]);
  if (Number(size.rows[0].n) + blob.length > SPOOL_CAP) throw new Error('spool is full for that peer');
  await db.query('INSERT INTO spool (id, recipient, sender, blob) VALUES ($1, $2, $3, $4)', [randomUUID(), recipient, sender, Buffer.from(blob)]);
}

export async function spoolPull(db: Db, recipient: string): Promise<{ id: string; from: string; body: string }[]> {
  await db.query(`DELETE FROM spool WHERE created_at < now() - interval '7 days'`);
  const r = await db.query('SELECT id, sender, blob FROM spool WHERE recipient = $1 ORDER BY created_at', [recipient]);
  return r.rows.map((x) => ({ id: x.id as string, from: x.sender as string, body: Buffer.from(x.blob as Buffer).toString('base64') }));
}

export async function spoolAck(db: Db, recipient: string, ids: string[]): Promise<void> {
  await db.query('DELETE FROM spool WHERE recipient = $1 AND id = ANY($2::uuid[])', [recipient, ids]);
}

export type { Snapshot };
