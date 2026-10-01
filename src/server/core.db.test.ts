import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshCore } from '../test/db';
import { ANALYST_ID, USER_ID } from '../shared/model';
import { Relay, type Publisher } from './bus';
import { ContextBuilder, type Delivery } from './context';
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
const asAnalyst = (because?: string) => who(ANALYST_ID, 'mcp', because);

async function ids(ops: unknown[]) {
  const r = await core.ops(asUser(), ops);
  return Object.fromEntries(r.filter((x) => x.ref).map((x) => [x.ref!, x.id]));
}

async function agent(title: string, attrs: Record<string, unknown> = {}, supervisor = ANALYST_ID) {
  const r = await ids([
    { op: 'create_node', ref: 'a', kind: 'agent', title, attrs },
    { op: 'create_edge', src: '$a', kind: 'reports_to', dst: supervisor },
  ]);
  return r.a!;
}

describe('graph', () => {
  it('seeds you and the analyst, the analyst reporting to you', async () => {
    const g = await core.graph();
    expect(g.nodes.map((n) => n.title).sort()).toEqual(['Analyst', 'You']);
    expect(g.edges).toMatchObject([{ src: ANALYST_ID, kind: 'reports_to', dst: USER_ID }]);
  });

  it('creates tasks with refs, and roots are tasks nothing needs', async () => {
    const t = await ids([
      { op: 'create_node', ref: 'root', kind: 'task', title: 'Ship v2' },
      { op: 'create_node', ref: 'sub', kind: 'task', title: 'Write the schema' },
      { op: 'create_edge', src: '$root', kind: 'needs', dst: '$sub' },
    ]);
    expect((await core.openRoots()).map((n) => n.id)).toEqual([t.root]);
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
    const leaf = ctx.task(t.leaf!, []);
    expect(leaf.guidance).toEqual([{ from: { id: t.root, title: 'Ship v2' }, item: 'Small commits.' }]);
    expect(leaf.resources).toMatchObject([{ from: { title: 'Ship v2' }, item: { name: 'ariadne repo', type: 'repo' } }]);
    expect(leaf.coordinateWith).toMatchObject([{ from: { title: 'Backend' }, item: { name: 'Bryan', note: 'owns auth', areas: ['RBAC'] } }]);
    expect(leaf.ready).toBe(true);
  });
});

