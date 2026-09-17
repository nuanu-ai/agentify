#!/usr/bin/env bash

# Retained at the installed timer target so a stale timer fails closed. Only a
# reviewed Ansible run may build or activate a source revision on a host.

set -euo pipefail
printf '%s\n' \
  'Agentify test pull refused: automatic delivery is retired and remains disabled' \
  >&2
exit 75
