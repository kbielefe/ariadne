// The application core: every change goes through here, in one transaction, then the hub is told.
import { readiness, taskState } from '../shared/graph';
import type { Edge, Node, NodeWithPrivate } from '../shared/model';
import { type Db, withTx } from './db';
import type { ApplyOutcome, Federation } from './federation';
import type { Hub } from './hub';
import { applyOps } from './ops';
import * as s from './store';
import type { Ctx, Who } from './store';

export class Core {
  /** Set when this process is speaking to other Ariadne instances. */
  federation: Federation | null = null;

  constructor(
    readonly db: Db,
    readonly hub: Hub,
  ) {}

  /** Runs `fn` in a transaction as `w`, then tells browsers to refetch. */
  async run<T>(w: Who, fn: (c: Ctx) => Promise<T>): Promise<T> {
    const result = await withTx(this.db, (tx) => fn({ tx, who: w }));
    this.hub.changed();
    return result;
  }

  /** The committed op results. Callers that need proposals still waiting use `apply`. */
  ops(w: Who, ops: unknown) {
    if (!this.federation) return this.run(w, (c) => applyOps(c, ops));
    return this.federation.apply(w, ops).then((out) => out.results);
  }

  /** Local ops commit here. Ops on a node homed elsewhere stay pending until that home accepts them. */
  async apply(w: Who, ops: unknown): Promise<ApplyOutcome> {
    if (this.federation) return this.federation.apply(w, ops);
    return this.run(w, async (c) => {
      const list = Array.isArray(ops) ? ops : [];
      const closing = list.flatMap((op) => (op && typeof op === 'object' && (op as { op?: string }).op === 'update_node' && (op as { status?: string }).status && (op as { status?: string }).status !== 'open' && typeof (op as { id?: string }).id === 'string' && !(op as { id: string }).id.startsWith('$') ? [(op as { id: string }).id] : []));
      const wasOpen = closing.length ? (await c.tx.query(`SELECT id FROM nodes WHERE id::text = ANY($1) AND status = 'open'`, [closing])).rows.map((r) => r.id as string) : [];
      const results = await applyOps(c, ops);
      return { results, pending: [], nowReady: await this.newlyReady(c.tx, wasOpen) };
    });
  }

  async undo(w: Who, changeset: string) {
    if (this.federation) await this.federation.assertUndoable(changeset);
    const undone = await this.run(w, (c) => s.undoChangeset(c, changeset));
    if (this.federation) await this.federation.afterLocal();
    return undone;
  }

  async graph(): Promise<{ nodes: Node[]; edges: Edge[] }> {
    const [nodes, edges] = await Promise.all([s.listNodes(this.db, { limit: 5000 }), s.listEdges(this.db)]);
    return { nodes, edges };
  }

  /** Open tasks that need one of `closed` and now wait on nothing (no open needs, no waits_on): what closing those tasks just made ready. */
  async newlyReady(q: s.Q, closed: string[]): Promise<{ id: string; title: string }[]> {
    if (!closed.length) return [];
    const r = await q.query(
      `SELECT DISTINCT t.id, t.title FROM edges e JOIN nodes t ON t.id = e.src JOIN nodes d ON d.id = e.dst
       WHERE e.kind = 'needs' AND e.dst::text = ANY($1) AND d.status <> 'open' AND t.status = 'open'
         AND NOT EXISTS (SELECT 1 FROM edges w JOIN nodes n ON n.id = w.dst WHERE w.kind = 'needs' AND w.src = t.id AND n.status = 'open')
         AND NOT EXISTS (SELECT 1 FROM edges x WHERE x.kind = 'waits_on' AND x.src = t.id)
       ORDER BY t.title`,
      [closed],
    );
    return r.rows.map((x) => ({ id: x.id as string, title: x.title as string }));
  }

  /** The node view for the local user (UI and MCP get_node): the only read that includes the node's private notes. Never export it. */
  async nodeDetail(id: string) {
    const node: NodeWithPrivate = { ...(await s.getNode(this.db, id)), privateNotes: await s.privateNotes(this.db, id) };
    const all = await s.listEdges(this.db);
    const edges = all.filter((e) => e.src === id || e.dst === id);
    const others = await Promise.all([...new Set(edges.map((e) => (e.src === id ? e.dst : e.src)))].map((n) => s.getNode(this.db, n)));
    const byId = new Map([node, ...others].map((n) => [n.id, n]));
    const pending = this.federation ? (await import('./federation/repo')).pendingForNode(this.db, id) : false;
    return { node, edges, neighbors: others, ...(pending ? { pending: true } : {}), ...(node.kind === 'task' ? { readiness: withState(readiness(node, all, byId)) } : {}) };
  }
}

const withState = (r: ReturnType<typeof readiness>) => ({ ...r, state: taskState(r) });
