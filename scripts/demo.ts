// Seeds a small demo into a running Ariadne: a scripted "analyst" builds it over MCP.
//   ARIADNE_URL=http://127.0.0.1:3100 pnpm tsx scripts/demo.ts
// Uses the real MCP, so it doubles as a smoke test. Don't run it against real data.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.env.ARIADNE_URL ?? 'http://127.0.0.1:3100';

const client = new Client({ name: 'demo-analyst', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
async function call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
  return r.structuredContent as T;
}

const { results } = await call<{ results: { ref?: string; id: string }[] }>('apply_ops', {
  ops: [
    { op: 'create_node', ref: 'root', kind: 'task', title: 'Ship SSO for the agent framework', body: 'Done = agents can call Mosaic APIs on behalf of a signed-in user.', attrs: { guidance: 'Keep PRs small. Follow the paved-road auth patterns.' } },
    { op: 'create_node', ref: 'oidc', kind: 'task', title: 'Pick an OIDC library' },
    { op: 'create_node', ref: 'flow', kind: 'task', title: 'Implement token exchange' },
    { op: 'create_node', ref: 'rbac', kind: 'task', title: 'Agree on the RBAC claims' },
    { op: 'create_node', ref: 'docs', kind: 'task', title: 'Write the how-to for delivery pods' },
    { op: 'create_node', ref: 'repo', kind: 'resource', title: 'agent-framework repo', attrs: { type: 'repo', url: 'https://github.com/example/agent-framework' } },
    { op: 'create_node', ref: 'build', kind: 'resource', title: 'agent-framework CI', attrs: { type: 'build', url: 'https://jenkins.example/job/agent-framework' } },
    { op: 'create_node', ref: 'bryan', kind: 'person', title: 'Bryan', attrs: { areas: ['RBAC', 'feature flags'] } },
    { op: 'create_node', ref: 'coder', kind: 'agent', title: 'Coder', body: 'Writes and tests code in a sandboxed checkout.', attrs: { models: ['sonnet', 'opus'], effort: 'medium', briefs: { onAssignment: 'Read the repo README first. Work on a branch.', onReport: 'Lead with what changed and how you tested it.' } } },
    { op: 'create_node', ref: 'jev', kind: 'agent', title: 'Jev', body: 'System One decider.', attrs: { decider: true, paused: true } },
    { op: 'create_edge', src: '$root', kind: 'needs', dst: '$oidc' },
    { op: 'create_edge', src: '$root', kind: 'needs', dst: '$flow' },
    { op: 'create_edge', src: '$root', kind: 'needs', dst: '$docs' },
    { op: 'create_edge', src: '$flow', kind: 'needs', dst: '$oidc' },
    { op: 'create_edge', src: '$flow', kind: 'needs', dst: '$rbac' },
    { op: 'create_edge', src: '$docs', kind: 'needs', dst: '$flow' },
    { op: 'create_edge', src: '$root', kind: 'uses', dst: '$repo' },
    { op: 'create_edge', src: '$root', kind: 'uses', dst: '$build' },
    { op: 'create_edge', src: '$rbac', kind: 'involves', dst: '$bryan', note: 'owns RBAC' },
    { op: 'create_edge', src: '$coder', kind: 'reports_to', dst: '00000000-0000-4000-8000-000000000002' },
    { op: 'create_edge', src: '$jev', kind: 'reports_to', dst: '00000000-0000-4000-8000-000000000002' },
  ],
});
const id = (ref: string) => results.find((r) => r.ref === ref)!.id;

const note = await call<{ id: string }>('tell_user', { tasks: [id('root')], body: 'I broke SSO into 4 tasks. **Pick an OIDC library** is ready now; token exchange waits on it and on the RBAC claims.' });
await call('assign', { because: note.id, to: id('coder'), tasks: [id('oidc')], body: 'Compare 2–3 OIDC client libraries for Node 24 and recommend one.', dueInMinutes: 120 });
await call('assign', { because: note.id, to: id('bryan'), tasks: [id('rbac')], body: 'Which claims should agents carry for RBAC? Roles only, or roles + tenant?' });
await call('ask_user', {
  because: note.id,
  tasks: [id('root')],
  body: 'Docs can wait until token exchange works, or start now from the design.',
  card: { kind: 'choice', title: 'When should the how-to start?', fields: [{ name: 'why', label: 'Anything I should know?', type: 'text' }], actions: [{ id: 'now', label: 'Start now', style: 'primary' }, { id: 'later', label: 'After token exchange' }] },
});
console.log(`Demo seeded. Open ${base}, or ask Claude Code to handle the next ariadne assignment.`);
await client.close();