describe('chat and cards', () => {
  it('a chat is an assignment to the analyst; its reply closes it', async () => {
    const chat = await core.chat('Plan the v2 prototype');
    expect(chat).toMatchObject({ kind: 'assign', sender: USER_ID, recipient: ANALYST_ID, state: 'open', delivery: 'pending' });
    const reply = await core.send(asAnalyst(chat.id), { kind: 'report', replyTo: chat.id, body: 'On it.' });
    expect(reply).toMatchObject({ recipient: USER_ID, closes: true, delivery: 'none' });
    expect((await s.getEvent(db, chat.id)).state).toBe('closed');
    expect((await core.timeline()).map((e) => e.id)).toEqual([chat.id, reply.id]);
  });

  it('tasks linked in a chat as [Title](ariadne:id) are attached to it', async () => {
    const t = await ids([
      { op: 'create_node', ref: 'a', kind: 'task', title: 'Ship v2' },
      { op: 'create_node', ref: 'p', kind: 'person', title: 'Bryan' },
    ]);
    const chat = await core.chat(`Status of [Ship v2](ariadne:${t.a}) and ask [Bryan](ariadne:${t.p}) (ariadne:00000000-0000-4000-8000-0000000000ff)?`);
    expect(chat.tasks).toEqual([t.a]); // people stay links in the text; unknown ids are ignored
  });

  it('attached references are listed after the text and their tasks attached', async () => {
    const t = await ids([
      { op: 'create_node', ref: 'a', kind: 'task', title: 'Ship [v2]' },
      { op: 'create_node', ref: 'p', kind: 'person', title: 'Bryan' },
    ]);
    const chat = await core.chat('Status?', null, [t.a!, t.p!, '00000000-0000-4000-8000-0000000000ff']);
    expect(chat.body).toBe(`Status?\n\n[Ship v2](ariadne:${t.a}) [Bryan](ariadne:${t.p})`);
    expect(chat.tasks).toEqual([t.a]);
  });

  it('you assign only through the analyst', async () => {
    const a = await agent('Coder');
    await expect(core.send(asUser(), { kind: 'assign', recipient: a, body: 'x' })).rejects.toThrow(/through the Analyst/);
  });

  it('a card is an assignment to you; pressing a button is your report to the analyst', async () => {
    const card = await core.send(asAnalyst(), {
      kind: 'assign',
      recipient: USER_ID,
      body: 'Which repo?',
      card: { kind: 'choice', title: 'Pick a repo', fields: [{ name: 'repo', label: 'Repo', type: 'select', options: [{ value: 'a', label: 'A' }] }], actions: [{ id: 'ok', label: 'Use it', style: 'primary' }] },
    });
    await expect(core.respond(card.id, { action: 'nope' })).rejects.toThrow(/no action/);
    const r = await core.respond(card.id, { action: 'ok', values: { repo: 'a' } });
    expect(r).toMatchObject({ kind: 'report', sender: USER_ID, recipient: ANALYST_ID, closes: true, delivery: 'pending', response: { action: 'ok', values: { repo: 'a' } } });
    expect(r.body).toBe('**Use it**\n- Repo: a');
    expect((await s.getEvent(db, card.id)).state).toBe('closed');
    await expect(core.respond(card.id, { action: 'ok' })).rejects.toThrow(/already closed/);
  });

  it('cards go to you only', async () => {
    const a = await agent('Coder');
    await expect(core.send(asAnalyst(), { kind: 'assign', recipient: a, card: { title: 'x', actions: [{ id: 'a', label: 'a' }] } })).rejects.toThrow(/user only/);
  });

  it('work for another person becomes a proxy card; your answer is their report', async () => {
    const t = await ids([
      { op: 'create_node', ref: 'bryan', kind: 'person', title: 'Bryan' },
      { op: 'create_node', ref: 'task', kind: 'task', title: 'Agree on RBAC model' },
    ]);
    const ask = await core.send(asAnalyst(), { kind: 'assign', recipient: t.bryan, body: 'Do roles nest?', tasks: [t.task!] });
    expect(ask.delivery).toBe('none');
    const [card] = await s.listEvents(db, { actor: USER_ID, open: true });
    expect(card).toMatchObject({ sender: null, recipient: USER_ID, replyTo: ask.id, card: { kind: 'proxy', title: 'Ask Bryan' }, tasks: [t.task] });

    await core.respond(card!.id, { action: 'done', values: { answer: 'No, flat roles.' } });
    expect((await s.getEvent(db, ask.id)).state).toBe('closed');
    const reports = await s.listEvents(db, { kind: 'report', actor: t.bryan });
    expect(reports).toMatchObject([{ sender: t.bryan, recipient: ANALYST_ID, replyTo: ask.id, body: 'No, flat roles.', closes: true, delivery: 'pending' }]);
  });
});

