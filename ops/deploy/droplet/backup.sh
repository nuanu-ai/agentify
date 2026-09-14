#!/usr/bin/env bash
set -euo pipefail

ROOT="/opt/agentify/current"
BACKUP_DIR="/opt/agentify/shared/backups"

install -d -m 700 "$BACKUP_DIR"
cd "$ROOT/ops/deploy/droplet"

docker compose --profile jobs \
  --env-file /opt/agentify/shared/.env.production \
  -f compose.production.yaml run --rm --no-deps -T database-backup

latest="$(find "$BACKUP_DIR" -type f -name 'agentify-*.dump' -print | sort | tail -1)"
test -n "$latest"
test -s "$latest"
chmod 600 "$latest"
