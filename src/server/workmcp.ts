// The claim loop for interactive Claude Code sessions (the Analyst, and agents marked interactive).
// These tools are part of /mcp (see mcp.ts).
//
//   "Handle the next ariadne assignment" → next_assignment(repo) → do the work → submit_result.
//
// Events for interactive agents wait as delivery = 'pending' (the relay skips these agents).
// next_assignment claims one ('claimed') and starts a claim timer; submit_result done finishes it
// ('delivered'); release_assignment, or the timer running out, puts it back ('pending').
import { z } from 'zod';
import { ANALYST_SYSTEM, analystPrompt, interactivePrompt } from '../runner/prompts';
import { ANALYST_ID, type Event, Op, USER_ID } from '../shared/model';
import { ContextBuilder } from './context';
import type { Core } from './core';
import type { Tool } from './mcp';
import * as s from './store';
import { who } from './store';

export const WORK_INSTRUCTIONS = `Interactive sessions: when the user asks you to handle the next Ariadne assignment, call
next_assignment with this repo's git remote URL (git remote get-url origin), follow the brief it returns, and
finish with submit_result. On long work, call still_working before the claim times out.`;

/** host/owner/name, lowercase, from https, ssh, and scp-style git URLs. */
export function normalizeRepo(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/** Same repo: same normalized URL, or the same owner and name (https and ssh paths differ on some hosts). A local path or bare name matches by name. */
export function sameRepo(arg: string, resource: { name: string; url?: unknown }): boolean {
  const a = normalizeRepo(arg);
  if (resource.name.trim().toLowerCase() === a) return true;
  if (typeof resource.url !== 'string' || !resource.url) return false;
  const r = normalizeRepo(resource.url);
  if (a === r) return true;
  const as = a.split('/').filter(Boolean);
  const rs = r.split('/').filter(Boolean);
  if (as.at(-1) !== rs.at(-1)) return false;
  const nameOnly = /^[/~.]/.test(arg.trim()) || as.length < 2;
  return nameOnly || as.at(-2) === rs.at(-2);
}

/** An event claimed by an interactive session, or an error. */
async function claimed(q: s.Q, eventId: string): Promise<Event> {
  const ev = await s.getEvent(q, eventId);
  const to = ev.recipient ? await s.findNode(q, ev.recipient) : null;
  if (!to?.attrs.interactive) throw new s.Invalid('That event is not for an interactive session');
  if (ev.delivery !== 'claimed') throw new s.Invalid(ev.delivery === 'pending' ? 'Claim it with next_assignment first' : 'That event is not claimed (it may have timed out and gone back in the queue)');
  return ev;
}

const finish = (ev: Event) =>
  `\n\n## When you're done\n\nCall submit_result with eventId "${ev.id}" and status "done"${ev.kind === 'assign' && ev.state === 'open' ? ' (if you already answered with reply, leave body out)' : ''}. Your claim times out after a while without a word: on long work call still_working.`;

export const WORK_TOOLS: Tool[] = [
  {
    name: 'next_assignment',
    description:
      "Claims the next thing for this session to handle. Ariadne picks: something about this repo (its tasks use it) if there is one, otherwise something that isn't about any repo. Returns a brief in markdown, or assignment: null when nothing is waiting. It is yours until submit_result done or release_assignment; call still_working on long work, or the claim times out and goes back in the queue.",
    input: z.object({
      repo: z.string().min(1).describe("This repo's git remote URL (git remote get-url origin), or its directory path when it has no remote"),
    }),
    run: async (core, a: { repo: string }) => {
      const picked = await core.run(who(null, 'core'), async (c) => {
        const r = await c.tx.query(
          `SELECT e.id FROM events e JOIN nodes n ON n.id = e.recipient
           WHERE e.delivery = 'pending' AND (e.kind = 'report' OR e.state = 'open') AND n.kind = 'agent'
             AND coalesce((n.attrs->>'interactive')::boolean, false) AND NOT coalesce((n.attrs->>'paused')::boolean, false)
           ORDER BY (e.sender IS NOT DISTINCT FROM $1) DESC, e.created_at FOR UPDATE OF e SKIP LOCKED`,
          [USER_ID],
        );
        if (!r.rowCount) return null;
        const ctx = await ContextBuilder.load(c.tx);
        let chosen: { ev: Event; repo: string | null } | null = null;
        let generic: Event | null = null;
        for (const row of r.rows) {
          const ev = await s.getEvent(c.tx, row.id);
          const repos = ev.tasks.flatMap((t) => (ctx.nodes.has(t) ? ctx.task(t, []).resources : [])).filter((x) => x.item.type === 'repo');
          const match = repos.find((x) => sameRepo(a.repo, x.item));
          if (match) {
            chosen = { ev, repo: match.item.name };
            break;
          }
          if (!repos.length) generic ??= ev;
        }
        if (!chosen && generic) chosen = { ev: generic, repo: null };
        if (!chosen) return null;
        // The delivery is built before claiming, so the Analyst's "userChanges" cover everything since its last claim.
        const delivery = await ctx.delivery(chosen.ev);
        await core.claimTx(c, chosen.ev.id);
        return { ...chosen, delivery };
      });
      if (!picked) return { assignment: null, message: 'Nothing waiting for this repo, or without a repo.' };
      const { ev, delivery: d } = picked;
      core.hub.status({ actor: ev.recipient!, text: 'Working in Claude Code…', eventId: ev.id });
      const brief = ev.recipient === ANALYST_ID ? `${ANALYST_SYSTEM}\n\n${analystPrompt(d)}${finish(ev)}` : interactivePrompt(d);
      return {
        assignment: { eventId: ev.id, kind: ev.kind, as: d.recipient.name, from: d.event.from, repo: picked.repo, tasks: ev.tasks, timeoutMinutes: core.claimTimeoutMinutes },
        brief,
      };
    },
  },
  {
    name: 'submit_result',
    description:
      'Finish (status done) or update a claimed event. For an assignment, body is your report to whoever assigned it (done closes it; blocked, question, and progress keep it open and your claim). Leave body out if you already answered with reply. For a report there is nothing to answer: done just marks it handled. proposals: graph changes for your supervisor to apply (same ops as apply_ops); the Analyst applies its own with apply_ops instead.',
    input: z.object({
      eventId: z.uuid(),
      status: z.enum(['done', 'blocked', 'question', 'progress']),
      body: z.string().min(1).optional(),
      proposals: z.array(Op).optional(),
    }),
    run: async (core, a: { eventId: string; status: 'done' | 'blocked' | 'question' | 'progress'; body?: string; proposals?: unknown[] }) => {
      const ev = await claimed(core.db, a.eventId);
      const me = ev.recipient!;
      if (a.proposals?.length && me === ANALYST_ID) throw new s.Invalid('The Analyst applies changes itself: use apply_ops, then submit_result');
      const answering = ev.kind === 'assign' && ev.state === 'open';
      if (answering && a.status === 'done' && !a.body) throw new s.Invalid('Say what you did: body is required to finish an open assignment (or answer with reply first)');
      const done = a.status === 'done';
      const result = await core.run(who(me, 'mcp', ev.id), async (c, after) => {
        let reportId: string | null = null;
        if (answering && a.body) {
          const label = { done: '', blocked: '**Blocked.** ', question: '**Question.** ', progress: '**Progress.** ' }[a.status];
          const report = await core.sendTx(c, after, me, { kind: 'report', replyTo: ev.id, closes: done, body: `${label}${a.body}`, ...(a.proposals?.length ? { proposals: a.proposals } : {}) });
          reportId = report.id;
        }
        if (done) await core.endClaimTx(c, ev.id, 'delivered');
        else await core.touchClaimTx(c, ev.id);
        return { reportId, claim: done ? 'finished' : 'kept' };
      });
      if (done) core.hub.clearStatus(me);
      return result;
    },
  },
  {
    name: 'still_working',
    description: 'Resets the claim timeout on an event you claimed ("still on it"). Optionally say how many minutes you need.',
    input: z.object({ eventId: z.uuid(), minutes: z.number().int().min(1).max(24 * 60).optional() }),
    run: async (core, a: { eventId: string; minutes?: number }) => {
      const ev = await claimed(core.db, a.eventId);
      const t = await core.run(who(ev.recipient, 'mcp', ev.id), (c) => core.touchClaimTx(c, ev.id, a.minutes));
      return { timesOutAt: t.at };
    },
  },
  {
    name: 'release_assignment',
    description: "Gives back something you claimed but won't finish here; it goes back in the queue.",
    input: z.object({ eventId: z.uuid() }),
    run: async (core, a: { eventId: string }) => {
      const ev = await claimed(core.db, a.eventId);
      await core.run(who(ev.recipient, 'mcp', ev.id), (c) => core.endClaimTx(c, ev.id, 'pending'));
      core.hub.clearStatus(ev.recipient!);
      return { released: true };
    },
  },
];
