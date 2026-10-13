// Row-level reads and writes. Every write records an audit row (DB-shaped before/after JSON),
// which is what makes "why did this change?" and Undo possible.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Edge, Node, Via } from '../shared/model';

export type Q = Pick<pg.PoolClient, 'query'>;

/** Who is changing things, and in which change set. */
export interface Who {
  /** null = Claude Code over MCP */
  actor: string | null;
  via: Via;
  changeset: string;
}
export const who = (actor: string | null, via: Via): Who => ({ actor, via, changeset: randomUUID() });

export interface Ctx {
  tx: Q;
  who: Who;
  /** Peer id stamped on nodes this transaction creates. */
  home?: string | null;
}

export class NotFound extends Error {}
export class Invalid extends Error {}
export class Conflict extends Error {}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));

// ---------------------------------------------------------------- mapping

export function mapNode(r: Record<string, unknown>): Node {
  return {
    id: r.id as string,
    kind: r.kind as Node['kind'],
    title: r.title as string,
    body: r.body as string,
    status: (r.status as Node['status']) ?? null,
    attrs: (r.attrs as Record<string, unknown>) ?? {},
    version: r.version as number,
    home: (r.home as string) ?? null,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

export function mapEdge(r: Record<string, unknown>): Edge {
  return { id: r.id as string, src: r.src as string, kind: r.kind as Edge['kind'], dst: r.dst as string, note: r.note as string, createdAt: iso(r.created_at)! };
}

// ---------------------------------------------------------------- reads

/** `lock` holds the row until the transaction ends, so a read-modify-write (like a body patch) can't lose a concurrent change. */
export async function getNode(q: Q, id: string, o: { lock?: boolean } = {}): Promise<Node> {
  const r = await q.query(`SELECT * FROM nodes WHERE id = $1${o.lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!r.rows[0]) throw new NotFound(`No node ${id}`);
  return mapNode(r.rows[0]);
}

export async function findNode(q: Q, id: string): Promise<Node | null> {
  const r = await q.query('SELECT * FROM nodes WHERE id = $1', [id]);
  return r.rows[0] ? mapNode(r.rows[0]) : null;
}

// A decision is a line in a node's body, by convention `**Decision (Karl, 2026-10-02):** text`
// (optionally a list item). The same pattern as decisionLines (shared/graph.ts), in PostgreSQL (newline-sensitive).
const DECISION_SQL = String.raw`(?n)^[ \t]*([-*][ \t]+)?\*\*Decision\y`;
export { decisionLines } from '../shared/graph';

export async function listNodes(q: Q, f: { kind?: string; query?: string; status?: string; decisions?: boolean; limit?: number } = {}): Promise<Node[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.kind) where.push(`kind = $${args.push(f.kind)}`);
  if (f.status) where.push(`status = $${args.push(f.status)}`);
  if (f.query) where.push(`(title ILIKE $${args.push(`%${f.query}%`)} OR body ILIKE $${args.length})`);
  if (f.decisions) where.push(`body ~ $${args.push(DECISION_SQL)}`);
  const sql = `SELECT * FROM nodes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ${Math.min(f.limit ?? 1000, 5000)}`;
  return (await q.query(sql, args)).rows.map(mapNode);
}

export async function listEdges(q: Q, f: { node?: string } = {}): Promise<Edge[]> {
  const r = f.node ? await q.query('SELECT * FROM edges WHERE src = $1 OR dst = $1 ORDER BY created_at', [f.node]) : await q.query('SELECT * FROM edges ORDER BY created_at');
  return r.rows.map(mapEdge);
}

// ---------------------------------------------------------------- audit

type Entity = 'node' | 'edge';

async function audit(c: Ctx, entity: Entity, entityId: string, action: 'create' | 'update' | 'delete', before: unknown, after: unknown) {
  await c.tx.query(
    `INSERT INTO audit (changeset, actor, via, entity, entity_id, action, before, after) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [c.who.changeset, c.who.actor, c.who.via, entity, entityId, action, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)],
  );
}

const TABLE: Record<Entity, string> = { node: 'nodes', edge: 'edges' };

async function snapshot(q: Q, entity: Entity, id: string): Promise<Record<string, unknown> | null> {
  const r = await q.query(`SELECT to_jsonb(t) AS j FROM ${TABLE[entity]} t WHERE id = $1`, [id]);
  return r.rows[0]?.j ?? null;
}

// ---------------------------------------------------------------- node writes

export async function insertNode(c: Ctx, n: { kind: string; title: string; body?: string; status?: string | null; attrs?: Record<string, unknown> }): Promise<Node> {
  const r = await c.tx.query('INSERT INTO nodes (kind, title, body, status, attrs, home) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [
    n.kind,
    n.title,
    n.body ?? '',
    n.kind === 'task' ? (n.status ?? 'open') : null,
    JSON.stringify(n.attrs ?? {}),
    c.home ?? null,
  ]);
  const node = mapNode(r.rows[0]);
  await audit(c, 'node', node.id, 'create', null, await snapshot(c.tx, 'node', node.id));
  return node;
}

