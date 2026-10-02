# Ariadne v2

**A task graph and an augmented chat for working with people, teams, and agents.** You chat
with the Analyst, which is an interactive Claude Code session. It keeps the graph up to date,
delegates to agents, and brings you only what needs you, as cards. The design and its reasons are in
[docs/DESIGN.md](docs/DESIGN.md).

> **Localhost only.** Neither the web UI nor `/mcp` has authentication yet.

## Quick start (Compose)

1. Configure:

   ```sh
   cp .env.example .env        # set POSTGRES_PASSWORD and RABBITMQ_PASSWORD (openssl rand -hex 24)
   ```

2. Start it (the first build needs the VPN for npm), then open <http://127.0.0.1:3100>:

   ```sh
   podman compose up -d
   ```

3. Connect Claude Code to Ariadne (once per machine):

   ```sh
   claude mcp add --scope user --transport http ariadne http://127.0.0.1:3100/mcp
   ```

   In any repo, say *"Handle the next ariadne assignment."* Claude calls `list_assignments` (your
   chats, card answers, and agent reports for the Analyst, plus assignments for agents marked
   **interactive (Claude Code)**; each shows the repos its tasks use). It claims the first one it can
   handle there with `claim_assignment`, does the work, and calls `submit_result`. A claim with no word
   for `ARIADNE_CLAIM_TIMEOUT_MINUTES` (default 30) goes back on the list and you're told;
   `still_working` resets the clock. Ariadne doesn't track which session claimed what: any session
   can submit a result.

4. Optional: headless agents over RabbitMQ. Create the agent in the Graph view and make it report to
   the Analyst. Then run:

   ```sh
   ARIADNE_AMQP_URL=amqp://ariadne:$RABBITMQ_PASSWORD@127.0.0.1:5674/ariadne AGENT_CWD=~/src/some-repo AGENT_ARGS='["--permission-mode","acceptEdits"]' pnpm runner agent <agentId>
   SYSTEMONE_API_KEY_FILE=~/.jev-key ARIADNE_AMQP_URL=… pnpm runner decider <deciderId>   # mark that agent "System One decider"
   ```

v1 keeps running on port 3000. v2 uses 3100 (web) and 5674 (RabbitMQ).

## Development

| Command | What it does |
|---|---|
| `scripts/dev-db.sh`, `scripts/dev-rabbit.sh` | Start a throwaway PostgreSQL (55433) and RabbitMQ (5673) |
| `podman exec ariadne2-devdb psql -U ariadne -d ariadne_test -c 'CREATE DATABASE ariadne_dev'` | Create the dev database (once) |
| `pnpm build && scripts/dev-up.sh` | Run the server on 3100 against them. `scripts/dev-up.sh stop` stops it |
| `pnpm tsx scripts/demo.ts` | Seed demo data through the real API and MCP (**never against real data**) |
| `pnpm test` | Unit, DB, and RabbitMQ tests (the dev DB and dev RabbitMQ must be running) |
| `pnpm typecheck` | TypeScript |

## Layout

| Path | Holds |
|---|---|
| `src/shared` | The vocabulary: node kinds, edge rules, events, cards, ops, bus names, graph helpers |
| `src/server` | Fastify API + SSE, MCP (incl. claims), core rules, timers, context packs, RabbitMQ relay and inbox |
| `src/web` | React: Timeline (chat + cards) and Graph (cytoscape) |
| `src/runner` | Headless agent and decider runners, and the prompts/briefs |
