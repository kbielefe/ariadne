# Ariadne

**A task and org graph you keep with Claude Code or Cursor.** Tasks, people, teams, and resources, linked by
what needs what and who's involved. You direct an agent in an interactive session (over MCP) to
look things up and update the graph; the web UI is the graph view, for the big picture and manual
edits. Every change is audited and can be undone. The design and its reasons are in
[docs/DESIGN.md](docs/DESIGN.md).

> **Local by default.** Without `ARIADNE_TOKEN`, neither the web UI nor `/mcp` has authentication:
> bind the published port to loopback only. For a Cloudflare Tunnel (or any remote URL), set a token.

## Quick start (Compose)

1. Configure:

   ```sh
   cp .env.example .env        # set POSTGRES_PASSWORD (openssl rand -hex 24)
   ```

2. Start it (the first build needs the VPN for npm), then open <http://127.0.0.1:3100>:

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

The same stack is installed as rootless Quadlets:

```sh
podman quadlet install --application ariadne --replace quadlet
systemctl --user start ariadne-app.service
```

At start, `quadlet/render-env.sh` reads `POSTGRES_PASSWORD` from `%h/source/ariadne/.env` for Postgres and the app. The containers are `ariadne-app` and `ariadne-postgres`, with network aliases `app` and `postgres`.

### Quadlets with a hand-built image (`deploy/quadlet/`)

A smaller set (e.g. for the work laptop): a hand-built image and podman secrets instead of `render-env.sh`.
Instead of Compose, run Ariadne as rootless Podman quadlets, so it starts with
your session. They reuse the Compose data volume, so stop Compose first (`podman compose down`).

```sh
podman build -t localhost/ariadne2:0.3.0 .   # needs the VPN
scripts/install-quadlet.sh                    # units + secrets from .env, then (re)starts
```

- Status and logs: `systemctl --user status ariadne` · `journalctl --user -u ariadne -f`
- Redeploy after a rebuild: `systemctl --user restart ariadne`
- Start at boot without logging in: `loginctl enable-linger`

## Remote access (cloudflared + Cursor)

Keep Ariadne on loopback; put a Cloudflare Tunnel in front. App-level auth is a shared Bearer token
(`ARIADNE_TOKEN`). Cursor speaks Streamable HTTP and can send headers; it does **not** complete a
browser Cloudflare Access login by itself.

### 1. Token and Host allowlist

In `.env` (and recreate the app container / re-render the quadlet env):

```sh
ARIADNE_TOKEN=$(openssl rand -hex 32)          # keep this; Cursor will send it
ARIADNE_ALLOWED_HOSTS=127.0.0.1:3100,localhost:3100,ariadne.example.com
ARIADNE_TRUST_PROXY=1                          # Secure cookies behind the tunnel
```

`ARIADNE_ALLOWED_HOSTS` must include the public hostname Cloudflare sends in `Host` (usually
without a port).

### 2. Tunnel to loopback

Example `~/.cloudflared/config.yml` ingress (hostname → local Compose/quadlet port):

```yaml
ingress:
  - hostname: ariadne.example.com
    service: http://127.0.0.1:3100
  - service: http_status:404
```

Leave the published Podman port on `127.0.0.1` only. The tunnel is the only way in from the internet.

### 3. Cursor MCP config

```json
{
  "mcpServers": {
    "ariadne": {
      "url": "https://ariadne.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:ARIADNE_TOKEN}"
      }
    }
  }
}
```

Put `ARIADNE_TOKEN` in your shell environment (or another secret store Cursor can interpolate). Do
not commit the raw token into `mcp.json`.

Claude Code, when the token is set:

```sh
claude mcp add --scope user --transport http ariadne https://ariadne.example.com/mcp \
  --header "Authorization: Bearer $ARIADNE_TOKEN"
```

The web UI asks for the same token once and stores an HttpOnly cookie.

### Cloudflare Access (Zero Trust)

| Approach | Works with Cursor MCP? |
|---|---|
| Tunnel only + `ARIADNE_TOKEN` | Yes (recommended default) |
| Access **browser** login (IdP / one-time PIN) in front of `/mcp` | No — Cursor will not complete the Access redirect |
| Access **Service Auth** (service token) in front of the hostname | Yes — add the CF headers in `mcp.json` (below) |
| Access on the **UI only**; `/mcp` outside Access, still requiring `ARIADNE_TOKEN` | Yes |

If you put Access on the whole hostname, create a **Service Auth** policy with a service token and
send both headers every request (in addition to Ariadne's Bearer):

```json
{
  "mcpServers": {
    "ariadne": {
      "url": "https://ariadne.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:ARIADNE_TOKEN}",
        "CF-Access-Client-Id": "${env:CF_ACCESS_CLIENT_ID}",
        "CF-Access-Client-Secret": "${env:CF_ACCESS_CLIENT_SECRET}"
      }
    }
  }
}
```

Cloudflare's [Authenticate coding agents](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/)
doc covers Service Auth. A simpler split many people use: Access protects browser paths you care
about, and `/mcp` stays reachable through the tunnel with Bearer only.

## Sharing with the pod

Ariadne no longer shares subgraphs itself. Sharing work with teammates is **steward**'s job, a separate
project; Ariadne is one of its back ends. Put `scripts/steward-backend-ariadne` on the steward daemon's
`PATH` (set `ARIADNE_URL` if Ariadne isn't on `http://127.0.0.1:3100`, and `ARIADNE_TOKEN` when the
server has one). Only tasks with `attrs.steward: true`, and what they need, are shared. Private notes
never leave this machine. See [docs/DESIGN.md](docs/DESIGN.md) §6.

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
