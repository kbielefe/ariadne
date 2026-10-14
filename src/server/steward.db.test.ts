import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER_ID } from '../shared/model';
import { freshCore } from '../test/db';
import { registerApi } from './api';
import type { Core } from './core';
import type { Db } from './db';
import { type Batch, dropExpiredIntents, type Item } from './steward';
import { who } from './store';

let db: Db;
let core: Core;
let app: FastifyInstance;
let base: string;

beforeEach(async () => {
  ({ db, core } = await freshCore());
  app = Fastify();
  const port = 40000 + Math.floor(Math.random() * 1000);
  registerApi(app, core, { allowedHosts: [`127.0.0.1:${port}`] });
  await app.listen({ host: '127.0.0.1', port });
  base = `http://127.0.0.1:${port}`;
});
afterEach(async () => {
  await app.close();
  await db.end();
});

const SCRIPT = resolve(import.meta.dirname, '../../scripts/steward-backend-ariadne');

/** Runs the exec back end the way the steward daemon does (async: the server answering it is in this process). */
function backend(verb: string, input?: unknown): Promise<{ code: number | null; out: any; err: string }> {
  return new Promise((done, fail) => {
    const p = spawn(SCRIPT, [verb], { env: { ...process.env, ARIADNE_URL: base } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', fail);
    p.on('close', (code) => done({ code, out: out ? JSON.parse(out) : null, err }));
    p.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

async function steward<T>(verb: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`${base}/api/steward/${verb}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

const ops = async (list: unknown[]) => (await core.apply(who(USER_ID, 'ui'), list)).results;
const ids = (b: Batch) => b.upserts.map((i) => i.id);
const SECRET = 'PRIVATE-NOTE-SECRET-xyzzy';

/** An opted-in PDP root with a subtask (and a private subtree), plus a task that is not shared. */
async function seed() {
  const r = await ops([
    { op: 'create_node', ref: 'root', kind: 'task', title: 'PDP: filter tools/list', body: 'Hide tools the caller cannot invoke.\n\n**Decision (Karl, 2026-10-14):** filter in the PDP, not the gateway', privateNotes: `Will is slow ${SECRET}`, privateReason: 'opinion about a person', attrs: { steward: true } },
    { op: 'create_node', ref: 'sub', kind: 'task', title: 'PDP: entitlement lookup', body: 'See https://github.com/Adtran-Kairos/policy-decision-point/pull/15', privateNotes: SECRET, privateReason: 'unannounced plan' },
    { op: 'create_node', ref: 'priv', kind: 'task', title: 'PDP: reorg fallout', attrs: { private: true } },
    { op: 'create_node', ref: 'below', kind: 'task', title: 'Below the private one' },
    { op: 'create_node', ref: 'other', kind: 'task', title: 'Unshared work' },
    { op: 'create_node', ref: 'br', kind: 'resource', title: 'wb/tools-list-filter', attrs: { type: 'branch', repo: 'https://github.com/Adtran-Kairos/policy-decision-point.git', branch: 'kb/tools-filter' } },
    { op: 'create_edge', src: '$root', kind: 'needs', dst: '$sub' },
    { op: 'create_edge', src: '$root', kind: 'needs', dst: '$priv' },
    { op: 'create_edge', src: '$priv', kind: 'needs', dst: '$below' },
    { op: 'create_edge', src: '$root', kind: 'uses', dst: '$br' },
  ]);
  const id = (ref: string) => r.find((x) => x.ref === ref)!.id;
  return { root: id('root'), sub: id('sub'), priv: id('priv'), below: id('below'), other: id('other') };
}

describe('steward publish', () => {
  it('shares only opted-in subtrees, minus private ones, mapped to items', async () => {
    const t = await seed();
    const b = await steward<Batch>('publish');
    expect(b.full).toBe(true);
    const work = b.upserts.filter((i) => i.kind === 'work');
    expect(work.map((i) => i.id).sort()).toEqual([t.root, t.sub].sort());
    const root = work.find((i) => i.id === t.root)!;
    expect(root).toMatchObject({ title: 'PDP: filter tools/list', state: 'waiting', repos: ['Adtran-Kairos/policy-decision-point'], branch: 'kb/tools-filter' });
    expect(typeof root.updated_at).toBe('number');
    // The subtask inherits the branch; its body names the PR.
    expect(work.find((i) => i.id === t.sub)).toMatchObject({ state: 'ready', branch: 'kb/tools-filter', pr_url: 'https://github.com/Adtran-Kairos/policy-decision-point/pull/15', published: true });
    const decision = b.upserts.find((i) => i.kind === 'decision')!;
    expect(decision).toMatchObject({ relates_to: [t.root], title: 'Decision (Karl, 2026-10-14): filter in the PDP, not the gateway' });
  });

  it('never carries private notes, through the API or the exec script', async () => {
    await seed();
    const viaApi = await steward<Batch>('publish');
    expect(JSON.stringify(viaApi)).not.toContain(SECRET);
    const viaScript = await backend('publish', {});
    expect(viaScript.code).toBe(0);
    expect(viaScript.out.upserts.length).toBe(viaApi.upserts.length);
    expect(JSON.stringify(viaScript.out)).not.toContain(SECRET);
    expect(JSON.stringify(await steward('describe'))).not.toContain(SECRET);
  });

  it('a cursor: nothing new means no upserts; a change resends the full set; un-opting removes', async () => {
    const t = await seed();
    const first = await steward<Batch>('publish', { since: null });
    expect(first.removed).toEqual([]);
    const same = await steward<Batch>('publish', { since: first.cursor });
    expect(same).toEqual({ cursor: first.cursor, upserts: [], removed: [] });

    await ops([
      { op: 'update_node', id: t.sub, status: 'done' },
      { op: 'update_node', id: t.priv, status: 'dropped' },
    ]);
    const after = await steward<Batch>('publish', { since: first.cursor });
    expect(after.cursor).not.toBe(first.cursor);
    expect(after.full).toBe(true);
    // Closed work stays, with its state; the root is ready now (the private task it needed is dropped).
    expect(after.upserts.find((i) => i.id === t.sub)?.state).toBe('done');
    expect(after.upserts.find((i) => i.id === t.root)?.state).toBe('ready');

    await ops([{ op: 'update_node', id: t.root, attrs: { steward: null } }]);
    const gone = await steward<Batch>('publish', { since: after.cursor });
    expect(gone.upserts).toEqual([]);
    expect(gone.removed).toEqual(expect.arrayContaining([t.root, t.sub]));
    expect(gone.removed).not.toContain(t.other);
  });
});

describe('steward receive', () => {
  const WILL = '12D3KooWWill';

  it('a ticket becomes an Ask leaf in your queue, needed by the task it is about; answering it publishes to the asker only', async () => {
    const t = await seed();
    const ticket = { id: '01JTICKET', from: WILL, to: 'me', kind: 'question', question: 'Are you filtering tools/list?', context: 'About to start', repo: 'Adtran-Kairos/policy-decision-point', relates_to: [t.root], created_at: 1_760_000_000 };
    const { localRef } = await steward<{ localRef: string }>('receive', { ticket, from_name: 'Will' });
    const d = await core.nodeDetail(localRef);
    expect(d.node.title).toBe('Ask (Will): Are you filtering tools/list?');
    expect(d.readiness?.state).toBe('yours');
    expect(d.node.attrs.steward).toEqual({ kind: 'ask', ticket: '01JTICKET', from: WILL });
    expect(d.edges.some((e) => e.kind === 'needs' && e.src === t.root && e.dst === localRef)).toBe(true);
    const will = d.neighbors.find((n) => n.kind === 'person' && n.id !== USER_ID)!;
    expect(will).toMatchObject({ title: 'Will', attrs: { peer: WILL } });
    // The audit log says who.
    expect((await db.query(`SELECT DISTINCT actor, via FROM audit WHERE entity_id = $1`, [localRef])).rows).toEqual([{ actor: will.id, via: 'steward' }]);

    // Redelivery is harmless; the same person is reused.
    expect((await steward<{ localRef: string }>('receive', { ticket })).localRef).toBe(localRef);
    expect((await core.graph()).nodes.filter((n) => n.kind === 'person' && n.attrs.peer === WILL)).toHaveLength(1);

    // The ask itself is not published as work, even inside a shared subtree.
    expect(ids(await steward<Batch>('publish'))).not.toContain(localRef);

    await ops([{ op: 'update_node', id: localRef, append: '**Answer (Karl, 2026-10-14):** yes, on kb/tools-filter; build on it.', status: 'done' }]);
    const answer = (await steward<Batch>('publish')).upserts.find((i) => i.kind === 'answer') as Item;
    expect(answer).toMatchObject({ id: `${localRef}:answer`, relates_to: ['01JTICKET'], audience: [WILL], body: '**Answer (Karl, 2026-10-14):** yes, on kb/tools-filter; build on it.' });
  });

  it('an answer closes the matching Waiting on leaf, and an unmatched one lands in your queue', async () => {
    const r = await ops([
      { op: 'create_node', ref: 'will', kind: 'person', title: 'Will', attrs: { peer: WILL } },
      { op: 'create_node', ref: 'wait', kind: 'task', title: 'Waiting on Will: does the gateway filter?', attrs: { steward: { kind: 'waiting', ticket: '01JMINE', to: WILL } } },
      { op: 'create_edge', src: '$wait', kind: 'waits_on', dst: '$will' },
    ]);
    const wait = r.find((x) => x.ref === 'wait')!.id;
    const answer = { id: 'a1', kind: 'answer', title: 'Re: gateway', body: 'No, only the PDP.', relates_to: ['01JMINE'], updated_at: 1_760_400_000 };
    const out = await backend('receive', { answer, from: WILL });
    expect(out.code).toBe(0);
    expect(out.out.localRef).toBe(wait);
    const d = await core.nodeDetail(wait);
    expect(d.node.status).toBe('done');
    expect(d.node.body).toContain('**Answer (Will, 2025-10-14):** No, only the PDP.');
    // Again: no second line.
    await steward('receive', { answer, from: WILL });
    expect((await core.nodeDetail(wait)).node.body.match(/\*\*Answer/g)).toHaveLength(1);

    const stray = await steward<{ localRef: string }>('receive', { answer: { ...answer, id: 'a2', relates_to: ['01JUNKNOWN'] }, from: WILL });
    const s = await core.nodeDetail(stray.localRef);
    expect(s.node.title).toBe('Answer (Will): Re: gateway');
    expect(s.readiness?.state).toBe('yours');
  });

  it('describe names the owner, repos, and capabilities; only the local daemon may call', async () => {
    await seed();
    await ops([{ op: 'update_node', id: USER_ID, title: 'Karl', attrs: { areas: ['PDP'] } }]);
    const d = await backend('describe');
    expect(d.code).toBe(0);
    expect(d.out).toEqual({ name: 'ariadne', owner: 'Karl', areas: ['PDP'], repos: ['Adtran-Kairos/policy-decision-point'], capabilities: ['ticket', 'answer', 'intent'] });
    expect((await backend('frobnicate', {})).code).toBe(3);

    const browser = await fetch(`${base}/api/steward/publish`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
    expect(browser.status).toBe(403);
    // fetch can't set Host, so inject.
    const otherHost = await app.inject({ method: 'POST', url: '/api/steward/publish', headers: { host: 'evil.example:80', 'content-type': 'application/json' }, payload: '{}' });
    expect(otherHost.statusCode).toBe(421);
    const bad = await fetch(`${base}/api/steward/receive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bogus: 1 }) });
    expect(bad.status).toBe(400);
  });
});

