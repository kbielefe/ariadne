// Applies a batch of operations (the one change vocabulary shared by the UI, MCP, and agent
// proposals) inside the caller's transaction. Checks every rule the database can't.
import { z } from 'zod';
import { wouldCycle } from '../shared/graph';
import { ANALYST_ID, ATTRS_BY_KIND, EDGE_RULES, type NodeKind, type Op, Ops, USER_ID } from '../shared/model';
import * as s from './store';
import { type Ctx, Invalid } from './store';

export interface OpResult {
  op: Op['op'];
  id: string;
  ref?: string;
}

const PROTECTED = new Set([USER_ID, ANALYST_ID]);

export async function applyOps(c: Ctx, input: unknown): Promise<OpResult[]> {
  const ops = Ops.parse(input);
  const refs = new Map<string, string>();
  const resolve = (v: string) => {
    if (!v.startsWith('$')) return v;
    const id = refs.get(v.slice(1));
    if (!id) throw new Invalid(`Unknown ref ${v}: create it earlier in the same batch with "ref": "${v.slice(1)}"`);
    return id;
  };
  const results: OpResult[] = [];
  for (const [i, op] of ops.entries()) {
    try {
      results.push(await applyOne(c, op, resolve, refs));
    } catch (err) {
      if (err instanceof Error) err.message = `op ${i} (${op.op}): ${err.message}`;
      throw err;
    }
  }
  return results;
}

function checkAttrs(kind: NodeKind, attrs: Record<string, unknown>) {
  const r = ATTRS_BY_KIND[kind].strict().safeParse(attrs);
  if (!r.success) throw new Invalid(`attrs for a ${kind}: ${z.prettifyError(r.error)}. Allowed keys: ${Object.keys(ATTRS_BY_KIND[kind].shape).join(', ')}`);
}

async function applyOne(c: Ctx, op: Op, resolve: (v: string) => string, refs: Map<string, string>): Promise<OpResult> {
  switch (op.op) {
    case 'create_node': {
      if (op.status && op.kind !== 'task') throw new Invalid('only tasks have a status');
      checkAttrs(op.kind, op.attrs ?? {});
      const n = await s.insertNode(c, op);
      if (op.ref) {
        if (refs.has(op.ref)) throw new Invalid(`ref "${op.ref}" used twice`);
        refs.set(op.ref, n.id);
      }
      return { op: op.op, id: n.id, ...(op.ref ? { ref: op.ref } : {}) };
    }
    case 'update_node': {
      const id = resolve(op.id);
      const node = await s.getNode(c.tx, id);
      if (op.status && node.kind !== 'task') throw new Invalid('only tasks have a status');
      if (op.attrs) {
        const merged: Record<string, unknown> = { ...node.attrs, ...op.attrs };
        for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
        checkAttrs(node.kind, merged);
      }
      await s.patchNode(c, id, op);
      return { op: op.op, id };
    }
    case 'delete_node': {
      const id = resolve(op.id);
      if (PROTECTED.has(id)) throw new Invalid('You and the Analyst can be edited but not deleted');
      await s.removeNode(c, id);
      return { op: op.op, id };
    }
    case 'create_edge': {
      const src = await s.getNode(c.tx, resolve(op.src));
      const dst = await s.getNode(c.tx, resolve(op.dst));
      const rule = EDGE_RULES[op.kind];
      if (!rule.src.includes(src.kind) || !rule.dst.includes(dst.kind))
        throw new Invalid(`${op.kind} goes from ${rule.src.join('/')} to ${rule.dst.join('/')}, not ${src.kind} to ${dst.kind}`);
      if (rule.acyclic) {
        await c.tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`edges:${op.kind}`]);
        const edges = (await c.tx.query('SELECT * FROM edges WHERE kind = $1', [op.kind])).rows.map(s.mapEdge);
        if (wouldCycle(edges, op.kind, src.id, dst.id)) throw new Invalid(`"${src.title}" ${op.kind} "${dst.title}" would make a cycle`);
      }
      const e = await s.insertEdge(c, { src: src.id, kind: op.kind, dst: dst.id, note: op.note ?? '' });
      return { op: op.op, id: e.id };
    }
    case 'update_edge': {
      await s.patchEdge(c, op.id, op.note);
      return { op: op.op, id: op.id };
    }
    case 'delete_edge': {
      let id = op.id;
      if (!id) {
        if (!op.src || !op.kind || !op.dst) throw new Invalid('give an edge id, or src + kind + dst');
        const r = await c.tx.query('SELECT id FROM edges WHERE src = $1 AND kind = $2 AND dst = $3', [resolve(op.src), op.kind, resolve(op.dst)]);
        if (!r.rows[0]) throw new s.NotFound('No such edge');
        id = r.rows[0].id as string;
      }
      await s.removeEdge(c, id);
      return { op: op.op, id };
    }
    case 'update_event': {
      const ev = await s.getEvent(c.tx, op.id);
      if (op.state && ev.kind !== 'assign') throw new Invalid('only assignments have a state');
      await s.patchEvent(c, op.id, { body: op.body, instructions: op.instructions, state: op.state });
      if (op.tasks) {
        const want = new Set(op.tasks.map(resolve));
        for (const t of want) if ((await s.getNode(c.tx, t)).kind !== 'task') throw new Invalid(`${t} is not a task`);
        for (const t of ev.tasks) if (!want.has(t)) await s.unlinkEventTask(c, ev.id, t);
        for (const t of want) await s.linkEventTask(c, ev.id, t);
      }
      return { op: op.op, id: op.id };
    }
    case 'delete_event': {
      await s.removeEvent(c, op.id);
      return { op: op.op, id: op.id };
    }
  }
}
