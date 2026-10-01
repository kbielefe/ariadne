// The application core: every change goes through here, in one transaction, then the hub is told.
//
// Event rules (docs/DESIGN.md §3):
//   - An assignment goes to an actor. Agents get it over RabbitMQ; you get it in the timeline;
//     other people and teams become a proxy card for you ("Ask Bryan about ...").
//   - A report replies to an assignment, from whoever it was assigned to, back to whoever assigned it.
//     `closes` finishes the assignment.
//   - Cards are assignments to you; pressing a button is your report.
import { readiness, reachable } from '../shared/graph';
import {
  ANALYST_ID,
  type Answer,
  Card,
  type CardInput,
  CardResponse,
  type Decision,
  type Edge,
  type Event,
  InboxMessage,
  type Node,
  Question,
  USER_ID,
  isActorKind,
} from '../shared/model';
import { type Db, withTx } from './db';
import type { Hub } from './hub';
import { applyOps } from './ops';
import * as s from './store';
import { type Ctx, Invalid, type Who, who } from './store';

export interface SendInput {
  kind: 'assign' | 'report';
  recipient?: string;
  replyTo?: string;
  closes?: boolean;
  body?: string;
  instructions?: string;
  card?: CardInput;
  response?: unknown;
  proposals?: unknown[];
  questions?: Record<string, unknown>;
  answers?: Record<string, Answer>;
  decisions?: Record<string, Decision>;
  dueAt?: string | null;
  tasks?: string[];
}

/** Decisions Ariadne makes before delivering an event, by asking a System One decider. */
type HoldUse = 'triage' | 'dispatch';

export interface CoreOptions {
  /** How long decide() waits for a decider. */
  decideTimeoutMs?: number;
  /** Below this confidence, a System One answer is not used (defaults apply). */
  confidenceThreshold?: number;
}

interface After {
  changed: boolean;
  deliver: boolean;
  answered: string[];
  holds: { eventId: string; use: HoldUse }[];
  clearStatus: string[];
}

export class Core {
  readonly decideTimeoutMs: number;
  readonly confidenceThreshold: number;

  constructor(
    readonly db: Db,
    readonly hub: Hub,
    o: CoreOptions = {},
  ) {
    this.decideTimeoutMs = o.decideTimeoutMs ?? 5000;
    this.confidenceThreshold = o.confidenceThreshold ?? 0.6;
  }

  // ============================================================== transactions

  /** Runs `fn` in a transaction as `w`, then signals the hub. */
  async run<T>(w: Who, fn: (c: Ctx, after: After) => Promise<T>): Promise<T> {
    const after: After = { changed: true, deliver: false, answered: [], holds: [], clearStatus: [] };
    const result = await withTx(this.db, (tx) => fn({ tx, who: w }, after));
    if (after.changed) this.hub.changed();
    if (after.deliver) this.hub.deliver();
    for (const a of after.clearStatus) this.hub.clearStatus(a);
    for (const id of after.answered) this.hub.answered(id);
    for (const h of after.holds) void this.resolveHold(h.eventId, h.use);
    return result;
  }

  // ============================================================== generic CRUD

  ops(w: Who, ops: unknown) {
    return this.run(w, (c) => applyOps(c, ops));
  }

  undo(w: Who, changeset: string) {
    return this.run(w, (c) => s.undoChangeset(c, changeset));
  }

  // ============================================================== events

  /** You type in the chat: an assignment to the analyst, about the focus task if there is one. */
  async chat(text: string, focus?: string | null): Promise<Event> {
    if (!text.trim()) throw new Invalid('Say something');
    return this.run(who(USER_ID, 'ui'), (c, after) =>
      this.sendTx(c, after, USER_ID, { kind: 'assign', recipient: ANALYST_ID, body: text, tasks: focus ? [focus] : [] }, ['triage']),
    );
  }