export async function patchNode(c: Ctx, id: string, p: { title?: string; body?: string; status?: string; attrs?: Record<string, unknown>; version?: number }): Promise<Node> {
  const before = await snapshot(c.tx, 'node', id);
  if (!before) throw new NotFound(`No node ${id}`);
  if (p.version != null && p.version !== before.version) throw new Conflict(`Node ${id} changed (version ${before.version}, you had ${p.version}). Reload and try again.`);
  const r = await c.tx.query(
    `UPDATE nodes SET title = coalesce($2, title), body = coalesce($3, body), status = coalesce($4, status),
       attrs = jsonb_strip_nulls(attrs || coalesce($5::jsonb, '{}')), version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, p.title ?? null, p.body ?? null, p.status ?? null, p.attrs ? JSON.stringify(p.attrs) : null],
  );
  await audit(c, 'node', id, 'update', before, await snapshot(c.tx, 'node', id));
  return mapNode(r.rows[0]);
}

export async function removeNode(c: Ctx, id: string): Promise<void> {
  const before = await snapshot(c.tx, 'node', id);
  if (!before) throw new NotFound(`No node ${id}`);
  // Audit what the cascade would remove silently, so Undo can bring it back.
  for (const e of (await c.tx.query('SELECT id FROM edges WHERE src = $1 OR dst = $1', [id])).rows) await removeEdge(c, e.id);
  await c.tx.query('DELETE FROM nodes WHERE id = $1', [id]);
  await audit(c, 'node', id, 'delete', before, null);
}

// ---------------------------------------------------------------- edge writes

export async function insertEdge(c: Ctx, e: { src: string; kind: string; dst: string; note?: string }): Promise<Edge> {
  const r = await c.tx.query('INSERT INTO edges (src, kind, dst, note) VALUES ($1, $2, $3, $4) ON CONFLICT (src, kind, dst) DO NOTHING RETURNING *', [e.src, e.kind, e.dst, e.note ?? '']);
  if (!r.rows[0]) {
    const existing = await c.tx.query('SELECT * FROM edges WHERE src = $1 AND kind = $2 AND dst = $3', [e.src, e.kind, e.dst]);
    return mapEdge(existing.rows[0]);
  }
  const edge = mapEdge(r.rows[0]);
  await audit(c, 'edge', edge.id, 'create', null, await snapshot(c.tx, 'edge', edge.id));
  return edge;
}

export async function patchEdge(c: Ctx, id: string, note: string): Promise<Edge> {
  const before = await snapshot(c.tx, 'edge', id);
  if (!before) throw new NotFound(`No edge ${id}`);
  const r = await c.tx.query('UPDATE edges SET note = $2 WHERE id = $1 RETURNING *', [id, note]);
  await audit(c, 'edge', id, 'update', before, await snapshot(c.tx, 'edge', id));
  return mapEdge(r.rows[0]);
}

export async function removeEdge(c: Ctx, id: string): Promise<void> {
  const before = await snapshot(c.tx, 'edge', id);
  if (!before) throw new NotFound(`No edge ${id}`);
  await c.tx.query('DELETE FROM edges WHERE id = $1', [id]);
  await audit(c, 'edge', id, 'delete', before, null);
}

// ---------------------------------------------------------------- undo

export interface AuditRow {
  id: number;
  changeset: string;
  at: string;
  actor: string | null;
  via: Via;
  entity: Entity;
  entityId: string;
  action: 'create' | 'update' | 'delete';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  undone: boolean;
}

export const mapAudit = (r: Record<string, unknown>): AuditRow => ({
  id: Number(r.id),
  changeset: r.changeset as string,
  at: iso(r.at)!,
  actor: (r.actor as string) ?? null,
  via: r.via as Via,
  entity: r.entity as Entity,
  entityId: r.entity_id as string,
  action: r.action as AuditRow['action'],
  before: (r.before as Record<string, unknown>) ?? null,
  after: (r.after as Record<string, unknown>) ?? null,
  undone: r.undone as boolean,
});

export async function listAudit(q: Q, f: { changeset?: string; since?: string; via?: string; limit?: number } = {}): Promise<AuditRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.changeset) where.push(`changeset = $${args.push(f.changeset)}`);
  if (f.since) where.push(`at > $${args.push(f.since)}`);
  if (f.via) where.push(`via = $${args.push(f.via)}`);
  const sql = `SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${Math.min(f.limit ?? 500, 5000)}`;
  return (await q.query(sql, args)).rows.map(mapAudit).reverse();
}

/**
 * Reverts a change set, newest change first. The revert is itself audited (in `c.who.changeset`),
 * so it can be undone too. Fails with Conflict if something it touched has changed since.
 */
export async function undoChangeset(c: Ctx, changeset: string): Promise<number> {
  const rows = (await c.tx.query('SELECT * FROM audit WHERE changeset = $1 AND NOT undone ORDER BY id DESC FOR UPDATE', [changeset])).rows.map(mapAudit);
  if (!rows.length) throw new NotFound(`Nothing to undo in ${changeset}`);
  for (const a of rows) {
    const table = TABLE[a.entity];
    const current = await snapshot(c.tx, a.entity, a.entityId);
    if (a.action === 'create') {
      if (!current) continue;
      if (a.entity === 'node') await removeNode(c, a.entityId);
      else await removeEdge(c, a.entityId);
    } else if (a.action === 'delete') {
      if (current) continue;
      await c.tx.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(null::${table}, $1)`, [JSON.stringify(a.before)]);
      await audit(c, a.entity, a.entityId, 'create', null, a.before);
    } else {
      if (!current) throw new Conflict(`Can't undo: ${a.entity} ${a.entityId} was deleted since`);
      if (a.entity === 'node' && a.after && current.version !== a.after.version) throw new Conflict(`Can't undo: ${String(current.title)} changed again since`);
      const cols = Object.keys(a.before!).filter((k) => k !== 'id');
      const restored = a.entity === 'node' ? { ...a.before, version: Number(current.version) + 1, updated_at: new Date().toISOString() } : a.before;
      await c.tx.query(
        `UPDATE ${table} SET (${cols.join(', ')}) = (SELECT ${cols.join(', ')} FROM jsonb_populate_record(null::${table}, $2)) WHERE id = $1`,
        [a.entityId, JSON.stringify(restored)],
      );
      await audit(c, a.entity, a.entityId, 'update', current, await snapshot(c.tx, a.entity, a.entityId));
    }
  }
  await c.tx.query('UPDATE audit SET undone = true WHERE changeset = $1', [changeset]);
  return rows.length;
}
