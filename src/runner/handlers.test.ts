import { describe, expect, it } from 'vitest';
import type { Delivery } from '../server/context';
import type { InboxMessage } from '../shared/model';
import { handleAgent, handleAnalyst, handleDecider, jev, type RunOptions } from './handlers';
import { agentPrompt, parseAgentOutput } from './prompts';

const ME = '11111111-1111-4111-8111-111111111111';
const EV = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';
const log = { info() {}, error() {} };

function delivery(over: Partial<Delivery['event']> = {}): Delivery {
  return {
    event: { id: EV, kind: 'assign', from: 'Analyst', to: 'Coder', body: 'Pick an OIDC library', tasks: [T], at: '2026-10-01T00:00:00Z', state: 'open', decisions: { model: { value: 'sonnet', by: 'jev', confidence: 0.9 }, effort: { value: 'medium', by: 'jev' } }, ...over },
    recipient: { id: ME, kind: 'agent', name: 'Coder', about: 'Writes code.', briefs: { onAssignment: 'Read the README first.' } },
    sender: null,
    inReplyTo: null,
    tasks: [
      {
        id: T,
        title: 'Pick an OIDC library',
        body: '',
        status: 'open',
        ready: true,
        needs: [],
        neededBy: [{ id: 'x', title: 'Ship SSO' }],
        guidance: [{ from: { id: 'x', title: 'Ship SSO' }, item: 'Small PRs.' }],
        resources: [{ from: { id: 'x', title: 'Ship SSO' }, item: { id: 'r', name: 'agent-framework', type: 'repo', url: 'https://github.com/x/y', about: '', note: '' } }],
        coordinateWith: [],
        openAssignments: [{ eventId: EV, to: 'Coder' }],
      },
    ],
    thread: [],
    supervisor: { id: 'a', kind: 'agent', name: 'Analyst', about: '' },
    subordinates: [],
    howToReply: '',
  };
}

describe('agent prompts', () => {
  it('carry briefs, inherited guidance, and resources in plain markdown', () => {
    const p = agentPrompt(delivery());
    expect(p).toContain('You are Coder: Writes code.');
    expect(p).toContain('Read the README first.');
    expect(p).toContain('Guidance (from "Ship SSO"): Small PRs.');
    expect(p).toContain('- agent-framework [repo] https://github.com/x/y');
  });

  it('parse the optional ariadne block', () => {
    expect(parseAgentOutput('All good.')).toEqual({ body: 'All good.', closes: true });
    expect(parseAgentOutput('Need the RBAC answer.\n\n```ariadne\n{"status":"blocked","proposals":[{"op":"create_node","kind":"task","title":"Ask Bryan"}]}\n```')).toEqual({
      body: 'Need the RBAC answer.',
      closes: false,
      proposals: [{ op: 'create_node', kind: 'task', title: 'Ask Bryan' }],
    });
    expect(parseAgentOutput('x\n```ariadne\n{nope}\n```').body).toMatch(/not valid JSON/);
  });
});

describe('handlers', () => {
  it('an agent runs with the decided model and effort and reports back', async () => {
    const runs: RunOptions[] = [];
    const sent: InboxMessage[] = [];
    await handleAgent(delivery(), async (o) => (runs.push(o), { ok: true, text: 'Use openid-client.' }), async (m) => void sent.push(m), log);
    expect(runs[0]).toMatchObject({ model: 'sonnet', effort: 'medium' });
    expect(sent.map((m) => m.type)).toEqual(['status', 'status', 'report']);
    expect(sent[2]).toEqual({ type: 'report', sender: ME, replyTo: EV, closes: true, body: 'Use openid-client.' });
  });

  it('a supervisor agent reviewing a report answers its own open assignment', async () => {
    const sent: InboxMessage[] = [];
    const d = delivery({ kind: 'report', from: 'Junior', id: '44444444-4444-4444-8444-444444444444' });
    await handleAgent(d, async () => ({ ok: true, text: 'Junior finished it.' }), async (m) => void sent.push(m), log);
    expect(sent.at(-1)).toMatchObject({ type: 'report', replyTo: EV, body: 'Junior finished it.' });
  });

  it('a failed analyst run tells the user on their message', async () => {
    const sent: InboxMessage[] = [];
    await handleAnalyst(delivery({ from: 'You (the user)' }), async () => ({ ok: false, text: 'rate limited' }), async (m) => void sent.push(m), log);
    expect(sent.at(-1)).toMatchObject({ type: 'report', replyTo: EV, closes: false });
    expect((sent.at(-1) as { body: string }).body).toMatch(/rate limited/);
  });

  it('a decider sends the state and questions to Jev and reports its answers', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ answers: { intent: { type: 'choice', choice: 'update', confidence: 0.88 } } }));
    }) as unknown as typeof fetch;
    const sent: InboxMessage[] = [];
    const questions = { intent: { type: 'choice', instructions: 'What?', criteria: { update: 'An update' } } };
    await handleDecider(delivery({ body: 'The user wrote: done', questions }), jev({ url: 'https://api.typesafe.ai/v1/systemone', apiKey: 'k', model: 'jev-latest', fetch: fakeFetch }), async (m) => void sent.push(m), log);
    expect(calls[0]!.body).toEqual({ state: 'The user wrote: done', model: 'jev-latest', questions });
    expect(sent).toEqual([{ type: 'report', sender: ME, replyTo: EV, closes: true, body: 'typesafe/jev-latest', answers: { intent: { type: 'choice', choice: 'update', confidence: 0.88 } } }]);
  });
});
