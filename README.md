# Ariadne v2

**A task graph and an augmented chat for working with people, teams, and agents.** You chat
with the Analyst. It keeps the graph up to date, delegates to agents over RabbitMQ, and brings you
only what needs you, as cards. The design and its reasons are in [docs/DESIGN.md](docs/DESIGN.md).

> **Localhost only.** The web UI has no authentication. `/mcp` requires the Analyst's token.

## Quick start (Compose)

1. Configure:

   ```sh
   cp .env.example .env        # set POSTGRES_PASSWORD and RABBITMQ_PASSWORD (openssl rand -hex 24)
   mkdir -p secrets && openssl rand -hex 24 > secrets/mcp_token && chmod 600 secrets/mcp_token
   ```

2. Start it (the first build needs the VPN for npm), then open <http://127.0.0.1:3100>:

   ```sh
   podman compose up -d
   ```

3. Start the Analyst on the host (it runs `claude -p` with Ariadne's MCP):

   ```sh
   ARIADNE_AMQP_URL=amqp://ariadne:$RABBITMQ_PASSWORD@127.0.0.1:5674/ariadne pnpm runner analyst
   ```

4. Optional: start more agents. Create the agent in the Graph view and make it report to the Analyst.
   Then run:

   ```sh
   ARIADNE_AMQP_URL=… AGENT_CWD=~/src/some-repo AGENT_ARGS='["--permission-mode","acceptEdits"]' pnpm runner agent <agentId>
   SYSTEMONE_API_KEY_FILE=~/.jev-key ARIADNE_AMQP_URL=… pnpm runner decider <deciderId>   # mark that agent "System One decider"
   ```

v1 keeps running on port 3000. v2 uses 3100 (web) and 5674 (RabbitMQ).

## Development

| Command | What it does |
|---|---|
| `scripts/dev-db.sh`, `scripts/dev-rabbit.sh` | Start a throwaway PostgreSQL (55433) and RabbitMQ (5673) |
| `podman exec ariadne2-devdb psql -U ariadne -d ariadne_test -c 'CREATE DATABASE ariadne_dev'` | Create the dev database (once) |
| `pnpm build && scripts/dev-up.sh analyst` | Run the server on 3100 plus the Analyst against them. `scripts/dev-up.sh stop` stops both |
| `pnpm tsx scripts/demo.ts` | Seed demo data through the real API and MCP (**never against real data**) |
| `pnpm test` | Unit, DB, and RabbitMQ tests (the dev DB and dev RabbitMQ must be running) |
| `pnpm typecheck` | TypeScript |

## Layout

| Path | Holds |
|---|---|
| `src/shared` | The vocabulary: node kinds, edge rules, events, cards, ops, bus names, graph helpers |
| `src/server` | Fastify API + SSE, the Analyst's MCP, core rules, context packs, RabbitMQ relay and inbox |
| `src/web` | React: Timeline (chat + cards) and Graph (cytoscape) |
| `src/runner` | Analyst, agent, and decider runners |
