import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshCore } from '../test/db';
import { ANALYST_ID, USER_ID } from '../shared/model';
import { registerApi } from './api';
import type { Core } from './core';
import type { Db } from './db';
import * as s from './store';
import { who } from './store';

let db: Db;
let core: Core;
let app: FastifyInstance;
let base: string;

beforeEach(async () => {
  ({ db, core } = await freshCore());
  app = Fastify();
  const port = 39000 + Math.floor(Math.random() * 1000);
  registerApi(app, core, { allowedHosts: [`127.0.0.1:${port}`] });
  await app.listen({ host: '127.0.0.1', port });
  base = `http://127.0.0.1:${port}`;
});
afterEach(async () => {
  await app.close();
  await db.end();
});

async function mcp() {
  const client = new Client({ name: 'test-claude-code', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const call = async <T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown>): Promise<T> => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return r.structuredContent as T;
};

describe('MCP', () => {
  it('lets the analyst build the graph, leave you a question, and see your answer', async () => {
    const client = await mcp();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['apply_ops', 'assign', 'ask_user', 'tell_user', 'decide', 'graph', 'undo']));
    expect(tools.map((t) => t.name)).not.toContain('reply');

    const r = await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          { op: 'create_node', ref: 'root', kind: 'task', title: 'Ship v2' },
          { op: 'create_node', ref: 'a', kind: 'task', title: 'Schema' },
          { op: 'create_edge', src: '$root', kind: 'needs', dst: '$a' },
        ],
      },
    });
    expect(r.isError).toBeFalsy();
    const root = (r.structuredContent as { results: { ref?: string; id: string }[] }).results.find((x) => x.ref === 'root')!.id;

    const bad = await client.callTool({ name: 'apply_ops', arguments: { ops: [{ op: 'create_edge', src: root, kind: 'uses', dst: root }] } });
    expect(bad.isError).toBe(true);

    const g = await client.callTool({ name: 'graph', arguments: { from: root } });
    expect((g.structuredContent as { nodes: { title: string }[] }).nodes.map((n) => n.title).sort()).toEqual(['Schema', 'Ship v2']);

    const { id: cardId } = await call<{ id: string }>(client, 'ask_user', {
      tasks: [root],
      body: 'Two subtasks so far.',
      card: { kind: 'approval', title: 'Approve the breakdown?', actions: [{ id: 'yes', label: 'Approve', style: 'primary' }, { id: 'no', label: 'Change it' }] },
    });

    // A session claims the card and asks you; your answer goes back to the Analyst.
    const got = await call<{ brief: string }>(client, 'claim_assignment', { eventId: cardId });
    expect(got.brief).toContain('Ask the user: Approve the breakdown?');
    expect(got.brief).toContain('Approve / Change it');
    await call(client, 'submit_result', { eventId: cardId, status: 'done', body: 'Approve' });
    const events = await call<{ items: { from: string; body: string }[] }>(client, 'list_events', { actor: ANALYST_ID, kind: 'report' });
    expect(events.items).toMatchObject([{ from: 'You (the user)', body: 'Approve' }]);

    // Undo the Analyst's changes from the history.
    const hist = await call<{ items: { changeset: string; entity: string }[] }>(client, 'history', {});
    const cs = hist.items.find((h) => h.entity === 'node')!.changeset;
    await call(client, 'undo', { changeset: cs });
    expect((await core.graph()).nodes.filter((n) => n.kind === 'task')).toEqual([]);
    await client.close();
  });
});

