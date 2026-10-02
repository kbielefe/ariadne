#!/usr/bin/env bash
# Dev loop without Compose: the server (port 3100), against
# scripts/dev-db.sh. Logs and pids go to var/dev/. Stop: scripts/dev-up.sh stop
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p var/dev
stop() { for f in var/dev/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done; }
if [ "${1:-}" = stop ]; then stop; exit 0; fi
stop
export DATABASE_URL=${DATABASE_URL:-postgres://ariadne:ariadne-dev@127.0.0.1:55433/ariadne_dev}
nohup node --import tsx src/server/main.ts > var/dev/server.log 2>&1 & echo $! > var/dev/server.pid
for _ in $(seq 1 30); do curl -fs http://127.0.0.1:3100/health/ready >/dev/null && break; sleep 0.5; done
echo "server: http://127.0.0.1:3100 (log var/dev/server.log)"
