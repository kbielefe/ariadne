// Ariadne's MCP server (/mcp, localhost only, no token yet: agent-specific permissions come later).
// The Analyst is an interactive Claude Code session: it claims its events with the work tools
// (workmcp.ts) and acts with the rest. Headless agents work through RabbitMQ instead.
//
// Stateless Streamable HTTP: a new server + transport per request, plain JSON responses.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type Direction, reachable } from '../shared/graph';
import { ANALYST_ID, Card, EdgeKind, Effort, NodeKind, Op, Question, TaskStatus, USER_ID } from '../shared/model';
import { ContextBuilder } from './context';
import type { Core } from './core';
import { applyOps } from './ops';
import * as s from './store';
import { who } from './store';
import { WORK_INSTRUCTIONS, WORK_TOOLS } from './workmcp';

const INSTRUCTIONS = `You are the Analyst inside Ariadne: the user's trusted external memory.
Ariadne holds a graph (tasks, people, agents, teams, resources; edges needs/uses/involves/reports_to/member_of)
and a log of events (assign / report). Every tool call is audited and can be undone by the user.
Pass "because" = the id of the event you are handling, so your changes are grouped under it.
Before working on a task, check it is clear: a specific title, and a clear point where it is done. If not, rename it
(when the context tells you what is meant) or ask the user first.

Decisions: when the user (or anyone) makes a decision about a task, record it in that task's body as its own line,
"**Decision (Name, YYYY-MM-DD):** what was decided, and why in a few words" (update_node; keep the rest of the body).
Put it on the task it shapes. search with decisions: true finds them; check there before re-asking the user.

${WORK_INSTRUCTIONS}`;

type Handler = (core: Core, args: never, because: string | null) => Promise<unknown>;
export interface Tool {
  name: string;
  description: string;
  input: z.ZodObject;
  readOnly?: boolean;
  run: Handler;
}

const because = z.uuid().optional().describe('The event you are handling; groups your changes under it');

