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
  esac
done < "$envfile"

: "${LOG_LEVEL:=info}"

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
      printf 'ARIADNE_ALLOWED_HOSTS=127.0.0.1:3100,localhost:3100\n'
      printf 'LOG_LEVEL=%s\n' "$LOG_LEVEL"
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
