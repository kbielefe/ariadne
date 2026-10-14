// The steward plug-in: Ariadne as one steward back end (docs/DESIGN.md §6).
//
// The steward daemon runs scripts/steward-backend-ariadne <verb>, which posts its stdin to /api/steward/<verb>:
// - describe: who this back end speaks for, and which receive kinds it handles.
// - publish: the opted-in subtrees as steward items. Built from Node only (never a nodes row, get_node, or an audit
//   snapshot), so private notes never leave this machine.
// - receive: a teammate's ticket or answer becomes nodes here.
//
// Wire shapes follow steward's src/item.rs: snake_case keys, times in Unix seconds, audience = peer ids (empty: pod).
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { decisionLines, readiness, reachable, taskState } from '../shared/graph';
import { type Edge, type Node, type Op, USER_ID } from '../shared/model';
import { ContextBuilder } from './context';
import type { Core } from './core';
import type { Db } from './db';
import { applyOps } from './ops';
import * as s from './store';
import { type Ctx, who } from './store';

// ---------------------------------------------------------------- wire shapes

export type ItemState = 'ready' | 'yours' | 'blocked' | 'waiting' | 'done' | 'dropped';

export interface Item {
  id: string;
  kind: 'work' | 'decision' | 'intent' | 'answer';
  title: string;
  body?: string;
  state?: ItemState;
  repos?: string[];
  branch?: string;
  pr_url?: string;
  paths?: string[];
  published?: boolean;
  relates_to?: string[];
  audience?: string[];
  updated_at: number;
  expires_at?: number;
}

export interface Batch {
  cursor: string;
  upserts: Item[];
  removed: string[];
  /** upserts is everything this back end publishes; anything else it published before is gone. */
  full?: boolean;
}

export interface Describe {
  name: string;
  owner: string;
  areas: string[];
  repos: string[];
  capabilities: string[];
}

/** The receive kinds this back end handles. steward keeps any other kind in its own inbox. */
export const CAPABILITIES = ['ticket', 'answer'];

// steward refuses a body over 16 KiB (src/item.rs MAX_BODY).
const MAX_BODY = 16 * 1024;
const MAX_TITLE = 300;

// ---------------------------------------------------------------- what is shared

/** Steward bookkeeping on a task: attrs.steward when it is an object rather than the opt-in flag. */
export interface StewardAttr {
  /** ask: a teammate's ticket to you. waiting: your ticket to a teammate. answer: an answer nothing here was waiting for. */
  kind?: 'ask' | 'waiting' | 'answer' | 'intent';
  ticket?: string;
  from?: string;
  to?: string;
  answer?: string;
}

export function stewardAttr(n: Node): StewardAttr | null {
  const v = n.attrs.steward;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as StewardAttr) : null;
}

const optedIn = (n: Node) => n.attrs.steward === true;
const isPrivate = (n: Node) => n.attrs.private === true;
/** Made from a teammate's message: their content, not ours to publish as work. */
const imported = (n: Node) => ['ask', 'answer', 'intent'].includes(stewardAttr(n)?.kind ?? '');

/** Opted-in roots (attrs.steward === true) and every task they transitively need, minus attrs.private subtrees and imported tasks. */
export function sharedTasks(byId: ReadonlyMap<string, Node>, edges: readonly Edge[]): Node[] {
  const needs = new Map<string, string[]>();
  for (const e of edges) if (e.kind === 'needs') needs.set(e.src, [...(needs.get(e.src) ?? []), e.dst]);
  const out = new Map<string, Node>();
  const stack = [...byId.values()].filter((n) => n.kind === 'task' && optedIn(n)).map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    const n = byId.get(id);
    // A private or imported task is pruned with everything below it (unless another shared path reaches it).
    if (out.has(id) || !n || n.kind !== 'task' || isPrivate(n) || imported(n)) continue;
    out.set(id, n);
    stack.push(...(needs.get(id) ?? []));
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- mapping Node → Item

const GITHUB = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/;
const PR_URL = /https?:\/\/[^\s)>\]"']+\/pull\/\d+/;
const ANSWER_LINE = /^[ \t]*(?:[-*][ \t]+)?\*\*Answer\b/;
const LABEL_LINE = /^[ \t]*(?:[-*][ \t]+)?\*\*\w/;

