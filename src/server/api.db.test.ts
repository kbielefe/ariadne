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

describe('MCP', () => {
  it('lets the analyst build the graph, ask you, and see your answer', async () => {
    const client = await mcp();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['apply_ops', 'assign', 'ask_user', 'reply', 'decide', 'graph']));

    const chat = (await (await post('/api/chat', { text: 'Break down v2' })).json()) as { id: string };
    const r = await client.callTool({
      name: 'apply_ops',
      arguments: {
        because: chat.id,
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

    const card = await client.callTool({
      name: 'ask_user',
      arguments: { because: chat.id, tasks: [root], body: 'Two subtasks so far.', card: { kind: 'approval', title: 'Approve the breakdown?', actions: [{ id: 'yes', label: 'Approve', style: 'primary' }, { id: 'no', label: 'Change it' }] } },
    });
    const cardId = (card.structuredContent as { id: string }).id;
    const tl = (await (await fetch(`${base}/api/timeline`)).json()) as { events: { id: string }[]; changes: Record<string, { count: number }> };
    expect(tl.events.map((e) => e.id)).toEqual([chat.id, cardId]);
    expect(tl.changes[chat.id]!.count).toBe(3);

    const answered = await post(`/api/cards/${cardId}/respond`, { action: 'yes' });
    expect(answered.status).toBe(200);
    const events = await client.callTool({ name: 'list_events', arguments: { actor: ANALYST_ID, kind: 'report' } });
    expect((events.structuredContent as { items: { from: string; body: string }[] }).items).toMatchObject([{ from: 'You (the user)', body: '**Approve**' }]);

    // Undo everything the analyst changed while handling the chat.
    expect(await (await post('/api/undo', { because: chat.id })).json()).toEqual({ undone: 3 });
    expect((await core.graph()).nodes.filter((n) => n.kind === 'task')).toEqual([]);
    await client.close();
  });
});

describe('claims', () => {
  const call = async <T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    return r.structuredContent as T;
  };

  it('hands out the repo item first, then generic ones, and takes valid results', async () => {
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
    const generic = await core.send(who(ANALYST_ID, 'mcp'), { kind: 'assign', recipient: agent!, body: 'Draft the memo', tasks: [loose!] });
    const forRepo = await core.send(who(ANALYST_ID, 'mcp'), { kind: 'assign', recipient: agent!, body: 'Add claims', tasks: [sub!] });
    expect(forRepo.delivery).toBe('pending');

    const client = await mcp();
    expect((await client.callTool({ name: 'next_assignment', arguments: {} })).isError).toBe(true); // repo is required
    const got = await call<{ assignment: { eventId: string; repo: string }; brief: string }>(client, 'next_assignment', { repo: 'git@github.com:kb/ariadne.git' });
    expect(got.assignment).toMatchObject({ eventId: forRepo.id, repo: 'ariadne' });
    expect(got.brief).toContain('submit_result');
    expect(await call(client, 'next_assignment', { repo: 'git@github.com:kb/other.git' })).toMatchObject({ assignment: { eventId: generic.id, repo: null } });
    expect(await call(client, 'next_assignment', { repo: 'git@github.com:kb/ariadne.git' })).toMatchObject({ assignment: null });

    // Released work goes back in the queue.
    await call(client, 'release_assignment', { eventId: generic.id });
    expect(await call(client, 'next_assignment', { repo: '/tmp/x' })).toMatchObject({ assignment: { eventId: generic.id } });

    // Invalid results are refused; a valid one closes the assignment and reaches the Analyst with its proposals.
    expect((await client.callTool({ name: 'submit_result', arguments: { eventId: forRepo.id, status: 'done', body: 'x', proposals: [{ op: 'explode' }] } })).isError).toBe(true);
    expect((await client.callTool({ name: 'submit_result', arguments: { eventId: forRepo.id, status: 'done' } })).isError).toBe(true);
    await call(client, 'submit_result', { eventId: forRepo.id, status: 'done', body: 'Added claims.', proposals: [{ op: 'create_node', kind: 'task', title: 'Document it' }] });
    const after = await s.getEvent(db, forRepo.id);
    expect(after).toMatchObject({ state: 'closed', delivery: 'delivered' });
    const [report] = await s.listEvents(db, { kind: 'report', actor: agent! });
    expect(report).toMatchObject({ sender: agent, recipient: ANALYST_ID, replyTo: forRepo.id, body: 'Added claims.', proposals: [{ title: 'Document it' }] });
    // The report waits for the Analyst, who is interactive too.
    expect(report!.delivery).toBe('pending');
    expect((await client.callTool({ name: 'submit_result', arguments: { eventId: forRepo.id, status: 'done', body: 'again' } })).isError).toBe(true);
    expect(await core.listTimers({ kind: 'claim_check' })).toHaveLength(1); // only the memo's claim is live
    await client.close();
  });

  it("lets the Analyst session handle your chat, and releases a stuck claim and tells you", async () => {
    const chat = await core.chat('What is next?');
    const client = await mcp();
    const got = await call<{ assignment: { eventId: string; as: string }; brief: string }>(client, 'next_assignment', { repo: 'https://github.com/kb/anything' });
    expect(got.assignment).toMatchObject({ eventId: chat.id, as: 'Analyst' });
    expect(got.brief).toContain('You are the Analyst');
    expect((await s.getEvent(db, chat.id)).delivery).toBe('claimed');

    // Nothing heard: past the deadline Ariadne releases it and tells you. still_working pushes the deadline back.
    const { timesOutAt } = await call<{ timesOutAt: string }>(client, 'still_working', { eventId: chat.id, minutes: 60 });
    expect(new Date(timesOutAt).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(await core.fireDue(new Date(Date.now() + 30 * 60_000))).toBe(0);
    expect(await core.fireDue(new Date(Date.now() + 61 * 60_000))).toBe(1);
    expect((await s.getEvent(db, chat.id)).delivery).toBe('pending');
    const fyi = (await s.listEvents(db, { kind: 'report', actor: USER_ID })).find((e) => e.sender === null);
    expect(fyi?.body).toMatch(/Released a stuck claim/);

    // Claimed again: the Analyst answers with reply, then finishes the claim without a body.
    await call(client, 'next_assignment', { repo: 'x' });
    await call(client, 'reply', { replyTo: chat.id, body: 'The memo.' });
    expect((await client.callTool({ name: 'submit_result', arguments: { eventId: chat.id, status: 'done', proposals: [{ op: 'create_node', kind: 'task', title: 'x' }] } })).isError).toBe(true);
    await call(client, 'submit_result', { eventId: chat.id, status: 'done' });
    expect(await s.getEvent(db, chat.id)).toMatchObject({ state: 'closed', delivery: 'delivered' });
    expect(await core.listTimers()).toEqual([]);
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
