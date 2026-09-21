#!/usr/bin/env bash
set -euo pipefail

repository="${1:-}"
running_revision="${2:-}"
candidate_revision="${3:-}"

if [[ ! "$running_revision" =~ ^[0-9a-f]{40}$ ]] || [[ ! "$candidate_revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Production forward-history check requires each revision to be one full Git SHA.' >&2
  exit 1
fi

git -C "$repository" cat-file -e "${running_revision}^{commit}"
git -C "$repository" cat-file -e "${candidate_revision}^{commit}"

if ! git -C "$repository" merge-base --is-ancestor "$running_revision" "$candidate_revision"; then
  echo "Tagged production revision $candidate_revision is older than or diverges from running revision $running_revision; manual recovery is required." >&2
  exit 1
fi

echo "Production candidate $candidate_revision advances from running revision $running_revision."
