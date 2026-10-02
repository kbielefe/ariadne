// The delivery: everything a recipient needs to act on an event, in one self-contained message.
// Agents have no MCP, so this is all they get. The analyst gets extras and can ask for more over MCP.
//
// Context is inherited down the `needs` graph: a task gets the guidance, resources, and people of
// every task that (transitively) needs it, so a repo attached to a root task reaches all its subtasks.
// A branch resource is a shared scope: every task in it ships together in one PR (Delivery.branches).
import { ancestorTasks, reachable, readiness } from '../shared/graph';
import { ANALYST_ID, type Edge, type Event, type Node, USER_ID } from '../shared/model';
import * as s from './store';
import type { Q } from './store';

export interface Delivery {
  event: EventView;
  recipient: ActorView;
  sender: ActorView | null;
  /** For a report: the assignment it answers. */
  inReplyTo: EventView | null;
  tasks: TaskContext[];
  /** Recent events on these tasks, oldest first. */
  thread: EventView[];
  supervisor: ActorView | null;
  subordinates: ActorView[];
  /** Branches these tasks use (directly or inherited), with every task that shares each one. */
  branches?: BranchScope[];
  howToReply: string;
  analyst?: AnalystExtras;
}

export interface EventView {
  id: string;
  kind: Event['kind'];
  from: string;
  to: string;
  body: string;
  instructions?: string;
  card?: unknown;
  response?: unknown;
  proposals?: unknown;
  questions?: unknown;
  decisions?: Event['decisions'];
  state?: Event['state'];
  closes?: boolean;
  replyTo?: string | null;
  tasks: string[];
  at: string;
}

export interface ActorView {
  id: string;
  kind: Node['kind'];
  name: string;
  about: string;
  areas?: unknown;
  briefs?: unknown;
  models?: unknown;
  effort?: unknown;
  decider?: boolean;
  paused?: boolean;
  interactive?: boolean;
}

interface Ref {
  id: string;
  title: string;
}
interface Inherited<T> {
  from: Ref | 'self';
  item: T;
}

export interface TaskContext {
  id: string;
  title: string;
  body: string;
  status: Node['status'];
  ready: boolean;
  needs: (Ref & { status: Node['status'] })[];
  neededBy: Ref[];
  guidance: Inherited<string>[];
  resources: Inherited<{ id: string; name: string; type?: unknown; url?: unknown; repo?: unknown; branch?: unknown; about: string; note: string }>[];
  coordinateWith: Inherited<ActorView & { note: string }>[];
  openAssignments: { eventId: string; to: string }[];
}

/** A branch resource and the open or done tasks that use it, directly or through a task that needs them. */
export interface BranchScope {
  id: string;
  name: string;
  repo?: unknown;
  branch?: unknown;
  url?: unknown;
  tasks: (Ref & { status: Node['status'] })[];
}

export interface AnalystExtras {
  openCards: EventView[];
  openAssignments: EventView[];
  openRoots: Ref[];
  /** What you changed yourself in the UI since the analyst's last delivery. */
  userChanges: string[];
}

const truncate = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

export function actorView(n: Node): ActorView {
  const a = n.attrs;
  return {
    id: n.id,
    kind: n.kind,
    name: n.title,
    about: n.body,
    ...(a.areas ? { areas: a.areas } : {}),
    ...(a.briefs ? { briefs: a.briefs } : {}),
    ...(a.models ? { models: a.models } : {}),
    ...(a.effort ? { effort: a.effort } : {}),
    ...(a.decider ? { decider: true } : {}),
    ...(a.paused ? { paused: true } : {}),
    ...(a.interactive ? { interactive: true } : {}),
  };
}

export class ContextBuilder {
  readonly nodes = new Map<string, Node>();
  private edges: Edge[] = [];

  private constructor(private readonly q: Q) {}

  static async load(q: Q): Promise<ContextBuilder> {
    const b = new ContextBuilder(q);
    for (const n of await s.listNodes(q, { limit: 5000 })) b.nodes.set(n.id, n);
    b.edges = await s.listEdges(q);
    return b;
  }

  name(id: string | null) {
    if (!id) return 'Ariadne';
    if (id === USER_ID) return `${this.nodes.get(id)?.title ?? 'You'} (the user)`;
    return this.nodes.get(id)?.title ?? id;
  }

