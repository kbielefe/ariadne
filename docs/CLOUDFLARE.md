# Cloudflare Tunnel + Access for Ariadne

Ariadne stays on loopback. A **cloudflared** sidecar (Podman quadlet) publishes
`https://ariadne.bielefeldt.dev`. **Cloudflare Access** is the only remote auth:

| Path | Access application | Who gets in |
|---|---|---|
| `ariadne.bielefeldt.dev/mcp` | more specific app | **Service Auth** (Access service token) — Cursor / Claude Code |
| `ariadne.bielefeldt.dev` (everything else) | site-wide app | your **IdP** (browser login) |

There is no app-level Bearer token. The Host allowlist
(`ARIADNE_ALLOWED_HOSTS`) still rejects wrong `Host` headers; Access stops
unauthenticated clients at the edge.

More specific Access paths win over broader ones
([Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)).

```text
Cursor --CF-Access-Client-*--> Access (/mcp, Service Auth) --tunnel--> cloudflared --> app:3100
Browser --IdP login----------> Access (site, Allow)         --tunnel--> cloudflared --> app:3100
```

---

## 1. Tunnel (dashboard)

1. Zero Trust → **Networks** → **Tunnels** → Create a tunnel (Cloudflared).
2. Name it e.g. `ariadne`. Copy the **tunnel token** (shown once).
3. Public hostname:
   - **Subdomain / Domain:** `ariadne` on `bielefeldt.dev`
   - **Service:** `http://app:3100`  
     (`app` is the Podman network alias of `ariadne-app` on `ariadne-frontend`.
     If cloudflared runs with host networking instead, use `http://127.0.0.1:3100`.)
4. Put the token in the machine’s `.env` as `CLOUDFLARE_TUNNEL_TOKEN=…`
   (see §5). Never commit it.

DNS for `ariadne.bielefeldt.dev` is created by the tunnel hostname UI (CNAME to
the tunnel). Ensure `bielefeldt.dev` is on the same Cloudflare account.

---

## 2. Access service token (for Cursor)

1. Zero Trust → **Access controls** → **Service credentials** → **Service Tokens**.
2. Create a token (e.g. `cursor-ariadne`). Copy **Client ID** and **Client Secret**
   (secret shown once).
3. Store them in your shell (or a secret store Cursor can interpolate):

   ```sh
   export CF_ACCESS_CLIENT_ID='….access'
   export CF_ACCESS_CLIENT_SECRET='…'
   ```

Docs: [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/),
[Authenticate coding agents](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/).

---

## 3. Access application for `/mcp` (Service Auth)

1. **Access controls** → **Applications** → Add an application → **Self-hosted**.
2. Name: `Ariadne MCP`.
3. Application domain: `ariadne.bielefeldt.dev` with path **`mcp`**
   (UI may show `ariadne.bielefeldt.dev/mcp`).
4. Policy:
   - Action: **Service Auth**
   - Include: **Service Token** → `cursor-ariadne`
5. Save. Optionally enable **Strict service token authentication** under
   Access settings so failed machine auth returns `401`/`403` instead of a
   login redirect.

---

## 4. Access application for the rest (IdP)

1. Add another self-hosted application: `Ariadne UI`.
2. Domain: `ariadne.bielefeldt.dev` with **no path** (entire hostname).
3. Policy:
   - Action: **Allow**
   - Include: your IdP identity (email, Google group, etc.)
4. Save.

Browsers hitting `/`, `/api/*`, static assets get the normal Access login.
`/mcp` is covered by the more specific app and does **not** inherit this Allow
policy.

---

## 5. Podman / Ariadne on the host

In `%h/source/ariadne/.env` (home quadlets) or the laptop `.env` (`deploy/quadlet`):

```sh
POSTGRES_PASSWORD=…
CLOUDFLARE_TUNNEL_TOKEN=…   # from §1
ARIADNE_ALLOWED_HOSTS=127.0.0.1:3100,localhost:3100,ariadne.bielefeldt.dev
ARIADNE_TRUST_PROXY=1
```

Home stack (`quadlet/`):

```sh
podman quadlet install --application ariadne --replace quadlet
systemctl --user start ariadne-app.service ariadne-cloudflared.service
```

Laptop stack (`deploy/quadlet/`):

```sh
scripts/install-quadlet.sh   # also creates the tunnel-token secret when set
```

`ariadne-cloudflared` joins `ariadne-frontend` and runs
`cloudflared tunnel --no-autoupdate run` with `TUNNEL_TOKEN` from the secret.
Keep the app’s `PublishPort` on `127.0.0.1:3100` for local use; the tunnel is
the public path.

---

## 6. Cursor MCP config

`~/.cursor/mcp.json` (or project `.cursor/mcp.json`):

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

Restart Cursor after changing env vars. Smoke test:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'content-type: application/json' \
  -d '{}' \
  https://ariadne.bielefeldt.dev/mcp
```

You should not get Access’s HTML login page. An Ariadne/MCP protocol error for
`{}` still means Service Auth let you through.

Claude Code:

```sh
claude mcp add --scope user --transport http ariadne https://ariadne.bielefeldt.dev/mcp \
  --header "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  --header "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

---

## 7. What not to do

- Do **not** put only an IdP **Allow** policy on `/mcp` — Cursor will not complete
  the browser login redirect.
- Do **not** expose port `3100` on a public interface; loopback + tunnel only.
- Do **not** commit tunnel tokens or Access Client Secrets.

---

## Checklist for `ariadne.bielefeldt.dev`

- [ ] Tunnel created; public hostname → `http://app:3100` (or `127.0.0.1:3100`)
- [ ] `CLOUDFLARE_TUNNEL_TOKEN` in `.env`; `ariadne-cloudflared` unit running
- [ ] `ARIADNE_ALLOWED_HOSTS` includes `ariadne.bielefeldt.dev`
- [ ] Access app on `/mcp` with Service Auth + service token
- [ ] Access app on hostname with Allow + your IdP
- [ ] Cursor `mcp.json` sends the two `CF-Access-*` headers
- [ ] Browser opens `https://ariadne.bielefeldt.dev` and completes IdP login
- [ ] `curl` with service token headers reaches `/mcp` without a login HTML body
