# Ariadne

**A task and org graph you keep with Claude Code.** Tasks, people, teams, and resources, linked by
what needs what and who's involved. You direct Claude Code in an interactive session (over MCP) to
look things up and update the graph; the web UI is the graph view, for the big picture and manual
edits. Every change is audited and can be undone. The design and its reasons are in
[docs/DESIGN.md](docs/DESIGN.md).

> **Localhost only.** Neither the web UI nor `/mcp` has authentication yet.

## Quick start (Compose)

1. Configure:

   ```sh
   cp .env.example .env        # set POSTGRES_PASSWORD (openssl rand -hex 24)
   ```

2. Start it (the first build needs the VPN for npm), then open <http://127.0.0.1:3100>:

   ```sh
   podman compose up -d
   ```

3. Connect Claude Code to Ariadne (once per machine):

   ```sh
   claude mcp add --scope user --transport http ariadne http://127.0.0.1:3100/mcp
   ```

   Then just ask: *"What's ready under the SSO task?"*, *"Add a subtask for the docs and involve
   Bryan"*, *"Record that we decided to skip signing"*.

To deploy UI or server changes: `podman compose build app && podman compose up -d --force-recreate app`.

## Development

| Command | What it does |
|---|---|
| `scripts/dev-db.sh` | Start a throwaway PostgreSQL (55433) |
| `podman exec ariadne2-devdb psql -U ariadne -d ariadne_test -c 'CREATE DATABASE ariadne_dev'` | Create the dev database (once) |
| `pnpm build && scripts/dev-up.sh` | Run the server on 3100 against it. `scripts/dev-up.sh stop` stops it |
| `pnpm tsx scripts/demo.ts` | Seed demo data through the real MCP (**never against real data**) |
| `pnpm test` | Unit and DB tests (the dev DB must be running) |
| `pnpm typecheck` | TypeScript |

## Layout

| Path | Holds |
|---|---|
| `src/shared` | The vocabulary: node kinds, edge rules, ops, graph helpers |
| `src/server` | Fastify API + SSE, MCP, ops and undo, task context |
| `src/web` | React: the graph view (cytoscape) |