  eventView(e: Event, bodyLimit = 4000): EventView {
    return {
      id: e.id,
      kind: e.kind,
      from: this.name(e.sender),
      to: this.name(e.recipient),
      body: truncate(e.body, bodyLimit),
      ...(e.instructions ? { instructions: e.instructions } : {}),
      ...(e.card ? { card: e.card } : {}),
      ...(e.response ? { response: e.response } : {}),
      ...(e.proposals ? { proposals: e.proposals } : {}),
      ...(e.questions ? { questions: e.questions } : {}),
      ...(Object.keys(e.decisions).length ? { decisions: e.decisions } : {}),
      ...(e.state ? { state: e.state } : {}),
      ...(e.kind === 'report' ? { closes: e.closes, replyTo: e.replyTo } : {}),
      tasks: e.tasks,
      at: e.createdAt,
    };
  }

  task(id: string, openAssignments: { eventId: string; to: string; tasks: string[] }[]): TaskContext {
    const t = this.nodes.get(id);
    if (!t) throw new s.NotFound(`No task ${id}`);
    const ref = (n: Node): Ref => ({ id: n.id, title: n.title });
    const chain = [t, ...ancestorTasks(this.edges, id).map((a) => this.nodes.get(a)!).filter(Boolean)];
    const from = (n: Node): Ref | 'self' => (n.id === id ? 'self' : ref(n));
    const guidance: TaskContext['guidance'] = [];
    const resources: TaskContext['resources'] = [];
    const coordinateWith: TaskContext['coordinateWith'] = [];
    const seen = new Set<string>();
    for (const n of chain) {
      if (typeof n.attrs.guidance === 'string' && n.attrs.guidance) guidance.push({ from: from(n), item: n.attrs.guidance });
      for (const e of this.edges.filter((x) => x.src === n.id)) {
        const d = this.nodes.get(e.dst);
        if (!d || seen.has(`${e.kind}:${d.id}`)) continue;
        if (e.kind === 'uses')
          resources.push({ from: from(n), item: { id: d.id, name: d.title, type: d.attrs.type, url: d.attrs.url, ...(d.attrs.type === 'branch' ? { repo: d.attrs.repo, branch: d.attrs.branch } : {}), about: truncate(d.body, 1000), note: e.note } });
        else if (e.kind === 'involves') coordinateWith.push({ from: from(n), item: { ...actorView(d), note: e.note } });
        else continue;
        seen.add(`${e.kind}:${d.id}`);
      }
    }
    const needs = this.edges.filter((e) => e.kind === 'needs' && e.src === id).map((e) => this.nodes.get(e.dst)!).filter(Boolean);
    const neededBy = this.edges.filter((e) => e.kind === 'needs' && e.dst === id).map((e) => this.nodes.get(e.src)!).filter(Boolean);
    return {
      id: t.id,
      title: t.title,
      body: t.body,
      status: t.status,
      ready: readiness(t, this.edges, this.nodes).ready,
      needs: needs.map((n) => ({ ...ref(n), status: n.status })),
      neededBy: neededBy.map(ref),
      guidance,
      resources,
      coordinateWith,
      openAssignments: openAssignments.filter((a) => a.tasks.includes(id)).map(({ eventId, to }) => ({ eventId, to })),
    };
  }

  /** The branches the tasks' context includes, each with every task in its scope (the tasks that use it and what they need). */
  branches(tasks: TaskContext[]): BranchScope[] {
    const ids = new Set(tasks.flatMap((t) => t.resources).filter((r) => r.item.type === 'branch').map((r) => r.item.id));
    return [...ids].map((id) => {
      const b = this.nodes.get(id)!;
      const scope = new Set<string>();
      for (const e of this.edges.filter((x) => x.kind === 'uses' && x.dst === id)) for (const t of reachable(this.edges, e.src, { kinds: ['needs'] }).keys()) scope.add(t);
      const inScope = [...scope].map((t) => this.nodes.get(t)!).filter((n) => n && n.status !== 'dropped');
      return { id, name: b.title, repo: b.attrs.repo, branch: b.attrs.branch, url: b.attrs.url, tasks: inScope.map((n) => ({ id: n.id, title: n.title, status: n.status })) };
    });
  }

  supervisor(id: string): Node | null {
    const e = this.edges.find((x) => x.kind === 'reports_to' && x.src === id);
    return e ? (this.nodes.get(e.dst) ?? null) : null;
  }

  subordinates(id: string): Node[] {
    return this.edges.filter((x) => x.kind === 'reports_to' && x.dst === id).map((x) => this.nodes.get(x.src)!).filter(Boolean);
  }

