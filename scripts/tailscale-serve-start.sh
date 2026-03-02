#!/bin/bash
# Start tailscale serve for inject endpoint — only if all 3 inject vars are set in .env

ENVFILE="$(dirname "$0")/../.env"

if [ ! -f "$ENVFILE" ]; then
  echo "tailscale-serve-start: .env not found, skipping"
  exit 0
fi

read_env_var() {
  grep "^$1=" "$ENVFILE" | head -1 | cut -d'=' -f2- | sed "s/^['\"]//;s/['\"]$//" | tr -d '[:space:]'
}

INJECT_SECRET=$(read_env_var INJECT_SECRET)
INJECT_HOST=$(read_env_var INJECT_HOST)
INJECT_PORT=$(read_env_var INJECT_PORT)

if [ -z "$INJECT_SECRET" ] || [ -z "$INJECT_HOST" ] || [ -z "$INJECT_PORT" ]; then
  echo "tailscale-serve-start: inject config incomplete, skipping tailscale serve"
  exit 0
fi

echo "tailscale-serve-start: starting https serve on port $INJECT_PORT"
exec tailscale serve --bg "http://127.0.0.1:$INJECT_PORT"
