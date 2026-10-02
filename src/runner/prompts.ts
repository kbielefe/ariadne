// Prompts built from a delivery: for headless runners, and the briefs claim_assignment returns. Pure functions, so they're easy to test and tune.
import type { Delivery, TaskContext } from '../server/context';
import type { Card } from '../shared/model';

export const ANALYST_SYSTEM = `You are the Analyst inside Ariadne, the user's trusted external memory. The user has
limited energy and working memory (ME/CFS): protect their attention.

You run in an interactive Claude Code session: the user is right here, so talk to them directly.

Your job, for each event you handle:
- Keep the graph true. Tasks are nodes; "A needs B" edges break work down and order it (a task nothing
  needs is a root, the user's goal). Attach repos, Jenkins builds, and docs with "uses"; people to
  coordinate with with "involves". Put things on the highest task they apply to: subtasks inherit them.
- Delegate. Use "assign" to give work to your subordinates (see "subordinates" in the delivery) with
  the tasks it's about.
- Conversations with people or teams: "assign" to that person or team, with the questions in the body.
  It becomes an "Ask <name>" item the user carries, and the answer comes back to you as their report.
- Review what comes back. Agents' reports may carry "proposals" (ops). Apply the sound ones with
  apply_ops; escalate the doubtful ones to the user with ask_user.
- Bring the user only what needs them, with the minimum they need. Ask them here. For a question or note
  that should wait (not for now), leave it with ask_user / tell_user. Withdraw ones that stop mattering.
- For quick classification (is this X or Y? how hard is this?), "decide" asks a System One model:
  fast and calibrated, but it cannot write text. Act on high confidence only.
- Always pass "because": <the event id you're handling> on changes.

Never invent facts about people or systems. If something is unknown, ask or leave it out.
Your own briefs (recipient.briefs in the delivery) are the user's standing instructions to you.`;

function section(title: string, body: string | undefined | null) {
  return body ? `## ${title}\n\n${body.trim()}\n` : '';
}

function taskMd(t: TaskContext): string {
  const lines = [`### ${t.title} (${t.status}${t.ready ? ', ready' : ''})`, `id: ${t.id}`];
  if (t.body) lines.push('', t.body);
  if (t.neededBy.length) lines.push('', `Needed by: ${t.neededBy.map((x) => x.title).join('; ')}`);
  if (t.needs.length) lines.push(`Needs: ${t.needs.map((x) => `${x.title} (${x.status})`).join('; ')}`);
  for (const g of t.guidance) lines.push('', `Guidance${g.from === 'self' ? '' : ` (from "${g.from.title}")`}: ${g.item}`);
  if (t.resources.length) {
    lines.push('', 'Resources:');
    for (const r of t.resources) lines.push(`- ${r.item.name}${r.item.type ? ` [${String(r.item.type)}]` : ''}${r.item.url ? ` ${String(r.item.url)}` : ''}${r.item.note ? ` — ${r.item.note}` : ''}${r.item.about ? `\n  ${r.item.about}` : ''}`);
  }
  if (t.coordinateWith.length) {
    lines.push('', 'Coordinate with:');
    for (const c of t.coordinateWith) lines.push(`- ${c.item.name} (${c.item.kind})${c.item.areas ? `: ${(c.item.areas as string[]).join(', ')}` : ''}${c.item.note ? ` — ${c.item.note}` : ''}`);
  }
  return lines.join('\n');
}

/** For the analyst: the delivery as JSON (it can call get_context for more), plus what to do now. */
export function analystPrompt(d: Delivery): string {
  const e = d.event;
  const what =
    e.kind === 'report' && e.from.endsWith('(the user)')
        ? `The user answered your card (event ${e.id}, replying to ${e.replyTo}). Act on the answer.`
        : e.kind === 'report'
          ? `${e.from} reported (event ${e.id}, replying to ${e.replyTo ?? 'nothing'}). Review it (your onReview brief), apply or escalate its proposals, and tell the user only if it matters to them.`
          : `${e.from} sent you an assignment (event ${e.id}). Handle it.`;
  return `${what}\n\nThe delivery:\n\n\`\`\`json\n${JSON.stringify(d, null, 1)}\n\`\`\`\n`;
}

/** For a session that claimed an event for the user: ask or tell them, then record it. */
export function userPrompt(d: Delivery, card: Card | null): string {
  const e = d.event;
  const tasks = d.tasks.length ? `\n\nTasks: ${d.tasks.map((t) => `${t.title} (${t.id})`).join('; ')}` : '';
  const from = e.from;
  if (e.kind === 'report') {
    return `Notify the user of this note from ${from} (event ${e.id}). It needs no answer.\n\n${e.body}${tasks}\n\nThen call submit_result with eventId "${e.id}" and status "done".`;
  }
  const fields = card?.fields.length ? `\n\nWhat to find out:\n${card.fields.map((f) => `- ${f.label || f.name}${f.options?.length ? ` (${f.options.map((o) => o.label).join(' / ')})` : ''}`).join('\n')}` : '';
  const actions = card?.actions.length ? `\n\nTheir options: ${card.actions.map((a) => a.label).join(' / ')}` : '';
  const proxy =
    card?.kind === 'proxy'
      ? `The user carries this to someone outside Ariadne: ${card.title}. Ask the user what they said.`
      : `Ask the user: ${card?.title ?? 'this assignment'}.`;
  return `${proxy} (event ${e.id}, from ${from})\n\n${e.body}${e.instructions ? `\n\n${e.instructions}` : ''}${fields}${actions}${tasks}

## When you have the answer

Call submit_result with eventId "${e.id}" and the user's answer as body: status "done" when it's answered${card?.kind === 'proxy' ? '' : ' (start with the option they chose)'}, or "question"/"blocked" if they can't answer yet (it stays open). Don't act on the answer yourself here: it goes back to ${from} as the user's report.`;
}

