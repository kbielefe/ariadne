import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshCore } from '../test/db';
import { USER_ID } from '../shared/model';
import { ContextBuilder } from './context';
import type { Core } from './core';
import type { Db } from './db';
import * as s from './store';
import { who } from './store';

let db: Db;
let core: Core;

beforeEach(async () => {
  ({ db, core } = await freshCore());
});
afterEach(async () => {
  await db.end();
});

const asUser = () => who(USER_ID, 'ui');
const asClaude = () => who(null, 'mcp');

async function ids(ops: unknown[]) {
  const r = await core.ops(asUser(), ops);
  return Object.fromEntries(r.filter((x) => x.ref).map((x) => [x.ref!, x.id]));
}

describe('graph', () => {
  it('seeds only you; agents and events are gone', async () => {
    const g = await core.graph();
    expect(g.nodes.map((n) => [n.id, n.title])).toEqual([[USER_ID, 'You']]);
    expect(g.edges).toEqual([]);
    await expect(core.ops(asUser(), [{ op: 'create_node', kind: 'agent', title: 'Coder' }])).rejects.toThrow();
    await expect(db.query(`INSERT INTO nodes (kind, title) VALUES ('agent', 'Coder')`)).rejects.toThrow(/nodes_kind_check/);
    expect((await db.query(`SELECT to_regclass('events') AS e, to_regclass('timers') AS t`)).rows[0]).toEqual({ e: null, t: null });
  });

  it('creates tasks with refs; a task waits on what it needs', async () => {
    const t = await ids([
      { op: 'create_node', ref: 'root', kind: 'task', title: 'Ship v2' },
      { op: 'create_node', ref: 'sub', kind: 'task', title: 'Write the schema' },
      { op: 'create_edge', src: '$root', kind: 'needs', dst: '$sub' },
    ]);
    const d = await core.nodeDetail(t.root!);
    expect(d.readiness).toEqual({ ready: false, waitingOn: [t.sub] });
  });

  it('refuses cycles, wrong edge endpoints, unknown attrs, and deleting you', async () => {
    const t = await ids([
      { op: 'create_node', ref: 'a', kind: 'task', title: 'A' },
      { op: 'create_node', ref: 'b', kind: 'task', title: 'B' },
      { op: 'create_edge', src: '$a', kind: 'needs', dst: '$b' },
    ]);
    await expect(core.ops(asUser(), [{ op: 'create_edge', src: t.b, kind: 'needs', dst: t.a }])).rejects.toThrow(/cycle/);
    // Teams nest, but never inside themselves.
    const tm = await ids([
      { op: 'create_node', ref: 'pod', kind: 'team', title: 'Pod' },
      { op: 'create_node', ref: 'dept', kind: 'team', title: 'Dept' },
      { op: 'create_edge', src: '$pod', kind: 'member_of', dst: '$dept' },
    ]);
    await expect(core.ops(asUser(), [{ op: 'create_edge', src: tm.dept, kind: 'member_of', dst: tm.pod }])).rejects.toThrow(/cycle/);
    await expect(core.ops(asUser(), [{ op: 'create_edge', src: t.a, kind: 'uses', dst: t.b }])).rejects.toThrow(/uses goes from task to resource/);
    await expect(core.ops(asUser(), [{ op: 'create_node', kind: 'task', title: 'C', attrs: { guidence: 'typo' } }])).rejects.toThrow(/Allowed keys: guidance/);
    await expect(core.ops(asUser(), [{ op: 'delete_node', id: USER_ID }])).rejects.toThrow(/not deleted/);
    // The batch is atomic: nothing from a failed batch remains.
    await expect(core.ops(asUser(), [{ op: 'create_node', kind: 'task', title: 'D' }, { op: 'delete_node', id: USER_ID }])).rejects.toThrow();
    expect((await s.listNodes(db, { query: 'D', kind: 'task' })).filter((n) => n.title === 'D')).toEqual([]);
  });

  it('subtasks inherit guidance, resources, and people from every task that needs them', async () => {
    const t = await ids([
      { op: 'create_node', ref: 'root', kind: 'task', title: 'Ship v2', attrs: { guidance: 'Small commits.' } },
      { op: 'create_node', ref: 'mid', kind: 'task', title: 'Backend' },
      { op: 'create_node', ref: 'leaf', kind: 'task', title: 'Schema' },
      { op: 'create_node', ref: 'repo', kind: 'resource', title: 'ariadne repo', attrs: { type: 'repo', url: 'https://github.com/x/ariadne' } },
      { op: 'create_node', ref: 'bryan', kind: 'person', title: 'Bryan', attrs: { areas: ['RBAC'] } },
      { op: 'create_edge', src: '$root', kind: 'needs', dst: '$mid' },
      { op: 'create_edge', src: '$mid', kind: 'needs', dst: '$leaf' },
      { op: 'create_edge', src: '$root', kind: 'uses', dst: '$repo' },
      { op: 'create_edge', src: '$mid', kind: 'involves', dst: '$bryan', note: 'owns auth' },
    ]);
    const ctx = await ContextBuilder.load(db);
    const leaf = ctx.task(t.leaf!);
    expect(leaf.guidance).toEqual([{ from: { id: t.root, title: 'Ship v2' }, item: 'Small commits.' }]);
    expect(leaf.resources).toMatchObject([{ from: { title: 'Ship v2' }, item: { name: 'ariadne repo', type: 'repo' } }]);
    expect(leaf.coordinateWith).toMatchObject([{ from: { title: 'Backend' }, item: { name: 'Bryan', note: 'owns auth', areas: ['RBAC'] } }]);
    expect(leaf.ready).toBe(true);
  });
});

