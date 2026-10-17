// Ariadne's MCP server (/mcp, localhost only, no token). The user keeps the graph with Claude Code
// in an interactive session: it looks things up and applies changes here.
//
// Stateless Streamable HTTP: a new server + transport per request, plain JSON responses.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type Direction, reachable, readiness, skipEdges, taskState } from '../shared/graph';
import { EdgeKind, NodeKind, Op, TaskStatus } from '../shared/model';
import { ContextBuilder, type TaskContext } from './context';
import type { Core } from './core';
import * as s from './store';
import { who } from './store';

const INSTRUCTIONS = `Ariadne is the user's task and org tracker: their trusted external memory, so the bigger picture
and what's next survive interruptions and session changes. It is a graph of tasks, people, teams, and resources
(edges needs/uses/involves/reports_to/member_of/waits_on/working_on). Every change is audited and can be undone (history, undo).
Before working on a task, check it is clear: a specific title, and a clear point where it is done. If not, rename it
(when the context tells you what is meant) or ask the user first. A task with an empty body is a quick capture: link
it with needs from the nearest task it belongs to, so it is not an orphan root. When you pick it up, fill in What/Why
and **Done when:** before starting.

Subtasks: before starting non-trivial work, split it into subtasks linked by needs. "A needs B" means B must be done
before A: check it against the real dependency (which code ships first), not the order you wrote the tasks. A good
leaf is about one PR or commit-sized change, one decision, one conversation with a specific person, or one verification
run ("integration suite passes on branch X"). An umbrella task's body says "Done when the kept subtasks are done."
Chains 3-6 levels deep are normal. When two parents need the same thing, link both to one subtask rather than
duplicating it. A direct needs edge is a skip when a longer needs path already connects the same tasks
(A needs B needs C, so A needs C adds nothing). remove_skip_links lists those; apply: true deletes them in one
changeset, which undo restores. search before creating a task; update or close a stale one instead of adding a near-duplicate.

Waiting: when work is blocked outside the user's control (a PR review, a CI build, a merge, a release, someone's
answer), add a leaf "Waiting on <what>: <subject>" (e.g. "Waiting on review: <repo> PR #48", "Waiting on CI: <repo>
PR #48", "Waiting on merge: <repo> PR #48"), needed by every task it blocks. Always link it with waits_on to who or
what it waits on: the reviewer or team (person/team), or the build or PR (resource with a url); search for that node
first and create it if missing. Add the leaf as soon as you open a PR, request a review, start a CI run, or ask someone
a question, not only once work is stuck. Use waits_on liberally: the user reads the graph view to see what is blocked
on what, without opening task bodies. A task with a waits_on edge is blocked, not ready, until it is closed: close it
when the wait is over, and add a new leaf for the next wait (review, then CI, then merge). A dropped need counts as satisfied, so drop only work that will not happen. When work moves (e.g. PRs combined),
retitle the task to what it is now and re-point its edges.

Waiting on the user: the person node "You" (id 00000000-0000-4000-8000-000000000001) is the user. When work needs
the user's own action, add a leaf "Review: <what>" (a branch to push, a PR to open, a draft to send, work to check) or
"Decide: <question>" (a choice only they make, or a provisional decision to confirm), linked waits_on You and needed by
the task it gates. Put the exact command or draft in its body. Do this instead of leaving it only in a Status line, so
the user's queue is visible in the graph. Close it when the user acts. Each open task has a state (graph, get_node):
ready means anyone, an agent included, can take it; yours means it waits only on the user (drawn violet); blocked
means it waits on someone or something else (yellow); waiting means it waits on open subtasks; theirs means someone
other than the user is working on it (a working_on edge from their person or team node; drawn muted). graph from You,
direction up, kinds [waits_on] lists the user's queue. Pick up ready tasks; never work around a yours one, and never
pick up a theirs one: coordinate with that person instead.

Someone else's work: when a teammate is doing something (they said so, or steward reports their intent), record it as a
task with working_on from their person node to it. working_on reads "Will is working on X"; involves (task to person)
stays "coordinate with".

Titles and bodies: prefix titles with the repo or area ("PDP CI: ...") and name the result, not the activity. Body:
What/Why, then **Done when:**. Keep one "**Status (YYYY-MM-DD):**" line for where it stands now; replace it on each
update instead of appending progress lines (history keeps the old ones). When closing, add "**Result (YYYY-MM-DD):**"
with the commit, PR, or test evidence. Close each subtask as soon as it is done, not in a batch at the end.
To change part of a long body, use update_node append (or section + body/append for one "## Heading")
instead of re-sending the whole body.

Decisions: when the user (or anyone) makes a decision about a task, record it in that task's body as its own line,
"**Decision (Name, YYYY-MM-DD):** what was decided, and why in a few words" (update_node; keep the rest of the body).
Put it on the task it shapes. search with decisions: true finds them; check there before re-asking the user. If you
must choose without the user (e.g. working unattended), write "**Decision (<agent>, provisional, YYYY-MM-DD):** chose A
over B, why. Flip: how to reverse." and add a "Decide: confirm <choice>" leaf for it (see Waiting on the user). When
the user confirms or changes it, rewrite it as their own Decision line, without Flip, and close the leaf.

Private notes: every node has a public body and separate private notes. Prefer the body: it may be shared with the
pod later, so write it as work facts. Use private notes only for what must never leave this machine: opinions about
people (frank or not), personnel or HR matters, unannounced plans, other teams' confidential details, pointers to where
credentials live (never the credentials themselves), and anything that would embarrass someone if shared. Writing them
(privateNotes or privateAppend on create_node / update_node) requires privateReason, one line on why this cannot go in
the body; it is recorded in the audit log, and history shows it. get_node returns them as node.privateNotes. Never copy
private notes into a body, a title, an edge note, or anything you send elsewhere.

Sharing with the pod (steward): attrs.steward: true on a task shares it and everything it needs with the user's pod
(title, body, state, repos, branch, PR link, decision lines; never private notes). attrs.private: true keeps a task and
what it needs out of a shared subtree. Only opt a subtree in when the user asks. A teammate's question arrives as an
"Ask (Name): ..." task waiting on You: when the user answers, append "**Answer (Name, YYYY-MM-DD):** ..." to its body and
close it; steward sends the answer lines to the asker only. When you ask a teammate through steward, add the "Waiting
on <Name>: ..." leaf as usual with attrs.steward {kind: "waiting", ticket: "<ticket id>", to: "<their peer id>"}: their
answer is appended there and closes it. A teammate's declared intent arrives as an "Intent (Name): ..." task that
their person node is working_on (theirs); steward keeps it up to date and drops it when it expires. Read intents to spot
overlap with the user's work; don't edit them.

When closing tasks makes others ready, apply_ops lists them as nowReady: offer the user the next one.`;

