// What a runner does with one delivery. Adapters (RabbitMQ, the claude CLI, Jev) are injected.
import type { Delivery } from '../server/context';
import type { Answer, InboxMessage } from '../shared/model';
import { agentPrompt, analystPrompt, ANALYST_SYSTEM, parseAgentOutput } from './prompts';

export type Publish = (m: InboxMessage) => Promise<void>;

export interface RunOptions {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  effort?: string;
}
export interface RunResult {
  ok: boolean;
  text: string;
}
/** Runs a model on a prompt (in production: `claude -p`). */
export type RunModel = (o: RunOptions) => Promise<RunResult>;

export interface Log {
  info(msg: string, o?: object): void;
  error(msg: string, o?: object): void;
}

const decided = (d: Delivery, k: string) => {
  const v = d.event.decisions?.[k]?.value;
  return typeof v === 'string' ? v : undefined;
};

/** The analyst acts through its MCP tools; the runner only reports failures. */
export async function handleAnalyst(d: Delivery, run: RunModel, publish: Publish, log: Log): Promise<void> {
  const me = d.recipient.id;
  await publish({ type: 'status', sender: me, text: 'Thinking…', eventId: d.event.id });
  const model = decided(d, 'model');
  const effort = decided(d, 'effort');
  const r = await run({ prompt: analystPrompt(d), systemPrompt: ANALYST_SYSTEM, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  await publish({ type: 'status', sender: me, text: '' });
  if (r.ok) return;
  log.error('analyst.failed', { eventId: d.event.id, output: r.text.slice(0, 500) });
  // Tell the user, on their own message if this was one.
  if (d.event.kind === 'assign' && d.event.state === 'open')
    await publish({ type: 'report', sender: me, replyTo: d.event.id, closes: false, body: `I couldn't finish this: ${r.text.slice(0, 300) || 'the model run failed'}. Ask again or check the runner log.` });
}

/** Other agents: the delivery is all they get; their final text is the report. */
export async function handleAgent(d: Delivery, run: RunModel, publish: Publish, log: Log): Promise<void> {
  const me = d.recipient.id;
  // A subordinate's report: the agent reviews it and may finish (or continue) its own assignment.
  const replyTo = d.event.kind === 'assign' ? d.event.id : d.tasks.flatMap((t) => t.openAssignments).find((a) => a.to === d.recipient.name)?.eventId;
  if (!replyTo) log.info('agent.report-without-own-assignment', { eventId: d.event.id });
  await publish({ type: 'status', sender: me, text: 'Working…', eventId: d.event.id });
  const model = decided(d, 'model');
  const effort = decided(d, 'effort');
  const r = await run({ prompt: agentPrompt(d), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  await publish({ type: 'status', sender: me, text: '' });
  if (!replyTo) return;
  if (!r.ok) {
    await publish({ type: 'report', sender: me, replyTo, closes: false, body: `Blocked: the run failed.\n\n${r.text.slice(0, 1000)}` });
    return;
  }
  const out = parseAgentOutput(r.text);
  for (const a of out.assign ?? []) await publish({ type: 'assign', sender: me, recipient: a.to, body: a.body, ...(a.instructions ? { instructions: a.instructions } : {}), tasks: a.tasks ?? d.event.tasks });
  await publish({ type: 'report', sender: me, replyTo, closes: out.closes, body: out.body, ...(out.proposals ? { proposals: out.proposals } : {}) });
}

export interface SystemOne {
  provider: string;
  model: string;
  decide(state: string, questions: Record<string, unknown>): Promise<Record<string, Answer>>;
}

/** Deciders answer questions; they never write text. */
export async function handleDecider(d: Delivery, model: SystemOne, publish: Publish, log: Log): Promise<void> {
  const q = d.event.questions as Record<string, unknown> | undefined;
  if (d.event.kind !== 'assign' || !q) return;
  try {
    const answers = await model.decide(d.event.body, q);
    await publish({ type: 'report', sender: d.recipient.id, replyTo: d.event.id, closes: true, body: `${model.provider}/${model.model}`, answers });
  } catch (err) {
    // No answer: Ariadne's timeout applies its fallback.
    log.error('decider.failed', { eventId: d.event.id, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Jev over TypeSafe's API (POST /v1/systemone). Our questions already use its primitives. */
export function jev(o: { url: string; apiKey: string; model: string; fetch?: typeof fetch; timeoutMs?: number }): SystemOne {
  const doFetch = o.fetch ?? globalThis.fetch;
  return {
    provider: 'typesafe',
    model: o.model,
    async decide(state, questions) {
      const res = await doFetch(o.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ state, model: o.model, questions }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
      });
      if (!res.ok) throw new Error(`System One request failed: HTTP ${res.status}`);
      const body = (await res.json()) as { answers?: Record<string, Answer> };
      if (!body.answers || typeof body.answers !== 'object') throw new Error('System One response has no answers');
      return body.answers;
    },
  };
}