describe('undo', () => {
  it('reverts a change set, including what a delete cascaded', async () => {
    const t = await ids([
      { op: 'create_node', ref: 'a', kind: 'task', title: 'A' },
      { op: 'create_node', ref: 'b', kind: 'task', title: 'B' },
      { op: 'create_edge', src: '$a', kind: 'needs', dst: '$b' },
    ]);
    const w = asClaude();
    await core.ops(w, [{ op: 'update_node', id: t.a!, title: 'A!' }, { op: 'delete_node', id: t.b! }]);
    expect((await core.graph()).edges.filter((e) => e.kind === 'needs')).toEqual([]);
    await core.undo(asUser(), w.changeset);
    const g = await core.graph();
    expect(g.nodes.find((n) => n.id === t.a)!.title).toBe('A');
    expect(g.nodes.find((n) => n.id === t.b)!.title).toBe('B');
    expect(g.edges.filter((e) => e.kind === 'needs')).toMatchObject([{ src: t.a, dst: t.b }]);
    await expect(core.undo(asUser(), w.changeset)).rejects.toThrow(/Nothing to undo/);
  });

  it('deletes a resource still used by an open task, and undo brings back its uses edges', async () => {
    const t = await ids([
      { op: 'create_node', ref: 't', kind: 'task', title: 'Open task' },
      { op: 'create_node', ref: 'r', kind: 'resource', title: 'Old repo', attrs: { type: 'repo' } },
      { op: 'create_edge', src: '$t', kind: 'uses', dst: '$r' },
    ]);
    const w = asUser();
    await core.ops(w, [{ op: 'delete_node', id: t.r! }]);
    let g = await core.graph();
    expect(g.nodes.find((n) => n.id === t.r)).toBeUndefined();
    expect(g.edges.filter((e) => e.kind === 'uses')).toEqual([]);
    await core.undo(asUser(), w.changeset);
    g = await core.graph();
    expect(g.nodes.find((n) => n.id === t.r)).toMatchObject({ kind: 'resource', title: 'Old repo' });
    expect(g.edges.filter((e) => e.kind === 'uses')).toMatchObject([{ src: t.t, dst: t.r }]);
  });

  it('refuses to undo over a newer edit', async () => {
    const t = await ids([{ op: 'create_node', ref: 'a', kind: 'task', title: 'A' }]);
    const w = asClaude();
    await core.ops(w, [{ op: 'update_node', id: t.a!, title: 'B' }]);
    await core.ops(asUser(), [{ op: 'update_node', id: t.a!, title: 'C' }]);
    await expect(core.undo(asUser(), w.changeset)).rejects.toThrow(/changed again/);
  });
});
