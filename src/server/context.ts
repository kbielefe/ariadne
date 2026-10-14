// A task's context, for MCP get_node.
//
// Context is inherited down the `needs` graph: a task gets the guidance, resources, and people of
// every task that (transitively) needs it, so a repo attached to a root task reaches all its subtasks.
// A branch resource is a shared scope: every task in it ships together in one PR (branches()).
import { ancestorTasks, reachable, readiness } from '../shared/graph';
import { type Edge, type Node, USER_ID } from '../shared/model';
import * as s from './store';
import type { Q } from './store';

export interface ActorView {
  id: string;
  kind: Node['kind'];
  name: string;
  about: string;
  areas?: unknown;
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

const truncate = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

export function actorView(n: Node): ActorView {
  const a = n.attrs;
  return {
    id: n.id,
    kind: n.kind,
    name: n.title,
    about: n.body,
    ...(a.areas ? { areas: a.areas } : {}),
  };
}

export class ContextBuilder {
  readonly nodes = new Map<string, Node>();
  private edges: Edge[] = [];

  private constructor() {}

  static async load(q: Q): Promise<ContextBuilder> {
    const b = new ContextBuilder();
    for (const n of await s.listNodes(q, { limit: 5000 })) b.nodes.set(n.id, n);
    b.edges = await s.listEdges(q);
    return b;
  }

  name(id: string | null) {
    if (!id) return 'Claude (MCP)';
    if (id === USER_ID) return `${this.nodes.get(id)?.title ?? 'You'} (the user)`;
    return this.nodes.get(id)?.title ?? id;
  }

  task(id: string): TaskContext {
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
}

export function describeChange(a: s.AuditRow, names: { name(id: string | null): string }): string {
  const row = (a.after ?? a.before ?? {}) as Record<string, unknown>;
  if (a.entity === 'node') {
    const what = `${row.kind} "${row.title}"`;
    if (a.action !== 'update') return `${a.action}d ${what}${a.reason ? ` (why: ${a.reason})` : ''}`;
    const changed = Object.keys(row).filter((k) => !['version', 'updated_at'].includes(k) && JSON.stringify(a.before?.[k]) !== JSON.stringify(a.after?.[k]));
    const fields = changed.map((k) => (k === 'status' ? `status ${a.before?.status} → ${a.after?.status}` : k)).join(', ');
    return `updated ${what}: ${fields}${a.reason ? ` (why: ${a.reason})` : ''}`;
  }
  return `${a.action === 'delete' ? 'removed' : a.action === 'create' ? 'added' : 'updated'} edge "${names.name(row.src as string)}" ${row.kind} "${names.name(row.dst as string)}"`;
}
