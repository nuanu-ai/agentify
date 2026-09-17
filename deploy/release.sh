#!/usr/bin/env bash

# Retained at the installed receiver path so a stale forced-SSH command fails
# closed. Source builds and channel activation belong only to the reviewed
# Ansible path.

set -euo pipefail
printf '%s\n' \
  'Agentify release refused: the source-build receiver is retired; use the reviewed Ansible release' \
  >&2
exit 64
