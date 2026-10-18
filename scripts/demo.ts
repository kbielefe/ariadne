// Seeds a small demo into a running Ariadne over MCP, the way Claude Code would.
//   ARIADNE_URL=http://127.0.0.1:3100 pnpm tsx scripts/demo.ts
// Uses the real MCP, so it doubles as a smoke test. Don't run it against real data.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.env.ARIADNE_URL ?? 'http://127.0.0.1:3100';

const client = new Client({ name: 'demo', version: '0' });
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
    { op: 'create_node', ref: 'rbac', kind: 'task', title: 'Agree on the RBAC claims', body: '**Decision (Bryan, 2026-10-02):** roles + tenant, so pods can share an IdP.' },
    { op: 'create_node', ref: 'docs', kind: 'task', title: 'Write the how-to for delivery pods' },
    { op: 'create_node', ref: 'review', kind: 'task', title: 'Waiting on review: agent-framework PR #7 (OIDC spike)' },
    { op: 'create_node', ref: 'repo', kind: 'resource', title: 'agent-framework repo', attrs: { type: 'repo', url: 'https://github.com/example/agent-framework' } },
    { op: 'create_node', ref: 'build', kind: 'resource', title: 'agent-framework CI', attrs: { type: 'build', url: 'https://jenkins.example/job/agent-framework' } },
    { op: 'create_node', ref: 'bryan', kind: 'person', title: 'Bryan', attrs: { areas: ['RBAC', 'feature flags'] } },
    { op: 'create_node', ref: 'pod', kind: 'team', title: 'Common agent needs pod', attrs: { areas: ['agent framework', 'auth'] } },
    { op: 'create_edge', src: '$root', kind: 'needs', dst: '$oidc' },
    { op: 'create_edge', src: '$root', kind: 'needs', dst: '$flow' },
    { op: 'create_edge', src: '$root', kind: 'needs', dst: '$docs' },
    { op: 'create_edge', src: '$flow', kind: 'needs', dst: '$oidc' },
    { op: 'create_edge', src: '$flow', kind: 'needs', dst: '$rbac' },
    { op: 'create_edge', src: '$docs', kind: 'needs', dst: '$flow' },
    { op: 'create_edge', src: '$root', kind: 'uses', dst: '$repo' },
    { op: 'create_edge', src: '$root', kind: 'uses', dst: '$build' },
    { op: 'create_edge', src: '$rbac', kind: 'involves', dst: '$bryan', note: 'owns RBAC' },
    { op: 'create_edge', src: '$bryan', kind: 'member_of', dst: '$pod' },
    { op: 'create_edge', src: '00000000-0000-4000-8000-000000000001', kind: 'member_of', dst: '$pod' },
    { op: 'create_edge', src: '$root', kind: 'involves', dst: '$pod' },
    { op: 'create_edge', src: '$oidc', kind: 'needs', dst: '$review' },
    { op: 'create_edge', src: '$review', kind: 'waits_on', dst: '$bryan' },
  ],
});
const id = (ref: string) => results.find((r) => r.ref === ref)!.id;

// Closing the RBAC agreement leaves token exchange waiting only on the OIDC library.
const { nowReady } = await call<{ nowReady?: { title: string }[] }>('apply_ops', { ops: [{ op: 'update_node', id: id('rbac'), status: 'done' }] });
if (nowReady) throw new Error(`Nothing should be ready yet, got ${JSON.stringify(nowReady)}`);
console.log(`Demo seeded. Open ${base}.`);
await client.close();
