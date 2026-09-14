#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${PRIVACY_CLEANUP_ACK:?Set PRIVACY_CLEANUP_ACK=yes after confirming the target database}"
[[ "$PRIVACY_CLEANUP_ACK" == "yes" ]] || {
  echo "PRIVACY_CLEANUP_ACK must equal yes" >&2
  exit 1
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
corepack pnpm --filter @agentify/web privacy:cleanup