/** A task's context without the bodies: its own is already in node, and the others can be fetched by id. */
function briefContext({ body: _, ...c }: TaskContext) {
  return {
    ...c,
    resources: c.resources.map(({ from, item: { about: _a, ...item } }) => ({ from, item })),
    coordinateWith: c.coordinateWith.map(({ from, item: { about: _a, ...item } }) => ({ from, item })),
  };
}

type Handler = (core: Core, args: never) => Promise<unknown>;
export interface Tool {
  name: string;
  description: string;
  input: z.ZodObject;
  readOnly?: boolean;
  run: Handler;
}

const tools: Tool[] = [
  {
    name: 'get_node',
    description: 'One node with its edges and neighbors. node.privateNotes holds the private notes (local only; never copy them into anything shared). For a task, also readiness, inherited context (guidance, resources, people from every task that needs it), and the shared branches it ships on with every task in their scope. brief: true leaves out neighbor, resource, and people bodies (ids, titles, and status only); use it on busy nodes.',
    input: z.object({ id: z.uuid(), brief: z.boolean().optional().describe('Neighbors as id, kind, title, status; no bodies besides this node\'s own') }),
    readOnly: true,
    run: async (core, a: { id: string; brief?: boolean }) => {
      const d = await core.nodeDetail(a.id);
      const detail = a.brief ? { ...d, neighbors: d.neighbors.map((n) => ({ id: n.id, kind: n.kind, title: n.title, status: n.status })) } : d;
      if (d.node.kind !== 'task') return detail;
      const ctx = await ContextBuilder.load(core.db);
      const full = ctx.task(a.id);
      const context = a.brief ? briefContext(full) : full;
      const branches = ctx.branches([full]);
      return { ...detail, context, ...(branches.length ? { branches } : {}) };
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
    description: 'The subgraph reachable from a node (down = what it needs/uses/involves, or what a person is working_on; up = what needs it). Without "from": root tasks, people, teams, and resources. Each open task has a state: ready (anyone, an agent included, can take it), yours (waits only on the user), blocked (waits on someone or something else), waiting (on open subtasks), or theirs (someone other than the user is working on it; never pick it up).',
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
        nodes: [...ids].map((id) => byId.get(id)!).filter(Boolean).map((n) => ({ id: n.id, kind: n.kind, title: n.title, status: n.status, ...(n.status === 'open' ? { state: taskState(readiness(n, g.edges, byId)) } : {}) })),
        edges: g.edges.filter((e) => ids.has(e.src) && ids.has(e.dst)).map((e) => ({ id: e.id, src: e.src, kind: e.kind, dst: e.dst, ...(e.note ? { note: e.note } : {}) })),
      };
    },
  },
  {
    name: 'remove_skip_links',
    description:
      'Transitive reduction of needs edges. A direct needs edge is a skip when a longer needs path already connects the same tasks (A needs B needs C, so A needs C adds nothing; this includes longer paths, such as A needs D when A needs B needs C needs D). Without apply, lists those edges and writes nothing. With apply: true, deletes every one in one changeset and returns that id, which undo restores. Reachability is unchanged. Readiness uses direct edges, so a task becomes ready once its remaining direct needs are closed.',
    input: z.object({
      apply: z.boolean().optional().describe('Delete the skip links. Default false: list them only.'),
    }),
    run: async (core, a: { apply?: boolean }) => {
      const g = await core.graph();
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      const edges = skipEdges(g.edges).map((e) => ({
        id: e.id,
        src: e.src,
        dst: e.dst,
        srcTitle: byId.get(e.src)?.title ?? '',
        dstTitle: byId.get(e.dst)?.title ?? '',
        ...(e.note ? { note: e.note } : {}),
      }));
      if (!a.apply) return { edges };
      if (!edges.length) return { edges, removed: 0 };
      const w = who(null, 'mcp');
      const out = await core.apply(w, edges.map((e) => ({ op: 'delete_edge' as const, id: e.id })));
      return { edges, removed: out.results.length, changeset: w.changeset };
    },
  },
  {
    name: 'history',
    description: 'The audit log: who changed what (via ui or mcp), grouped by changeset. Filter by changeset or since a time.',
    input: z.object({ changeset: z.uuid().optional(), since: z.string().optional(), limit: z.number().int().max(500).optional() }),
    readOnly: true,
    run: async (core, a: { changeset?: string; since?: string; limit?: number }) => s.listAudit(core.db, { ...a, limit: a.limit ?? 100 }),
  },
  {
    name: 'apply_ops',
    description:
      'Create, update, or delete nodes and edges in one transaction. When it closes tasks, nowReady lists the tasks that just became ready. Ops: create_node (kind, title, body?, privateNotes?, privateReason?, status?, attrs?, ref?), update_node (id, ...; attrs merge, null removes; task attrs take guidance plus any keys of your own, e.g. structured run state; append adds to the body, and section limits body or append to one "## Heading" section, instead of re-sending the whole body; privateNotes replaces and privateAppend adds to the private notes), privateNotes and privateAppend are refused without privateReason (why it must stay private; prefer the body), delete_node, create_edge (src, kind, dst, note?), update_edge, delete_edge (id, or src+kind+dst). Use "ref" on create_node and "$ref" in later ops to link new nodes. Edge kinds: needs (task→task; a root task is one nothing needs), uses (task→resource), involves (task→person/team), reports_to (person/team→person/team), member_of (person/team→team), waits_on (task→person/team/resource it is blocked on outside the user\'s control; the task is blocked, not ready, until closed), working_on (person/team→task they are doing; the task is theirs, never ready for the user).',
    input: z.object({ ops: z.array(Op).min(1) }),
    run: async (core, a: { ops: Op[] }) => {
      const out = await core.apply(who(null, 'mcp'), a.ops);
      return { results: out.results, ...(out.nowReady.length ? { nowReady: out.nowReady } : {}) };
    },
  },
  {
    name: 'undo',
    description: 'Revert a changeset (from history).',
    input: z.object({ changeset: z.uuid() }),
    run: async (core, a: { changeset: string }) => ({ undone: await core.undo(who(null, 'mcp'), a.changeset) }),
  },
];

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { items: value },
});
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

const byName = new Map(tools.map((t) => [t.name, t]));

export function createMcpServer(core: Core): Server {
  const server = new Server({ name: 'ariadne', version: '0.3.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
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
    try {
      return ok(await tool.run(core, parsed.data as never));
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
