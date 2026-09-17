#!/usr/bin/env bash

# Retained at the installed receiver path so a stale forced-SSH command fails
# closed. Release images are built off-host and test and production promotion
# now belongs only to the reviewed Ansible path.

set -euo pipefail
printf '%s\n' \
  'Agentify release refused: the source-build receiver is retired; use the immutable manifest through Ansible' \
  >&2
exit 64