describe('steward intents', () => {
  const BRYAN = '12D3KooWBryan';
  const now = () => Math.floor(Date.now() / 1000);
  const intent = (o: Record<string, unknown> = {}) => ({ id: 'i1', kind: 'intent', title: 'PDP: cache entitlements', body: 'Caching lookups per session.', repos: ['Adtran-Kairos/policy-decision-point'], branch: 'bw/cache', paths: ['src/pdp/cache.py'], updated_at: now(), expires_at: now() + 3600, ...o });

  it('lands as a theirs task off the teammate\'s person node (created if missing), and updates in place', async () => {
    const { localRef } = await steward<{ localRef: string }>('receive', { intent: intent(), from: BRYAN, from_name: 'Bryan' });
    const d = await core.nodeDetail(localRef);
    expect(d.node).toMatchObject({ title: 'Intent (Bryan): PDP: cache entitlements', status: 'open' });
    expect(d.node.body).toContain('**Branch:** bw/cache');
    expect(d.node.attrs.steward).toMatchObject({ kind: 'intent', peer: BRYAN, itemId: 'i1' });
    expect(Date.parse((d.node.attrs.steward as { expiresAt: string }).expiresAt)).toBeGreaterThan(Date.now());
    const bryan = d.neighbors.find((n) => n.kind === 'person')!;
    expect(bryan).toMatchObject({ title: 'Bryan', attrs: { peer: BRYAN } });
    expect(d.edges).toEqual([expect.objectContaining({ src: bryan.id, kind: 'working_on', dst: localRef })]);
    // Nothing below it and nothing it waits on, yet never ready for you.
    expect(d.readiness).toMatchObject({ ready: false, state: 'theirs', theirs: [bryan.id] });

    const again = await steward<{ localRef: string }>('receive', { intent: intent({ title: 'PDP: cache entitlements per tenant' }), from: BRYAN });
    expect(again.localRef).toBe(localRef);
    expect((await core.nodeDetail(localRef)).node.title).toBe('Intent (Bryan): PDP: cache entitlements per tenant');
    const g = await core.graph();
    expect(g.nodes.filter((n) => n.title.startsWith('Intent ('))).toHaveLength(1);
    expect(g.edges.filter((e) => e.kind === 'working_on')).toHaveLength(1);
    // Never published back: it is Bryan's.
    expect((await steward<Batch>('publish')).upserts).toEqual([]);
  });

  it('is dropped on expiry: at once if it arrives expired, otherwise by the sweep', async () => {
    const stale = await steward<{ localRef: string }>('receive', { intent: intent({ id: 'old', expires_at: now() - 60 }), from: BRYAN });
    expect((await core.nodeDetail(stale.localRef)).node.status).toBe('dropped');

    const { localRef } = await steward<{ localRef: string }>('receive', { intent: intent(), from: BRYAN });
    expect(await dropExpiredIntents(core)).toEqual([]);
    expect(await dropExpiredIntents(core, new Date(Date.now() + 2 * 3600_000))).toEqual([localRef]);
    const d = await core.nodeDetail(localRef);
    expect(d.node.status).toBe('dropped');
    expect(d.node.body).toContain('the intent expired; dropped by steward');
    // The author closing it closes it here too; a renewed one reopens.
    await steward('receive', { intent: intent({ expires_at: now() + 7200 }), from: BRYAN });
    expect((await core.nodeDetail(localRef)).node.status).toBe('open');
    await steward('receive', { intent: intent({ expires_at: now() + 7200, state: 'done' }), from: BRYAN });
    expect((await core.nodeDetail(localRef)).node.status).toBe('done');
  });

  it('a task someone else is working on is never reported as newly ready', async () => {
    const r = await ops([
      { op: 'create_node', ref: 'ann', kind: 'person', title: 'Ann' },
      { op: 'create_node', ref: 't', kind: 'task', title: 'Ann\'s rollout' },
      { op: 'create_node', ref: 'sub', kind: 'task', title: 'Prep' },
      { op: 'create_edge', src: '$t', kind: 'needs', dst: '$sub' },
      { op: 'create_edge', src: '$ann', kind: 'working_on', dst: '$t' },
    ]);
    const sub = r.find((x) => x.ref === 'sub')!.id;
    expect((await core.apply(who(USER_ID, 'ui'), [{ op: 'update_node', id: sub, status: 'done' }])).nowReady).toEqual([]);
    // working_on goes from a person or team to a task only.
    await expect(ops([{ op: 'create_edge', src: sub, kind: 'working_on', dst: r.find((x) => x.ref === 't')!.id }])).rejects.toThrow(/working_on goes from person\/team to task/);
  });
});
