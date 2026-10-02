// Row-level reads and writes. Every write records an audit row (DB-shaped before/after JSON),
// which is what makes "why did this change?" and Undo possible.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Edge, Event, Node, Via } from '../shared/model';

export type Q = Pick<pg.PoolClient, 'query'>;

/** Who is changing things, and in which change set. */
export interface Who {
  actor: string | null;
  via: Via;
  because?: string | null;
  changeset: string;
}
export const who = (actor: string | null, via: Via, because?: string | null): Who => ({ actor, via, because: because ?? null, changeset: randomUUID() });

export interface Ctx {
  tx: Q;
  who: Who;
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
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

export function mapEdge(r: Record<string, unknown>): Edge {
  return { id: r.id as string, src: r.src as string, kind: r.kind as Edge['kind'], dst: r.dst as string, note: r.note as string, createdAt: iso(r.created_at)! };
}

export function mapEvent(r: Record<string, unknown>): Event {
  return {
    id: r.id as string,
    kind: r.kind as Event['kind'],
    sender: (r.sender as string) ?? null,
    recipient: (r.recipient as string) ?? null,
    replyTo: (r.reply_to as string) ?? null,
    closes: r.closes as boolean,
    body: r.body as string,
    instructions: r.instructions as string,
    card: (r.card as Event['card']) ?? null,
    response: (r.response as Event['response']) ?? null,
    proposals: (r.proposals as unknown[]) ?? null,
    questions: (r.questions as Event['questions']) ?? null,
    answers: (r.answers as Event['answers']) ?? null,
    decisions: (r.decisions as Event['decisions']) ?? {},
    state: (r.state as Event['state']) ?? null,
    dueAt: iso(r.due_at),
    delivery: r.delivery as Event['delivery'],
    tasks: (r.tasks as string[]) ?? [],
    createdAt: iso(r.created_at)!,
    closedAt: iso(r.closed_at),
  };
}

const EVENT_SELECT = `SELECT e.*, (SELECT coalesce(array_agg(et.task_id), '{}') FROM event_tasks et WHERE et.event_id = e.id) AS tasks FROM events e`;

// ---------------------------------------------------------------- reads

export async function getNode(q: Q, id: string): Promise<Node> {
  const r = await q.query('SELECT * FROM nodes WHERE id = $1', [id]);
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

export async function getEvent(q: Q, id: string): Promise<Event> {
  const r = await q.query(`${EVENT_SELECT} WHERE e.id = $1`, [id]);
  if (!r.rows[0]) throw new NotFound(`No event ${id}`);
  return mapEvent(r.rows[0]);
}

export async function findEvent(q: Q, id: string): Promise<Event | null> {
  const r = await q.query(`${EVENT_SELECT} WHERE e.id = $1`, [id]);
  return r.rows[0] ? mapEvent(r.rows[0]) : null;
}

export interface EventFilter {
  task?: string;
  tasks?: string[];
  actor?: string;
  kind?: string;
  open?: boolean;
  since?: string;
  limit?: number;
}

export async function listEvents(q: Q, f: EventFilter = {}): Promise<Event[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.task) where.push(`EXISTS (SELECT 1 FROM event_tasks et WHERE et.event_id = e.id AND et.task_id = $${args.push(f.task)})`);
  if (f.tasks) where.push(`EXISTS (SELECT 1 FROM event_tasks et WHERE et.event_id = e.id AND et.task_id = ANY($${args.push(f.tasks)}::uuid[]))`);
  if (f.actor) where.push(`(e.sender = $${args.push(f.actor)} OR e.recipient = $${args.length})`);
  if (f.kind) where.push(`e.kind = $${args.push(f.kind)}`);
  if (f.open) where.push(`e.state = 'open'`);
  if (f.since) where.push(`e.created_at > $${args.push(f.since)}`);
  const limit = Math.min(f.limit ?? 200, 2000);
  // Newest `limit`, returned oldest first.
  const sql = `SELECT * FROM (${EVENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit}) x ORDER BY created_at, id`;
  return (await q.query(sql, args)).rows.map(mapEvent);
}

// ---------------------------------------------------------------- audit

type Entity = 'node' | 'edge' | 'event' | 'event_task';

async function audit(c: Ctx, entity: Entity, entityId: string, action: 'create' | 'update' | 'delete', before: unknown, after: unknown) {
  await c.tx.query(
    `INSERT INTO audit (changeset, actor, via, because, entity, entity_id, action, before, after) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [c.who.changeset, c.who.actor, c.who.via, c.who.because ?? null, entity, entityId, action, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)],
  );
}

const TABLE: Record<Exclude<Entity, 'event_task'>, string> = { node: 'nodes', edge: 'edges', event: 'events' };

async function snapshot(q: Q, entity: Exclude<Entity, 'event_task'>, id: string): Promise<Record<string, unknown> | null> {
  const r = await q.query(`SELECT to_jsonb(t) AS j FROM ${TABLE[entity]} t WHERE id = $1`, [id]);
  return r.rows[0]?.j ?? null;
}

// ---------------------------------------------------------------- node writes

export async function insertNode(c: Ctx, n: { kind: string; title: string; body?: string; status?: string | null; attrs?: Record<string, unknown> }): Promise<Node> {
  const r = await c.tx.query('INSERT INTO nodes (kind, title, body, status, attrs) VALUES ($1, $2, $3, $4, $5) RETURNING *', [
    n.kind,
    n.title,
    n.body ?? '',
    n.kind === 'task' ? (n.status ?? 'open') : null,
    JSON.stringify(n.attrs ?? {}),
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
  for (const l of (await c.tx.query('SELECT event_id FROM event_tasks WHERE task_id = $1', [id])).rows) await unlinkEventTask(c, l.event_id, id);
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

// ---------------------------------------------------------------- event writes

export interface NewEvent {
  kind: 'assign' | 'report';
  sender: string | null;
  recipient: string | null;
  replyTo?: string | null;
  closes?: boolean;
  body?: string;
  instructions?: string;
  card?: unknown;
  response?: unknown;
  proposals?: unknown[] | null;
  questions?: unknown;
  answers?: unknown;
  decisions?: Record<string, unknown>;
  dueAt?: string | null;
  delivery: Event['delivery'];
  tasks: string[];
}

const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

export async function insertEvent(c: Ctx, e: NewEvent): Promise<Event> {
  const r = await c.tx.query(
    `INSERT INTO events (kind, sender, recipient, reply_to, closes, body, instructions, card, response, proposals, questions, answers, decisions, state, due_at, delivery)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [
      e.kind,
      e.sender,
      e.recipient,
      e.replyTo ?? null,
      e.kind === 'report' && (e.closes ?? false),
      e.body ?? '',
      e.instructions ?? '',
      json(e.card),
      json(e.response),
      json(e.proposals),
      json(e.questions),
      json(e.answers),
      JSON.stringify(e.decisions ?? {}),
      e.kind === 'assign' ? 'open' : null,
      e.dueAt ?? null,
      e.delivery,
    ],
  );
  const id = r.rows[0].id as string;
  await audit(c, 'event', id, 'create', null, await snapshot(c.tx, 'event', id));
  for (const t of new Set(e.tasks)) await linkEventTask(c, id, t);
  return getEvent(c.tx, id);
}

export async function patchEvent(c: Ctx, id: string, p: Partial<Record<'body' | 'instructions' | 'state' | 'delivery' | 'decisions' | 'answers' | 'closed_at' | 'delivered_at', unknown>>): Promise<Event> {
  const before = await snapshot(c.tx, 'event', id);
  if (!before) throw new NotFound(`No event ${id}`);
  const sets: string[] = [];
  const args: unknown[] = [id];
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    const isJson = k === 'decisions' || k === 'answers';
    sets.push(`${k} = $${args.push(isJson ? JSON.stringify(v) : v)}`);
  }
  if (p.state && p.state !== 'open' && before.closed_at == null) sets.push('closed_at = now()');
  if (p.state === 'open') sets.push('closed_at = NULL');
  if (sets.length) await c.tx.query(`UPDATE events SET ${sets.join(', ')} WHERE id = $1`, args);
  await audit(c, 'event', id, 'update', before, await snapshot(c.tx, 'event', id));
  return getEvent(c.tx, id);
}

