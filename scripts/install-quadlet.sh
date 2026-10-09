#!/usr/bin/env bash
# Install Ariadne as rootless Podman quadlets (systemd user units) and start it.
# Reads POSTGRES_PASSWORD from .env. Safe to re-run: replaces units and secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
set -a; source .env; set +a
: "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}"

printf '%s' "$POSTGRES_PASSWORD" | podman secret create --replace ariadne-postgres-password - >/dev/null
printf '%s' "postgres://ariadne:${POSTGRES_PASSWORD}@ariadne-postgres:5432/ariadne" \
  | podman secret create --replace ariadne-database-url - >/dev/null

dest="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
mkdir -p "$dest"
cp deploy/quadlet/* "$dest/"

systemctl --user daemon-reload
systemctl --user restart ariadne-postgres.service ariadne.service
systemctl --user --no-pager status ariadne-postgres.service ariadne.service | grep -E '●|Active:'