/** For other agents: everything in plain markdown. They have no Ariadne tools. */
export function agentPrompt(d: Delivery, answer = fencedAnswer(d)): string {
  const e = d.event;
  const r = d.recipient;
  const briefs = (r.briefs ?? {}) as Record<string, string>;
  const parts = [
    `You are ${r.name}${r.about ? `: ${r.about}` : ''}.`,
    d.supervisor ? `You report to ${d.supervisor.name}.` : '',
    '',
    section('How you work on an assignment', briefs.onAssignment),
    section('How you report back', briefs.onReport),
    e.kind === 'assign' ? section(`Assignment from ${e.from}`, e.body) : section(`Report from ${e.from}`, e.body),
    section('Instructions for this assignment', e.instructions),
    d.inReplyTo ? section('This replies to', d.inReplyTo.body) : '',
    d.tasks.length ? section('Tasks', d.tasks.map(taskMd).join('\n\n')) : '',
    d.thread.length ? section('Recent history on these tasks', d.thread.map((t) => `- ${t.at} ${t.from} → ${t.to} (${t.kind}): ${t.body.split('\n')[0]}`).join('\n')) : '',
    d.subordinates.length
      ? section(
          'Your subordinates (you may delegate to them)',
          [section('How you delegate', briefs.onDelegate), section('How you review their results', briefs.onReview), d.subordinates.map((s) => `- ${s.name} (id ${s.id})${s.areas ? `: ${(s.areas as string[]).join(', ')}` : ''}`).join('\n')].join('\n'),
        )
      : '',
    e.kind === 'report'
      ? section('What to do', `${e.from}, your subordinate, reported (above). Review it. If your own assignment is now complete, your answer is your report to your supervisor; if not, delegate again and use status "blocked".`)
      : '',
    section('Your answer', answer),
  ];
  return parts.filter(Boolean).join('\n');
}

/** Headless agents (`claude -p`) end their final message with an optional ```ariadne block. */
function fencedAnswer(d: Delivery): string {
  const e = d.event;
  return `Your final message is your report, in markdown, to ${e.kind === 'assign' ? e.from : (d.supervisor?.name ?? 'your supervisor')}. Lead with the outcome.
If you want Ariadne's graph changed (new tasks, a repo or build to attach, someone to coordinate with), or you are blocked,
end with one fenced block:

\`\`\`ariadne
{"status": "done" | "blocked" | "question",
 "proposals": [{"op": "create_node", "ref": "t1", "kind": "task", "title": "..."}, {"op": "create_edge", "src": "<task id>", "kind": "needs", "dst": "$t1"}],
 "assign": [{"to": "<subordinate id>", "body": "...", "tasks": ["<task id>"]}]}
\`\`\`

"done" finishes the assignment; "blocked" and "question" keep it open. Omit what you don't need.`;
}

/** For an interactive Claude Code session that pulled the assignment over MCP: it reports with submit_result. */
export function interactivePrompt(d: Delivery): string {
  const e = d.event;
  return agentPrompt(
    d,
    `Do the work here, in this session. When you're finished (or blocked, or need an answer), call submit_result with
eventId "${e.id}" and a markdown body for ${e.from} that leads with the outcome. status: "done" finishes the
assignment; "blocked", "question", and "progress" keep it open. If Ariadne's graph should change (new tasks, a repo or
build to attach, someone to coordinate with), add proposals: the same ops as apply_ops, for example
[{"op": "create_node", "ref": "t1", "kind": "task", "title": "..."}, {"op": "create_edge", "src": "<task id>", "kind": "needs", "dst": "$t1"}].
If you can't work on it here after all, call release_assignment so it goes back in the list.`,
  );
}

export interface AgentOutcome {
  body: string;
  closes: boolean;
  proposals?: unknown[];
  assign?: { to: string; body: string; tasks?: string[]; instructions?: string }[];
}

/** Splits an agent's final text into the report and its optional ```ariadne block. */
export function parseAgentOutput(text: string): AgentOutcome {
  const re = /```ariadne\s*\n([\s\S]*?)```\s*$/;
  const m = re.exec(text.trim());
  if (!m) return { body: text.trim() || '(no output)', closes: true };
  const body = text.trim().slice(0, m.index).trim();
  try {
    const block = JSON.parse(m[1]!) as { status?: string; proposals?: unknown[]; assign?: AgentOutcome['assign'] };
    return {
      body: body || '(see proposals)',
      closes: (block.status ?? 'done') === 'done',
      ...(Array.isArray(block.proposals) && block.proposals.length ? { proposals: block.proposals } : {}),
      ...(Array.isArray(block.assign) && block.assign.length ? { assign: block.assign } : {}),
    };
  } catch {
    return { body: `${body}\n\n(The ariadne block was not valid JSON and was ignored.)`, closes: true };
  }
}
