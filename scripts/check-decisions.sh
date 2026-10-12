#!/usr/bin/env bash
#
# Checks the decision log and its boundary with the code.
#
# In docs/decisions: every file is named NNNN-slug.md and no number is handed
# out twice, because documents cite decisions by number and a duplicate turns
# a citation into a riddle.
#
# Outside the documents: no tracked file outside docs/ that is not markdown
# cites a decision or a research note by number (ADR-NNNN,
# docs/decisions/NNNN, docs/research/NN). Code states the constraint it keeps
# and a test holds it; the reasoning stays in the record, so a decision
# changes in one place. SQL under drizzle/ and migrations/ is exempt, because
# an applied migration must stay byte-identical; a new migration's comments
# follow the rule by review.
#
# Not checked: that decisions already taken stay unchanged. They are living
# documents edited in place, and the history is in git.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
decisions_directory="${repository_root}/docs/decisions"

problems=0

report() {
  printf '%s\n' "$1" >&2
  problems=$((problems + 1))
}

if [ ! -d "${decisions_directory}" ]; then
  printf 'The docs/decisions directory does not exist — nothing to check.\n' >&2
  exit 1
fi

numbers=""
found=0

for path in "${decisions_directory}"/*; do
  [ -e "${path}" ] || continue

  name="$(basename "${path}")"

  # The README describes the format of the log and is not a decision itself.
  if [ "${name}" = "README.md" ]; then
    continue
  fi

  if [ ! -f "${path}" ]; then
    report "docs/decisions/${name}: a decision is a file, not a directory."
    continue
  fi

  if ! printf '%s' "${name}" | grep -Eq '^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md$'; then
    report "docs/decisions/${name}: the name is not in the NNNN-slug.md format (four digits, a hyphen, lowercase latin)."
    continue
  fi

  found=$((found + 1))
  numbers="${numbers}${name%%-*}
"
done

if [ "${found}" -eq 0 ]; then
  report "There is not a single decision in docs/decisions — the log is empty."
fi

duplicates="$(printf '%s' "${numbers}" | sort | uniq -d)"

if [ -n "${duplicates}" ]; then
  for number in ${duplicates}; do
    same="$(cd "${decisions_directory}" && printf '%s ' "${number}"-*.md)"
    report "Number ${number} has been handed out more than once: ${same}"
  done
fi

# git grep answers 1 when nothing matches and more than 1 when it could not
# search at all; only the second is a failure of the check.
grep_status=0
citations="$(
  git -C "${repository_root}" grep -n -I -E \
    'ADR-[0-9]{4}|docs/decisions/[0-9]{4}|docs/research/[0-9]{2}' \
    -- . ':(exclude)*.md' ':(exclude)docs/**' ':(exclude)**/drizzle/*.sql' ':(exclude)**/migrations/*.sql' \
    ':(exclude)scripts/check-decisions.sh'
)" || grep_status=$?

if [ "${grep_status}" -gt 1 ]; then
  printf 'Could not search the tracked files for citations (git grep exit %s).\n' "${grep_status}" >&2
  exit 1
fi

if [ -n "${citations}" ]; then
  while IFS= read -r line; do
    report "${line}: cites a decision or a research note by number. State the constraint in the code and hold it with a test; the reasoning stays in the record."
  done <<<"$(printf '%s\n' "${citations}" | cut -d: -f1,2)"
fi

if [ "${problems}" -ne 0 ]; then
  printf 'The decision log is not in order. Problems: %s.\n' "${problems}" >&2
  exit 1
fi

printf 'The decision log is in order. Decisions: %s, numbers are unique, and no code cites them.\n' "${found}"
