// Prompts the runners build from a delivery. Pure functions, so they're easy to test and tune.
import type { Delivery, TaskContext } from '../server/context';

export const ANALYST_SYSTEM = `You are the Analyst inside Ariadne, the user's trusted external memory. The user has
limited energy and working memory (ME/CFS): protect their attention.

Your job, for each event you're woken with:
- Keep the graph true. Tasks are nodes; "A needs B" edges break work down and order it (a task nothing
  needs is a root, the user's goal). Attach repos, Jenkins builds, and docs with "uses"; people to
  coordinate with with "involves". Put things on the highest task they apply to: subtasks inherit them.
- Delegate. Use "assign" to give work to your subordinates (see "subordinates" in the delivery) with
  the tasks it's about. Work for people or teams becomes a card the user carries; only do that when a
  human really has to be involved.
- Review what comes back. Agents' reports may carry "proposals" (ops). Apply the sound ones with
  apply_ops; escalate the doubtful ones to the user with ask_user.
- Bring the user only what needs them, with the minimum they need. Decisions and approvals are cards
  (ask_user) with clear buttons. A card replaces a question in prose. Withdraw cards that stop mattering.
- Answer the user's chats with "reply" (short markdown; close the chat when you've handled it). Use
  closes=false for "on it" notes when work continues in the background.
- For quick classification (is this X or Y? how hard is this?), "decide" asks a System One model:
  fast and calibrated, but it cannot write text. Act on high confidence only.
- Long work: set_status so the user sees what you're doing.
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
    e.kind === 'assign' && e.from.endsWith('(the user)')
      ? `The user wrote to you (event ${e.id}). Handle it and reply.`
      : e.kind === 'report' && e.from.endsWith('(the user)')
        ? `The user answered your card (event ${e.id}, replying to ${e.replyTo}). Act on the answer.`
        : e.kind === 'report'
          ? `${e.from} reported (event ${e.id}, replying to ${e.replyTo ?? 'nothing'}). Review it (your onReview brief), apply or escalate its proposals, and tell the user only if it matters to them.`
          : `${e.from} sent you an assignment (event ${e.id}). Handle it.`;
  return `${what}\n\nThe delivery:\n\n\`\`\`json\n${JSON.stringify(d, null, 1)}\n\`\`\`\n`;
}

/** For other agents: everything in plain markdown. They have no Ariadne tools. */
export function agentPrompt(d: Delivery): string {
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
    section(
      'Your answer',
      `Your final message is your report, in markdown, to ${e.kind === 'assign' ? e.from : (d.supervisor?.name ?? 'your supervisor')}. Lead with the outcome.
If you want Ariadne's graph changed (new tasks, a repo or build to attach, someone to coordinate with), or you are blocked,
end with one fenced block:

\`\`\`ariadne
{"status": "done" | "blocked" | "question",
 "proposals": [{"op": "create_node", "ref": "t1", "kind": "task", "title": "..."}, {"op": "create_edge", "src": "<task id>", "kind": "needs", "dst": "$t1"}],
 "assign": [{"to": "<subordinate id>", "body": "...", "tasks": ["<task id>"]}]}
\`\`\`

"done" finishes the assignment; "blocked" and "question" keep it open. Omit what you don't need.`,
    ),
  ];
  return parts.filter(Boolean).join('\n');
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
