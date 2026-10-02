import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshCore } from '../test/db';
import { USER_ID } from '../shared/model';
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
  it('lets Claude Code build the graph, look at it, and undo from the history', async () => {
    const client = await mcp();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['apply_ops', 'get_node', 'graph', 'history', 'search', 'undo']);

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
    const top = await call<{ nodes: { title: string }[] }>(client, 'graph', {});
    expect(top.nodes.map((n) => n.title).sort()).toEqual(['Ship v2', 'You']);

    const hist = await call<{ items: { changeset: string; entity: string; actor: string | null; via: string }[] }>(client, 'history', {});
    const made = hist.items.find((h) => h.entity === 'node')!;
    expect(made).toMatchObject({ actor: null, via: 'mcp' });
    await call(client, 'undo', { changeset: made.changeset });
    expect((await core.graph()).nodes.filter((n) => n.kind === 'task')).toEqual([]);
    await client.close();
  });

  it('says which tasks just became ready when apply_ops closes tasks', async () => {
    const [root, a, b, next] = (
      await core.ops(who(USER_ID, 'ui'), [
        { op: 'create_node', ref: 'root', kind: 'task', title: 'Ship it' },
        { op: 'create_node', ref: 'a', kind: 'task', title: 'Build' },
        { op: 'create_node', ref: 'b', kind: 'task', title: 'Test' },
        { op: 'create_node', ref: 'next', kind: 'task', title: 'Demo' },
        { op: 'create_edge', src: '$root', kind: 'needs', dst: '$a' },
        { op: 'create_edge', src: '$root', kind: 'needs', dst: '$b' },
        { op: 'create_edge', src: '$next', kind: 'needs', dst: '$a' },
      ])
    )
      .filter((x) => x.ref)
      .map((x) => x.id) as string[];
    const client = await mcp();
    // Closing Build makes Demo ready; Ship it still waits on Test.
    expect((await call<{ nowReady?: unknown[] }>(client, 'apply_ops', { ops: [{ op: 'update_node', id: a, status: 'done' }] })).nowReady).toEqual([{ id: next, title: 'Demo' }]);
    // Only tasks this batch closed count; nothing new: no nowReady.
    expect((await call<{ nowReady?: unknown[] }>(client, 'apply_ops', { ops: [{ op: 'update_node', id: a, status: 'done' }] })).nowReady).toBeUndefined();
    expect((await call<{ nowReady?: unknown[] }>(client, 'apply_ops', { ops: [{ op: 'update_node', id: b, status: 'dropped' }] })).nowReady).toEqual([{ id: root, title: 'Ship it' }]);
    await client.close();
  });

  it("get_node gives a task's inherited context and the branches it ships on", async () => {
    const r = await core.ops(who(USER_ID, 'ui'), [
      { op: 'create_node', ref: 'b', kind: 'resource', title: 'PDP first tag', attrs: { type: 'branch', repo: 'pdp', branch: 'feature/first-tag' } },
      { op: 'create_node', ref: 'tag', kind: 'task', title: 'Cut the first PDP tag', attrs: { guidance: 'Small commits.' } },
      { op: 'create_node', ref: 'a', kind: 'task', title: 'Add the parser' },
      { op: 'create_node', ref: 'c', kind: 'task', title: 'Add the CLI' },
      { op: 'create_node', ref: 'x', kind: 'task', title: 'Unrelated', status: 'dropped' },
      { op: 'create_node', ref: 'solo', kind: 'task', title: 'No branch' },
      { op: 'create_edge', src: '$tag', kind: 'uses', dst: '$b' },
      { op: 'create_edge', src: '$tag', kind: 'needs', dst: '$a' },
      { op: 'create_edge', src: '$tag', kind: 'needs', dst: '$c' },
      { op: 'create_edge', src: '$tag', kind: 'needs', dst: '$x' },
    ]);
    const id = (ref: string) => r.find((x) => x.ref === ref)!.id;
    const client = await mcp();
    const d = await call<{ context: { guidance: unknown[]; ready: boolean }; branches: { name: string; repo: string; branch: string; tasks: { title: string }[] }[] }>(client, 'get_node', { id: id('a') });
    expect(d.context).toMatchObject({ ready: true, guidance: [{ from: { title: 'Cut the first PDP tag' }, item: 'Small commits.' }] });
    expect(d.branches).toMatchObject([{ name: 'PDP first tag', repo: 'pdp', branch: 'feature/first-tag' }]);
    expect(d.branches[0]!.tasks.map((t) => t.title).sort()).toEqual(['Add the CLI', 'Add the parser', 'Cut the first PDP tag']);
    expect(await call(client, 'get_node', { id: id('solo') })).not.toHaveProperty('branches');
    await client.close();
  });
});