describe('agents', () => {
  it('reports from agents arrive over the inbox, only from the assignee', async () => {
    const coder = await agent('Coder', { models: ['sonnet', 'opus'], effort: 'medium' });
    const other = await agent('Other');
    const job = await core.send(asAnalyst(), { kind: 'assign', recipient: coder, body: 'Write it' });
    expect(job.decisions).toEqual({ model: { value: 'sonnet', by: 'default' }, effort: { value: 'medium', by: 'default' } });
    await expect(core.receive({ type: 'report', sender: other, replyTo: job.id, body: 'done' })).rejects.toThrow(/Only the assignee/);
    await expect(core.receive({ type: 'report', sender: coder, replyTo: job.id, body: 'done' }, other)).rejects.toThrow(/broker user/);
    const r = await core.receive({ type: 'report', sender: coder, replyTo: job.id, body: 'Done.', proposals: [{ op: 'create_node', kind: 'task', title: 'Follow-up' }] });
    expect(r).toMatchObject({ sender: coder, recipient: ANALYST_ID, closes: true, delivery: 'pending', proposals: [{ title: 'Follow-up' }] });
    expect((await s.getEvent(db, job.id)).state).toBe('closed');
  });

  it('agents assign only to their direct subordinates', async () => {
    const lead = await agent('Lead');
    const junior = await agent('Junior', {}, lead);
    const peer = await agent('Peer');
    expect((await core.receive({ type: 'assign', sender: lead, recipient: junior, body: 'Do X' }))!.recipient).toBe(junior);
    await expect(core.receive({ type: 'assign', sender: lead, recipient: peer, body: 'Do X' })).rejects.toThrow(/direct subordinates/);
  });

  it('the relay publishes self-contained deliveries and skips paused agents', async () => {
    const t = await ids([
      { op: 'create_node', ref: 'root', kind: 'task', title: 'Root', attrs: { guidance: 'Be brief.' } },
      { op: 'create_node', ref: 'leaf', kind: 'task', title: 'Leaf' },
      { op: 'create_edge', src: '$root', kind: 'needs', dst: '$leaf' },
    ]);
    const coder = await agent('Coder', { briefs: { onAssignment: 'Read the repo first.' } });
    const sleepy = await agent('Sleepy', { paused: true });
    const job = await core.send(asAnalyst(), { kind: 'assign', recipient: coder, body: 'Do the leaf', tasks: [t.leaf!] });
    await core.send(asAnalyst(), { kind: 'assign', recipient: sleepy, body: 'Later' });
    const sent: { to: string; d: Delivery; priority: number }[] = [];
    const publisher: Publisher = { publish: async (to, d, o) => void sent.push({ to, d, priority: o.priority }) };
    const relay = new Relay(core, publisher, { info() {}, error() {} });
    expect(await relay.flush()).toBe(1);
    expect(sent[0]!.to).toBe(coder);
    expect(sent[0]!.d).toMatchObject({
      event: { id: job.id, from: 'Analyst', body: 'Do the leaf' },
      recipient: { name: 'Coder', briefs: { onAssignment: 'Read the repo first.' } },
      supervisor: { name: 'Analyst' },
      tasks: [{ title: 'Leaf', neededBy: [{ title: 'Root' }], guidance: [{ item: 'Be brief.' }] }],
    });
    expect((await s.getEvent(db, job.id)).delivery).toBe('delivered');
    expect(await relay.flush()).toBe(0);
  });

  it('the analyst delivery includes your own UI changes since its last delivery', async () => {
    await ids([{ op: 'create_node', ref: 't', kind: 'task', title: 'Renamed by you' }]);
    const chat = await core.chat('hi');
    const d = await (await ContextBuilder.load(db)).delivery(chat);
    expect(d.analyst!.userChanges).toContain('created task "Renamed by you"');
    expect(d.analyst!.openRoots).toMatchObject([{ title: 'Renamed by you' }]);
  });

  it('tells the sender when an assignment is overdue, once', async () => {
    const coder = await agent('Coder');
    const job = await core.send(asAnalyst(), { kind: 'assign', recipient: coder, body: 'Quick one', dueAt: new Date(Date.now() - 1000).toISOString() });
    expect(await core.sweepOverdue()).toBe(1);
    expect(await core.sweepOverdue()).toBe(0);
    const [r] = await s.listEvents(db, { kind: 'report' });
    expect(r).toMatchObject({ sender: null, recipient: ANALYST_ID, delivery: 'pending' });
    expect(r!.body).toMatch(/No report yet from Coder/);
    expect((await s.getEvent(db, job.id)).state).toBe('open');
  });
});

