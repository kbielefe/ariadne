// Ariadne runner. One process per actor queue (run several for more throughput).
//
//   pnpm runner analyst                 the Analyst: claude -p with Ariadne's MCP
//   pnpm runner agent   <actorId>       any other agent: claude -p, no Ariadne MCP
//   pnpm runner decider <actorId>       a System One decider (Jev)
//
// Environment:
//   ARIADNE_AMQP_URL | _FILE        required (amqp://user:pass@127.0.0.1:5672/ariadne)
//   ARIADNE_MCP_URL                 analyst only, default http://127.0.0.1:3100/mcp
//   ARIADNE_MCP_TOKEN | _FILE       analyst only, default file secrets/mcp_token
//   AGENT_COMMAND                   default "claude"
//   AGENT_ARGS                      extra args as a JSON array, e.g. ["--permission-mode","acceptEdits"]
//   AGENT_CWD                       working directory for runs (default: current directory)
//   AGENT_TIMEOUT_MS                default 1800000 (30 minutes)
//   SYSTEMONE_URL                   decider, default https://api.typesafe.ai/v1/systemone
//   SYSTEMONE_API_KEY | _FILE       decider, required
//   SYSTEMONE_MODEL                 decider, default jev-latest
import { existsSync, readFileSync } from 'node:fs';
import { ANALYST_ID } from '../shared/model';
import { claude, consume } from './adapters';
import { handleAgent, handleAnalyst, handleDecider, jev, type Log, type Publish } from './handlers';

const env = process.env;
const secret = (name: string, defaultFile?: string) => {
  if (env[name]) return env[name]!.trim();
  const file = env[`${name}_FILE`] ?? defaultFile;
  return file && existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined;
};
const log: Log = {
  info: (msg, o) => console.log(JSON.stringify({ level: 'info', msg, ...o })),
  error: (msg, o) => console.error(JSON.stringify({ level: 'error', msg, ...o })),
};

async function main() {
  const [mode, idArg] = process.argv.slice(2);
  const url = secret('ARIADNE_AMQP_URL');
  if (!url) throw new Error('Set ARIADNE_AMQP_URL or ARIADNE_AMQP_URL_FILE');
  const actorId = mode === 'analyst' ? ANALYST_ID : idArg;
  if (!actorId) throw new Error('Usage: runner analyst | agent <actorId> | decider <actorId>');

  const base = { command: env.AGENT_COMMAND ?? 'claude', args: env.AGENT_ARGS ? (JSON.parse(env.AGENT_ARGS) as string[]) : [], cwd: env.AGENT_CWD ?? process.cwd(), timeoutMs: Number(env.AGENT_TIMEOUT_MS ?? 1_800_000), log };
  let publish: Publish = async () => {
    throw new Error('not connected');
  };
  let handle;
  if (mode === 'analyst') {
    const token = secret('ARIADNE_MCP_TOKEN', 'secrets/mcp_token');
    if (!token) throw new Error('Set ARIADNE_MCP_TOKEN or ARIADNE_MCP_TOKEN_FILE');
    const run = claude({ ...base, mcp: { url: env.ARIADNE_MCP_URL ?? 'http://127.0.0.1:3100/mcp', token } });
    handle = (d: Parameters<typeof handleAnalyst>[0]) => handleAnalyst(d, run, publish, log);
  } else if (mode === 'agent') {
    const run = claude(base);
    handle = (d: Parameters<typeof handleAgent>[0]) => handleAgent(d, run, publish, log);
  } else if (mode === 'decider') {
    const apiKey = secret('SYSTEMONE_API_KEY');
    if (!apiKey) throw new Error('Set SYSTEMONE_API_KEY or SYSTEMONE_API_KEY_FILE');
    const model = jev({ url: env.SYSTEMONE_URL ?? 'https://api.typesafe.ai/v1/systemone', apiKey, model: env.SYSTEMONE_MODEL ?? 'jev-latest' });
    handle = (d: Parameters<typeof handleDecider>[0]) => handleDecider(d, model, publish, log);
  } else throw new Error(`Unknown mode ${mode}`);

  const c = await consume(url, actorId, handle, (p) => (publish = p), log);
  log.info('runner.started', { mode, actorId });
  const stop = () => void c.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await c.closed;
  log.error('runner.disconnected', {});
  process.exit(1);
}

main().catch((err) => {
  log.error('runner.failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
