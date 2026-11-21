#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-002}"

umask "$UMASK"
mkdir -p /app/config /app/library /app/log

if [ "$(id -u)" = "0" ]; then
  if ! getent group "$PGID" >/dev/null 2>&1; then
    addgroup -g "$PGID" nexus 2>/dev/null || addgroup -g "$PGID" -S nexus
  fi
  GROUP_NAME="$(getent group "$PGID" | cut -d: -f1)"
  if ! getent passwd "$PUID" >/dev/null 2>&1; then
    adduser -D -H -u "$PUID" -G "$GROUP_NAME" nexus 2>/dev/null || true
  fi
  chown -R "$PUID:$PGID" /app/config /app/library /app/log || true
  exec su-exec "$PUID:$PGID" node /app/worker.mjs
fi

exec node /app/worker.mjs