describe('claims', () => {
  it('lists what is waiting, claims each item once, and takes results whatever the claim state', async () => {
    const [agent, , , sub, loose] = (
      await core.ops(who(USER_ID, 'ui'), [
        { op: 'create_node', ref: 'cc', kind: 'agent', title: 'Coder', attrs: { interactive: true } },
        { op: 'create_edge', src: '$cc', kind: 'reports_to', dst: ANALYST_ID },
        { op: 'create_node', ref: 'r', kind: 'resource', title: 'ariadne', attrs: { type: 'repo', url: 'https://github.com/kb/ariadne' } },
        { op: 'create_node', ref: 'root', kind: 'task', title: 'Ship v2' },
        { op: 'create_node', ref: 'sub', kind: 'task', title: 'Add claims' },
        { op: 'create_node', ref: 'loose', kind: 'task', title: 'Write the memo' },
        { op: 'create_edge', src: '$root', kind: 'uses', dst: '$r' },
        { op: 'create_edge', src: '$root', kind: 'needs', dst: '$sub' },
      ])
    )
      .filter((x) => x.ref)
      .map((x) => x.id) as string[];
    const memo = await core.send(who(ANALYST_ID, 'mcp'), { kind: 'assign', recipient: agent!, body: 'Draft the memo', tasks: [loose!] });
    const code = await core.send(who(ANALYST_ID, 'mcp'), { kind: 'assign', recipient: agent!, body: 'Add claims', tasks: [sub!] });
    const fyi = await core.send(who(ANALYST_ID, 'mcp'), { kind: 'report', recipient: USER_ID, body: 'The memo is next.' });

    const client = await mcp();
    type Item = { eventId: string; as: string; repos: { name: string; url?: string }[]; tasks: { title: string }[] };
    const list = async () => (await call<{ items: Item[] }>(client, 'list_assignments', {})).items;
    // Things for you first, then oldest; each with the repos its tasks use (inherited).
    const items = await list();
    expect(items.map((i) => i.eventId)).toEqual([fyi.id, memo.id, code.id]);
    expect(items[0]!.as).toBe('You (the user)');
    expect(items[2]).toMatchObject({ as: 'Coder', tasks: [{ title: 'Add claims' }], repos: [{ name: 'ariadne', url: 'https://github.com/kb/ariadne' }] });
    expect(items[1]!.repos).toEqual([]);

    // A claim is exclusive and takes the item off the list.
    const got = await call<{ brief: string }>(client, 'claim_assignment', { eventId: code.id });
    expect(got.brief).toContain('submit_result');
    expect((await client.callTool({ name: 'claim_assignment', arguments: { eventId: code.id } })).isError).toBe(true);
    expect((await list()).map((i) => i.eventId)).toEqual([fyi.id, memo.id]);
    expect(await core.listTimers({ kind: 'claim_check' })).toHaveLength(1);

    // Released work goes back on the list.
    await call(client, 'claim_assignment', { eventId: memo.id });
    await call(client, 'release_assignment', { eventId: memo.id });
    expect((await list()).map((i) => i.eventId)).toContain(memo.id);

    // Results: invalid ones are refused; a valid one closes the assignment and reaches the Analyst with its proposals.
    expect((await client.callTool({ name: 'submit_result', arguments: { eventId: code.id, status: 'done', body: 'x', proposals: [{ op: 'explode' }] } })).isError).toBe(true);
    expect((await client.callTool({ name: 'submit_result', arguments: { eventId: code.id, status: 'done' } })).isError).toBe(true);
    await call(client, 'submit_result', { eventId: code.id, status: 'done', body: 'Added claims.', proposals: [{ op: 'create_node', kind: 'task', title: 'Document it' }] });
    expect(await s.getEvent(db, code.id)).toMatchObject({ state: 'closed', delivery: 'delivered' });
    const [report] = await s.listEvents(db, { kind: 'report', actor: agent! });
    expect(report).toMatchObject({ sender: agent, recipient: ANALYST_ID, replyTo: code.id, body: 'Added claims.', proposals: [{ title: 'Document it' }], delivery: 'pending' });
    expect(await core.listTimers({ kind: 'claim_check' })).toEqual([]);
    // Completed or unknown: errors.
    expect((await client.callTool({ name: 'submit_result', arguments: { eventId: code.id, status: 'done', body: 'again' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'submit_result', arguments: { eventId: '99999999-9999-4999-8999-999999999999', status: 'done', body: 'x' } })).isError).toBe(true);

    // A result for an item no one claimed (another session, or a lost claim) still counts.
    await call(client, 'submit_result', { eventId: memo.id, status: 'progress', body: 'Outline done.' });
    expect(await s.getEvent(db, memo.id)).toMatchObject({ state: 'open', delivery: 'pending' });
    await call(client, 'submit_result', { eventId: memo.id, status: 'done', body: 'Memo drafted.' });
    expect(await s.getEvent(db, memo.id)).toMatchObject({ state: 'closed', delivery: 'delivered' });

    // The Analyst handles the agent's report: done marks it handled, and it leaves the list.
    await call(client, 'claim_assignment', { eventId: report!.id });
    await call(client, 'submit_result', { eventId: report!.id, status: 'done' });
    expect((await s.getEvent(db, report!.id)).delivery).toBe('delivered');
    expect((await list()).map((i) => i.eventId)).not.toContain(report!.id);

    // The note for you: the brief says to tell you; done marks it delivered.
    const brief = await call<{ brief: string }>(client, 'claim_assignment', { eventId: fyi.id });
    expect(brief.brief).toMatch(/^Notify the user/);
    expect(brief.brief).toContain('The memo is next.');
    await call(client, 'submit_result', { eventId: fyi.id, status: 'done' });
    expect((await s.getEvent(db, fyi.id)).delivery).toBe('delivered');
    await client.close();
  });

  it('releases a stuck claim and tells you; still_working keeps the claim honest', async () => {
    const note = await core.send(who(null, 'core'), { kind: 'report', recipient: ANALYST_ID, body: 'What is next?' });
    const client = await mcp();
    const got = await call<{ brief: string }>(client, 'claim_assignment', { eventId: note.id });
    expect(got.brief).toContain('You are the Analyst');
    expect((await s.getEvent(db, note.id)).delivery).toBe('claimed');

    // Nothing heard: past the deadline Ariadne releases it and tells you. still_working pushes the deadline back.
    const { timesOutAt } = await call<{ timesOutAt: string }>(client, 'still_working', { eventId: note.id, minutes: 60 });
    expect(new Date(timesOutAt).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(await core.fireDue(new Date(Date.now() + 30 * 60_000))).toBe(0);
    expect(await core.fireDue(new Date(Date.now() + 61 * 60_000))).toBe(1);
    expect((await s.getEvent(db, note.id)).delivery).toBe('pending');
    const fyi = (await s.listEvents(db, { kind: 'report', actor: USER_ID })).find((e) => e.sender === null);
    expect(fyi).toMatchObject({ recipient: USER_ID, delivery: 'pending' });
    expect(fyi?.body).toMatch(/Released a stuck claim/);

    // A stuck claim on something for you just goes back on the list, with no notice about the notice.
    await call(client, 'claim_assignment', { eventId: fyi!.id });
    expect(await core.fireDue(new Date(Date.now() + 31 * 60_000))).toBe(1);
    expect((await s.getEvent(db, fyi!.id)).delivery).toBe('pending');
    expect((await s.listEvents(db, { kind: 'report', actor: USER_ID })).filter((e) => e.sender === null)).toHaveLength(1);

    // A session still on it after the claim expired re-claims it with still_working.
    await call(client, 'still_working', { eventId: note.id });
    expect((await s.getEvent(db, note.id)).delivery).toBe('claimed');

    // Done completes it and ends the claim; submit_result then says it's completed.
    await call(client, 'submit_result', { eventId: note.id, status: 'done' });
    expect((await s.getEvent(db, note.id)).delivery).toBe('delivered');
    expect(await core.listTimers()).toEqual([]);
    expect((await client.callTool({ name: 'submit_result', arguments: { eventId: note.id, status: 'done' } })).isError).toBe(true);
    await client.close();
  });

  it('schedules events, cancels them, and sends the due ones', async () => {
    const client = await mcp();
    const keep = await call<{ id: string }>(client, 'schedule_event', { inMinutes: 10, event: { kind: 'report', to: USER_ID, body: 'Stand-up in 5' } });
    const drop = await call<{ id: string }>(client, 'schedule_event', { at: new Date(Date.now() + 5 * 60_000).toISOString(), event: { kind: 'report', to: USER_ID, body: 'Never mind' } });
    expect((await client.callTool({ name: 'schedule_event', arguments: { event: { kind: 'report', to: USER_ID, body: 'when?' } } })).isError).toBe(true);
    await call(client, 'cancel_scheduled', { id: drop.id });
    expect((await call<{ items: { id: string }[] }>(client, 'list_scheduled', {})).items.map((t) => t.id)).toEqual([keep.id]);
    expect(await core.fireDue(new Date(Date.now() + 11 * 60_000))).toBe(1);
    const sent = await s.listEvents(db, { kind: 'report', actor: USER_ID });
    expect(sent.map((e) => [e.sender, e.body])).toEqual([[ANALYST_ID, 'Stand-up in 5']]);
    await client.close();
  });
});

describe('web API', () => {
  it('applies your edits directly, refuses other hosts, and reports bad input', async () => {
    const ok = await post('/api/ops', { ops: [{ op: 'create_node', kind: 'task', title: 'Mine' }] });
    expect(ok.status).toBe(200);
    const bad = await post('/api/ops', { ops: [{ op: 'create_node', kind: 'nope', title: 'x' }] });
    expect(bad.status).toBe(400);
    // fetch can't set Host, so inject.
    const host = await app.inject({ method: 'GET', url: '/api/graph', headers: { host: 'evil.example:80' } });
    expect(host.statusCode).toBe(421);
    const cross = await fetch(`${base}/api/ops`, { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(cross.status).toBe(403);
    const hist = (await (await fetch(`${base}/api/history`)).json()) as { who: string; line: string }[];
    expect(hist).toMatchObject([{ who: 'You (the user)', line: 'created task "Mine"' }]);
  });
});

describe('briefs', () => {
  it('carry the run-until policy set when assigning', async () => {
    const [agent, , task] = (
      await core.ops(who(USER_ID, 'ui'), [
        { op: 'create_node', ref: 'cc', kind: 'agent', title: 'Coder', attrs: { interactive: true } },
        { op: 'create_edge', src: '$cc', kind: 'reports_to', dst: ANALYST_ID },
        { op: 'create_node', ref: 't', kind: 'task', title: 'Add claims' },
      ])
    ).map((x) => x.id) as string[];
    const client = await mcp();
    const until = 'Through the ready subtasks, committing between tasks, until the branch is ready for a PR';
    const { id } = await call<{ id: string }>(client, 'assign', { to: agent!, tasks: [task!], body: 'Add claims', until });
    expect((await s.getEvent(db, id)).decisions.until).toEqual({ value: until, by: 'analyst' });
    const { brief } = await call<{ brief: string }>(client, 'claim_assignment', { eventId: id });
    expect(brief).toContain(`## Keep going until\n\n${until}`);
    expect(brief).toContain("Don't stop to ask whether to continue");
    await client.close();
  });
});