  /** You press a button on a card. */
  async respond(cardEventId: string, response: unknown): Promise<Event> {
    const r = CardResponse.parse(response);
    return this.run(who(USER_ID, 'ui', cardEventId), async (c, after) => {
      const card = await s.getEvent(c.tx, cardEventId);
      if (!card.card) throw new Invalid('That event is not a card');
      if (!card.card.actions.some((a) => a.id === r.action)) throw new Invalid(`The card has no action "${r.action}"`);
      const label = card.card.actions.find((a) => a.id === r.action)!.label;
      const values = Object.entries(r.values).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length));
      const body = [`**${label}**`, ...values.map(([k, v]) => `- ${card.card!.fields.find((f) => f.name === k)?.label ?? k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)].join('\n');
      return this.sendTx(c, after, USER_ID, { kind: 'report', replyTo: cardEventId, closes: true, response: r, body });
    });
  }

  /** The analyst (MCP) or Ariadne sends an event. */
  send(w: Who, input: SendInput): Promise<Event> {
    return this.run(w, (c, after) => this.sendTx(c, after, w.actor, input));
  }

  /** A runner published to ariadne.inbox. `brokerUser` is RabbitMQ's validated user id, if any. */
  async receive(raw: unknown, brokerUser?: string | null): Promise<Event | null> {
    const m = InboxMessage.parse(raw);
    if (brokerUser && /^[0-9a-f-]{36}$/.test(brokerUser) && brokerUser !== m.sender) throw new Invalid(`Sender ${m.sender} does not match broker user ${brokerUser}`);
    const sender = await s.getNode(this.db, m.sender);
    if (sender.kind !== 'agent') throw new Invalid('Only agents publish to the inbox');
    if (m.type === 'status') {
      this.hub.status({ actor: m.sender, text: m.text, ...(m.eventId ? { eventId: m.eventId } : {}) });
      return null;
    }
    const w = who(m.sender, 'bus', m.type === 'report' ? m.replyTo : null);
    if (m.type === 'assign') {
      return this.send(w, { kind: 'assign', recipient: m.recipient, body: m.body, instructions: m.instructions ?? '', tasks: m.tasks ?? [] });
    }
    return this.send(w, {
      kind: 'report',
      replyTo: m.replyTo,
      closes: m.closes,
      body: m.body,
      ...(m.proposals ? { proposals: m.proposals } : {}),
      ...(m.answers ? { answers: m.answers } : {}),
    });
  }

  async sendTx(c: Ctx, after: After, sender: string | null, input: SendInput, holdUses: HoldUse[] = []): Promise<Event> {
    const senderNode = sender ? await s.getNode(c.tx, sender) : null;
    let tasks = input.tasks ?? [];
    for (const t of tasks) if ((await s.getNode(c.tx, t)).kind !== 'task') throw new Invalid(`${t} is not a task`);
    after.clearStatus.push(...(sender ? [sender] : []));

    if (input.kind === 'assign') {
      if (!input.recipient) throw new Invalid('An assignment needs a recipient');
      const to = await s.getNode(c.tx, input.recipient);
      if (!isActorKind(to.kind)) throw new Invalid(`${to.title} is not a person, agent, or team`);
      if (sender && sender === to.id) throw new Invalid('Assign to someone else');
      await this.checkMayAssign(c, senderNode, to);
      const card = input.card ? Card.parse(input.card) : null;
      if (card && to.id !== USER_ID) throw new Invalid('Cards go to the user only');
      const questions = input.questions ? parseQuestions(input.questions) : null;
      if (questions && !to.attrs.decider) throw new Invalid('Questions go to a decider agent');
      const proxy = to.kind !== 'agent' && to.id !== USER_ID;

      const holds: HoldUse[] = holdUses.filter((u) => u === 'triage');
      if (to.kind === 'agent' && !to.attrs.decider && !(input.decisions?.model && input.decisions?.effort)) holds.push('dispatch');
      const decider = holds.length ? await this.findDecider(c.tx) : null;
      const delivery: Event['delivery'] = to.kind !== 'agent' ? 'none' : decider ? 'held' : 'pending';
      const decisions = { ...input.decisions };
      if (to.kind === 'agent' && !decider) Object.assign(decisions, defaultDispatch(to, decisions));

      const ev = await s.insertEvent(c, {
        kind: 'assign',
        sender,
        recipient: to.id,
        body: input.body ?? '',
        instructions: input.instructions ?? '',
        card,
        questions,
        decisions,
        dueAt: input.dueAt ?? null,
        delivery,
        tasks,
      });
      if (delivery === 'pending') after.deliver = true;
      if (delivery === 'held') for (const use of holds) after.holds.push({ eventId: ev.id, use });
      if (proxy) await this.proxyCard(c, ev, to);
      return ev;
    }

    // ---- report
    let recipient = input.recipient ?? null;
    let original: Event | null = null;
    if (input.replyTo) {
      original = await s.getEvent(c.tx, input.replyTo);
      if (original.kind !== 'assign') throw new Invalid('Reports reply to an assignment');
      if (sender !== null && original.recipient !== sender) throw new Invalid('Only the assignee reports on an assignment');
      if (original.state !== 'open') throw new Invalid(`That assignment is already ${original.state}`);
      recipient = original.sender;
      if (!tasks.length) tasks = original.tasks;
    } else if (!recipient) throw new Invalid('A report needs replyTo or a recipient');
    const to = recipient ? await s.getNode(c.tx, recipient) : null;
    const ev = await s.insertEvent(c, {
      kind: 'report',
      sender,
      recipient,
      replyTo: original?.id ?? null,
      closes: !!original && (input.closes ?? true),
      body: input.body ?? '',
      response: input.response ?? null,
      proposals: input.proposals ?? null,
      answers: input.answers ?? null,
      // Decider answers are collected by decide(); they never wake anyone.
      delivery: to?.kind === 'agent' && !to.attrs.decider && !senderNode?.attrs.decider ? 'pending' : 'none',
      tasks,
    });
    if (ev.delivery === 'pending') after.deliver = true;
    if (original && ev.closes) await s.patchEvent(c, original.id, { state: 'closed' });
    if (original && senderNode?.attrs.decider) after.answered.push(original.id);
    // A proxy card answered: the proxied person or team reports back to whoever assigned them.
    if (original?.card?.kind === 'proxy' && original.replyTo) {
      const proxied = await s.getEvent(c.tx, original.replyTo);
      const r = input.response as CardResponse | null;
      if (proxied.state === 'open' && proxied.recipient && r) {
        const answer = typeof r.values.answer === 'string' ? r.values.answer : '';
        const done = r.action === 'done';
        await this.sendTx(c, after, proxied.recipient, {
          kind: 'report',
          replyTo: proxied.id,
          closes: done,
          body: done ? answer || '(done, no details)' : `Not reached yet${answer ? `: ${answer}` : ''}`,
        });
      }
    }
    return ev;
  }

  /** You may assign to the analyst. The analyst and Ariadne may assign to anyone. Other agents: their direct subordinates. */
  private async checkMayAssign(c: Ctx, from: Node | null, to: Node) {
    if (!from || from.id === ANALYST_ID) return;
    if (from.id === USER_ID) {
      if (to.id !== ANALYST_ID) throw new Invalid('You assign work through the Analyst');
      return;
    }
    if (to.attrs.decider) return;
    const r = await c.tx.query(`SELECT 1 FROM edges WHERE kind = 'reports_to' AND src = $1 AND dst = $2`, [to.id, from.id]);
    if (!r.rowCount) throw new Invalid(`${from.title} may assign only to its direct subordinates; ${to.title} does not report to it`);
  }

  /** People and teams other than you have no channel: you carry the assignment to them. */
  private async proxyCard(c: Ctx, ev: Event, to: Node) {
    await s.insertEvent(c, {
      kind: 'assign',
      sender: null,
      recipient: USER_ID,
      replyTo: ev.id,
      body: ev.body,
      instructions: ev.instructions,
      card: Card.parse({
        kind: 'proxy',
        title: `Ask ${to.title}`,
        fields: [{ name: 'answer', label: `What did ${to.title} say?`, type: 'textarea' }],
        actions: [
          { id: 'done', label: 'Record answer', style: 'primary' },
          { id: 'not_reached', label: 'Not reached yet' },
        ],
      }),
      delivery: 'none',
      tasks: ev.tasks,
    });
  }

  // ============================================================== System One

  async findDecider(q: s.Q): Promise<Node | null> {
    const r = await q.query(`SELECT * FROM nodes WHERE kind = 'agent' AND (attrs->>'decider')::boolean AND NOT coalesce((attrs->>'paused')::boolean, false) ORDER BY created_at LIMIT 1`);
    return r.rows[0] ? s.mapNode(r.rows[0]) : null;
  }

  /**
   * Asks a decider. Resolves with its answers, or null (no decider, timeout, or bad answers).
   * The question and the answer are ordinary events, so they are audited like everything else.
   */
  async decide(sender: string | null, state: string, questions: Record<string, unknown>, timeoutMs = this.decideTimeoutMs): Promise<{ answers: Record<string, Answer>; decider: string; eventId: string } | null> {
    const decider = await this.findDecider(this.db);
    if (!decider) return null;
    const ask = await this.send(who(sender, sender ? 'mcp' : 'core'), { kind: 'assign', recipient: decider.id, body: state, questions });
    const answered = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
      const off = this.hub.once(`answered:${ask.id}`, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!answered) {
      await this.run(who(null, 'core'), (c) => s.patchEvent(c, ask.id, { state: 'withdrawn' })).catch(() => {});
      return null;
    }
    const r = await this.db.query(`SELECT answers FROM events WHERE reply_to = $1 AND kind = 'report' ORDER BY created_at LIMIT 1`, [ask.id]);
    const answers = r.rows[0]?.answers as Record<string, Answer> | null;
    return answers ? { answers, decider: decider.id, eventId: ask.id } : null;
  }

  /** Makes the decisions an event waits on, then releases it for delivery. Never fails the event. */
  async resolveHold(eventId: string, use: HoldUse): Promise<void> {
    try {
      const ev = await s.getEvent(this.db, eventId);
      if (ev.delivery !== 'held') return;
      const decisions: Record<string, Decision> = {};
      if (use === 'triage') Object.assign(decisions, await this.triage(ev));
      else Object.assign(decisions, await this.dispatch(ev));
      await this.run(who(null, 'core', eventId), async (c, after) => {
        const cur = await s.getEvent(c.tx, eventId);
        await s.patchEvent(c, eventId, { decisions: { ...decisions, ...cur.decisions }, delivery: cur.delivery === 'held' ? 'pending' : cur.delivery });
        after.deliver = true;
      });
    } catch (err) {
      console.error('hold.failed', eventId, err);
      await this.releaseHeld(eventId).catch(() => {});
    }
  }

  /** Releases a held event with default decisions (startup sweep, or when deciding failed). */
  async releaseHeld(eventId?: string): Promise<number> {
    return this.run(who(null, 'core'), async (c, after) => {
      const r = await c.tx.query(`SELECT id FROM events WHERE delivery = 'held' ${eventId ? 'AND id = $1' : ''} FOR UPDATE`, eventId ? [eventId] : []);
      for (const row of r.rows) {
        const ev = await s.getEvent(c.tx, row.id);
        const to = ev.recipient ? await s.findNode(c.tx, ev.recipient) : null;
        await s.patchEvent(c, ev.id, { decisions: { ...(to ? defaultDispatch(to, ev.decisions) : {}), ...ev.decisions }, delivery: 'pending' });
      }
      after.deliver = r.rowCount! > 0;
      return r.rowCount ?? 0;
    });
  }

  /** Chat triage: what kind of message is this, and what is it about? Hints for the analyst, shown to you. */
  private async triage(ev: Event): Promise<Record<string, Decision>> {
    const openCards = await s.listEvents(this.db, { actor: USER_ID, open: true, kind: 'assign', limit: 10 });
    const roots = await this.openRoots(8);
    const about: Record<string, string> = { none: 'Nothing listed here' };
    const keys = new Map<string, string>();
    openCards.forEach((e, i) => {
      if (!e.card) return;
      about[`card${i + 1}`] = `Answers the open card "${e.card.title}"`;
      keys.set(`card${i + 1}`, e.id);
    });
    roots.forEach((t, i) => {
      about[`task${i + 1}`] = `Is about "${t.title}"`;
      keys.set(`task${i + 1}`, t.id);
    });
    const res = await this.decide(null, `The user wrote to their analyst:\n\n${ev.body}`, {
      intent: {
        type: 'choice',
        instructions: 'What is the user doing with this message?',
        criteria: {
          new_work: 'Asks for something new to be done',
          answer: 'Answers or responds to something they were asked',
          question: 'Asks about the state of existing work',
          update: 'Tells about progress or a change on existing work',
          other: 'None of these',
        },
      },
      about: { type: 'choice', instructions: 'Which of these is the message about?', criteria: about },
    });
    if (!res) return {};
    const out: Record<string, Decision> = {};
    const intent = res.answers.intent;
    if (intent?.choice) out.intent = { value: intent.choice, by: 'jev', ...(intent.confidence != null ? { confidence: intent.confidence } : {}) };
    const a = res.answers.about;
    if (a?.choice && a.choice !== 'none' && keys.has(a.choice))
      out.about = { value: keys.get(a.choice), by: 'jev', ...(a.confidence != null ? { confidence: a.confidence } : {}) };
    return out;
  }

  /** Model and effort for an agent assignment, from one difficulty score. */
  private async dispatch(ev: Event): Promise<Record<string, Decision>> {
    const to = await s.getNode(this.db, ev.recipient!);
    const fallback = defaultDispatch(to, ev.decisions);
    const tasks = await Promise.all(ev.tasks.map((t) => s.getNode(this.db, t)));
    const state = [`Assignment for ${to.title}:`, ev.body, ev.instructions, ...tasks.map((t) => `Task: ${t.title}\n${t.body}`)].filter(Boolean).join('\n\n');
    const res = await this.decide(null, state, { difficulty: { type: 'score', instructions: 'How hard is this work for a capable software agent?', scale: DIFFICULTY } });
    const a = res?.answers.difficulty;
    const index = a ? scoreIndex(a, DIFFICULTY) : -1;
    if (index < 0 || (a?.confidence ?? 1) < this.confidenceThreshold) return fallback;
    const models = (to.attrs.models as string[] | undefined) ?? [];
    const conf = a?.confidence != null ? { confidence: a.confidence } : {};
    const out: Record<string, Decision> = { difficulty: { value: DIFFICULTY[index], by: 'jev', ...conf } };
    if (!ev.decisions.effort) out.effort = { value: EFFORT_BY_DIFFICULTY[index], by: 'jev', ...conf };
    if (!ev.decisions.model && models.length) out.model = { value: models[Math.min(models.length - 1, Math.floor((index / DIFFICULTY.length) * models.length))], by: 'jev', ...conf };
    return { ...fallback, ...out };
  }

  // ============================================================== reads

  async openRoots(limit = 50): Promise<Node[]> {
    const r = await this.db.query(
      `SELECT n.* FROM nodes n WHERE n.kind = 'task' AND n.status = 'open'
         AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.kind = 'needs' AND e.dst = n.id)
       ORDER BY n.updated_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map(s.mapNode);
  }

  async graph(): Promise<{ nodes: Node[]; edges: Edge[]; assignments: { eventId: string; recipient: string; tasks: string[] }[] }> {
    const [nodes, edges, open] = await Promise.all([
      s.listNodes(this.db, { limit: 5000 }),
      s.listEdges(this.db),
      this.db.query(`SELECT e.id, e.recipient, array_agg(et.task_id) AS tasks FROM events e JOIN event_tasks et ON et.event_id = e.id
                     WHERE e.kind = 'assign' AND e.state = 'open' AND e.recipient IS NOT NULL GROUP BY e.id`),
    ]);
    return { nodes, edges, assignments: open.rows.map((r) => ({ eventId: r.id, recipient: r.recipient, tasks: r.tasks })) };
  }

  async nodeDetail(id: string) {
    const node = await s.getNode(this.db, id);
    const all = await s.listEdges(this.db);
    const edges = all.filter((e) => e.src === id || e.dst === id);
    const others = await Promise.all([...new Set(edges.map((e) => (e.src === id ? e.dst : e.src)))].map((n) => s.getNode(this.db, n)));
    const byId = new Map([node, ...others].map((n) => [n.id, n]));
    const events = node.kind === 'task' ? await s.listEvents(this.db, { task: id, limit: 100 }) : await s.listEvents(this.db, { actor: id, limit: 100 });
    return { node, edges, neighbors: others, events, ...(node.kind === 'task' ? { readiness: readiness(node, all, byId) } : {}) };
  }

  /** Events to and from you, newest last. With a focus task, only events about it or what it needs. */
  async timeline(o: { focus?: string | null; all?: boolean; limit?: number } = {}): Promise<Event[]> {
    let tasks: string[] | undefined;
    if (o.focus) tasks = [...reachable(await s.listEdges(this.db), o.focus, { kinds: ['needs'] }).keys()];
    const events = await s.listEvents(this.db, { ...(o.all ? {} : { actor: USER_ID }), ...(tasks ? { tasks } : {}), limit: o.limit ?? 200 });
    // Decider traffic is plumbing; it shows up as decisions on the events it decided.
    const deciders = new Set((await s.listNodes(this.db, { kind: 'agent' })).filter((n) => n.attrs.decider).map((n) => n.id));
    return events.filter((e) => !(e.recipient && deciders.has(e.recipient)) && !(e.sender && deciders.has(e.sender)));
  }

  // ============================================================== background

  /** Tells the sender about assignments past due, once each. */
  async sweepOverdue(): Promise<number> {
    const r = await this.db.query(`SELECT id FROM events WHERE kind = 'assign' AND state = 'open' AND due_at < now() AND NOT decisions ? 'overdue'`);
    for (const row of r.rows) {
      await this.run(who(null, 'core', row.id), async (c, after) => {
        const ev = await s.getEvent(c.tx, row.id);
        if (ev.decisions.overdue || ev.state !== 'open') return;
        await s.patchEvent(c, ev.id, { decisions: { ...ev.decisions, overdue: { value: true, by: 'core' } } });
        if (!ev.sender) return;
        const to = await s.findNode(c.tx, ev.recipient ?? '');
        await this.sendTx(c, after, null, {
          kind: 'report',
          recipient: ev.sender,
          body: `No report yet from ${to?.title ?? 'the assignee'} on an assignment due ${ev.dueAt}:\n\n> ${ev.body.split('\n')[0]}`,
          tasks: ev.tasks,
        });
      });
    }
    return r.rowCount ?? 0;
  }
}

// ---------------------------------------------------------------- helpers

const DIFFICULTY = ['trivial', 'routine', 'moderate', 'hard', 'very hard'];
const EFFORT_BY_DIFFICULTY = ['low', 'low', 'medium', 'high', 'xhigh'];

function defaultDispatch(to: Node, have: Record<string, Decision> = {}): Record<string, Decision> {
  if (to.kind !== 'agent' || to.attrs.decider) return {};
  const out: Record<string, Decision> = {};
  const models = to.attrs.models as string[] | undefined;
  if (!have.model && models?.length) out.model = { value: models[0], by: 'default' };
  if (!have.effort && to.attrs.effort) out.effort = { value: to.attrs.effort, by: 'default' };
  return out;
}

function scoreIndex(a: Answer, scale: string[]): number {
  const raw = a.index ?? (a as { score?: number }).score;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < scale.length) return raw;
  return a.choice ? scale.indexOf(a.choice) : -1;
}

function parseQuestions(q: Record<string, unknown>) {
  const out: Record<string, Question> = {};
  for (const [k, v] of Object.entries(q)) out[k] = Question.parse(v);
  if (!Object.keys(out).length) throw new Invalid('Ask at least one question');
  return out;
}