describe('decisions', () => {
  it('search with decisions: true finds decision lines in bodies, and only those nodes', async () => {
    await core.ops(who(null, 'mcp'), [
      { op: 'create_node', kind: 'task', title: 'Sign builds', body: 'Context.\n\n**Decision (Karl, 2026-10-01):** skip signing for now.\n\nMore.' },
      { op: 'create_node', kind: 'task', title: 'Versioning', body: '- **Decision (Karl):** Jenkins sets the version.\n  **Decision:** DECISION_LOG_URL is optional' },
      { op: 'create_node', kind: 'task', title: 'Talks about it', body: 'We need a **Decision (Karl):** soon, mid-line.' },
      { op: 'create_node', kind: 'task', title: 'No decision', body: 'Nothing decided.' },
    ]);
    const client = await mcp();
    const found = await call<{ items: { title: string; decisions: string[] }[] }>(client, 'search', { decisions: true });
    expect(Object.fromEntries(found.items.map((n) => [n.title, n.decisions]))).toEqual({
      'Sign builds': ['**Decision (Karl, 2026-10-01):** skip signing for now.'],
      Versioning: ['- **Decision (Karl):** Jenkins sets the version.', '**Decision:** DECISION_LOG_URL is optional'],
    });
    expect((await call<{ items: { title: string }[] }>(client, 'search', { decisions: true, query: 'jenkins' })).items.map((n) => n.title)).toEqual(['Versioning']);
    // Without the filter, results don't carry a decisions field.
    expect((await call<{ items: Record<string, unknown>[] }>(client, 'search', { query: 'Sign' })).items[0]).not.toHaveProperty('decisions');
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
    // Changes over MCP have no actor: the history says they came from Claude.
    const client = await mcp();
    await call(client, 'apply_ops', { ops: [{ op: 'update_node', id: (await s.listNodes(db, { query: 'Mine' }))[0]!.id, title: 'Mine!' }] });
    await client.close();
    const after = (await (await fetch(`${base}/api/history`)).json()) as { who: string; via: string; line: string }[];
    expect(after.at(-1)).toMatchObject({ who: 'Claude (MCP)', via: 'mcp', line: 'updated task "Mine!": title' });
  });

  it('returns the changeset of your edit, so Undo can revert it', async () => {
    const made = (await (await post('/api/ops', { ops: [{ op: 'create_node', kind: 'resource', title: 'Old repo' }] })).json()) as { results: { id: string }[]; changeset: string };
    const id = made.results[0]!.id;
    const del = (await (await post('/api/ops', { ops: [{ op: 'delete_node', id }] })).json()) as { changeset: string };
    expect(del.changeset).toMatch(/^[0-9a-f-]{36}$/);
    await expect(s.getNode(db, id)).rejects.toThrow();
    const undo = await post('/api/undo', { changeset: del.changeset });
    expect(undo.status).toBe(200);
    expect((await s.getNode(db, id)).title).toBe('Old repo');
    expect((await post('/api/undo', { changeset: 'nope' })).status).toBe(400);
  });
});
