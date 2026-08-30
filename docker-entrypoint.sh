#!/bin/sh
# `demo` runs mockdd inside the container so a bare `docker run` works offline, with no
# Datadog account and no keys. Anything else is passed straight through to the CLI.
set -e

if [ "$1" != "demo" ]; then
  exec node /app/ddguard/bin/ddguard.js "$@"
fi
shift

node /app/mockdd/seed.js >/dev/null
node /app/mockdd/server.js &
mock=$!
trap 'kill $mock 2>/dev/null' INT TERM

up=
for _ in $(seq 1 50); do
  if wget -q -O /dev/null http://localhost:8126/health 2>/dev/null; then up=1; break; fi
  sleep 0.2
done
if [ -z "$up" ]; then
  echo "ddguard: mockdd did not come up — nothing could be verified" >&2
  kill $mock 2>/dev/null
  exit 2
fi

status=0
DD_API_URL=http://localhost:8126 \
  node /app/ddguard/bin/ddguard.js /app/fixtures/tfplan.json --days=30 "$@" || status=$?
kill $mock 2>/dev/null
wait $mock 2>/dev/null || true
exit $status