/** "https://github.com/Adtran-Kairos/pdp.git" → "Adtran-Kairos/pdp". Anything else is kept as given. */
export function repoName(v: string): string {
  const m = GITHUB.exec(v);
  return m ? `${m[1]}/${m[2]}` : v.trim().replace(/\/+$/, '');
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();

function clip(text: string, max: number): string {
  const b = Buffer.from(text);
  if (b.length <= max) return text;
  return `${b.subarray(0, max - 3).toString('utf8').replace(/�+$/, '')}…`;
}

const shortHash = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 12);

/** An open task's state on the wire. */
function wireState(n: Node, edges: readonly Edge[], byId: ReadonlyMap<string, Node>): ItemState {
  if (n.status !== 'open') return n.status === 'dropped' ? 'dropped' : 'done';
  return taskState(readiness(n, edges, byId));
}

interface Where {
  repos: string[];
  branch?: string;
  pr_url?: string;
  published?: boolean;
}

/** Repos, branch, and PR from the task's attrs, the resources it (or a task that needs it) uses, then a PR link in its body. */
function where(n: Node, ctx: ContextBuilder): Where {
  const repos = new Set<string>();
  const add = (v: unknown) => {
    const x = str(v);
    if (x) repos.add(repoName(x));
  };
  add(n.attrs.repo);
  if (Array.isArray(n.attrs.repos)) n.attrs.repos.forEach(add);
  let branch = str(n.attrs.branch);
  let prUrl = str(n.attrs.pr_url) ?? str(n.attrs.prUrl);
  for (const { item: r } of ctx.task(n.id).resources) {
    const url = str(r.url);
    if (r.type === 'branch') {
      add(r.repo);
      branch ??= str(r.branch);
    } else if (r.type === 'repo') add(url ?? r.name);
    if (url && PR_URL.test(url)) prUrl ??= PR_URL.exec(url)![0];
  }
  prUrl ??= PR_URL.exec(n.body)?.[0];
  if (prUrl) add(prUrl);
  const published = typeof n.attrs.published === 'boolean' ? n.attrs.published : prUrl ? true : undefined;
  return { repos: [...repos].sort(), ...(branch ? { branch } : {}), ...(prUrl ? { pr_url: prUrl } : {}), ...(published != null ? { published } : {}) };
}

const withRepos = (w: Where): Partial<Item> => (w.repos.length ? { repos: w.repos } : {});

