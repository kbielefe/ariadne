// HTTP for the web UI (and /mcp for the analyst). Your UI edits apply directly and are audited;
// the analyst sees them in its next delivery ("userChanges").
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { USER_ID } from '../shared/model';
import { ContextBuilder, describeChange } from './context';
import type { Core } from './core';
import { handleMcp } from './mcp';
import * as s from './store';
import { who } from './store';

export interface ApiOptions {
  allowedHosts: string[];
  mcpToken: string;
}

export function registerApi(app: FastifyInstance, core: Core, o: ApiOptions) {
  // DNS-rebinding guard: only our own Host header, and same-origin browser writes.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/health')) return;
    if (!o.allowedHosts.includes(req.headers.host ?? '')) return reply.code(421).send({ error: 'Host not allowed' });
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET' && !o.allowedHosts.some((h) => origin === `http://${h}`)) return reply.code(403).send({ error: 'Cross-origin request refused' });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: z.prettifyError(err) });
    if (err instanceof s.NotFound) return reply.code(404).send({ error: err.message });
    if (err instanceof s.Invalid) return reply.code(400).send({ error: err.message });
    if (err instanceof s.Conflict) return reply.code(409).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong on the server; see its log.' });
  });

  app.get('/health/live', async () => ({ ok: true }));
  app.get('/health/ready', async () => {
    await core.db.query('SELECT 1');
    return { ok: true };
  });

  app.get('/api/graph', async () => core.graph());
  app.get<{ Params: { id: string } }>('/api/nodes/:id', async (req) => core.nodeDetail(z.uuid().parse(req.params.id)));

  app.get<{ Querystring: { focus?: string; all?: string; limit?: string } }>('/api/timeline', async (req) => {
    const events = await core.timeline({ focus: req.query.focus || null, all: req.query.all === '1', limit: Number(req.query.limit) || 200 });
    // What the analyst (or Ariadne) changed while handling each of these events, so it can be undone.
    const ids = events.map((e) => e.id);
    const audit = ids.length ? await core.db.query(`SELECT * FROM audit WHERE because = ANY($1::uuid[]) AND actor IS DISTINCT FROM $2 AND via IN ('mcp', 'core') ORDER BY id`, [ids, USER_ID]) : { rows: [] };
    const ctx = await ContextBuilder.load(core.db);
    const changes: Record<string, { lines: string[]; undone: boolean; count: number }> = {};
    for (const a of audit.rows.map(s.mapAudit)) {
      if (a.entity === 'event' || a.entity === 'event_task') continue; // messages are already in the timeline
      const c = (changes[a.because!] ??= { lines: [], undone: true, count: 0 });
      c.lines.push(describeChange(a, ctx));
      c.count++;
      c.undone &&= a.undone;
    }
    return { events, changes, statuses: core.hub.currentStatuses() };
  });

  app.get<{ Querystring: { task?: string; actor?: string; open?: string; limit?: string } }>('/api/events', async (req) =>
    s.listEvents(core.db, { ...(req.query.task ? { task: req.query.task } : {}), ...(req.query.actor ? { actor: req.query.actor } : {}), open: req.query.open === '1', limit: Number(req.query.limit) || 200 }),
  );

  app.get<{ Querystring: { because?: string; changeset?: string; limit?: string } }>('/api/history', async (req) => {
    const rows = await s.listAudit(core.db, { ...(req.query.because ? { because: req.query.because } : {}), ...(req.query.changeset ? { changeset: req.query.changeset } : {}), limit: Number(req.query.limit) || 200 });
    const ctx = await ContextBuilder.load(core.db);
    return rows.map((a) => ({ ...a, line: describeChange(a, ctx), who: ctx.name(a.actor) }));
  });

  app.post('/api/ops', async (req) => ({ results: await core.ops(who(USER_ID, 'ui'), (req.body as { ops?: unknown })?.ops) }));

  app.post('/api/chat', async (req) => {
    const b = z.object({ text: z.string().min(1).max(20000), focus: z.uuid().nullable().optional(), refs: z.array(z.uuid()).max(30).optional() }).parse(req.body);
    return core.chat(b.text, b.focus ?? null, b.refs ?? []);
  });

  app.post<{ Params: { id: string } }>('/api/cards/:id/respond', async (req) => core.respond(z.uuid().parse(req.params.id), req.body));

  /** Undo everything the analyst and Ariadne changed while handling an event (newest first). */
  app.post('/api/undo', async (req) => {
    const b = z.object({ because: z.uuid().optional(), changeset: z.uuid().optional() }).parse(req.body);
    if (b.changeset) return { undone: await core.undo(who(USER_ID, 'ui'), b.changeset) };
    if (!b.because) throw new s.Invalid('Give because or changeset');
    const r = await core.db.query(`SELECT changeset, max(id) AS last FROM audit WHERE because = $1 AND NOT undone AND actor IS DISTINCT FROM $2 AND entity IN ('node', 'edge') GROUP BY changeset ORDER BY last DESC`, [b.because, USER_ID]);
    let undone = 0;
    for (const row of r.rows) undone += await core.undo(who(USER_ID, 'ui', b.because), row.changeset);
    return { undone };
  });

  // Server-sent events: browsers refetch on "changed" and show "status" lines.
  app.get('/api/stream', (req: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (type: string, data: unknown) => reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', { statuses: core.hub.currentStatuses() });
    const offs = [core.hub.on('changed', () => send('changed', {})), core.hub.on('status', (st) => send('status', st))];
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      for (const off of offs) off();
    });
  });

  // ---- MCP: the analyst only
  const expected = Buffer.from(`Bearer ${o.mcpToken}`);
  const authorized = (req: FastifyRequest) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  app.post('/mcp', async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ jsonrpc: '2.0', error: { code: -32001, message: 'Only the Analyst may use MCP' }, id: null });
    reply.hijack();
    await handleMcp(core, req.raw, reply.raw, req.body);
  });
  app.get('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'POST only (stateless)' }));

}