export async function removeEvent(c: Ctx, id: string): Promise<void> {
  const before = await snapshot(c.tx, 'event', id);
  if (!before) throw new NotFound(`No event ${id}`);
  for (const l of (await c.tx.query('SELECT task_id FROM event_tasks WHERE event_id = $1', [id])).rows) await unlinkEventTask(c, id, l.task_id);
  await c.tx.query('DELETE FROM events WHERE id = $1', [id]);
  await audit(c, 'event', id, 'delete', before, null);
}

export async function linkEventTask(c: Ctx, eventId: string, taskId: string): Promise<void> {
  const r = await c.tx.query('INSERT INTO event_tasks (event_id, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [eventId, taskId]);
  if (r.rowCount) await audit(c, 'event_task', `${eventId}:${taskId}`, 'create', null, { event_id: eventId, task_id: taskId });
}

export async function unlinkEventTask(c: Ctx, eventId: string, taskId: string): Promise<void> {
  const r = await c.tx.query('DELETE FROM event_tasks WHERE event_id = $1 AND task_id = $2', [eventId, taskId]);
  if (r.rowCount) await audit(c, 'event_task', `${eventId}:${taskId}`, 'delete', { event_id: eventId, task_id: taskId }, null);
}

// ---------------------------------------------------------------- undo

export interface AuditRow {
  id: number;
  changeset: string;
  at: string;
  actor: string | null;
  via: Via;
  because: string | null;
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
  because: (r.because as string) ?? null,
  entity: r.entity as Entity,
  entityId: r.entity_id as string,
  action: r.action as AuditRow['action'],
  before: (r.before as Record<string, unknown>) ?? null,
  after: (r.after as Record<string, unknown>) ?? null,
  undone: r.undone as boolean,
});

export async function listAudit(q: Q, f: { changeset?: string; because?: string; since?: string; via?: string; limit?: number } = {}): Promise<AuditRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.changeset) where.push(`changeset = $${args.push(f.changeset)}`);
  if (f.because) where.push(`because = $${args.push(f.because)}`);
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
    if (a.entity === 'event_task') {
      const { event_id, task_id } = (a.before ?? a.after) as { event_id: string; task_id: string };
      if (a.action === 'create') await unlinkEventTask(c, event_id, task_id);
      else if ((await c.tx.query('SELECT 1 FROM events WHERE id = $1', [event_id])).rowCount && (await c.tx.query('SELECT 1 FROM nodes WHERE id = $1', [task_id])).rowCount) await linkEventTask(c, event_id, task_id);
      continue;
    }
    const table = TABLE[a.entity];
    const current = await snapshot(c.tx, a.entity, a.entityId);
    if (a.action === 'create') {
      if (!current) continue;
      if (a.entity === 'node') await removeNode(c, a.entityId);
      else if (a.entity === 'edge') await removeEdge(c, a.entityId);
      else await removeEvent(c, a.entityId);
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
