// The claim loop for interactive Claude Code sessions (the Analyst, agents marked interactive, and
// events for you: the session asks or tells you, then records your answer).
// These tools are part of /mcp (see mcp.ts).
//
//   "Handle the next ariadne assignment" → list_assignments → claim_assignment → work → submit_result.
//
// Events for interactive agents wait as delivery = 'pending' (the relay skips these agents).
// claim_assignment claims one ('claimed') and starts a claim timer; submit_result done completes it
// ('delivered'); release_assignment, or the timer running out, puts it back ('pending'). Any MCP call made
// for the item (because / eventId) pushes the timer back (core.heartbeat, called from mcp.ts).
// Ariadne doesn't track who claimed: any session may report on any item (MCP is asynchronous).
import { z } from 'zod';
import { ANALYST_SYSTEM, analystPrompt, interactivePrompt, userPrompt } from '../runner/prompts';
import { ANALYST_ID, type Event, Op, USER_ID } from '../shared/model';
import { ContextBuilder } from './context';
import { claimKey } from './core';
import type { Tool } from './mcp';
import * as s from './store';
import { who } from './store';

export const WORK_INSTRUCTIONS = `Interactive sessions: when the user asks you to handle the next Ariadne assignment, call
list_assignments and pick the FIRST item you have the capability to handle here (the repo it needs, access, tools,
knowledge). claim_assignment it; if the claim fails, take the next one. Follow the brief it returns, then
submit_result. Any call that passes the item's id (as because or eventId) keeps your claim alive; on long quiet work,
call still_working. Before you stop to wait for the user's reply, call still_working with waitingOnUser: true.`;

/** Items waiting for an interactive session: pending, not finished, for you or an unpaused interactive agent. */
const AVAILABLE = `e.delivery = 'pending' AND (e.kind = 'report' OR e.state = 'open') AND (n.id = $1 OR (n.kind = 'agent'
  AND coalesce((n.attrs->>'interactive')::boolean, false) AND NOT coalesce((n.attrs->>'paused')::boolean, false)))`;

/** The event, or an error if it's missing or already completed (an assignment no longer open, a report already handled). */
async function unfinished(q: s.Q, eventId: string): Promise<Event> {
  const ev = await s.findEvent(q, eventId);
  if (!ev) throw new s.NotFound(`No event ${eventId}`);
  if (ev.kind === 'assign' ? ev.state !== 'open' : ev.delivery === 'delivered') throw new s.Invalid(`That ${ev.kind === 'assign' ? 'assignment' : 'report'} is already completed`);
  return ev;
}

const finish = (ev: Event) =>
  `\n\n## When you're done\n\nCall submit_result with eventId "${ev.id}" and status "done"${ev.kind === 'assign' ? ' and a body that leads with the outcome' : ''}. Pass "because": "${ev.id}" on your changes; that also keeps your claim alive. Before you stop to wait for the user's reply, call still_working with waitingOnUser: true.`;

