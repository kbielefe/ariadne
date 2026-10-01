#!/usr/bin/env bash
# Start a throwaway PostgreSQL for development and DB tests (not the Compose stack).
# Prints the TEST_DATABASE_URL to export. Bound to loopback only; data lives in tmpfs.
set -euo pipefail
NAME=${ARIADNE_DEV_DB_NAME:-ariadne2-devdb}
PORT=${ARIADNE_DEV_DB_PORT:-55433}

if ! podman container exists "$NAME"; then
  podman run -d --name "$NAME" -p "127.0.0.1:${PORT}:5432" \
    -e POSTGRES_USER=ariadne -e POSTGRES_PASSWORD=ariadne-dev -e POSTGRES_DB=ariadne_test \
    --tmpfs /var/lib/postgresql/data artifactory.adtran.com/docker/postgres:17.6-alpine >/dev/null
elif [ "$(podman inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
  podman start "$NAME" >/dev/null
fi

for _ in $(seq 1 60); do
  if podman exec "$NAME" pg_isready -U ariadne -d ariadne_test >/dev/null 2>&1; then
    echo "TEST_DATABASE_URL=postgres://ariadne:ariadne-dev@127.0.0.1:${PORT}/ariadne_test"
    exit 0
  fi
  sleep 1
done
echo "PostgreSQL did not become ready" >&2
exit 1