describe('undo', () => {
  it('reverts a change set, including what a delete cascaded', async () => {
    const t = await ids([
      { op: 'create_node', ref: 'a', kind: 'task', title: 'A' },
      { op: 'create_node', ref: 'b', kind: 'task', title: 'B' },
      { op: 'create_edge', src: '$a', kind: 'needs', dst: '$b' },
    ]);
    const chat = await core.chat('drop B', t.a);
    const w = asAnalyst(chat.id);
    await core.ops(w, [{ op: 'update_node', id: t.a!, title: 'A!' }, { op: 'delete_node', id: t.b! }]);
    expect((await core.graph()).edges.filter((e) => e.kind === 'needs')).toEqual([]);
    await core.undo(asUser(), w.changeset);
    const g = await core.graph();
    expect(g.nodes.find((n) => n.id === t.a)!.title).toBe('A');
    expect(g.nodes.find((n) => n.id === t.b)!.title).toBe('B');
    expect(g.edges.filter((e) => e.kind === 'needs')).toMatchObject([{ src: t.a, dst: t.b }]);
    await expect(core.undo(asUser(), w.changeset)).rejects.toThrow(/Nothing to undo/);
  });

  it('refuses to undo over a newer edit', async () => {
    const t = await ids([{ op: 'create_node', ref: 'a', kind: 'task', title: 'A' }]);
    const w = asAnalyst();
    await core.ops(w, [{ op: 'update_node', id: t.a!, title: 'B' }]);
    await core.ops(asUser(), [{ op: 'update_node', id: t.a!, title: 'C' }]);
    await expect(core.undo(asUser(), w.changeset)).rejects.toThrow(/changed again/);
  });
});

describe('System One', () => {
  it('holds a chat for triage, then delivers it with the decisions', async () => {
    const decider = await agent('Jev', { decider: true });
    const t = await ids([{ op: 'create_node', ref: 'root', kind: 'task', title: 'Ship v2' }]);
    const chat = await core.chat('the schema is done');
    expect(chat.delivery).toBe('held');
    // The decider gets a question event; answer it like a decider runner would.
    let [q] = await s.listEvents(db, { actor: decider, kind: 'assign', open: true });
    for (let i = 0; i < 50 && !q; i++) {
      await new Promise((r) => setTimeout(r, 20));
      [q] = await s.listEvents(db, { actor: decider, kind: 'assign', open: true });
    }
    expect(Object.keys(q!.questions!).sort()).toEqual(['about', 'intent']);
    expect(q!.questions!.about).toMatchObject({ criteria: { task1: 'Is about "Ship v2"' } });
    await core.receive({ type: 'report', sender: decider, replyTo: q!.id, body: '', answers: { intent: { type: 'choice', choice: 'update', confidence: 0.9 }, about: { type: 'choice', choice: 'task1', confidence: 0.8 } } });
    let ev = await s.getEvent(db, chat.id);
    for (let i = 0; i < 50 && ev.delivery === 'held'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      ev = await s.getEvent(db, chat.id);
    }
    expect(ev.delivery).toBe('pending');
    expect(ev.decisions).toEqual({ intent: { value: 'update', by: 'jev', confidence: 0.9 }, about: { value: t.root, by: 'jev', confidence: 0.8 } });
    // Decider traffic stays out of your timeline.
    expect((await core.timeline()).map((e) => e.id)).toEqual([chat.id]);
  });

  it('falls back to defaults when no decider answers in time', async () => {
    await db.end();
    ({ db, core } = await freshCore({ decideTimeoutMs: 100 }));
    await agent('Jev', { decider: true });
    const coder = await agent('Coder', { models: ['sonnet'], effort: 'low' });
    const job = await core.send(asAnalyst(), { kind: 'assign', recipient: coder, body: 'Write it' });
    expect(job.delivery).toBe('held');
    let ev = await s.getEvent(db, job.id);
    for (let i = 0; i < 100 && ev.delivery === 'held'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      ev = await s.getEvent(db, job.id);
    }
    expect(ev).toMatchObject({ delivery: 'pending', decisions: { model: { value: 'sonnet', by: 'default' }, effort: { value: 'low', by: 'default' } } });
  });
});
