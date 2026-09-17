#!/usr/bin/env bash

# Retained at the installed timer target so a stale timer fails closed. GitHub
# Actions may build an immutable release bundle, but no timer may activate it.

set -euo pipefail
printf '%s\n' \
  'Agentify test pull refused: automatic delivery is retired and remains disabled' \
  >&2
exit 75
