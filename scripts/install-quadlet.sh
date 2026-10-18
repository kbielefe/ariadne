#!/usr/bin/env bash
# Install Ariadne as rootless Podman quadlets (systemd user units) and start it.
# Reads POSTGRES_PASSWORD (and optional CLOUDFLARE_TUNNEL_TOKEN) from .env.
# Safe to re-run: replaces units and secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
set -a; source .env; set +a
: "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}"

printf '%s' "$POSTGRES_PASSWORD" | podman secret create --replace ariadne-postgres-password - >/dev/null
printf '%s' "postgres://ariadne:${POSTGRES_PASSWORD}@ariadne-postgres:5432/ariadne" \
  | podman secret create --replace ariadne-database-url - >/dev/null

if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  printf '%s' "$CLOUDFLARE_TUNNEL_TOKEN" | podman secret create --replace ariadne-tunnel-token - >/dev/null
fi

dest="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
mkdir -p "$dest"
cp deploy/quadlet/* "$dest/"

systemctl --user daemon-reload
units=(ariadne-postgres.service ariadne.service)
if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  units+=(ariadne-cloudflared.service)
fi
systemctl --user restart "${units[@]}"
systemctl --user --no-pager status "${units[@]}" | grep -E '●|Active:'