const tools: Tool[] = [
  {
    name: 'get_context',
    description: 'The full delivery for an event: the event, its tasks with inherited guidance/resources/people, the thread, supervisor and subordinates. Same shape agents receive.',
    input: z.object({ eventId: z.uuid() }),
    readOnly: true,
    run: async (core, a: { eventId: string }) => (await ContextBuilder.load(core.db)).delivery(await s.getEvent(core.db, a.eventId)),
  },
  {
    name: 'get_node',
    description: 'One node with its edges, neighbors, recent events and (for a task) readiness and inherited context.',
    input: z.object({ id: z.uuid() }),
    readOnly: true,
    run: async (core, a: { id: string }) => {
      const d = await core.nodeDetail(a.id);
      if (d.node.kind !== 'task') return d;
      const ctx = await ContextBuilder.load(core.db);
      return { ...d, context: ctx.task(a.id, []) };
    },
  },
  {
    name: 'search',
    description: 'Find nodes by text (title or body), kind, and task status. Newest changes first. decisions: true finds only nodes that record a decision (a "**Decision (Who, date):**" line in the body) and returns those lines.',
    input: z.object({
      query: z.string().optional(),
      kind: NodeKind.optional(),
      status: TaskStatus.optional(),
      decisions: z.boolean().optional().describe('Only nodes with decision lines; each result lists them'),
      limit: z.number().int().max(200).optional(),
    }),
    readOnly: true,
    run: async (core, a: { query?: string; kind?: string; status?: string; decisions?: boolean; limit?: number }) =>
      (await s.listNodes(core.db, { ...a, limit: a.limit ?? 50 })).map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        status: n.status,
        attrs: n.attrs,
        ...(a.decisions ? { decisions: s.decisionLines(n.body) } : {}),
      })),
  },
  {
    name: 'graph',
    description: 'The subgraph reachable from a node (down = what it needs/uses/involves; up = what needs it). Without "from": open root tasks and all actors.',
    input: z.object({
      from: z.uuid().optional(),
      direction: z.enum(['down', 'up', 'both']).optional(),
      kinds: z.array(EdgeKind).optional(),
      depth: z.number().int().min(1).max(20).optional(),
      includeClosed: z.boolean().optional().describe('Include done and dropped tasks'),
    }),
    readOnly: true,
    run: async (core, a: { from?: string; direction?: Direction; kinds?: z.infer<typeof EdgeKind>[]; depth?: number; includeClosed?: boolean }) => {
      const g = await core.graph();
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      let ids: Set<string>;
      if (a.from) ids = new Set(reachable(g.edges, a.from, { direction: a.direction ?? 'down', ...(a.kinds ? { kinds: a.kinds } : {}), ...(a.depth ? { depth: a.depth } : {}) }).keys());
      else ids = new Set(g.nodes.filter((n) => n.kind !== 'task' || !g.edges.some((e) => e.kind === 'needs' && e.dst === n.id)).map((n) => n.id));
      if (!a.includeClosed) for (const id of ids) if (byId.get(id)?.status && byId.get(id)!.status !== 'open' && id !== a.from) ids.delete(id);
      return {
        nodes: [...ids].map((id) => byId.get(id)!).filter(Boolean).map((n) => ({ id: n.id, kind: n.kind, title: n.title, status: n.status })),
        edges: g.edges.filter((e) => ids.has(e.src) && ids.has(e.dst)).map((e) => ({ id: e.id, src: e.src, kind: e.kind, dst: e.dst, ...(e.note ? { note: e.note } : {}) })),
        openAssignments: g.assignments.filter((x) => x.tasks.some((t) => ids.has(t))),
      };
    },
  },
  {
    name: 'list_events',
    description: 'Events, oldest first, filtered by task, actor (sender or recipient), kind, or open assignments only.',
    input: z.object({ task: z.uuid().optional(), actor: z.uuid().optional(), kind: z.enum(['assign', 'report']).optional(), open: z.boolean().optional(), limit: z.number().int().max(500).optional() }),
    readOnly: true,
    run: async (core, a: s.EventFilter) => {
      const ctx = await ContextBuilder.load(core.db);
      return (await s.listEvents(core.db, { ...a, limit: a.limit ?? 50 })).map((e) => ctx.eventView(e, 2000));
    },
  },
  {
    name: 'history',
    description: 'The audit log: who changed what, grouped by changeset. Filter by changeset, by the event a change was made because of, or since a time.',
    input: z.object({ changeset: z.uuid().optional(), because: z.uuid().optional(), since: z.string().optional(), limit: z.number().int().max(500).optional() }),
    readOnly: true,
    run: async (core, a: { changeset?: string; because?: string; since?: string; limit?: number }) => s.listAudit(core.db, { ...a, limit: a.limit ?? 100 }),
  },
  {
    name: 'apply_ops',
    description:
      'Create, update, or delete nodes, edges, and events in one transaction. When it closes tasks, nowReady lists the tasks that just became ready. Ops: create_node (kind, title, body?, status?, attrs?, ref?), update_node (id, ...; attrs merge, null removes), delete_node, create_edge (src, kind, dst, note?), update_edge, delete_edge (id, or src+kind+dst), update_event (id, body?, instructions?, state?, tasks?), delete_event. Use "ref" on create_node and "$ref" in later ops to link new nodes. Edge kinds: needs (task→task; a root task is one nothing needs), uses (task→resource), involves (task→person/agent/team), reports_to (actor→actor), member_of (person/agent→team).',
    input: z.object({ ops: z.array(Op).min(1), because }),
    run: async (core, a: { ops: Op[] }, b) =>
      core.run(who(ANALYST_ID, 'mcp', b), async (c) => {
        // Tasks this batch closes, so the answer can say what that made ready.
        const closing = a.ops.flatMap((op) => (op.op === 'update_node' && op.status && op.status !== 'open' && !op.id.startsWith('$') ? [op.id] : []));
        const wasOpen = closing.length ? (await c.tx.query(`SELECT id FROM nodes WHERE id::text = ANY($1) AND status = 'open'`, [closing])).rows.map((r) => r.id as string) : [];
        const results = await applyOps(c, a.ops);
        const nowReady = await core.newlyReady(c.tx, wasOpen);
        return { results, ...(nowReady.length ? { nowReady } : {}) };
      }),
  },
  {
    name: 'assign',
    description: "Give work to an agent, person, or team. Agents receive it over RabbitMQ with the tasks' full context; people and teams become an 'Ask <name>' item for the user. Model and effort are chosen by a System One decider (or the agent's defaults) unless you set them.",
    input: z.object({
      to: z.uuid(),
      tasks: z.array(z.uuid()).describe('Tasks this assignment is about'),
      body: z.string().min(1).describe('What to do, in markdown'),
      instructions: z.string().optional().describe('How to do it / how to report back, for this assignment only'),
      until: z.string().optional().describe('When to stop: keep working without asking until this is met (or blocked, or a decision is needed). E.g. "through the ready subtasks of X, committing between tasks, until the branch is ready for a PR"'),
      model: z.string().optional(),
      effort: Effort.optional(),
      dueInMinutes: z.number().positive().optional().describe('You get a report from Ariadne if nothing arrives by then'),
      because,
    }),
    run: async (core, a: { to: string; tasks: string[]; body: string; instructions?: string; until?: string; model?: string; effort?: string; dueInMinutes?: number }, b) =>
      core.send(who(ANALYST_ID, 'mcp', b), {
        kind: 'assign',
        recipient: a.to,
        tasks: a.tasks,
        body: a.body,
        instructions: a.instructions ?? '',
        decisions: {
          ...(a.until ? { until: { value: a.until, by: 'analyst' } } : {}),
          ...(a.model ? { model: { value: a.model, by: 'analyst' } } : {}),
          ...(a.effort ? { effort: { value: a.effort, by: 'analyst' } } : {}),
        },
        dueAt: a.dueInMinutes ? new Date(Date.now() + a.dueInMinutes * 60_000).toISOString() : null,
      }),
  },
  {
    name: 'tell_user',
    description: 'Leave a short markdown note for the user that needs no answer. It waits in list_assignments until a session tells them. In a live session, just tell the user directly; use this only for things that should wait.',
    input: z.object({ body: z.string().min(1), tasks: z.array(z.uuid()).optional(), because }),
    run: async (core, a: { body: string; tasks?: string[] }, b) => core.send(who(ANALYST_ID, 'mcp', b), { kind: 'report', recipient: USER_ID, body: a.body, tasks: a.tasks ?? [] }),
  },
  {
    name: 'ask_user',
    description:
      'Leave a question for the user: an approval, a choice, a task list. The card is an assignment to the user; it waits in list_assignments until a session asks them, and their answer comes back to you as a report. In a live session, just ask the user directly; use this only for things that should wait. Field types: text, textarea, select (options), checkbox, tasks (checklist of task ids; defaults to the card tasks). Ask only what needs them, with the minimum they need to decide.',
    input: z.object({ card: Card, body: z.string().optional().describe('Markdown shown on the card'), tasks: z.array(z.uuid()).optional(), because }),
    run: async (core, a: { card: unknown; body?: string; tasks?: string[] }, b) =>
      core.send(who(ANALYST_ID, 'mcp', b), { kind: 'assign', recipient: USER_ID, card: a.card as never, body: a.body ?? '', tasks: a.tasks ?? [] }),
  },
  {
    name: 'withdraw',
    description: 'Withdraw an open assignment you made (a card that no longer matters, or work no longer needed).',
    input: z.object({ eventId: z.uuid(), because }),
    run: async (core, a: { eventId: string }, b) => {
      const ev = await s.getEvent(core.db, a.eventId);
      if (ev.sender !== ANALYST_ID) throw new s.Invalid('You can withdraw only your own assignments');
      return core.ops(who(ANALYST_ID, 'mcp', b), [{ op: 'update_event', id: a.eventId, state: 'withdrawn' }]);
    },
  },
  {
    name: 'decide',
    description:
      'Ask a System One decider (fast, cheap, calibrated; it cannot write text). Question types: choice {instructions, criteria: {option: description}}, score {instructions, scale: [labels]}, noul {instructions} (yes/no as 0-1). Returns answers with confidence, or null when no decider answers in time. Act on high confidence; otherwise think it through or ask the user.',
    input: z.object({ state: z.string().min(1), questions: z.record(z.string(), Question), timeoutMs: z.number().int().max(30000).optional() }),
    readOnly: true,
    run: async (core, a: { state: string; questions: Record<string, unknown>; timeoutMs?: number }) => (await core.decide(ANALYST_ID, a.state, a.questions, a.timeoutMs)) ?? { answers: null },
  },
  {
    name: 'schedule_event',
    description:
      'Send an event later: a reminder for the user (report to them), a follow-up assignment, a check-in. Give "at" (ISO time) or "inMinutes". The event is checked when it is sent; if it fails then, the user is told. Returns the timer id for cancel_scheduled.',
    input: z
      .object({
        at: z.iso.datetime({ offset: true }).optional(),
        inMinutes: z.number().positive().optional(),
        event: z.object({
          kind: z.enum(['assign', 'report']),
          to: z.uuid().optional().describe('Recipient. A report needs "to" or "replyTo"'),
          replyTo: z.uuid().optional(),
          closes: z.boolean().optional(),
          body: z.string().min(1),
          instructions: z.string().optional(),
          tasks: z.array(z.uuid()).optional(),
        }),
        because,
      })
      .refine((x) => (x.at ? 1 : 0) + (x.inMinutes ? 1 : 0) === 1, 'Give exactly one of at or inMinutes'),
    run: async (core, a: { at?: string; inMinutes?: number; event: { kind: 'assign' | 'report'; to?: string; replyTo?: string; closes?: boolean; body: string; instructions?: string; tasks?: string[] } }, b) => {
      const at = a.at ? new Date(a.at) : new Date(Date.now() + a.inMinutes! * 60_000);
      const e = a.event;
      if (e.kind === 'assign' && !e.to) throw new s.Invalid('An assignment needs "to"');
      if (e.kind === 'report' && !e.to && !e.replyTo) throw new s.Invalid('A report needs "to" or "replyTo"');
      if (e.to) await s.getNode(core.db, e.to);
      const input = { kind: e.kind, body: e.body, ...(e.to ? { recipient: e.to } : {}), ...(e.replyTo ? { replyTo: e.replyTo } : {}), ...(e.closes !== undefined ? { closes: e.closes } : {}), ...(e.instructions ? { instructions: e.instructions } : {}), ...(e.tasks ? { tasks: e.tasks } : {}) };
      const t = await core.run(who(ANALYST_ID, 'mcp', b), (c) => core.scheduleTx(c, { kind: 'send', at, payload: { input } }));
      return { id: t.id, at: t.at };
    },
  },
  {
    name: 'cancel_scheduled',
    description: 'Cancel a scheduled event (or any timer) before it fires.',
    input: z.object({ id: z.uuid(), because }),
    run: async (core, a: { id: string }, b) => {
      const cancelled = await core.run(who(ANALYST_ID, 'mcp', b), (c) => core.cancelTimerTx(c, a.id));
      if (!cancelled) throw new s.Invalid('No live timer with that id (it may have fired already)');
      return { cancelled };
    },
  },
  {
    name: 'list_scheduled',
    description: 'Timers that have not fired yet: scheduled events (kind send) and claim checks (kind claim_check).',
    input: z.object({ kind: z.enum(['send', 'claim_check']).optional() }),
    readOnly: true,
    run: async (core, a: { kind?: string }) => core.listTimers(a),
  },
  ...WORK_TOOLS,
  {
    name: 'undo',
    description: 'Revert a changeset (from history).',
    input: z.object({ changeset: z.uuid(), because }),
    run: async (core, a: { changeset: string }, b) => ({ undone: await core.undo(who(ANALYST_ID, 'mcp', b), a.changeset) }),
  },
];

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { items: value },
});
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

