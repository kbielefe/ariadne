// HTTP for the web UI and /mcp (Claude Code sessions). Both are localhost only, with no authentication.
// UI edits apply directly and are audited.
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

  app.get<{ Querystring: { changeset?: string; limit?: string } }>('/api/history', async (req) => {
    const rows = await s.listAudit(core.db, { ...(req.query.changeset ? { changeset: req.query.changeset } : {}), limit: Number(req.query.limit) || 200 });
    const ctx = await ContextBuilder.load(core.db);
    return rows.map((a) => ({ ...a, line: describeChange(a, ctx), who: ctx.name(a.actor) }));
  });

  // The changeset id lets the UI offer Undo right after a change.
  app.post('/api/ops', async (req) => {
    const w = who(USER_ID, 'ui');
    const out = await core.apply(w, (req.body as { ops?: unknown })?.ops);
    return { results: out.results, changeset: w.changeset, ...(out.nowReady.length ? { nowReady: out.nowReady } : {}) };
  });
  app.post('/api/undo', async (req) => ({ undone: await core.undo(who(USER_ID, 'ui'), z.object({ changeset: z.uuid() }).parse(req.body).changeset) }));

  // Server-sent events: browsers refetch on "changed".
  app.get('/api/stream', (req: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (type: string, data: unknown) => reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', {});
    const off = core.hub.on('changed', () => send('changed', {}));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  });

  // ---- MCP: no token; the Host/Origin guard above keeps it to localhost.
  app.post('/mcp', async (req, reply) => {
    reply.hijack();
    await handleMcp(core, req.raw, reply.raw, req.body);
  });
  app.get('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'POST only (stateless)' }));
}
