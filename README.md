# Ariadne

**A task and org graph you keep with Claude Code or Cursor.** Tasks, people, teams, and resources, linked by
what needs what and who's involved. You direct an agent in an interactive session (over MCP) to
look things up and update the graph; the web UI is the graph view, for the big picture and manual
edits. Every change is audited and can be undone. The design and its reasons are in
[docs/DESIGN.md](docs/DESIGN.md).

> **Local by default.** The published port stays on loopback. Remote access is a Cloudflare Tunnel
> plus Access: Service Auth on `/mcp` (Cursor), IdP on the UI. See [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md).

## Quick start (Compose)

1. Configure:

   ```sh
   cp .env.example .env        # set POSTGRES_PASSWORD (openssl rand -hex 24)
   ```

2. Start it (the first build needs network for npm and base images), then open <http://127.0.0.1:3100>:

   ```sh
   podman compose up -d
   ```

3. Connect Claude Code or Cursor to Ariadne (once per machine):

   ```sh
   claude mcp add --scope user --transport http ariadne http://127.0.0.1:3100/mcp
   ```

   Cursor (`~/.cursor/mcp.json`):

   ```json
   {
     "mcpServers": {
       "ariadne": {
         "url": "http://127.0.0.1:3100/mcp"
       }
     }
   }
   ```

   Then just ask: *"What's ready under the SSO task?"*, *"Add a subtask for the docs and involve
   Bryan"*, *"Record that we decided to skip signing"*.

To deploy UI or server changes: `podman compose build app && podman compose up -d --force-recreate app`.

The same stack is installed as rootless Quadlets (includes optional `ariadne-cloudflared`):

```sh
podman quadlet install --application ariadne --replace quadlet
systemctl --user start ariadne-app.service ariadne-cloudflared.service
```

At start, `quadlet/render-env.sh` reads `%h/source/ariadne/.env` for Postgres, the app, and the
tunnel token. The containers are `ariadne-app`, `ariadne-postgres`, and `ariadne-cloudflared`, with
network aliases `app` and `postgres`.

### Quadlets with a hand-built image (`deploy/quadlet/`)

A smaller set (e.g. for the work laptop): a hand-built image and podman secrets instead of `render-env.sh`.
They reuse the Compose data volume, so stop Compose first (`podman compose down`).

```sh
podman build -t localhost/ariadne2:0.3.0 .   # needs network for npm / base images
scripts/install-quadlet.sh                    # units + secrets from .env, then (re)starts
```

- Status and logs: `systemctl --user status ariadne` · `journalctl --user -u ariadne -f`
- Redeploy after a rebuild: `systemctl --user restart ariadne`
- Start at boot without logging in: `loginctl enable-linger`
- Tunnel (when `CLOUDFLARE_TUNNEL_TOKEN` is in `.env`): `systemctl --user status ariadne-cloudflared`

## Remote access (cloudflared + Access)

Full steps: **[docs/CLOUDFLARE.md](docs/CLOUDFLARE.md)**. Summary for `ariadne.bielefeldt.dev`:

1. Cloudflare Tunnel public hostname → `http://app:3100` (or `http://ariadne:3100` on the laptop units).
2. Access app on **`/mcp`**: policy **Service Auth** + an Access service token.
3. Access app on the hostname: policy **Allow** + your IdP.
4. Cursor:

   ```json
   {
     "mcpServers": {
       "ariadne": {
         "url": "https://ariadne.bielefeldt.dev/mcp",
         "headers": {
           "CF-Access-Client-Id": "${env:CF_ACCESS_CLIENT_ID}",
           "CF-Access-Client-Secret": "${env:CF_ACCESS_CLIENT_SECRET}"
         }
       }
     }
   }
   ```

A browser IdP login in front of `/mcp` alone does **not** work with Cursor; Service Auth headers do.

## Sharing with the pod

Ariadne no longer shares subgraphs itself. Sharing work with teammates is **steward**'s job, a separate
project; Ariadne is one of its back ends. Put `scripts/steward-backend-ariadne` on the steward daemon's
`PATH` (set `ARIADNE_URL` if Ariadne isn't on `http://127.0.0.1:3100`). Only tasks with
`attrs.steward: true`, and what they need, are shared. Private notes never leave this machine. See
[docs/DESIGN.md](docs/DESIGN.md) §6.

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
| `docs/CLOUDFLARE.md` | Tunnel + Access setup for Cursor and the UI |
