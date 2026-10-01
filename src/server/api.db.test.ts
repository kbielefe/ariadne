import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshCore } from '../test/db';
import { ANALYST_ID } from '../shared/model';
import { registerApi } from './api';
import type { Core } from './core';
import type { Db } from './db';

let db: Db;
let core: Core;
let app: FastifyInstance;
let base: string;
const TOKEN = 'test-token';

beforeEach(async () => {
  ({ db, core } = await freshCore());
  app = Fastify();
  const port = 39000 + Math.floor(Math.random() * 1000);
  registerApi(app, core, { allowedHosts: [`127.0.0.1:${port}`], mcpToken: TOKEN });
  await app.listen({ host: '127.0.0.1', port });
  base = `http://127.0.0.1:${port}`;
});
afterEach(async () => {
  await app.close();
  await db.end();
});

async function mcp(token = TOKEN) {
  const client = new Client({ name: 'test-analyst', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('MCP', () => {
  it('is for the analyst only', async () => {
    await expect(mcp('wrong')).rejects.toThrow();
  });

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
