// The application core: every change goes through here, in one transaction, then the hub is told.
import { readiness } from '../shared/graph';
import type { Edge, Node } from '../shared/model';
import { type Db, withTx } from './db';
import type { Hub } from './hub';
import { applyOps } from './ops';
import * as s from './store';
import type { Ctx, Who } from './store';

export class Core {
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

  ops(w: Who, ops: unknown) {
    return this.run(w, (c) => applyOps(c, ops));
  }

  undo(w: Who, changeset: string) {
    return this.run(w, (c) => s.undoChangeset(c, changeset));
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

  async nodeDetail(id: string) {
    const node = await s.getNode(this.db, id);
    const all = await s.listEdges(this.db);
    const edges = all.filter((e) => e.src === id || e.dst === id);
    const others = await Promise.all([...new Set(edges.map((e) => (e.src === id ? e.dst : e.src)))].map((n) => s.getNode(this.db, n)));
    const byId = new Map([node, ...others].map((n) => [n.id, n]));
    return { node, edges, neighbors: others, ...(node.kind === 'task' ? { readiness: readiness(node, all, byId) } : {}) };
  }
}
