#!/bin/sh
# Turn %h/source/ariadne/.env into a podman --env-file. systemd does not expand
# ${VAR} in Environment=.
# Usage: render-env.sh app|postgres DEST
set -eu

mode=${1:?mode}
dest=${2:?dest}
envfile=${ARIADNE_ENV_FILE:-${HOME}/source/ariadne/.env}

POSTGRES_PASSWORD=
LOG_LEVEL=
ARIADNE_TOKEN=
ARIADNE_ALLOWED_HOSTS=
ARIADNE_TRUST_PROXY=

if [ ! -f "$envfile" ]; then
  echo "missing $envfile" >&2
  exit 1
fi

while IFS= read -r line || [ -n "$line" ]; do
  case $line in
    '' | '#'*) continue ;;
  esac
  key=${line%%=*}
  val=${line#*=}
  case $val in
    \"*\") val=${val#\"}; val=${val%\"} ;;
    \'*\') val=${val#\'}; val=${val%\'} ;;
  esac
  case $key in
    POSTGRES_PASSWORD) POSTGRES_PASSWORD=$val ;;
    LOG_LEVEL) LOG_LEVEL=$val ;;
    ARIADNE_TOKEN) ARIADNE_TOKEN=$val ;;
    ARIADNE_ALLOWED_HOSTS) ARIADNE_ALLOWED_HOSTS=$val ;;
    ARIADNE_TRUST_PROXY) ARIADNE_TRUST_PROXY=$val ;;
  esac
done < "$envfile"

: "${LOG_LEVEL:=info}"
: "${ARIADNE_ALLOWED_HOSTS:=127.0.0.1:3100,localhost:3100}"
: "${ARIADNE_TRUST_PROXY:=0}"

umask 077
tmp=${dest}.tmp
case $mode in
  app)
    if [ -z "$POSTGRES_PASSWORD" ]; then
      echo "POSTGRES_PASSWORD is unset in $envfile" >&2
      exit 1
    fi
    {
      printf 'DATABASE_URL=postgres://ariadne:%s@postgres:5432/ariadne\n' "$POSTGRES_PASSWORD"
      printf 'ARIADNE_LISTEN_HOST=0.0.0.0\n'
      printf 'ARIADNE_LISTEN_PORT=3100\n'
      printf 'ARIADNE_ALLOWED_HOSTS=%s\n' "$ARIADNE_ALLOWED_HOSTS"
      printf 'ARIADNE_TRUST_PROXY=%s\n' "$ARIADNE_TRUST_PROXY"
      printf 'LOG_LEVEL=%s\n' "$LOG_LEVEL"
      if [ -n "$ARIADNE_TOKEN" ]; then
        printf 'ARIADNE_TOKEN=%s\n' "$ARIADNE_TOKEN"
      fi
    } > "$tmp"
    ;;
  postgres)
    if [ -z "$POSTGRES_PASSWORD" ]; then
      echo "POSTGRES_PASSWORD is unset in $envfile" >&2
      exit 1
    fi
    printf 'POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD" > "$tmp"
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 1
    ;;
esac
mv "$tmp" "$dest"