export const WORK_TOOLS: Tool[] = [
  {
    name: 'list_assignments',
    description:
      'What is waiting for an interactive session: things for the user first (ask or tell them), then from the user, then oldest. Each item shows who it is for, a summary, its tasks, and the repos they use. Pick the first one you have the capability to handle here and claim_assignment it. Listing claims nothing.',
    input: z.object({}),
    readOnly: true,
    run: async (core) => {
      const r = await core.db.query(
        `SELECT e.id FROM events e JOIN nodes n ON n.id = e.recipient WHERE ${AVAILABLE}
         ORDER BY (e.recipient = $1) DESC, (e.sender IS NOT DISTINCT FROM $1) DESC, e.created_at LIMIT 30`,
        [USER_ID],
      );
      const ctx = await ContextBuilder.load(core.db);
      const items = [];
      for (const row of r.rows) {
        const ev = await s.getEvent(core.db, row.id);
        const tasks = ev.tasks.filter((t) => ctx.nodes.has(t)).map((t) => ctx.task(t, []));
        const repos = new Map(tasks.flatMap((t) => t.resources).filter((x) => x.item.type === 'repo').map((x) => [x.item.id, { name: x.item.name, ...(x.item.url ? { url: x.item.url } : {}) }]));
        items.push({
          eventId: ev.id,
          kind: ev.kind,
          as: ctx.name(ev.recipient),
          from: ctx.name(ev.sender),
          summary: ev.body.length > 200 ? `${ev.body.slice(0, 200)}…` : ev.body,
          tasks: tasks.map((t) => ({ id: t.id, title: t.title })),
          repos: [...repos.values()],
          createdAt: ev.createdAt,
        });
      }
      return { items };
    },
  },
  {
    name: 'claim_assignment',
    description:
      "Claims one item from list_assignments so no one else takes it, and returns its brief (everything you need). Fails if it's already claimed or completed: then take the next one. The claim expires after a while without a word (still_working resets it).",
    input: z.object({ eventId: z.uuid() }),
    run: async (core, a: { eventId: string }) => {
      const { ev, delivery: d } = await core.run(who(null, 'core', a.eventId), async (c) => {
        const ev = await unfinished(c.tx, a.eventId);
        const to = ev.recipient ? await s.findNode(c.tx, ev.recipient) : null;
        if (to?.id !== USER_ID && !to?.attrs.interactive) throw new s.Invalid('That event is not for an interactive session');
        if (ev.delivery === 'claimed') throw new s.Invalid('Already claimed: take the next one');
        // Built before claiming, so the Analyst's "userChanges" cover everything since its last claim.
        const delivery = await (await ContextBuilder.load(c.tx)).delivery(ev);
        if (!(await core.claimTx(c, ev.id))) throw new s.Invalid('Not available to claim (it was delivered another way)');
        return { ev, delivery };
      });
      if (ev.recipient !== USER_ID) core.hub.status({ actor: ev.recipient!, text: 'Working in Claude Code…', eventId: ev.id });
      return {
        eventId: ev.id,
        timeoutMinutes: core.claimTimeoutMinutes,
        brief:
          ev.recipient === USER_ID ? userPrompt(d, ev.card) : ev.recipient === ANALYST_ID ? `${ANALYST_SYSTEM}\n\n${analystPrompt(d)}${finish(ev)}` : interactivePrompt(d),
      };
    },
  },
  {
    name: 'submit_result',
    description:
      'Report on an item, whether or not this session claimed it. status: done completes it; blocked, question, and progress keep it open. For an assignment, body (required) is your report to whoever assigned it; lead with the outcome. For a report there is nothing to answer: done marks it handled. proposals: graph changes for your supervisor to apply (same ops as apply_ops); the Analyst applies its own with apply_ops instead. Fails only if the item is missing or already completed.',
    input: z.object({
      eventId: z.uuid(),
      status: z.enum(['done', 'blocked', 'question', 'progress']),
      body: z.string().min(1).optional(),
      proposals: z.array(Op).optional(),
    }),
    run: async (core, a: { eventId: string; status: 'done' | 'blocked' | 'question' | 'progress'; body?: string; proposals?: unknown[] }) => {
      const ev = await unfinished(core.db, a.eventId);
      const me = ev.recipient;
      if (!me) throw new s.Invalid('That event has no recipient to report as');
      if (a.proposals?.length && me === ANALYST_ID) throw new s.Invalid('The Analyst applies changes itself: use apply_ops, then submit_result');
      if (ev.kind === 'assign' && !a.body) throw new s.Invalid('body is required: say what you did, or what you need');
      const done = a.status === 'done';
      const result = await core.run(who(me, 'mcp', ev.id), async (c, after) => {
        let reportId: string | null = null;
        if (ev.kind === 'assign') {
          const label = { done: '', blocked: '**Blocked.** ', question: '**Question.** ', progress: '**Progress.** ' }[a.status];
          reportId = (await core.sendTx(c, after, me, { kind: 'report', replyTo: ev.id, closes: done, body: `${label}${a.body}`, ...(a.proposals?.length ? { proposals: a.proposals } : {}) })).id;
        }
        if (done) {
          await c.tx.query(`UPDATE events SET delivery = 'delivered', delivered_at = coalesce(delivered_at, now()) WHERE id = $1`, [ev.id]);
          await core.cancelTimerTx(c, claimKey(ev.id));
        } else if ((await s.getEvent(c.tx, ev.id)).delivery === 'claimed') await core.extendClaimTx(c, ev.id);
        return { reportId, completed: done };
      });
      if (done) core.hub.clearStatus(me);
      return result;
    },
  },
  {
    name: 'still_working',
    description:
      "Still on it: resets the claim timeout (re-claims it if the claim already expired). Optionally say how many minutes you need. waitingOnUser: you're about to stop and wait for the user's reply in this session; the claim then lasts much longer (unless you give minutes).",
    input: z.object({ eventId: z.uuid(), minutes: z.number().int().min(1).max(24 * 60).optional(), waitingOnUser: z.boolean().optional() }),
    run: async (core, a: { eventId: string; minutes?: number; waitingOnUser?: boolean }) => {
      const { ev, at } = await core.run(who(null, 'core', a.eventId), async (c) => {
        const ev = await unfinished(c.tx, a.eventId);
        if (ev.delivery === 'pending') await core.claimTx(c, ev.id);
        else if (ev.delivery !== 'claimed') throw new s.Invalid('That item is not handled over MCP');
        const t = await core.touchClaimTx(c, ev.id, a.minutes ?? (a.waitingOnUser ? core.claimWaitMinutes : undefined));
        return { ev, at: t.at };
      });
      if (ev.recipient && ev.recipient !== USER_ID) core.hub.status({ actor: ev.recipient, text: a.waitingOnUser ? 'Waiting on you in Claude Code…' : 'Working in Claude Code…', eventId: ev.id });
      return { timesOutAt: at };
    },
  },
  {
    name: 'release_assignment',
    description: "Gives back an item you claimed but won't finish here; it goes back in the list.",
    input: z.object({ eventId: z.uuid() }),
    run: async (core, a: { eventId: string }) => {
      const ev = await unfinished(core.db, a.eventId);
      await core.run(who(null, 'core', ev.id), (c) => core.endClaimTx(c, ev.id, 'pending'));
      if (ev.recipient) core.hub.clearStatus(ev.recipient);
      return { released: ev.delivery === 'claimed' };
    },
  },
];