function workItems(n: Node, ctx: ContextBuilder, edges: readonly Edge[]): Item[] {
  const w = where(n, ctx);
  const updated_at = secs(n.updatedAt);
  const work: Item = {
    id: n.id,
    kind: 'work',
    title: clip(n.title, MAX_TITLE),
    ...(n.body.trim() ? { body: clip(n.body, MAX_BODY) } : {}),
    state: wireState(n, edges, ctx.nodes),
    ...withRepos(w),
    ...(w.branch ? { branch: w.branch } : {}),
    ...(w.pr_url ? { pr_url: w.pr_url } : {}),
    ...(w.published != null ? { published: w.published } : {}),
    updated_at,
  };
  // Each decision line is its own item, so a teammate's `decisions` query finds it; its id follows the line's text.
  const seen = new Set<string>();
  const decisions: Item[] = [];
  for (const line of decisionLines(n.body)) {
    const id = `${n.id}:decision:${shortHash(line)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const text = line.replace(/^[-*][ \t]+/, '').replace(/\*\*/g, '');
    decisions.push({ id, kind: 'decision', title: clip(text, MAX_TITLE), body: clip(line, MAX_BODY), ...withRepos(w), relates_to: [n.id], updated_at });
  }
  return [work, ...decisions];
}

/** The Answer lines in a body, each with the lines that continue its paragraph. */
export function answerText(body: string): string {
  const out: string[] = [];
  let inAnswer = false;
  for (const line of body.split('\n')) {
    if (ANSWER_LINE.test(line)) inAnswer = true;
    else if (!line.trim() || LABEL_LINE.test(line)) inAnswer = false;
    if (inAnswer) out.push(line);
  }
  return out.join('\n').trim();
}

/** Your answer to a teammate's ticket: an item only the asker gets (steward sends it by letter, not in the feed). */
function answerItem(n: Node): Item | null {
  const st = stewardAttr(n);
  if (st?.kind !== 'ask' || !st.ticket || !st.from) return null;
  const text = answerText(n.body);
  if (!text) return null;
  return {
    id: `${n.id}:answer`,
    kind: 'answer',
    title: clip(`Answer: ${n.title.replace(/^Ask \([^)]*\):\s*/, '')}`, MAX_TITLE),
    body: clip(text, MAX_BODY),
    relates_to: [st.ticket],
    audience: [st.from],
    updated_at: secs(n.updatedAt),
  };
}

/** Everything this back end publishes now. Takes Node only: the type that never carries private notes. */
export function buildItems(nodes: readonly Node[], edges: readonly Edge[]): Item[] {
  const ctx = ContextBuilder.from(nodes, edges);
  const shared = sharedTasks(ctx.nodes, edges).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const answers = nodes.filter((n) => n.kind === 'task').flatMap((n) => answerItem(n) ?? []);
  return [...shared.flatMap((n) => workItems(n, ctx, edges)), ...answers];
}

// ---------------------------------------------------------------- verbs

export async function describe(core: Core): Promise<Describe> {
  const { nodes, edges } = await core.graph();
  const you = nodes.find((n) => n.id === USER_ID);
  const areas = Array.isArray(you?.attrs.areas) ? you.attrs.areas.filter((a): a is string => typeof a === 'string') : [];
  const repos = [...new Set(buildItems(nodes, edges).flatMap((i) => i.repos ?? []))].sort();
  return { name: 'ariadne', owner: you?.title ?? 'You', areas, repos, capabilities: CAPABILITIES };
}

/**
 * The cursor is "<newest audit id>-<audit row count>": every change to the graph adds audit rows, and the count also
 * catches a transaction that commits after a newer id was seen. Nothing changed since `since`: no upserts. Otherwise
 * the whole current set, with `full: true` (steward drops unchanged items and removes what is missing).
 */
async function auditCursor(db: Db): Promise<{ cursor: string; maxId: number }> {
  const r = await db.query('SELECT coalesce(max(id), 0) AS max, count(*) AS n FROM audit');
  const maxId = Number(r.rows[0].max);
  return { cursor: `${maxId}-${Number(r.rows[0].n)}`, maxId };
}

const CURSOR = /^(\d+)-(\d+)$/;

export async function publish(core: Core, since?: string | null): Promise<Batch> {
  const { cursor, maxId } = await auditCursor(core.db);
  if (since === cursor) return { cursor, upserts: [], removed: [] };
  const { nodes, edges } = await core.graph();
  const upserts = buildItems(nodes, edges);
  const prev = since ? CURSOR.exec(since) : null;
  const removed = prev ? await removedSince(core.db, Number(prev[1]), Math.max(maxId, Number(prev[1])), nodes, edges, new Set(upserts.map((i) => i.id))) : [];
  return { cursor, upserts, removed, full: true };
}

/**
 * Tasks touched since the cursor (or below one that was, e.g. an un-opted root) that are no longer shared: deleted,
 * un-opted, made private, or cut loose. Best effort, for consumers that ignore `full`; it may name ids that were never
 * published (ids only, never content). Reads only audit ids and edge endpoints, never a node snapshot.
 */
async function removedSince(db: Db, after: number, upTo: number, nodes: readonly Node[], edges: readonly Edge[], shared: Set<string>): Promise<string[]> {
  const r = await db.query(
    `SELECT entity_id::text AS id FROM audit WHERE id > $1 AND id <= $2 AND entity = 'node'
     UNION SELECT coalesce(after, before)->>'src' FROM audit WHERE id > $1 AND id <= $2 AND entity = 'edge'
     UNION SELECT coalesce(after, before)->>'dst' FROM audit WHERE id > $1 AND id <= $2 AND entity = 'edge'`,
    [after, upTo],
  );
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const touched = new Set<string>();
  for (const { id } of r.rows as { id: string | null }[]) if (id) for (const d of reachable(edges, id, { kinds: ['needs'] }).keys()) touched.add(d);
  return [...touched].filter((id) => !shared.has(id) && (!byId.has(id) || byId.get(id)!.kind === 'task')).sort();
}

// ---------------------------------------------------------------- receive

const Ticket = z.object({
  id: z.string().min(1).max(200),
  from: z.string().min(1),
  to: z.string().optional(),
  kind: z.string().optional(),
  question: z.string().min(1),
  context: z.string().nullish(),
  repo: z.string().nullish(),
  relates_to: z.array(z.string()).optional(),
  created_at: z.union([z.number(), z.string()]).optional(),
});
const InItem = z.object({
  id: z.string().min(1).max(200),
  kind: z.string().optional(),
  title: z.string().min(1),
  body: z.string().nullish(),
  relates_to: z.array(z.string()).optional(),
  updated_at: z.number().optional(),
});
// `from` is the author's steward peer id; `from_name` (optional) names a person this creates.
const Inbound = z.union([
  z.object({ ticket: Ticket, from_name: z.string().optional() }),
  z.object({ answer: InItem, from: z.string().min(1).optional(), from_name: z.string().optional() }),
]);
export type Inbound = z.infer<typeof Inbound>;

export async function receive(core: Core, msg: unknown): Promise<{ localRef: string }> {
  const m = Inbound.parse(msg);
  if ('ticket' in m) return { localRef: await core.run(who(null, 'steward'), (c) => receiveTicket(c, m.ticket, m.from_name)) };
  return { localRef: await core.run(who(null, 'steward'), (c) => receiveAnswer(c, m.answer, m.from, m.from_name)) };
}

/** The person this steward peer is (attrs.peer), created if missing. Later changes in the batch are theirs in the audit log. */
export async function personForPeer(c: Ctx, peer: string, name?: string): Promise<Node> {
  const r = await c.tx.query(`SELECT * FROM nodes WHERE kind = 'person' AND attrs->>'peer' = $1 ORDER BY created_at LIMIT 1`, [peer]);
  const person = r.rows[0]
    ? s.mapNode(r.rows[0])
    : await s.getNode(
        c.tx,
        (await applyOps(c, [{ op: 'create_node', kind: 'person', title: str(name) ?? `Steward peer …${peer.slice(-8)}`, body: 'A pod member, added when steward first brought something from them.', attrs: { peer } }]))[0]!.id,
      );
  c.who.actor = person.id;
  return person;
}

const today = (at?: number) => new Date(at ? at * 1000 : Date.now()).toISOString().slice(0, 10);

async function findTask(c: Ctx, where: string, args: unknown[]): Promise<Node | null> {
  const r = await c.tx.query(`SELECT * FROM nodes WHERE kind = 'task' AND ${where} ORDER BY (status = 'open') DESC, created_at LIMIT 1`, args);
  return r.rows[0] ? s.mapNode(r.rows[0]) : null;
}

/** Open tasks named by item ids from our own feed ("<node id>" or "<node id>:decision:…"). */
async function relatedTasks(c: Ctx, itemIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(itemIds.map((i) => i.split(':')[0]!).filter((i) => z.uuid().safeParse(i).success))];
  if (!ids.length) return [];
  const r = await c.tx.query(`SELECT id FROM nodes WHERE kind = 'task' AND status = 'open' AND id::text = ANY($1)`, [ids]);
  return r.rows.map((x) => x.id as string);
}

/** A teammate's ticket → "Ask (Name): …", waiting on You (your queue), needed by the tasks it is about. Idempotent per ticket id. */
async function receiveTicket(c: Ctx, t: z.infer<typeof Ticket>, fromName?: string): Promise<string> {
  const person = await personForPeer(c, t.from, fromName);
  const existing = await findTask(c, `attrs->'steward'->>'kind' = 'ask' AND attrs->'steward'->>'ticket' = $1`, [t.id]);
  if (existing) return existing.id;
  const you = await s.getNode(c.tx, USER_ID);
  const body = [
    t.question.trim(),
    '',
    `**From:** ${person.title} (steward peer \`${t.from}\`), ticket \`${t.id}\`${t.kind ? ` (${t.kind})` : ''}`,
    ...(str(t.repo) ? [`**Repo:** ${t.repo}`] : []),
    ...(str(t.context) ? ['', `**Context:** ${t.context!.trim()}`] : []),
    '',
    `**Done when:** answered here with a line "**Answer (${you.title}, YYYY-MM-DD):** ..." and closed. Steward sends the answer lines to ${person.title} only.`,
  ].join('\n');
  const ops: Op[] = [
    { op: 'create_node', ref: 'ask', kind: 'task', title: clip(`Ask (${person.title}): ${oneLine(t.question)}`, 160), body, attrs: { steward: { kind: 'ask', ticket: t.id, from: t.from } } },
    { op: 'create_edge', src: '$ask', kind: 'waits_on', dst: USER_ID },
    { op: 'create_edge', src: '$ask', kind: 'involves', dst: person.id, note: 'asked through steward' },
    ...(await relatedTasks(c, t.relates_to ?? [])).map((id): Op => ({ op: 'create_edge', src: id, kind: 'needs', dst: '$ask' })),
  ];
  return (await applyOps(c, ops))[0]!.id;
}

