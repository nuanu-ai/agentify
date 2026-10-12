#!/usr/bin/env bash
#
# Lists the agent worktrees under .claude/worktrees and, with `clean`, removes
# the merged ones with their branches; a merge removes neither. Safe to run at
# any moment.
#
# It never touches the primary checkout; a locked worktree (the agent harness
# locks one while its agent is alive); a dirty one; or a branch whose commits
# are not in main, checked with git cherry, which compares patches rather than
# hashes and so survives a rewritten history. Whatever it keeps, it names with
# the reason; forcing is left to a human with plain git.
#
# Usage: scripts/worktrees.sh [list|clean]   (also: pnpm worktrees[:clean])

set -euo pipefail

mode="${1:-list}"
case "${mode}" in
  list | clean) ;;
  *)
    printf 'Unknown mode: %s (expected list or clean)\n' "${mode}" >&2
    exit 2
    ;;
esac

repository_root="$(git rev-parse --show-toplevel)"
agents_prefix="${repository_root}/.claude/worktrees/"

git worktree prune

# Snapshot the porcelain listing first: removing worktrees while reading
# the list would saw the branch we sit on.
listing="$(git worktree list --porcelain)"

path=""
branch=""
locked=0
removed=0
kept=0

flush() {
  [ -n "${path}" ] || return 0
  case "${path}" in
  "${agents_prefix}"*) ;;
  *)
    path=""
    branch=""
    locked=0
    return 0
    ;;
  esac

  name="${path#"${agents_prefix}"}"
  short_branch="${branch#refs/heads/}"

  state=""
  if [ "${locked}" -eq 1 ]; then
    state="active (locked by its agent)"
  elif [ -n "$(git -C "${path}" status --porcelain)" ]; then
    state="dirty (uncommitted work)"
  elif [ -z "${short_branch}" ]; then
    state="detached HEAD — inspect by hand"
  elif [ "$(git rev-parse "${short_branch}")" = "$(git rev-parse main)" ]; then
    # A branch exactly on main's HEAD is a worktree an agent has only just
    # created, or one that did nothing; a merged branch stays on its own last
    # commit. Removing it could delete a running agent's fresh worktree.
    state="no commits of its own — fresh or untouched, not auto-removed"
  elif git cherry main "${short_branch}" | grep -q '^+'; then
    state="unmerged commits — accept or discard by hand"
  fi

  if [ -z "${state}" ]; then
    if [ "${mode}" = "clean" ]; then
      git worktree remove "${path}"
      git branch -D "${short_branch}" >/dev/null
      printf 'removed  %-40s %s\n' "${name}" "${short_branch}"
      removed=$((removed + 1))
    else
      printf 'merged   %-40s %s (removable: pnpm worktrees:clean)\n' "${name}" "${short_branch}"
    fi
  else
    printf 'kept     %-40s %s — %s\n' "${name}" "${short_branch:-—}" "${state}"
    kept=$((kept + 1))
  fi

  path=""
  branch=""
  locked=0
}

while IFS= read -r line; do
  case "${line}" in
  worktree\ *) flush; path="${line#worktree }" ;;
  branch\ *) branch="${line#branch }" ;;
  locked*) locked=1 ;;
  esac
done <<EOF
${listing}
EOF
flush

git worktree prune

if [ "${mode}" = "clean" ]; then
  printf 'Removed: %s, kept: %s.\n' "${removed}" "${kept}"
fi
