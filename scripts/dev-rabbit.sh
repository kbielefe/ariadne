#!/usr/bin/env bash
# Start a throwaway RabbitMQ for development and bus tests (not the Compose stack).
# Prints the TEST_AMQP_URL to export. Bound to loopback only.
set -euo pipefail
NAME=${ARIADNE_DEV_RABBIT_NAME:-ariadne2-devrabbit}
PORT=${ARIADNE_DEV_RABBIT_PORT:-5673}

if ! podman container exists "$NAME"; then
  podman run -d --name "$NAME" --user rabbitmq -p "127.0.0.1:${PORT}:5672" \
    -e RABBITMQ_DEFAULT_USER=ariadne -e RABBITMQ_DEFAULT_PASS=ariadne-dev -e RABBITMQ_DEFAULT_VHOST=ariadne \
    artifactory.adtran.com/docker/rabbitmq:4.1.4-alpine >/dev/null
elif [ "$(podman inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
  podman start "$NAME" >/dev/null
fi

for _ in $(seq 1 90); do
  if podman exec "$NAME" rabbitmq-diagnostics -q check_port_connectivity >/dev/null 2>&1; then
    echo "TEST_AMQP_URL=amqp://ariadne:ariadne-dev@127.0.0.1:${PORT}/ariadne"
    exit 0
  fi
  sleep 1
done
echo "RabbitMQ did not become ready" >&2
exit 1