/**
 * A teammate's answer → an Answer line on your "Waiting on" leaf for that ticket (attrs.steward.ticket), which it then
 * closes. An answer nothing here waits for becomes an "Answer (Name): …" task in your queue, so it isn't lost.
 */
async function receiveAnswer(c: Ctx, a: z.infer<typeof InItem>, from?: string, fromName?: string): Promise<string> {
  const person = from ? await personForPeer(c, from, fromName) : null;
  const name = person?.title ?? str(fromName) ?? 'teammate';
  const line = `**Answer (${name}, ${today(a.updated_at)}):** ${(str(a.body) ?? a.title).trim()}`;
  const tickets = a.relates_to ?? [];
  const leaf = tickets.length ? await findTask(c, `attrs->'steward'->>'ticket' = ANY($1) AND coalesce(attrs->'steward'->>'kind', '') NOT IN ('ask', 'answer', 'intent')`, [tickets]) : null;
  if (leaf) {
    const ops: Op[] = [];
    if (!leaf.body.includes(line)) ops.push({ op: 'update_node', id: leaf.id, append: line });
    if (leaf.status === 'open') ops.push({ op: 'update_node', id: leaf.id, status: 'done' });
    if (ops.length) await applyOps(c, ops);
    return leaf.id;
  }
  const existing = await findTask(c, `attrs->'steward'->>'kind' = 'answer' AND attrs->'steward'->>'answer' = $1`, [a.id]);
  if (existing) return existing.id;
  const ops: Op[] = [
    {
      op: 'create_node',
      ref: 'ans',
      kind: 'task',
      title: clip(`Answer (${name}): ${oneLine(a.title)}`, 160),
      body: `${line}\n\nNo open "Waiting on" task here had ticket ${tickets.map((t) => `\`${t}\``).join(', ') || '(none given)'}. Read it, act on it, and close this.`,
      attrs: { steward: { kind: 'answer', answer: a.id, ...(tickets[0] ? { ticket: tickets[0] } : {}), ...(from ? { from } : {}) } },
    },
    { op: 'create_edge', src: '$ans', kind: 'waits_on', dst: USER_ID },
    ...(person ? [{ op: 'create_edge', src: '$ans', kind: 'involves', dst: person.id } as Op] : []),
  ];
  return (await applyOps(c, ops))[0]!.id;
}