  async delivery(ev: Event): Promise<Delivery> {
    const q = this.q;
    const recipient = this.nodes.get(ev.recipient ?? '');
    if (!recipient) throw new s.NotFound(`No recipient for event ${ev.id}`);
    const open = (
      await q.query(`SELECT e.id, e.recipient, array_agg(et.task_id) AS tasks FROM events e JOIN event_tasks et ON et.event_id = e.id
                     WHERE e.kind = 'assign' AND e.state = 'open' GROUP BY e.id`)
    ).rows.map((r) => ({ eventId: r.id as string, to: this.name(r.recipient), tasks: r.tasks as string[] }));
    const inReplyTo = ev.replyTo ? await s.findEvent(q, ev.replyTo) : null;
    const thread = ev.tasks.length ? (await s.listEvents(q, { tasks: ev.tasks, limit: 20 })).filter((e) => e.id !== ev.id) : [];
    const sup = this.supervisor(recipient.id);
    const tasks = ev.tasks.filter((t) => this.nodes.has(t)).map((t) => this.task(t, open));
    const branches = this.branches(tasks);
    const d: Delivery = {
      event: this.eventView(ev, 20000),
      recipient: actorView(recipient),
      sender: ev.sender && this.nodes.get(ev.sender) ? actorView(this.nodes.get(ev.sender)!) : null,
      inReplyTo: inReplyTo ? this.eventView(inReplyTo) : null,
      tasks,
      thread: thread.map((e) => this.eventView(e, 1500)),
      supervisor: sup ? actorView(sup) : null,
      subordinates: this.subordinates(recipient.id).map(actorView),
      ...(branches.length ? { branches } : {}),
      howToReply: recipient.id === USER_ID
        ? `Ask or tell the user, then call submit_result with eventId "${ev.id}" (their answer as body, for an assignment).`
        : recipient.attrs.interactive
        ? ev.kind === 'assign'
          ? `When finished, call the submit_result tool with eventId "${ev.id}", a status (done, blocked, question, or progress), a markdown body, and optional proposals (ops).`
          : 'This is a report. There is nothing to reply to.'
        : recipient.attrs.decider
        ? `Publish {"type":"report","sender":"${recipient.id}","replyTo":"${ev.id}","body":"","answers":{...}} to ariadne.inbox.`
        : ev.kind === 'assign'
          ? `When finished, publish {"type":"report","sender":"${recipient.id}","replyTo":"${ev.id}","body":"<markdown>","closes":true,"proposals":[<ops>]} to ariadne.inbox. Use closes=false for a progress note or a question.`
          : 'This is a report. Act on it (follow your onReview brief); there is nothing to reply to.',
    };
    if (recipient.id === ANALYST_ID) d.analyst = await this.analystExtras();
    return d;
  }

  private async analystExtras(): Promise<AnalystExtras> {
    const q = this.q;
    const openCards = await s.listEvents(q, { actor: USER_ID, kind: 'assign', open: true, limit: 30 });
    const openAssignments = (await s.listEvents(q, { kind: 'assign', open: true, limit: 100 })).filter((e) => e.sender === ANALYST_ID && e.recipient !== USER_ID && !this.nodes.get(e.recipient ?? '')?.attrs.decider);
    const last = await q.query(`SELECT max(delivered_at) AS at FROM events WHERE recipient = $1 AND delivered_at IS NOT NULL`, [ANALYST_ID]);
    const since = last.rows[0]?.at ? new Date(last.rows[0].at).toISOString() : new Date(Date.now() - 86_400_000).toISOString();
    const changes = await s.listAudit(q, { via: 'ui', since, limit: 50 });
    const roots = (await q.query(`SELECT n.id, n.title FROM nodes n WHERE n.kind = 'task' AND n.status = 'open' AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.kind = 'needs' AND e.dst = n.id) ORDER BY n.updated_at DESC LIMIT 30`)).rows;
    return {
      openCards: openCards.map((e) => this.eventView(e, 500)),
      openAssignments: openAssignments.map((e) => this.eventView(e, 300)),
      openRoots: roots.map((r) => ({ id: r.id, title: r.title })),
      userChanges: changes.filter((c) => c.entity !== 'event_task').map((c) => describeChange(c, this)),
    };
  }
}

export function describeChange(a: s.AuditRow, names: { name(id: string | null): string }): string {
  const row = (a.after ?? a.before ?? {}) as Record<string, unknown>;
  if (a.entity === 'node') {
    const what = `${row.kind} "${row.title}"`;
    if (a.action !== 'update') return `${a.action}d ${what}`;
    const changed = Object.keys(row).filter((k) => !['version', 'updated_at'].includes(k) && JSON.stringify(a.before?.[k]) !== JSON.stringify(a.after?.[k]));
    return `updated ${what}: ${changed.map((k) => (k === 'status' ? `status ${a.before?.status} → ${a.after?.status}` : k)).join(', ')}`;
  }
  if (a.entity === 'edge') return `${a.action === 'delete' ? 'removed' : a.action === 'create' ? 'added' : 'updated'} edge "${names.name(row.src as string)}" ${row.kind} "${names.name(row.dst as string)}"`;
  return `${a.action}d ${row.kind ?? 'event'} ${a.entityId.slice(0, 8)}`;
}