const byName = new Map(tools.map((t) => [t.name, t]));

export function createMcpServer(core: Core): Server {
  const server = new Server({ name: 'ariadne', version: '0.2.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const listed = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: 'input' }) as { type: 'object' },
    annotations: { readOnlyHint: !!t.readOnly, destructiveHint: false, openWorldHint: false },
  }));
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) return fail(`Unknown tool ${req.params.name.slice(0, 80)}`);
    const parsed = tool.input.safeParse(req.params.arguments ?? {});
    if (!parsed.success) return fail(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
    const args = parsed.data as Record<string, unknown>;
    try {
      const result = await tool.run(core, args as never, (args.because as string | undefined) ?? null);
      // A call made for an event keeps its claim alive (core.heartbeat), so a session busy on it isn't timed out.
      // The claim tools (workmcp.ts) set the claim timer themselves.
      const forEvent = (args.because ?? args.eventId) as string | undefined;
      if (forEvent && !WORK_TOOLS.includes(tool)) await core.heartbeat(forEvent).catch((err) => console.error('heartbeat.failed', forEvent, err));
      return ok(result);
    } catch (err) {
      if (err instanceof z.ZodError) return fail(`Invalid: ${z.prettifyError(err)}`);
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
  return server;
}

export async function handleMcp(core: Core, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const server = createMcpServer(core);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export const MCP_TOOL_NAMES = tools.map((t) => t.name);
